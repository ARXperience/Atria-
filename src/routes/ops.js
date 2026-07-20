// Atria Ops (secciones 30 y 31): housekeeping y mantenimiento.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { requestApproval } from '../services/approvals.js';
import { checklistFor, toggleChecklistItem, checklistComplete, registerLostItem, updateLostItem, listLostItems } from '../services/housekeeping.js';
import { createAsset, updateAsset, listAssets, generatePreventiveOrders, onOrderResolved } from '../services/maintenance.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';
import { emitEvent } from '../lib/events.js';

export const opsRouter = Router();

// ---- Solicitudes de huéspedes (portal §14) ----
opsRouter.get('/guest-requests', requirePermission('reservations.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = { in: String(status).split(',') };
  res.json(await prisma.guestRequest.findMany({ where, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200 }));
});

opsRouter.patch('/guest-requests/:id', requirePermission('reservations.view'), async (req, res) => {
  const gr = await prisma.guestRequest.findUnique({ where: { id: req.params.id } });
  if (!gr || !propertyScope(req, gr.propertyId)) return res.status(404).json({ error: 'Solicitud no encontrada' });
  const status = req.body?.status;
  if (!['pending', 'in_progress', 'done', 'cancelled'].includes(status)) return badRequest(res, 'estado inválido');
  const updated = await prisma.guestRequest.update({ where: { id: gr.id }, data: { status, resolvedBy: ['done', 'cancelled'].includes(status) ? req.user.name : null, resolvedAt: ['done', 'cancelled'].includes(status) ? new Date() : null } });
  await audit({ propertyId: gr.propertyId, user: req.user, action: `guest_request.${status}`, entity: 'GuestRequest', entityId: gr.id });
  res.json(updated);
});

// ---- Housekeeping ----
opsRouter.get('/housekeeping/tasks', requirePermission('housekeeping.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = { in: String(status).split(',') };
  res.json(await prisma.housekeepingTask.findMany({ where, include: { room: true }, orderBy: [{ status: 'asc' }, { createdAt: 'desc' }], take: 200 }));
});

opsRouter.post('/housekeeping/tasks', requirePermission('housekeeping.create'), async (req, res) => {
  const { propertyId, roomId, type = 'request', priority = 'normal', notes } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!roomId) return badRequest(res, 'roomId requerido');
  const task = await prisma.housekeepingTask.create({ data: { propertyId, roomId, type, priority, notes, assignedTo: req.body?.assignedTo || null, checklist: JSON.stringify(checklistFor(type)) } });
  await audit({ propertyId, user: req.user, action: 'housekeeping.task_created', entity: 'HousekeepingTask', entityId: task.id, after: req.body });
  emitEvent('housekeeping.task_created', { propertyId, entityId: task.id });
  res.status(201).json(task);
});

opsRouter.patch('/housekeeping/tasks/:id', requirePermission('housekeeping.edit'), async (req, res) => {
  const task = await prisma.housekeepingTask.findUnique({ where: { id: req.params.id } });
  if (!task || !propertyScope(req, task.propertyId)) return res.status(404).json({ error: 'Tarea no encontrada' });
  const { status, assignedTo, notes } = req.body || {};
  const data = {};
  if (status) {
    if (!['pending', 'in_progress', 'done', 'inspected'].includes(status)) return badRequest(res, 'Estado inválido');
    // No se puede cerrar la limpieza con el protocolo incompleto (§30).
    if ((status === 'done' || status === 'inspected') && task.checklist && !checklistComplete(task)) {
      return badRequest(res, 'Completa todos los puntos del protocolo de limpieza antes de cerrar la tarea');
    }
    data.status = status;
    if (status === 'done' || status === 'inspected') data.completedAt = new Date();
  }
  if (assignedTo !== undefined) data.assignedTo = assignedTo;
  if (notes !== undefined) data.notes = notes;
  const updated = await prisma.housekeepingTask.update({ where: { id: task.id }, data });

  // Al terminar la limpieza, la habitación pasa a limpia/inspeccionada
  if (data.status === 'done' || data.status === 'inspected') {
    const roomStatus = data.status === 'inspected' ? 'inspected' : 'clean';
    await prisma.room.update({ where: { id: task.roomId }, data: { status: roomStatus } });
    emitEvent('room.status_changed', { propertyId: task.propertyId, roomId: task.roomId, status: roomStatus });
  }
  await audit({ propertyId: task.propertyId, user: req.user, action: 'housekeeping.task_updated', entity: 'HousekeepingTask', entityId: task.id, before: { status: task.status }, after: data });
  res.json(updated);
});

