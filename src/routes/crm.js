// CRM hotelero (sección 12): leads, etapas y huéspedes.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest, parseDay } from '../lib/util.js';

export const crmRouter = Router();

crmRouter.get('/leads', requirePermission('crm.view'), async (req, res) => {
  const { propertyId, stage } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (stage) where.stage = stage;
  res.json(await prisma.lead.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200 }));
});

crmRouter.post('/leads', requirePermission('crm.create'), async (req, res) => {
  const { propertyId, name, phone, email, channel = 'phone', intent, checkIn, checkOut, adults, notes } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!name && !phone && !email) return badRequest(res, 'Se requiere al menos nombre, teléfono o email');
  const lead = await prisma.lead.create({
    data: {
      propertyId, name, phone, email, channel, intent,
      checkIn: checkIn ? parseDay(checkIn) : null,
      checkOut: checkOut ? parseDay(checkOut) : null,
      adults: adults ? +adults : null, notes,
      assignedTo: req.user.name,
    },
  });
  await audit({ propertyId, user: req.user, action: 'lead.created', entity: 'Lead', entityId: lead.id, after: req.body });
  res.status(201).json(lead);
});

crmRouter.patch('/leads/:id', requirePermission('crm.edit'), async (req, res) => {
  const lead = await prisma.lead.findUnique({ where: { id: req.params.id } });
  if (!lead || !propertyScope(req, lead.propertyId)) return res.status(404).json({ error: 'Lead no encontrado' });
  const allowed = ['stage', 'score', 'assignedTo', 'notes', 'lostReason', 'intent', 'name', 'phone', 'email'];
  const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const updated = await prisma.lead.update({ where: { id: lead.id }, data });
  await audit({ propertyId: lead.propertyId, user: req.user, action: 'lead.updated', entity: 'Lead', entityId: lead.id, before: lead, after: data });
  res.json(updated);
});

crmRouter.get('/guests', requirePermission('guests.view'), async (req, res) => {
  const { propertyId, q } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (q) where.OR = [{ fullName: { contains: q } }, { phone: { contains: q } }, { documentNumber: { contains: q } }];
  res.json(await prisma.guest.findMany({ where, orderBy: { updatedAt: 'desc' }, take: 200, include: { _count: { select: { reservations: true } } } }));
});
