// Portal del huésped (§14) y check-in digital (§48.2). Operaciones que el
// huésped ejecuta con el código de su reserva (sin autenticación de panel).
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { notify } from './notifications.js';
import { ensureTraForReservation } from './compliance.js';
import { createPaymentLink } from './payments.js';

const REQUEST_TYPES = ['cleaning', 'towels', 'amenities', 'room_service', 'maintenance', 'checkout', 'other'];

async function reservationByCode(code) {
  const r = await prisma.reservation.findUnique({ where: { code }, include: { guest: true, room: true, payments: true } });
  if (!r) throw new Error('Reserva no encontrada');
  return r;
}

function balanceOf(r) {
  const paid = r.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0)
    - r.payments.filter(p => p.status === 'approved' && p.kind === 'refund').reduce((s, p) => s + p.amount, 0);
  return Math.round(r.total - paid);
}

// Pre-check-in: el huésped completa sus datos y acepta políticas antes de llegar.
export async function submitPrecheckin(code, data = {}) {
  const r = await reservationByCode(code);
  if (['cancelled', 'expired', 'checked_out'].includes(r.status)) throw new Error('Esta reserva no admite pre-check-in.');
  if (!data.acceptPolicies) throw new Error('Debes aceptar las políticas y el tratamiento de datos para continuar.');

  // Actualiza la ficha del huésped con lo aportado.
  const guestData = {};
  for (const [k, field] of [['documentType', 'documentType'], ['documentNumber', 'documentNumber'], ['nationality', 'nationality'], ['email', 'email'], ['phone', 'phone']]) {
    if (data[field]) guestData[k] = String(data[field]).trim();
  }
  if (Object.keys(guestData).length) await prisma.guest.update({ where: { id: r.guestId }, data: guestData });

  const companions = Array.isArray(data.companions) ? data.companions.slice(0, 20) : [];
  await prisma.reservation.update({
    where: { id: r.id },
    data: {
      precheckinAt: new Date(),
      arrivalTime: data.arrivalTime || null,
      precheckinData: JSON.stringify({ companions, acceptedPolicies: true, acceptedAt: new Date().toISOString() }),
    },
  });

  // Registra consentimiento de tratamiento de datos y asegura la TRA.
  await prisma.dataConsent.create({
    data: { propertyId: r.propertyId, subjectType: 'guest', subjectId: r.guestId, subjectName: r.guest.fullName, documentNumber: guestData.documentNumber || r.guest.documentNumber, purpose: 'tratamiento', channel: 'web', granted: true, source: `pre-check-in ${r.code}` },
  }).catch(() => {});
  await ensureTraForReservation(r.id).catch(() => {});

  await notify({ propertyId: r.propertyId, audienceRole: 'FRONTDESK', title: `Pre-check-in listo · ${r.code}`, body: `${r.guest.fullName} completó su registro${data.arrivalTime ? ` · llega ${data.arrivalTime}` : ''}${companions.length ? ` · ${companions.length} acompañante(s)` : ''}.`, entity: 'Reservation', entityId: r.id });
  emitEvent('precheckin.completed', { propertyId: r.propertyId, reservationId: r.id, code: r.code });
  return { ok: true, arrivalTime: data.arrivalTime || null, companions: companions.length };
}

// Solicitud de servicio → tarea/alerta interna.
export async function createGuestRequest(code, { type, detail }) {
  const r = await reservationByCode(code);
  if (!REQUEST_TYPES.includes(type)) throw new Error(`Tipo inválido (${REQUEST_TYPES.join(', ')})`);
  const req = await prisma.guestRequest.create({
    data: { propertyId: r.propertyId, reservationId: r.id, guestName: r.guest.fullName, roomNumber: r.room?.number || null, type, detail: detail ? String(detail).slice(0, 500) : null },
  });
  // Enruta al área correspondiente.
  const role = type === 'maintenance' ? 'MAINTENANCE' : type === 'cleaning' ? 'HOUSEKEEPING' : 'FRONTDESK';
  await notify({ propertyId: r.propertyId, audienceRole: role, severity: type === 'maintenance' ? 'warning' : 'info', title: `Solicitud de huésped · Hab ${r.room?.number || '—'}`, body: `${r.guest.fullName}: ${type}${detail ? ` — ${detail}` : ''}`, entity: 'GuestRequest', entityId: req.id });
  // Si es limpieza y hay habitación, crea tarea de housekeeping.
  if (type === 'cleaning' && r.roomId) {
    await prisma.housekeepingTask.create({ data: { propertyId: r.propertyId, roomId: r.roomId, type: 'request', priority: 'normal', notes: `Solicitud del huésped: ${detail || 'limpieza'}` } }).catch(() => {});
  }
  emitEvent('guest_request.created', { propertyId: r.propertyId, reservationId: r.id, entityId: req.id, type });
  return req;
}

export async function listGuestRequests(code) {
  const r = await reservationByCode(code);
  return prisma.guestRequest.findMany({ where: { reservationId: r.id }, orderBy: { createdAt: 'desc' }, take: 30 });
}

// Genera un link de pago para el saldo pendiente.
export async function payBalanceLink(code) {
  const r = await reservationByCode(code);
  const balance = balanceOf(r);
  if (balance <= 0) throw new Error('No tienes saldo pendiente. 🎉');
  const link = await createPaymentLink({ propertyId: r.propertyId, reservationId: r.id, concept: `Saldo reserva ${r.code}`, amount: balance });
  return { paymentUrl: link.url, amount: balance };
}

// Check-out express: si no hay saldo, solicita el cierre; si hay, pide pagar.
export async function requestExpressCheckout(code) {
  const r = await reservationByCode(code);
  if (r.status !== 'checked_in') throw new Error('El check-out express solo está disponible durante la estadía.');
  const balance = balanceOf(r);
  if (balance > 0) return { needsPayment: true, balance };
  const req = await prisma.guestRequest.create({ data: { propertyId: r.propertyId, reservationId: r.id, guestName: r.guest.fullName, roomNumber: r.room?.number || null, type: 'checkout', detail: 'Check-out express solicitado desde el portal' } });
  await notify({ propertyId: r.propertyId, audienceRole: 'FRONTDESK', severity: 'warning', title: `Check-out express · Hab ${r.room?.number || '—'}`, body: `${r.guest.fullName} solicitó check-out express (sin saldo).`, entity: 'GuestRequest', entityId: req.id });
  emitEvent('express_checkout.requested', { propertyId: r.propertyId, reservationId: r.id, code: r.code });
  return { needsPayment: false, requested: true };
}
