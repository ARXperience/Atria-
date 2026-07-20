// Ciclo de vida de la reserva: tentativa → confirmada → check-in → check-out
// (flujos críticos de la sección 48 del documento funcional).
import { prisma } from '../db.js';
import { config } from '../config.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { buildQuote } from './quote.js';
import { findAvailability } from './availability.js';
import { reservationCode, money } from '../lib/util.js';

export async function upsertGuest({ propertyId, fullName, phone = null, email = null, documentType = null, documentNumber = null, nationality = 'CO' }) {
  let guest = null;
  if (phone) guest = await prisma.guest.findFirst({ where: { propertyId, phone } });
  if (!guest && documentNumber) guest = await prisma.guest.findFirst({ where: { propertyId, documentNumber } });
  if (!guest && email) guest = await prisma.guest.findFirst({ where: { propertyId, email } });
  if (guest) {
    return prisma.guest.update({
      where: { id: guest.id },
      data: {
        fullName: fullName || guest.fullName,
        phone: phone || guest.phone,
        email: email || guest.email,
        documentType: documentType || guest.documentType,
        documentNumber: documentNumber || guest.documentNumber,
        nationality: nationality || guest.nationality,
      },
    });
  }
  return prisma.guest.create({ data: { propertyId, fullName, phone, email, documentType, documentNumber, nationality } });
}

export async function createTentativeReservation({
  propertyId, guest, roomTypeId, ratePlanId = null, checkIn, checkOut,
  adults = 2, children = 0, channel = 'direct', createdBy = null, actor = 'human', notes = null,
  discountPct = 0, corporateAccountId = null,
}) {
  // Revalidar disponibilidad para evitar sobreventa
  const availability = await findAvailability({ propertyId, checkIn, checkOut, adults, children });
  const option = availability.find(a => a.roomTypeId === roomTypeId);
  if (!option) throw new Error('No hay disponibilidad para el tipo de habitación en esas fechas');

  const quote = await buildQuote({ propertyId, roomTypeId, ratePlanId, checkIn, checkOut });
  const guestRecord = await upsertGuest({ propertyId, ...guest });

  // Descuento negociado (cuenta corporativa / agencia): rebaja la tarifa y recalcula.
  const pct = Math.min(Math.max(Number(discountPct) || 0, 0), 0.9);
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  const nightlyRate = money(quote.nightlyRate * (1 - pct));
  const subtotal = money(nightlyRate * quote.nights);
  const taxes = money(subtotal * (property?.taxRate || 0));
  const total = money(subtotal + taxes);
  const depositRequired = money(total * quote.depositPct);

  const holdExpiresAt = new Date(Date.now() + config.tentativeHoldHours * 3600000);
  const reservation = await prisma.reservation.create({
    data: {
      code: reservationCode(),
      propertyId, guestId: guestRecord.id, roomTypeId,
      ratePlanId: quote.ratePlanId,
      checkIn, checkOut, adults, children,
      nights: quote.nights, nightlyRate,
      subtotal, taxes, total,
      depositRequired,
      channel, status: 'tentative', holdExpiresAt, createdBy, notes,
      corporateAccountId: corporateAccountId || null,
    },
    include: { guest: true },
  });

  await audit({ propertyId, actor, action: 'reservation.tentative_created', entity: 'Reservation', entityId: reservation.id, after: { code: reservation.code, total: reservation.total } });
  emitEvent('reservation.tentative_created', { propertyId, reservationId: reservation.id, code: reservation.code });
  return reservation;
}

export async function confirmReservation(reservationId, { actor = 'system', user = null } = {}) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { guest: true, property: true } });
  if (!reservation) throw new Error('Reserva no encontrada');
  if (['confirmed', 'checked_in', 'checked_out'].includes(reservation.status)) return reservation;
  if (['cancelled', 'no_show'].includes(reservation.status)) throw new Error(`La reserva está ${reservation.status}`);

  const updated = await prisma.reservation.update({
    where: { id: reservationId },
    data: { status: 'confirmed', holdExpiresAt: null },
    include: { guest: true, property: true },
  });

  await audit({ propertyId: reservation.propertyId, user, actor, action: 'reservation.confirmed', entity: 'Reservation', entityId: reservationId, before: { status: reservation.status }, after: { status: 'confirmed' } });
  emitEvent('reservation.confirmed', { propertyId: reservation.propertyId, reservationId, code: reservation.code });
  return updated;
}

export async function cancelReservation(reservationId, { reason = null, actor = 'human', user = null } = {}) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!reservation) throw new Error('Reserva no encontrada');
  if (['checked_in', 'checked_out'].includes(reservation.status)) throw new Error('No se puede cancelar una estadía en curso o cerrada');
  const updated = await prisma.reservation.update({ where: { id: reservationId }, data: { status: 'cancelled', notes: reason ? `${reservation.notes || ''}\nCancelación: ${reason}`.trim() : reservation.notes } });
  await audit({ propertyId: reservation.propertyId, user, actor, action: 'reservation.cancelled', entity: 'Reservation', entityId: reservationId, before: { status: reservation.status }, after: { status: 'cancelled' }, reason });
  emitEvent('reservation.cancelled', { propertyId: reservation.propertyId, reservationId });
  return updated;
}

