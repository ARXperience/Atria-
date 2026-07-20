// Activos y mantenimiento preventivo (§31).
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';

const DAY = 86400_000;

export async function createAsset({ propertyId, name, category = 'other', location = null, serial = null, brand = null, intervalDays = null, nextServiceAt = null, notes = null, user = null }) {
  if (!name) throw new Error('El nombre del activo es obligatorio');
  const days = intervalDays != null ? Math.max(1, parseInt(intervalDays, 10)) : null;
  // Si hay cadencia pero no primera fecha, programa el primer servicio a un intervalo.
  const next = nextServiceAt ? new Date(nextServiceAt) : (days ? new Date(Date.now() + days * DAY) : null);
  const asset = await prisma.asset.create({
    data: { propertyId, name, category, location, serial, brand, intervalDays: days, nextServiceAt: next, notes },
  });
  await audit({ propertyId, user, action: 'asset.created', entity: 'Asset', entityId: asset.id, after: { name, category } });
  return asset;
}

export async function updateAsset(id, { user = null, ...fields }) {
  const asset = await prisma.asset.findUnique({ where: { id } });
  if (!asset) throw new Error('Activo no encontrado');
  const data = {};
  for (const k of ['name', 'category', 'location', 'serial', 'brand', 'status', 'notes']) {
    if (fields[k] !== undefined) data[k] = fields[k];
  }
  if (fields.intervalDays !== undefined) data.intervalDays = fields.intervalDays == null ? null : Math.max(1, parseInt(fields.intervalDays, 10));
  if (fields.nextServiceAt !== undefined) data.nextServiceAt = fields.nextServiceAt ? new Date(fields.nextServiceAt) : null;
  const updated = await prisma.asset.update({ where: { id }, data });
  await audit({ propertyId: asset.propertyId, user, action: 'asset.updated', entity: 'Asset', entityId: id, after: data });
  return updated;
}

export async function listAssets(propertyId, { status, category } = {}) {
  const where = { propertyId };
  if (status) where.status = { in: String(status).split(',') };
  if (category) where.category = category;
  const assets = await prisma.asset.findMany({ where, orderBy: [{ nextServiceAt: 'asc' }, { name: 'asc' }], take: 300 });
  const now = Date.now();
  return assets.map((a) => ({
    ...a,
    due: !!(a.nextServiceAt && a.nextServiceAt.getTime() <= now),
    dueSoon: !!(a.nextServiceAt && a.nextServiceAt.getTime() > now && a.nextServiceAt.getTime() <= now + 7 * DAY),
  }));
}

// Activos con servicio preventivo vencido (o dentro de N días).
export async function dueAssets(propertyId, { withinDays = 0 } = {}) {
  const limit = new Date(Date.now() + withinDays * DAY);
  return prisma.asset.findMany({
    where: { propertyId, status: { not: 'retired' }, nextServiceAt: { not: null, lte: limit } },
    orderBy: { nextServiceAt: 'asc' },
  });
}

// Genera órdenes de mantenimiento preventivo para los activos vencidos que aún
// no tienen una orden preventiva abierta. Idempotente por activo.
export async function generatePreventiveOrders(propertyId, { withinDays = 0, user = null } = {}) {
  const due = await dueAssets(propertyId, { withinDays });
  const created = [];
  for (const asset of due) {
    const existing = await prisma.maintenanceOrder.findFirst({
      where: { propertyId, assetId: asset.id, preventive: true, status: { in: ['open', 'in_progress'] } },
    });
    if (existing) continue;
    const order = await prisma.maintenanceOrder.create({
      data: {
        propertyId, assetId: asset.id, preventive: true,
        title: `Mantenimiento preventivo — ${asset.name}`,
        description: `Servicio programado del activo ${asset.name}${asset.location ? ` (${asset.location})` : ''}.`,
        priority: 'medium', reportedBy: 'Plan preventivo',
      },
    });
    await prisma.asset.update({ where: { id: asset.id }, data: { status: 'needs_service' } });
    await audit({ propertyId, user, action: 'maintenance.preventive_generated', entity: 'MaintenanceOrder', entityId: order.id, after: { assetId: asset.id } });
    emitEvent('maintenance.order_created', { propertyId, entityId: order.id });
    created.push(order);
  }
  return { generated: created.length, orders: created };
}

// Al resolver una orden ligada a un activo, actualiza su histórico y reprograma
// el próximo servicio según la cadencia.
export async function onOrderResolved(order) {
  if (!order.assetId) return;
  const asset = await prisma.asset.findUnique({ where: { id: order.assetId } });
  if (!asset) return;
  const now = new Date();
  const next = asset.intervalDays ? new Date(now.getTime() + asset.intervalDays * DAY) : asset.nextServiceAt;
  await prisma.asset.update({
    where: { id: asset.id },
    data: { lastServiceAt: now, nextServiceAt: next, status: 'operational' },
  });
}
