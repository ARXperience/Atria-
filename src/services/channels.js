// Channel manager (§35): sincroniza disponibilidad/tarifas con OTAs y recibe
// reservas externas. La conexión real a cada OTA se hace en el punto de
// integración (push*/pull*); aquí queda la arquitectura completa: mapeos, logs,
// recepción de reservas y detección de overbooking.
import { prisma } from '../db.js';
import { findAvailability } from './availability.js';
import { buildQuote } from './quote.js';
import { upsertGuest } from './reservations.js';
import { notify } from './notifications.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { parseDay, reservationCode, money } from '../lib/util.js';

async function log(propertyId, channelId, action, status, detail) {
  return prisma.channelSyncLog.create({ data: { propertyId, channelId, action, status, detail } });
}

// Empuja disponibilidad y tarifas a la OTA (simulado; punto de integración real).
export async function syncChannel(channelId, { user } = {}) {
  const channel = await prisma.channel.findUnique({ where: { id: channelId }, include: { mappings: { where: { active: true } } } });
  if (!channel) throw new Error('Canal no encontrado');
  if (!channel.enabled) throw new Error('El canal está deshabilitado');
  if (!channel.mappings.length) throw new Error('El canal no tiene tipos de habitación mapeados');

  // Aquí un conector real llamaría a la API de la OTA con inventario y tarifas.
  await log(channel.propertyId, channelId, 'push_availability', 'ok', `${channel.mappings.length} tipo(s) sincronizado(s)`);
  await log(channel.propertyId, channelId, 'push_rates', 'ok', 'Tarifas publicadas');
  const updated = await prisma.channel.update({ where: { id: channelId }, data: { status: 'connected', lastSyncAt: new Date() } });
  await audit({ propertyId: channel.propertyId, user, action: 'channel.sync', entity: 'Channel', entityId: channelId });
  emitEvent('channel.sync_started', { propertyId: channel.propertyId, entityId: channelId });
  return updated;
}

// Recibe una reserva desde una OTA (webhook). Detecta overbooking.
export async function receiveChannelReservation({ propertyId, channelCode, payload }) {
  const channel = await prisma.channel.findUnique({ where: { propertyId_code: { propertyId, code: channelCode } }, include: { mappings: true } });
  if (!channel) throw new Error('Canal no configurado');
  const ci = parseDay(payload.checkIn), co = parseDay(payload.checkOut);
  if (!ci || !co || co <= ci) throw new Error('Fechas inválidas en la reserva del canal');

  // Mapear código externo → tipo interno
  const mapping = channel.mappings.find(m => m.externalCode === payload.externalCode && m.active);
  if (!mapping) {
    await log(propertyId, channel.id, 'error', 'error', `Sin mapeo para código externo ${payload.externalCode}`);
    emitEvent('channel.sync_failed', { propertyId, entityId: channel.id });
    throw new Error(`No hay mapeo para el código externo "${payload.externalCode}"`);
  }

  // Detección de overbooking
  const availability = await findAvailability({ propertyId, checkIn: ci, checkOut: co, adults: +payload.adults || 2 });
  const option = availability.find(a => a.roomTypeId === mapping.roomTypeId);
  const overbooking = !option;

  const quote = await buildQuote({ propertyId, roomTypeId: mapping.roomTypeId, checkIn: ci, checkOut: co });
  const guest = await upsertGuest({ propertyId, fullName: payload.guestName || 'Huésped OTA', email: payload.email || null, phone: payload.phone || null });
  const total = payload.total != null ? money(+payload.total) : quote.total;

  const reservation = await prisma.reservation.create({
    data: {
      code: reservationCode(), propertyId, guestId: guest.id, roomTypeId: mapping.roomTypeId,
      checkIn: ci, checkOut: co, adults: +payload.adults || 2, children: +payload.children || 0,
      nights: quote.nights, nightlyRate: quote.nightlyRate, subtotal: quote.subtotal, taxes: quote.taxes,
      total, depositRequired: 0, channel: 'ota', channelRef: payload.ref || null,
      status: 'confirmed', createdBy: `channel:${channelCode}`,
      notes: `Reserva ${channel.name}${payload.ref ? ` (${payload.ref})` : ''}`,
    },
    include: { guest: true },
  });

  await log(propertyId, channel.id, 'reservation_received', overbooking ? 'warning' : 'ok', `${reservation.code} — ${channel.name}${overbooking ? ' (overbooking)' : ''}`);
  await audit({ propertyId, actor: 'system', action: 'channel.reservation_received', entity: 'Reservation', entityId: reservation.id, after: { channel: channelCode, code: reservation.code, overbooking } });
  emitEvent('channel.reservation_received', { propertyId, reservationId: reservation.id });

  if (overbooking) {
    await log(propertyId, channel.id, 'overbooking', 'warning', `Sobreventa detectada en ${reservation.code}`);
    await notify({ propertyId, audienceRole: 'MANAGER', severity: 'critical', title: `⚠ Riesgo de overbooking (${channel.name})`, body: `La reserva ${reservation.code} del canal excede la disponibilidad para esas fechas. Revisa y reubica.`, entity: 'Reservation', entityId: reservation.id });
    emitEvent('overbooking_risk.detected', { propertyId, reservationId: reservation.id });
  }
  return { reservation, overbooking };
}

export async function channelsOverview(propertyId) {
  const channels = await prisma.channel.findMany({ where: { propertyId }, include: { _count: { select: { mappings: true } } } });
  const otaReservations = await prisma.reservation.count({ where: { propertyId, channel: 'ota' } });
  const recentOverbooking = await prisma.channelSyncLog.count({ where: { propertyId, action: 'overbooking', createdAt: { gte: new Date(Date.now() - 7 * 86400000) } } });
  return { channels: channels.length, connected: channels.filter(c => c.enabled).length, otaReservations, recentOverbooking };
}
