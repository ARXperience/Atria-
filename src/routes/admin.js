// Panel administrativo (secciones 6 y 7): empresa, sedes, habitaciones,
// tarifas, usuarios y parámetros legales versionados.
import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { requirePermission, propertyScope, ROLES } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';
import { importRooms, importGuests, importEmployees, goLiveChecklist } from '../services/importer.js';

export const adminRouter = Router();

// ---- Onboarding e importadores (§55.2) ----
adminRouter.get('/checklist', requirePermission('settings.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await goLiveChecklist(req.query.propertyId, req.user.companyId));
});

adminRouter.post('/import/rooms', requirePermission('rooms.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const result = await importRooms(req.body.propertyId, req.body.csv ?? req.body.rows);
    await audit({ companyId: req.user.companyId, user: req.user, action: 'import.rooms', entity: 'Room', after: { imported: result.imported, errores: result.errors.length } });
    res.json(result);
  } catch (err) { badRequest(res, err.message); }
});

adminRouter.post('/import/guests', requirePermission('guests.create'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const result = await importGuests(req.body.propertyId, req.body.csv ?? req.body.rows);
    await audit({ companyId: req.user.companyId, user: req.user, action: 'import.guests', entity: 'Guest', after: { imported: result.imported, errores: result.errors.length } });
    res.json(result);
  } catch (err) { badRequest(res, err.message); }
});

adminRouter.post('/import/employees', requirePermission('hr.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const result = await importEmployees(req.user.companyId, req.body.propertyId, req.body.csv ?? req.body.rows);
    await audit({ companyId: req.user.companyId, user: req.user, action: 'import.employees', entity: 'Employee', after: { imported: result.imported, errores: result.errors.length } });
    res.json(result);
  } catch (err) { badRequest(res, err.message); }
});

// ---- Sedes ----
adminRouter.get('/properties', async (req, res) => {
  const where = { companyId: req.user.companyId };
  if (req.user.propertyIds !== '*') where.id = { in: req.user.propertyIds.split(',') };
  res.json(await prisma.property.findMany({ where, include: { _count: { select: { rooms: true } } } }));
});

adminRouter.patch('/properties/:id', requirePermission('settings.edit'), async (req, res) => {
  if (!propertyScope(req, req.params.id)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const allowed = ['name', 'address', 'city', 'rnt', 'checkInTime', 'checkOutTime', 'taxRate'];
  const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (req.body?.rntExpiresAt) data.rntExpiresAt = new Date(req.body.rntExpiresAt);
  const before = await prisma.property.findUnique({ where: { id: req.params.id } });
  const updated = await prisma.property.update({ where: { id: req.params.id }, data });
  await audit({ companyId: req.user.companyId, propertyId: req.params.id, user: req.user, action: 'property.updated', entity: 'Property', entityId: req.params.id, before, after: data });
  res.json(updated);
});

// ---- Tipos de habitación y habitaciones ----
adminRouter.get('/room-types', async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.roomType.findMany({ where: { propertyId }, include: { ratePlans: true, _count: { select: { rooms: true } } } }));
});

adminRouter.post('/room-types', requirePermission('rooms.manage'), async (req, res) => {
  const { propertyId, name, code, capacity, baseRate, description } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!name || !code || !baseRate) return badRequest(res, 'name, code y baseRate son requeridos');
  const rt = await prisma.roomType.create({ data: { propertyId, name, code, capacity: capacity || 2, baseRate, description } });
  await audit({ propertyId, user: req.user, action: 'room_type.created', entity: 'RoomType', entityId: rt.id, after: req.body });
  res.status(201).json(rt);
});

adminRouter.get('/rooms', requirePermission('rooms.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.room.findMany({ where: { propertyId, active: true }, include: { roomType: true }, orderBy: { number: 'asc' } }));
});

adminRouter.post('/rooms', requirePermission('rooms.manage'), async (req, res) => {
  const { propertyId, roomTypeId, number, floor } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!roomTypeId || !number) return badRequest(res, 'roomTypeId y number son requeridos');
  const room = await prisma.room.create({ data: { propertyId, roomTypeId, number: String(number), floor } });
  await audit({ propertyId, user: req.user, action: 'room.created', entity: 'Room', entityId: room.id, after: req.body });
  res.status(201).json(room);
});

