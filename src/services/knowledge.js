// IA-1 · Contenido y conocimiento del hotel (§55.5). Centraliza el contenido
// de habitaciones + la base de conocimiento que el agente consultará (IA-3/IA-5).
import { prisma } from '../db.js';
import { GUEST_SERVICES, parseServiceList } from '../lib/services.js';
import { disabledFeatures } from './platform.js';

// Servicios de cara al huésped que ofrece la sede (sin inventar): el mismo
// subconjunto que se publica en el sitio, filtrado por lo habilitado (§14/§55.1).
export async function hotelGuestServices(propertyId) {
  const property = await prisma.property.findUnique({ where: { id: propertyId }, select: { enabledServices: true } });
  const enabled = parseServiceList(property?.enabledServices); // null = todos
  const disabled = await disabledFeatures();
  return GUEST_SERVICES.filter(s => (enabled == null || enabled.includes(s.key)) && !disabled.has(s.key));
}

// Imágenes de un tipo de habitación: se guardan en el centro documental
// (entityType='RoomType', docType='image') y se referencian por URL pública.
export async function roomTypeImages(roomTypeId) {
  const docs = await prisma.document.findMany({
    where: { entityType: 'RoomType', entityId: roomTypeId, docType: 'image', status: 'active' },
    orderBy: { createdAt: 'asc' },
    select: { id: true, title: true, fileName: true },
  });
  return docs.map(d => ({ id: d.id, title: d.title, url: `/api/public/media/${d.id}` }));
}

// Contenido completo de habitaciones de una sede (para admin, web y agente).
export async function roomsContent(propertyId) {
  const types = await prisma.roomType.findMany({
    where: { propertyId, active: true },
    include: { ratePlans: { where: { active: true }, orderBy: { price: 'asc' }, take: 1 }, _count: { select: { rooms: true } } },
    orderBy: { baseRate: 'asc' },
  });
  const out = [];
  for (const t of types) {
    out.push({
      id: t.id, name: t.name, code: t.code, capacity: t.capacity,
      baseRate: t.baseRate, fromPrice: t.ratePlans[0]?.price ?? t.baseRate,
      description: t.description, longDescription: t.longDescription,
      bedConfig: t.bedConfig, sizeM2: t.sizeM2, view: t.view,
      amenities: t.amenities, features: t.features, rooms: t._count.rooms,
      images: await roomTypeImages(t.id),
    });
  }
  return out;
}

export async function updateRoomTypeContent(roomTypeId, data) {
  const allowed = ['name', 'description', 'longDescription', 'bedConfig', 'sizeM2', 'view', 'amenities', 'features', 'baseRate', 'capacity'];
  const clean = Object.fromEntries(Object.entries(data).filter(([k]) => allowed.includes(k)));
  if (clean.sizeM2 !== undefined && clean.sizeM2 !== null) clean.sizeM2 = +clean.sizeM2 || null;
  if (clean.baseRate !== undefined) clean.baseRate = +clean.baseRate;
  if (clean.capacity !== undefined) clean.capacity = +clean.capacity;
  return prisma.roomType.update({ where: { id: roomTypeId }, data: clean });
}

// ---- Base de conocimiento ----
// Un ítem está vigente si está activo, ya empezó su vigencia y no ha expirado.
export function isCurrent(item, now = new Date()) {
  if (!item.active) return false;
  if (item.validFrom && item.validFrom > now) return false;
  if (item.validUntil && item.validUntil < now) return false;
  return true;
}

export async function listKnowledge(propertyId, { visibility = null, activeOnly = true, currentOnly = false } = {}) {
  const where = { propertyId };
  if (visibility) where.visibility = visibility;
  if (activeOnly) where.active = true;
  const items = await prisma.knowledgeItem.findMany({ where, orderBy: [{ category: 'asc' }, { title: 'asc' }] });
  if (currentOnly) { const now = new Date(); return items.filter(i => isCurrent(i, now)); }
  return items;
}

// Crea un ítem con su primera versión.
export async function createKnowledgeItem({ propertyId, category, title, content, visibility = 'public', tags = null, validFrom = null, validUntil = null, user = null }) {
  return prisma.knowledgeItem.create({
    data: {
      propertyId, category, title, content, visibility, tags, updatedBy: user?.name || null,
      validFrom: validFrom ? new Date(validFrom) : null,
      validUntil: validUntil ? new Date(validUntil) : null,
      revisions: { create: { propertyId, version: 1, title, content, tags, editedBy: user?.name || null } },
    },
  });
}