// Marcar/desmarcar un punto del protocolo de limpieza (§30)
opsRouter.patch('/housekeeping/tasks/:id/checklist', requirePermission('housekeeping.edit'), async (req, res) => {
  const task = await prisma.housekeepingTask.findUnique({ where: { id: req.params.id } });
  if (!task || !propertyScope(req, task.propertyId)) return res.status(404).json({ error: 'Tarea no encontrada' });
  try {
    res.json(await toggleChecklistItem(task.id, { index: +req.body?.index, done: req.body?.done, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

// ---- Objetos perdidos y encontrados (§30) ----
opsRouter.get('/lost-found', requirePermission('housekeeping.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await listLostItems(req.query.propertyId, { status: req.query.status }));
});

opsRouter.post('/lost-found', requirePermission('housekeeping.create'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    res.status(201).json(await registerLostItem({ ...req.body, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

opsRouter.patch('/lost-found/:id', requirePermission('housekeeping.edit'), async (req, res) => {
  const item = await prisma.lostItem.findUnique({ where: { id: req.params.id } });
  if (!item || !propertyScope(req, item.propertyId)) return res.status(404).json({ error: 'Objeto no encontrado' });
  try {
    res.json(await updateLostItem(item.id, { status: req.body?.status, claimedBy: req.body?.claimedBy, notes: req.body?.notes, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

// ---- Mantenimiento ----
opsRouter.get('/maintenance/orders', requirePermission('maintenance.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = { in: String(status).split(',') };
  res.json(await prisma.maintenanceOrder.findMany({ where, include: { room: true }, orderBy: { createdAt: 'desc' }, take: 200 }));
});

opsRouter.post('/maintenance/orders', requirePermission('maintenance.create'), async (req, res) => {
  const { propertyId, roomId, assetId, title, description, priority = 'medium', blocksRoom = false } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!title) return badRequest(res, 'title requerido');
  const order = await prisma.maintenanceOrder.create({
    data: { propertyId, roomId: roomId || null, assetId: assetId || null, title, description, priority, blocksRoom: false, reportedBy: req.user.name },
  });
  await audit({ propertyId, user: req.user, action: 'maintenance.order_created', entity: 'MaintenanceOrder', entityId: order.id, after: req.body });
  emitEvent('maintenance.order_created', { propertyId, entityId: order.id });

  // Bloquear habitación vendible requiere aprobación de gerente (sección 31)
  let pendingApproval = null;
  if (blocksRoom && roomId) {
    pendingApproval = await requestApproval({
      propertyId, type: 'room_block',
      summary: `Bloquear habitación por mantenimiento: ${title}`,
      payload: { propertyId, roomId, reason: `Mantenimiento: ${title}` },
      requiredRole: 'MANAGER', user: req.user,
    });
  }
  res.status(201).json({ order, pendingApproval });
});

opsRouter.patch('/maintenance/orders/:id', requirePermission('maintenance.edit'), async (req, res) => {
  const order = await prisma.maintenanceOrder.findUnique({ where: { id: req.params.id } });
  if (!order || !propertyScope(req, order.propertyId)) return res.status(404).json({ error: 'Orden no encontrada' });
  const { status, assignedTo, cost } = req.body || {};
  const data = {};
  if (status) {
    if (!['open', 'in_progress', 'resolved', 'closed'].includes(status)) return badRequest(res, 'Estado inválido');
    data.status = status;
    if (status === 'resolved' || status === 'closed') data.resolvedAt = new Date();
  }
  if (assignedTo !== undefined) data.assignedTo = assignedTo;
  if (cost !== undefined) data.cost = +cost;
  const updated = await prisma.maintenanceOrder.update({ where: { id: order.id }, data });

  // Al resolver, si la habitación estaba fuera de servicio, vuelve a sucia para limpieza
  if ((data.status === 'resolved' || data.status === 'closed') && order.roomId) {
    const room = await prisma.room.findUnique({ where: { id: order.roomId } });
    if (room?.status === 'out_of_service') {
      await prisma.room.update({ where: { id: room.id }, data: { status: 'dirty' } });
      emitEvent('room.status_changed', { propertyId: order.propertyId, roomId: room.id, status: 'dirty' });
    }
  }
  // Al resolver una orden ligada a un activo, actualiza su histórico y reprograma (§31)
  if ((data.status === 'resolved' || data.status === 'closed') && order.assetId) {
    await onOrderResolved(order);
  }
  await audit({ propertyId: order.propertyId, user: req.user, action: 'maintenance.order_updated', entity: 'MaintenanceOrder', entityId: order.id, before: { status: order.status }, after: data });
  res.json(updated);
});

// ---- Activos y mantenimiento preventivo (§31) ----
opsRouter.get('/assets', requirePermission('maintenance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await listAssets(req.query.propertyId, { status: req.query.status, category: req.query.category }));
});

opsRouter.post('/assets', requirePermission('maintenance.create'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    res.status(201).json(await createAsset({ ...req.body, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

opsRouter.patch('/assets/:id', requirePermission('maintenance.edit'), async (req, res) => {
  const asset = await prisma.asset.findUnique({ where: { id: req.params.id } });
  if (!asset || !propertyScope(req, asset.propertyId)) return res.status(404).json({ error: 'Activo no encontrado' });
  try {
    res.json(await updateAsset(asset.id, { ...req.body, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

// Genera órdenes preventivas para los activos vencidos (o próximos a vencer).
opsRouter.post('/maintenance/preventive/run', requirePermission('maintenance.create'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    res.json(await generatePreventiveOrders(req.body.propertyId, { withinDays: +req.body?.withinDays || 0, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});
