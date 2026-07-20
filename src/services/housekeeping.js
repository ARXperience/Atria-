// Housekeeping (§30): protocolos de limpieza (checklists) y objetos perdidos.
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';

// Protocolo de limpieza por tipo de tarea. Se materializa como checklist al crear
// la tarea; la camarera lo marca punto por punto.
const CHECKLIST_TEMPLATES = {
  checkout_clean: [
    'Retirar ropa de cama y toallas usadas',
    'Tender cama con lencería limpia',
    'Limpiar y desinfectar baño',
    'Reponer amenities y toallas',
    'Aspirar/trapear pisos',
    'Vaciar papeleras',
    'Revisar minibar y reponer',
    'Verificar funcionamiento de TV, luces y A/C',
    'Revisar objetos olvidados por el huésped',
  ],
  stayover: [
    'Tender cama',
    'Cambiar toallas si el huésped lo solicitó',
    'Limpiar baño',
    'Reponer amenities',
    'Vaciar papeleras',
    'Ordenar la habitación',
  ],
  deep_clean: [
    'Lavado profundo de baño y juntas',
    'Limpieza de cortinas y ventanas',
    'Limpieza detrás de muebles',
    'Desinfección de colchón y almohadas',
    'Limpieza de A/C y filtros',
    'Revisión de plagas',
  ],
  request: [
    'Atender la solicitud del huésped',
    'Verificar conformidad',
  ],
};

export function checklistFor(type) {
  const items = CHECKLIST_TEMPLATES[type] || CHECKLIST_TEMPLATES.request;
  return items.map((item) => ({ item, done: false }));
}

export function parseChecklist(task) {
  if (!task?.checklist) return [];
  try { return JSON.parse(task.checklist); } catch { return []; }
}

// Marca/desmarca un punto del checklist por índice.
export async function toggleChecklistItem(taskId, { index, done, user }) {
  const task = await prisma.housekeepingTask.findUnique({ where: { id: taskId } });
  if (!task) throw new Error('Tarea no encontrada');
  const list = parseChecklist(task);
  if (index < 0 || index >= list.length) throw new Error('Punto del checklist inválido');
  list[index].done = done === undefined ? !list[index].done : !!done;
  const updated = await prisma.housekeepingTask.update({ where: { id: taskId }, data: { checklist: JSON.stringify(list) } });
  await audit({ propertyId: task.propertyId, user, action: 'housekeeping.checklist_item', entity: 'HousekeepingTask', entityId: taskId, after: { index, done: list[index].done } });
  return updated;
}

export function checklistComplete(task) {
  const list = parseChecklist(task);
  return list.length > 0 && list.every((x) => x.done);
}

// ---- Objetos perdidos y encontrados ----
export async function registerLostItem({ propertyId, roomId = null, reservationId = null, description, location = null, foundBy = null, notes = null, user = null }) {
  if (!description) throw new Error('La descripción del objeto es obligatoria');
  // Si viene una habitación pero no reserva, intenta asociar la última estadía.
  let resId = reservationId;
  if (!resId && roomId) {
    const last = await prisma.reservation.findFirst({ where: { propertyId, roomId, status: { in: ['checked_out', 'checked_in'] } }, orderBy: { checkOut: 'desc' } });
    resId = last?.id || null;
  }
  const item = await prisma.lostItem.create({
    data: { propertyId, roomId, reservationId: resId, description, location, foundBy: foundBy || user?.name || null, notes },
  });
  await audit({ propertyId, user, action: 'lostfound.registered', entity: 'LostItem', entityId: item.id, after: { description } });
  emitEvent('lostfound.registered', { propertyId, entityId: item.id });
  return item;
}

export async function updateLostItem(id, { status, claimedBy = null, notes = null, user = null }) {
  const item = await prisma.lostItem.findUnique({ where: { id } });
  if (!item) throw new Error('Objeto no encontrado');
  const data = {};
  if (status) {
    if (!['stored', 'claimed', 'returned', 'discarded'].includes(status)) throw new Error('Estado inválido');
    data.status = status;
    if (['returned', 'discarded'].includes(status)) { data.resolvedBy = user?.name || null; data.resolvedAt = new Date(); }
    if (status === 'claimed' || status === 'returned') data.claimedBy = claimedBy || item.claimedBy;
  }
  if (notes !== null) data.notes = notes;
  const updated = await prisma.lostItem.update({ where: { id }, data });
  await audit({ propertyId: item.propertyId, user, action: `lostfound.${status || 'updated'}`, entity: 'LostItem', entityId: id, after: data });
  return updated;
}

export async function listLostItems(propertyId, { status } = {}) {
  const where = { propertyId };
  if (status) where.status = { in: String(status).split(',') };
  return prisma.lostItem.findMany({ where, orderBy: [{ status: 'asc' }, { foundAt: 'desc' }], take: 200 });
}