// Check-in (sección 11): valida pago mínimo, TRA y asigna habitación.
export async function checkIn(reservationId, { roomId = null, user = null, overrideDeposit = false } = {}) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { guest: true, payments: true, traRecords: true },
  });
  if (!reservation) throw new Error('Reserva no encontrada');
  if (reservation.status === 'checked_in') return reservation;
  if (!['confirmed', 'tentative'].includes(reservation.status)) throw new Error(`No se puede hacer check-in de una reserva ${reservation.status}`);

  const paid = reservation.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0);
  if (paid < reservation.depositRequired && !overrideDeposit) {
    throw new Error(`Pago insuficiente para check-in: pagado ${paid} de anticipo requerido ${reservation.depositRequired}. Requiere aprobación de gerente (overrideDeposit).`);
  }

  // Asignación de habitación
  let room;
  if (roomId) {
    room = await prisma.room.findUnique({ where: { id: roomId } });
    if (!room || room.roomTypeId !== reservation.roomTypeId) throw new Error('Habitación inválida para el tipo reservado');
    if (room.status === 'out_of_service') throw new Error('Habitación fuera de servicio');
  } else {
    const { findAvailability } = await import('./availability.js');
    const availability = await findAvailability({ propertyId: reservation.propertyId, checkIn: reservation.checkIn, checkOut: reservation.checkOut, adults: reservation.adults, children: reservation.children });
    const option = availability.find(a => a.roomTypeId === reservation.roomTypeId);
    const freeId = option?.freeRoomIds?.[0];
    if (!freeId) throw new Error('No hay habitación libre para asignar');
    room = await prisma.room.findUnique({ where: { id: freeId } });
  }

  const updated = await prisma.$transaction(async tx => {
    const r = await tx.reservation.update({
      where: { id: reservationId },
      data: { status: 'checked_in', roomId: room.id },
      include: { guest: true },
    });
    await tx.room.update({ where: { id: room.id }, data: { status: 'occupied' } });
    await tx.folio.upsert({
      where: { reservationId },
      create: {
        reservationId,
        charges: { create: { concept: 'alojamiento', description: `${r.nights} noche(s) x ${r.nightlyRate}`, amount: r.subtotal, taxAmount: r.taxes, postedBy: user?.name || 'sistema' } },
      },
      update: {},
    });
    return r;
  });

  await audit({ propertyId: reservation.propertyId, user, action: 'checkin.completed', entity: 'Reservation', entityId: reservationId, after: { room: room.number } });
  emitEvent('checkin.completed', { propertyId: reservation.propertyId, reservationId, roomId: room.id });
  emitEvent('room.status_changed', { propertyId: reservation.propertyId, roomId: room.id, status: 'occupied' });
  return updated;
}

// Check-out (sección 11 y 48): valida saldo, cierra folio, habitación a sucia,
// crea tarea de limpieza y dispara encuesta.
export async function checkOut(reservationId, { user = null, allowBalance = false } = {}) {
  const reservation = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { folio: { include: { charges: true } }, payments: true, room: true },
  });
  if (!reservation) throw new Error('Reserva no encontrada');
  if (reservation.status !== 'checked_in') throw new Error('La reserva no está en check-in');

  const charges = (reservation.folio?.charges || []).filter(c => !c.voided);
  const totalCharges = charges.reduce((s, c) => s + c.amount + c.taxAmount, 0);
  const paid = reservation.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0);
  const balance = totalCharges - paid;
  if (balance > 0 && !allowBalance) {
    throw new Error(`Saldo pendiente de ${balance}. Cobre el saldo o solicite aprobación de gerente (allowBalance).`);
  }

  const updated = await prisma.$transaction(async tx => {
    const r = await tx.reservation.update({ where: { id: reservationId }, data: { status: 'checked_out' } });
    if (reservation.folio) {
      await tx.folio.update({ where: { id: reservation.folio.id }, data: { status: 'closed', closedAt: new Date() } });
    }
    if (reservation.roomId) {
      await tx.room.update({ where: { id: reservation.roomId }, data: { status: 'dirty' } });
    }
    return r;
  });

  await audit({ propertyId: reservation.propertyId, user, action: 'checkout.completed', entity: 'Reservation', entityId: reservationId, after: { balance } });
  emitEvent('checkout.completed', { propertyId: reservation.propertyId, reservationId, roomId: reservation.roomId, balance });
  if (reservation.roomId) emitEvent('room.status_changed', { propertyId: reservation.propertyId, roomId: reservation.roomId, status: 'dirty' });
  return { reservation: updated, balance, totalCharges, paid };
}

// Job: expira reservas tentativas vencidas (recuperación de abandono, sección 10)
export async function expireStaleTentatives() {
  const now = new Date();
  const stale = await prisma.reservation.findMany({ where: { status: 'tentative', holdExpiresAt: { lt: now } } });
  for (const r of stale) {
    await prisma.reservation.update({ where: { id: r.id }, data: { status: 'expired' } });
    await audit({ propertyId: r.propertyId, actor: 'system', action: 'reservation.expired', entity: 'Reservation', entityId: r.id });
    emitEvent('booking.abandoned', { propertyId: r.propertyId, reservationId: r.id, code: r.code });
  }
  return stale.length;
}
