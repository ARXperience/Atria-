// Segmentos dinámicos de huéspedes (§12/§36). Un segmento es un conjunto de
// criterios reutilizables que se evalúan en el momento para marketing/CRM.
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { audit } from '../lib/audit.js';

const DAY = 86400_000;
const STAY_STATUSES = ['checked_out', 'checked_in', 'confirmed'];

// Agregados por huésped: número de estadías, última estadía y gasto acumulado.
async function guestAggregates(propertyId) {
  const reservations = await prisma.reservation.findMany({
    where: { propertyId, status: { in: STAY_STATUSES } },
    select: { guestId: true, checkOut: true, total: true },
    take: 20000,
  });
  const map = new Map();
  for (const r of reservations) {
    const a = map.get(r.guestId) || { stays: 0, lastStay: null, spend: 0 };
    a.stays += 1;
    a.spend += r.total;
    if (!a.lastStay || r.checkOut > a.lastStay) a.lastStay = r.checkOut;
    map.set(r.guestId, a);
  }
  return map;
}

export function parseCriteria(criteria) {
  if (!criteria) return {};
  if (typeof criteria === 'object') return criteria;
  try { return JSON.parse(criteria); } catch { return {}; }
}

// Evalúa un conjunto de criterios y devuelve los huéspedes que lo cumplen.
export async function evaluateCriteria(propertyId, criteria) {
  const c = parseCriteria(criteria);
  const guests = await prisma.guest.findMany({ where: { propertyId }, take: 20000 });
  const agg = await guestAggregates(propertyId);
  const now = Date.now();
  const matched = guests.filter((g) => {
    const a = agg.get(g.id) || { stays: 0, lastStay: null, spend: 0 };
    if (c.marketingConsent === true && !g.marketingConsent) return false;
    if (c.city && String(g.city || '').toLowerCase() !== String(c.city).toLowerCase()) return false;
    if (c.nationality && String(g.nationality || '').toUpperCase() !== String(c.nationality).toUpperCase()) return false;
    if (c.language && String(g.language || '').toLowerCase() !== String(c.language).toLowerCase()) return false;
    if (c.minStays != null && a.stays < c.minStays) return false;
    if (c.minSpend != null && a.spend < c.minSpend) return false;
    if (c.lastStayWithinDays != null) {
      if (!a.lastStay || (now - a.lastStay.getTime()) > c.lastStayWithinDays * DAY) return false;
    }
    if (c.inactiveDays != null) {
      // Sin estadías o con última estadía anterior a N días (win-back).
      if (a.lastStay && (now - a.lastStay.getTime()) < c.inactiveDays * DAY) return false;
    }
    return true;
  });
  return matched.map((g) => {
    const a = agg.get(g.id) || { stays: 0, lastStay: null, spend: 0 };
    return { id: g.id, fullName: g.fullName, email: g.email, phone: g.phone, city: g.city, marketingConsent: g.marketingConsent, stays: a.stays, spend: money(a.spend), lastStay: a.lastStay };
  });
}

// ---- CRUD de segmentos guardados ----
export async function createSegment({ propertyId, name, description = null, criteria = {}, user = null }) {
  if (!name) throw new Error('El segmento requiere un nombre');
  const seg = await prisma.guestSegment.create({
    data: { propertyId, name, description, criteria: JSON.stringify(parseCriteria(criteria)), createdBy: user?.name || null },
  });
  await audit({ propertyId, user, action: 'crm.segment_created', entity: 'GuestSegment', entityId: seg.id, after: { name } });
  return seg;
}

export async function updateSegment(id, { user = null, ...fields }) {
  const seg = await prisma.guestSegment.findUnique({ where: { id } });
  if (!seg) throw new Error('Segmento no encontrado');
  const data = {};
  if (fields.name !== undefined) data.name = fields.name;
  if (fields.description !== undefined) data.description = fields.description;
  if (fields.criteria !== undefined) data.criteria = JSON.stringify(parseCriteria(fields.criteria));
  const updated = await prisma.guestSegment.update({ where: { id }, data });
  await audit({ propertyId: seg.propertyId, user, action: 'crm.segment_updated', entity: 'GuestSegment', entityId: id, after: data });
  return updated;
}

export async function deleteSegment(id, { user = null } = {}) {
  const seg = await prisma.guestSegment.findUnique({ where: { id } });
  if (!seg) throw new Error('Segmento no encontrado');
  await prisma.guestSegment.delete({ where: { id } });
  await audit({ propertyId: seg.propertyId, user, action: 'crm.segment_deleted', entity: 'GuestSegment', entityId: id });
  return { deleted: true };
}

// Lista los segmentos con su conteo actual de huéspedes.
export async function listSegments(propertyId) {
  const segments = await prisma.guestSegment.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 100 });
  const out = [];
  for (const s of segments) {
    const matched = await evaluateCriteria(propertyId, s.criteria);
    out.push({ ...s, criteria: parseCriteria(s.criteria), count: matched.length });
  }
  return out;
}

export async function getSegmentMembers(id) {
  const seg = await prisma.guestSegment.findUnique({ where: { id } });
  if (!seg) throw new Error('Segmento no encontrado');
  const members = await evaluateCriteria(seg.propertyId, seg.criteria);
  return { segment: { ...seg, criteria: parseCriteria(seg.criteria) }, members, count: members.length };
}
