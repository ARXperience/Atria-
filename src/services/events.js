// Eventos & corporativo (§33): salones, cotización de eventos y montajes.
// Evita el doble-uso de un salón el mismo día (choque de eventos confirmados)
// y calcula la propuesta económica (salón + catering + extras + IVA).
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { audit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';

const SETUPS = ['auditorio', 'escuela', 'banquete', 'coctel', 'u'];
const DURATIONS = ['full', 'half', 'hourly'];
let evSeq = 1000;

function eventCode() {
  evSeq = (evSeq + 1) % 1000000;
  return `EVT-${new Date().getUTCFullYear()}-${String(evSeq).padStart(6, '0')}`;
}

export async function listVenues(propertyId, { activeOnly = false } = {}) {
  const where = { propertyId };
  if (activeOnly) where.active = true;
  return prisma.venue.findMany({ where, orderBy: { name: 'asc' } });
}

export async function createVenue({ propertyId, name, capacity = 0, halfDayRate = 0, fullDayRate = 0, hourlyRate = 0, amenities = null }) {
  if (!name) throw new Error('name requerido');
  return prisma.venue.create({ data: { propertyId, name, capacity: +capacity, halfDayRate: money(halfDayRate), fullDayRate: money(fullDayRate), hourlyRate: money(hourlyRate), amenities } });
}

function dayBounds(date) {
  const d = new Date(date);
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  return { start, end: new Date(start.getTime() + 86400000) };
}

// ¿El salón está libre esa fecha? (choque con eventos confirmados/en curso)
export async function venueAvailable(venueId, date, { excludeId = null } = {}) {
  const { start, end } = dayBounds(date);
  const where = { venueId, date: { gte: start, lt: end }, status: { in: ['confirmed', 'in_progress'] } };
  if (excludeId) where.id = { not: excludeId };
  const clash = await prisma.eventBooking.count({ where });
  return clash === 0;
}

// Cotización: salón según duración + catering por persona + extras + IVA.
export function quoteEvent(venue, { durationType = 'full', hours = 0, attendees = 0, cateringPerPerson = 0, extras = 0, taxRate = 0.19 }) {
  if (!DURATIONS.includes(durationType)) throw new Error(`durationType inválido (${DURATIONS.join(', ')})`);
  let venueFee = 0;
  if (durationType === 'full') venueFee = venue.fullDayRate;
  else if (durationType === 'half') venueFee = venue.halfDayRate;
  else venueFee = venue.hourlyRate * Math.max(1, +hours);
  const cateringTotal = money((+cateringPerPerson || 0) * (+attendees || 0));
  const ex = money(+extras || 0);
  const subtotal = money(venueFee + cateringTotal + ex);
  const taxes = money(subtotal * taxRate);
  const total = money(subtotal + taxes);
  return { venueFee: money(venueFee), cateringTotal, extras: ex, subtotal, taxes, total, deposit: money(total * 0.5) };
}

export async function createEvent(data) {
  const { propertyId, venueId, clientName, date } = data;
  if (!clientName) throw new Error('clientName requerido');
  if (!date) throw new Error('date requerida');
  const venue = await prisma.venue.findUnique({ where: { id: venueId } });
  if (!venue || venue.propertyId !== propertyId) throw new Error('Salón no encontrado en esta sede');
  if (data.attendees && venue.capacity && +data.attendees > venue.capacity) {
    throw new Error(`El salón ${venue.name} admite ${venue.capacity} personas (solicitaste ${data.attendees})`);
  }
  const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { taxRate: true } });
  const q = quoteEvent(venue, { ...data, taxRate: prop?.taxRate ?? 0.19 });
  return prisma.eventBooking.create({
    data: {
      code: eventCode(), propertyId, venueId, leadId: data.leadId || null,
      clientName, clientContact: data.clientContact || null,
      eventType: data.eventType || 'corporativo',
      date: new Date(date), startTime: data.startTime || '08:00', endTime: data.endTime || '17:00',
      attendees: +data.attendees || 0, setup: SETUPS.includes(data.setup) ? data.setup : 'auditorio',
      durationType: data.durationType || 'full', hours: +data.hours || 0,
      cateringPerPerson: money(data.cateringPerPerson || 0), extrasNote: data.extrasNote || null,
      ...q, notes: data.notes || null, createdBy: data.createdBy || null,
    },
  });
}

export async function confirmEvent(id, { user } = {}) {
  const ev = await prisma.eventBooking.findUnique({ where: { id } });
  if (!ev) throw new Error('Evento no encontrado');
  if (ev.status === 'cancelled') throw new Error('El evento está cancelado');
  if (!(await venueAvailable(ev.venueId, ev.date, { excludeId: ev.id }))) {
    throw new Error('El salón ya está reservado por otro evento en esa fecha');
  }
  const updated = await prisma.eventBooking.update({ where: { id }, data: { status: 'confirmed' } });
  await audit({ propertyId: ev.propertyId, user, action: 'event.confirmed', entity: 'EventBooking', entityId: id, after: { code: ev.code, total: ev.total } });
  emitEvent('event.confirmed', { propertyId: ev.propertyId, entityId: ev.id, code: ev.code, total: ev.total });
  return updated;
}

export async function setEventStatus(id, status, { user } = {}) {
  const allowed = ['quote', 'confirmed', 'in_progress', 'completed', 'cancelled'];
  if (!allowed.includes(status)) throw new Error('estado inválido');
  const ev = await prisma.eventBooking.findUnique({ where: { id } });
  if (!ev) throw new Error('Evento no encontrado');
  if (status === 'confirmed') return confirmEvent(id, { user });
  const updated = await prisma.eventBooking.update({ where: { id }, data: { status } });
  await audit({ propertyId: ev.propertyId, user, action: `event.${status}`, entity: 'EventBooking', entityId: id, after: { code: ev.code } });
  return updated;
}

export async function eventsOverview(propertyId) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [venues, events] = await Promise.all([
    prisma.venue.count({ where: { propertyId, active: true } }),
    prisma.eventBooking.findMany({ where: { propertyId }, orderBy: { date: 'asc' }, take: 200 }),
  ]);
  const upcoming = events.filter(e => e.date >= now && ['quote', 'confirmed', 'in_progress'].includes(e.status));
  const pipeline = events.filter(e => e.status === 'quote').reduce((s, e) => s + e.total, 0);
  const confirmed = events.filter(e => e.status === 'confirmed').length;
  const monthRevenue = events.filter(e => e.status === 'completed' && e.date >= monthStart).reduce((s, e) => s + e.total, 0);
  return {
    venues, confirmed,
    pipeline: money(pipeline), monthRevenue: money(monthRevenue),
    upcomingCount: upcoming.length,
    events: events.slice().sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 60),
  };
}
