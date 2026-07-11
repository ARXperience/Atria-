// Atria Pay (sección 15): links de pago, webhook de pasarela, pagos manuales
// con aprobación y reembolsos con aprobación.
import crypto from 'node:crypto';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { token } from '../lib/util.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { confirmReservation } from './reservations.js';

export async function createPaymentLink({ propertyId, reservationId = null, concept, amount, createdBy = null, expiresHours = 48 }) {
  if (!(amount > 0)) throw new Error('El valor del link debe ser mayor a cero');
  const link = await prisma.paymentLink.create({
    data: {
      propertyId, reservationId, concept, amount,
      token: token(18),
      provider: config.paymentProvider,
      expiresAt: new Date(Date.now() + expiresHours * 3600000),
      createdBy,
    },
  });
  await audit({ propertyId, action: 'payment_link.created', entity: 'PaymentLink', entityId: link.id, after: { amount, concept } });
  emitEvent('payment_link.created', { propertyId, reservationId, entityId: link.id });
  return { ...link, url: paymentLinkUrl(link) };
}

export function paymentLinkUrl(link) {
  return `${config.publicBaseUrl}/pay/${link.token}`;
}

// Aplica un pago aprobado: registra, marca link, confirma reserva si cubre anticipo.
export async function applyApprovedPayment({ paymentLink = null, reservationId = null, amount, method, provider, providerRef = null, registeredBy = null, actor = 'system' }) {
  const resId = reservationId || paymentLink?.reservationId || null;
  let propertyId = paymentLink?.propertyId;
  if (!propertyId && resId) {
    const r = await prisma.reservation.findUnique({ where: { id: resId } });
    propertyId = r?.propertyId;
  }
  if (!propertyId) throw new Error('No se pudo determinar la sede del pago');

  const payment = await prisma.payment.create({
    data: {
      propertyId, reservationId: resId,
      paymentLinkId: paymentLink?.id || null,
      amount, method, provider, providerRef,
      status: 'approved', kind: 'payment', registeredBy,
    },
  });

  if (paymentLink) {
    await prisma.paymentLink.update({ where: { id: paymentLink.id }, data: { status: 'paid', paidAt: new Date() } });
  }

  await audit({ propertyId, actor, action: 'payment.succeeded', entity: 'Payment', entityId: payment.id, after: { amount, method, providerRef } });
  emitEvent('payment.succeeded', { propertyId, reservationId: resId, entityId: payment.id, amount });

  // Confirmación automática si el pago cubre el anticipo (matriz 47: automático)
  if (resId) {
    const reservation = await prisma.reservation.findUnique({ where: { id: resId }, include: { payments: true } });
    if (reservation && reservation.status === 'tentative') {
      const paid = reservation.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0);
      if (paid >= reservation.depositRequired) {
        await confirmReservation(resId, { actor: 'system' });
      }
    }
  }
  return payment;
}

// Webhook del proveedor de pagos. Para Wompi valida firma de eventos.
export async function handleGatewayWebhook(providerName, body, headers = {}) {
  if (providerName === 'wompi') {
    const tx = body?.data?.transaction;
    if (!tx) throw new Error('Payload Wompi inválido');
    if (config.wompi.eventsSecret) {
      const props = body.signature?.properties || [];
      const values = props.map(p => p.split('.').reduce((o, k) => o?.[k], body.data)).join('');
      const expected = crypto.createHash('sha256').update(values + body.timestamp + config.wompi.eventsSecret).digest('hex');
      if (expected !== body.signature?.checksum) throw new Error('Firma de webhook Wompi inválida');
    }
    if (tx.status !== 'APPROVED') return { ignored: true, status: tx.status };
    const link = await prisma.paymentLink.findUnique({ where: { token: tx.reference } });
    if (!link || link.status === 'paid') return { ignored: true };
    return applyApprovedPayment({
      paymentLink: link, amount: tx.amount_in_cents / 100,
      method: (tx.payment_method_type || 'card').toLowerCase(), provider: 'wompi', providerRef: tx.id,
    });
  }
  // Proveedor mock/simulador
  const link = await prisma.paymentLink.findUnique({ where: { token: body.reference } });
  if (!link) throw new Error('Link de pago no encontrado');
  if (link.status === 'paid') return { ignored: true };
  if (link.expiresAt && link.expiresAt < new Date()) throw new Error('El link de pago está vencido');
  return applyApprovedPayment({
    paymentLink: link, amount: link.amount,
    method: body.method || 'mock', provider: 'mock', providerRef: body.txId || token(8),
  });
}

export async function reservationBalance(reservationId) {
  const r = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { folio: { include: { charges: true } }, payments: true },
  });
  if (!r) throw new Error('Reserva no encontrada');
  const charges = (r.folio?.charges || []).filter(c => !c.voided);
  const chargesTotal = charges.reduce((s, c) => s + c.amount + c.taxAmount, 0);
  const base = r.folio ? chargesTotal : r.total;
  const paid = r.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0);
  const refunded = r.payments.filter(p => p.status === 'approved' && p.kind === 'refund').reduce((s, p) => s + p.amount, 0);
  return { total: base, paid: paid - refunded, balance: base - (paid - refunded) };
}
