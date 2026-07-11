// Automatizador de procesos (sección 40): reacciones automáticas a eventos
// de dominio. Solo acciones de bajo riesgo son automáticas (matriz 47).
import { bus } from '../lib/events.js';
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import { notify } from './notifications.js';
import { ensureTraForReservation } from './compliance.js';
import { fmtCOP, dayStr } from '../lib/util.js';

async function sendToGuest(propertyId, reservationId, text) {
  // Envía mensaje por la conversación de WhatsApp/webchat asociada al huésped
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { guest: true } });
  if (!reservation?.guest?.phone) return false;
  const conversation = await prisma.conversation.findFirst({
    where: { propertyId, contactPhone: reservation.guest.phone },
    orderBy: { lastMessageAt: 'desc' },
  });
  if (!conversation) return false;
  const { sendOutbound } = await import('./inbox.js');
  await sendOutbound(conversation.id, text, { sender: 'ai' });
  return true;
}

export function registerAutomations() {
  // Check-out → tarea de limpieza + encuesta (flujo 48.3)
  bus.on('checkout.completed', async ({ propertyId, reservationId, roomId }) => {
    try {
      if (roomId) {
        await prisma.housekeepingTask.create({
          data: { propertyId, roomId, type: 'checkout_clean', priority: 'high', notes: `Post check-out reserva ${reservationId}` },
        });
      }
      await sendToGuest(propertyId, reservationId,
        '¡Gracias por hospedarte con nosotros! 🌟 ¿Cómo calificarías tu estadía de 1 a 5? Tu opinión nos ayuda a mejorar.');
    } catch (err) { logger.error({ err }, 'automation checkout failed'); }
  });

  // Reserva confirmada → TRA/SIRE + voucher + notificación a recepción (flujo 48.1)
  bus.on('reservation.confirmed', async ({ propertyId, reservationId }) => {
    try {
      await ensureTraForReservation(reservationId);
      const r = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { guest: true, property: true } });
      if (r) {
        await notify({
          propertyId, audienceRole: 'FRONTDESK', title: `Reserva confirmada ${r.code}`,
          body: `${r.guest.fullName} · ${dayStr(r.checkIn)} → ${dayStr(r.checkOut)} · ${fmtCOP(r.total)}`,
          entity: 'Reservation', entityId: reservationId,
        });
        await sendToGuest(propertyId, reservationId,
          `✅ ¡Tu reserva está confirmada!\n\n📄 Voucher ${r.code}\n🏨 ${r.property.name}\n📅 Llegada: ${dayStr(r.checkIn)} (${r.property.checkInTime})\n📅 Salida: ${dayStr(r.checkOut)} (${r.property.checkOutTime})\n👥 ${r.adults} adulto(s)${r.children ? `, ${r.children} niño(s)` : ''}\n💰 Total: ${fmtCOP(r.total)}\n\nAntes de tu llegada te pediremos los datos de registro. ¡Te esperamos!`);
      }
    } catch (err) { logger.error({ err }, 'automation confirm failed'); }
  });

  // Pago recibido → notificación a contabilidad
  bus.on('payment.succeeded', async ({ propertyId, reservationId, amount }) => {
    try {
      await notify({
        propertyId, audienceRole: 'ACCOUNTING', title: 'Pago recibido',
        body: `Pago de ${fmtCOP(amount)}${reservationId ? ' aplicado a reserva' : ''}`,
        entity: 'Reservation', entityId: reservationId || null,
      });
    } catch (err) { logger.error({ err }, 'automation payment failed'); }
  });

  // Reserva tentativa vencida → seguimiento de recuperación (sección 10)
  bus.on('booking.abandoned', async ({ propertyId, reservationId, code }) => {
    try {
      await notify({
        propertyId, audienceRole: 'SALES', severity: 'warning',
        title: `Reserva ${code || ''} venció sin pago`,
        body: 'Oportunidad de recuperación: contactar al cliente.',
        entity: 'Reservation', entityId: reservationId,
      });
      await sendToGuest(propertyId, reservationId,
        'Hola 👋 Notamos que tu reserva quedó pendiente de pago y el bloqueo venció. ¿Quieres que la retomemos? Con gusto verifico disponibilidad de nuevo.');
    } catch (err) { logger.error({ err }, 'automation abandonment failed'); }
  });

  // Huésped extranjero → alerta SIRE a recepción
  bus.on('foreign_guest.detected', async ({ propertyId, reservationId }) => {
    try {
      await notify({
        propertyId, audienceRole: 'FRONTDESK', severity: 'warning',
        title: 'Huésped extranjero: reporte SIRE pendiente',
        body: 'Preparar reporte SIRE de Migración Colombia para esta reserva.',
        entity: 'Reservation', entityId: reservationId,
      });
    } catch (err) { logger.error({ err }, 'automation sire failed'); }
  });

  // Transferencia a humano solicitada
  bus.on('human_takeover.requested', async ({ propertyId, conversationId, reason }) => {
    try {
      await notify({
        propertyId, audienceRole: 'FRONTDESK', severity: 'critical',
        title: 'Conversación requiere atención humana',
        body: reason || 'El huésped pidió hablar con una persona.',
        entity: 'Conversation', entityId: conversationId,
      });
    } catch (err) { logger.error({ err }, 'automation takeover failed'); }
  });

  logger.info('automations registered');
}
