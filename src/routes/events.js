// Eventos & corporativo (§33).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { listVenues, createVenue, venueAvailable, quoteEvent, createEvent, confirmEvent, setEventStatus, eventsOverview } from '../services/events.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const eventsRouter = Router();

eventsRouter.get('/overview', requirePermission('events.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await eventsOverview(req.query.propertyId));
});

// ---- Salones ----
eventsRouter.get('/venues', requirePermission('events.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await listVenues(req.query.propertyId, { activeOnly: req.query.active === '1' }));
});

eventsRouter.post('/venues', requirePermission('events.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const v = await createVenue(req.body);
    await audit({ propertyId: v.propertyId, user: req.user, action: 'venue.created', entity: 'Venue', entityId: v.id, after: { name: v.name } });
    res.status(201).json(v);
  } catch (err) { badRequest(res, err.message); }
});

eventsRouter.get('/venues/:id/availability', requirePermission('events.view'), async (req, res) => {
  const v = await prisma.venue.findUnique({ where: { id: req.params.id } });
  if (!v || !propertyScope(req, v.propertyId)) return res.status(404).json({ error: 'Salón no encontrado' });
  if (!req.query.date) return badRequest(res, 'date requerida');
  res.json({ available: await venueAvailable(v.id, req.query.date) });
});

// Cotización sin persistir (para previsualizar en el panel).
eventsRouter.post('/quote', requirePermission('events.view'), async (req, res) => {
  const v = await prisma.venue.findUnique({ where: { id: req.body?.venueId } });
  if (!v || !propertyScope(req, v.propertyId)) return res.status(404).json({ error: 'Salón no encontrado' });
  const prop = await prisma.property.findUnique({ where: { id: v.propertyId }, select: { taxRate: true } });
  try { res.json(quoteEvent(v, { ...req.body, taxRate: prop?.taxRate ?? 0.19 })); }
  catch (err) { badRequest(res, err.message); }
});

// ---- Eventos ----
eventsRouter.get('/', requirePermission('events.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId: req.query.propertyId };
  if (req.query.status) where.status = req.query.status;
  res.json(await prisma.eventBooking.findMany({ where, include: { venue: { select: { name: true } } }, orderBy: { date: 'asc' }, take: 200 }));
});

eventsRouter.post('/', requirePermission('events.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const ev = await createEvent({ ...req.body, createdBy: req.user.name });
    await audit({ propertyId: ev.propertyId, user: req.user, action: 'event.created', entity: 'EventBooking', entityId: ev.id, after: { code: ev.code, total: ev.total } });
    res.status(201).json(ev);
  } catch (err) { badRequest(res, err.message); }
});

eventsRouter.post('/:id/confirm', requirePermission('events.manage'), async (req, res) => {
  const ev = await prisma.eventBooking.findUnique({ where: { id: req.params.id } });
  if (!ev || !propertyScope(req, ev.propertyId)) return res.status(404).json({ error: 'Evento no encontrado' });
  try { res.json(await confirmEvent(ev.id, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

eventsRouter.post('/:id/status', requirePermission('events.manage'), async (req, res) => {
  const ev = await prisma.eventBooking.findUnique({ where: { id: req.params.id } });
  if (!ev || !propertyScope(req, ev.propertyId)) return res.status(404).json({ error: 'Evento no encontrado' });
  try { res.json(await setEventStatus(ev.id, req.body?.status, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});
