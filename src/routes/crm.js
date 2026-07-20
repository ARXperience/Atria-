// CRM hotelero (sección 12): leads, etapas y huéspedes.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { guestRecall, getGuestMemory } from '../services/ai/memory.js';
import { createCorporateAccount, updateCorporateAccount, listCorporateAccounts, accountStatement, createRoomingList, addRoomingEntry, getRoomingList, listRoomingLists, materializeRoomingList } from '../services/corporate.js';
import { audit } from '../lib/audit.js';
import { badRequest, parseDay } from '../lib/util.js';

export const crmRouter = Router();

// ---- Cuentas corporativas / agencias (§35) ----
crmRouter.get('/corporate', requirePermission('crm.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await listCorporateAccounts(req.query.propertyId, { status: req.query.status }));
});

crmRouter.post('/corporate', requirePermission('crm.create'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.status(201).json(await createCorporateAccount({ ...req.body, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

crmRouter.patch('/corporate/:id', requirePermission('crm.edit'), async (req, res) => {
  const acc = await prisma.corporateAccount.findUnique({ where: { id: req.params.id } });
  if (!acc || !propertyScope(req, acc.propertyId)) return res.status(404).json({ error: 'Cuenta no encontrada' });
  try { res.json(await updateCorporateAccount(acc.id, { ...req.body, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

crmRouter.get('/corporate/:id/statement', requirePermission('crm.view'), async (req, res) => {
  const acc = await prisma.corporateAccount.findUnique({ where: { id: req.params.id } });
  if (!acc || !propertyScope(req, acc.propertyId)) return res.status(404).json({ error: 'Cuenta no encontrada' });
  res.json(await accountStatement(acc.id));
});

// ---- Rooming lists (§35) ----
crmRouter.get('/rooming', requirePermission('crm.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await listRoomingLists(req.query.propertyId));
});

crmRouter.get('/rooming/:id', requirePermission('crm.view'), async (req, res) => {
  const list = await getRoomingList(req.params.id);
  if (!list || !propertyScope(req, list.propertyId)) return res.status(404).json({ error: 'Rooming list no encontrado' });
  res.json(list);
});

crmRouter.post('/rooming', requirePermission('crm.create'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.status(201).json(await createRoomingList({ ...req.body, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

crmRouter.post('/rooming/:id/entries', requirePermission('crm.edit'), async (req, res) => {
  const list = await prisma.roomingList.findUnique({ where: { id: req.params.id } });
  if (!list || !propertyScope(req, list.propertyId)) return res.status(404).json({ error: 'Rooming list no encontrado' });
  try { res.status(201).json(await addRoomingEntry(list.id, req.body || {})); }
  catch (err) { badRequest(res, err.message); }
});

crmRouter.post('/rooming/:id/materialize', requirePermission('reservations.create'), async (req, res) => {
  const list = await prisma.roomingList.findUnique({ where: { id: req.params.id } });
  if (!list || !propertyScope(req, list.propertyId)) return res.status(404).json({ error: 'Rooming list no encontrado' });
  try { res.json(await materializeRoomingList(list.id, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// Memoria del huésped e historial (IA-5)
crmRouter.get('/guests/:id/memory', requirePermission('guests.view'), async (req, res) => {
  const guest = await prisma.guest.findUnique({ where: { id: req.params.id } });
  if (!guest || !propertyScope(req, guest.propertyId)) return res.status(404).json({ error: 'Huésped no encontrado' });
  const memory = await getGuestMemory(guest.id); // se lee directo del huésped (no depende del teléfono)
  const reservations = await prisma.reservation.findMany({
    where: { guestId: guest.id }, orderBy: { checkIn: 'desc' }, take: 10,
    select: { code: true, status: true, checkIn: true, checkOut: true, total: true },
  });
  const stays = reservations.filter(r => ['confirmed', 'checked_in', 'checked_out'].includes(r.status)).length;
  res.json({
    guest: { id: guest.id, fullName: guest.fullName, phone: guest.phone, language: guest.language },
    memory,
    isReturning: stays > 0,
    stays,
    reservations,
  });
});

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