adminRouter.patch('/rooms/:id/status', requirePermission('rooms.status'), async (req, res) => {
  const { status } = req.body || {};
  const valid = ['clean', 'dirty', 'inspected', 'out_of_service'];
  if (!valid.includes(status)) return badRequest(res, `Estado inválido. Use: ${valid.join(', ')}`);
  const room = await prisma.room.findUnique({ where: { id: req.params.id } });
  if (!room || !propertyScope(req, room.propertyId)) return res.status(403).json({ error: 'Sin acceso' });
  if (room.status === 'occupied') return badRequest(res, 'La habitación está ocupada; realice check-out primero');
  const updated = await prisma.room.update({ where: { id: req.params.id }, data: { status } });
  await audit({ propertyId: room.propertyId, user: req.user, action: 'room.status_changed', entity: 'Room', entityId: room.id, before: { status: room.status }, after: { status } });
  res.json(updated);
});

// ---- Planes tarifarios ----
adminRouter.post('/rate-plans', requirePermission('rooms.manage'), async (req, res) => {
  const { propertyId, roomTypeId, name, code, price, refundable = true, minNights = 1, depositPct = 0.5 } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!roomTypeId || !name || !code || !price) return badRequest(res, 'roomTypeId, name, code y price son requeridos');
  const plan = await prisma.ratePlan.create({ data: { propertyId, roomTypeId, name, code, price, refundable, minNights, depositPct } });
  await audit({ propertyId, user: req.user, action: 'rate_plan.created', entity: 'RatePlan', entityId: plan.id, after: req.body });
  res.status(201).json(plan);
});

// ---- Usuarios ----
adminRouter.get('/users', requirePermission('users.view'), async (req, res) => {
  const users = await prisma.user.findMany({
    where: { companyId: req.user.companyId },
    select: { id: true, name: true, email: true, role: true, active: true, lastLoginAt: true, propertyIds: true },
  });
  res.json(users);
});

adminRouter.post('/users', requirePermission('users.manage'), async (req, res) => {
  const { name, email, password, role, propertyIds = '*' } = req.body || {};
  if (!name || !email || !password || !role) return badRequest(res, 'name, email, password y role son requeridos');
  if (!ROLES.includes(role)) return badRequest(res, `Rol inválido. Use: ${ROLES.join(', ')}`);
  if (password.length < 8) return badRequest(res, 'La contraseña debe tener mínimo 8 caracteres');
  const user = await prisma.user.create({
    data: {
      companyId: req.user.companyId, name,
      email: String(email).toLowerCase().trim(),
      passwordHash: await bcrypt.hash(password, 10),
      role, propertyIds,
    },
  });
  await audit({ companyId: req.user.companyId, user: req.user, action: 'user.created', entity: 'User', entityId: user.id, after: { name, email, role } });
  res.status(201).json({ id: user.id, name: user.name, email: user.email, role: user.role });
});

// ---- Parámetros legales versionados (sección 6) ----
adminRouter.get('/legal-parameters', async (req, res) => {
  res.json(await prisma.legalParameter.findMany({
    where: { companyId: req.user.companyId },
    orderBy: [{ key: 'asc' }, { validFrom: 'desc' }],
  }));
});

adminRouter.post('/legal-parameters', requirePermission('settings.edit'), async (req, res) => {
  const { key, value, unit, validFrom, validTo, source } = req.body || {};
  if (!key || value === undefined || !validFrom) return badRequest(res, 'key, value y validFrom son requeridos');
  const param = await prisma.legalParameter.create({
    data: {
      companyId: req.user.companyId, key, value: Number(value), unit,
      validFrom: new Date(validFrom), validTo: validTo ? new Date(validTo) : null,
      source, updatedBy: req.user.name,
    },
  });
  await audit({ companyId: req.user.companyId, user: req.user, action: 'legal_parameter.created', entity: 'LegalParameter', entityId: param.id, after: req.body });
  res.status(201).json(param);
});