// Actualiza un ítem versionando la copia anterior (historial de vigencia).
export async function updateKnowledgeItem(id, { user = null, ...fields }) {
  const item = await prisma.knowledgeItem.findUnique({ where: { id } });
  if (!item) throw new Error('Ítem no encontrado');
  const data = {};
  for (const k of ['category', 'title', 'content', 'visibility', 'tags', 'active']) if (fields[k] !== undefined) data[k] = fields[k];
  if (fields.validFrom !== undefined) data.validFrom = fields.validFrom ? new Date(fields.validFrom) : null;
  if (fields.validUntil !== undefined) data.validUntil = fields.validUntil ? new Date(fields.validUntil) : null;
  data.updatedBy = user?.name || null;
  // Solo se crea una nueva versión si cambió el contenido sustantivo.
  const contentChanged = ['title', 'content', 'tags'].some(k => data[k] !== undefined && data[k] !== item[k]);
  if (contentChanged) {
    data.version = item.version + 1;
    return prisma.knowledgeItem.update({
      where: { id },
      data: { ...data, revisions: { create: { propertyId: item.propertyId, version: item.version + 1, title: data.title ?? item.title, content: data.content ?? item.content, tags: data.tags ?? item.tags, editedBy: user?.name || null } } },
    });
  }
  return prisma.knowledgeItem.update({ where: { id }, data });
}

export async function listKnowledgeRevisions(itemId) {
  return prisma.knowledgeRevision.findMany({ where: { knowledgeItemId: itemId }, orderBy: { version: 'desc' }, take: 50 });
}

// Panel de vigencia: ítems vencidos y por vencer (dentro de N días).
export async function knowledgeReview(propertyId, { withinDays = 30 } = {}) {
  const items = await prisma.knowledgeItem.findMany({ where: { propertyId, active: true } });
  const now = new Date();
  const soon = new Date(now.getTime() + withinDays * 86400_000);
  const expired = [];
  const expiringSoon = [];
  const notYetValid = [];
  for (const i of items) {
    if (i.validUntil && i.validUntil < now) expired.push(i);
    else if (i.validUntil && i.validUntil <= soon) expiringSoon.push(i);
    if (i.validFrom && i.validFrom > now) notYetValid.push(i);
  }
  return { expired, expiringSoon, notYetValid, counts: { expired: expired.length, expiringSoon: expiringSoon.length, notYetValid: notYetValid.length } };
}

// Snapshot de conocimiento que consumirá el agente (IA-3): contenido de
// habitaciones + ítems de conocimiento según el ámbito permitido del agente.
export async function knowledgeSnapshot(propertyId, { visibility = 'public' } = {}) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  const rooms = await roomsContent(propertyId);
  const items = await listKnowledge(propertyId, {
    visibility: visibility === 'internal' ? null : 'public', // interno ve todo; externo solo público
    currentOnly: true, // el agente nunca ve conocimiento vencido o aún no vigente (§55.5)
  });
  const policies = await prisma.hotelPolicy.findMany({ where: { propertyId, active: true } });
  // Carta del restaurante/room service: entrena al agente para responder platos,
  // precios y hacer upsell de consumos (§ restaurante/POS).
  const menu = await prisma.menuItem.findMany({ where: { propertyId, active: true }, orderBy: [{ category: 'asc' }, { price: 'asc' }], select: { name: true, category: true, price: true } });
  const services = await hotelGuestServices(propertyId);
  return {
    hotel: {
      name: property?.name, city: property?.city, address: property?.address,
      checkInTime: property?.checkInTime, checkOutTime: property?.checkOutTime,
      currency: property?.currency,
    },
    rooms,
    services, // servicios reales que ofrece el hotel (el agente no debe inventar otros)
    knowledge: items.map(i => ({ category: i.category, title: i.title, content: i.content, tags: i.tags, updatedAt: i.updatedAt })),
    policies: policies.map(p => ({ type: p.type, title: p.title, text: p.publicText || p.conditions })),
    menu: menu.map(m => ({ name: m.name, category: m.category, price: m.price })),
  };
}
