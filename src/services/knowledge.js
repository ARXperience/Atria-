// IA-1 · Contenido y conocimiento del hotel (§55.5). Centraliza el contenido
// de habitaciones + la base de conocimiento que el agente consultará (IA-3/IA-5).
import { prisma } from '../db.js';

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
export async function listKnowledge(propertyId, { visibility = null, activeOnly = true } = {}) {
  const where = { propertyId };
  if (visibility) where.visibility = visibility;
  if (activeOnly) where.active = true;
  return prisma.knowledgeItem.findMany({ where, orderBy: [{ category: 'asc' }, { title: 'asc' }] });
}

// Snapshot de conocimiento que consumirá el agente (IA-3): contenido de
// habitaciones + ítems de conocimiento según el ámbito permitido del agente.
export async function knowledgeSnapshot(propertyId, { visibility = 'public' } = {}) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  const rooms = await roomsContent(propertyId);
  const items = await listKnowledge(propertyId, {
    visibility: visibility === 'internal' ? null : 'public', // interno ve todo; externo solo público
  });
  const policies = await prisma.hotelPolicy.findMany({ where: { propertyId, active: true } });
  return {
    hotel: {
      name: property?.name, city: property?.city, address: property?.address,
      checkInTime: property?.checkInTime, checkOutTime: property?.checkOutTime,
      currency: property?.currency,
    },
    rooms,
    knowledge: items.map(i => ({ category: i.category, title: i.title, content: i.content, tags: i.tags })),
    policies: policies.map(p => ({ type: p.type, title: p.title, text: p.publicText || p.conditions })),
  };
}
