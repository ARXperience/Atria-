// Atria Service — Restaurante/POS (§32). Comandas de mesa, room service y
// minibar; al cobrar descuenta el inventario según receta y carga al folio del
// huésped o registra el pago directo.
import { prisma } from '../db.js';
import { registerMovement } from './inventory.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { money } from '../lib/util.js';

export async function createOrder({ propertyId, type = 'table', tableLabel = null, reservationId = null, items, createdBy = null }) {
  if (!Array.isArray(items) || !items.length) throw new Error('La comanda debe tener al menos un ítem');
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  const resolved = [];
  for (const it of items) {
    const mi = await prisma.menuItem.findUnique({ where: { id: it.menuItemId } });
    if (!mi || mi.propertyId !== propertyId) throw new Error('Ítem de menú inválido');
    const qty = +it.qty || 1;
    resolved.push({ menuItemId: mi.id, name: mi.name, qty, price: mi.price, total: money(mi.price * qty) });
  }
  if (reservationId) {
    const r = await prisma.reservation.findUnique({ where: { id: reservationId } });
    if (!r || r.propertyId !== propertyId) throw new Error('Reserva inválida');
  }
  const subtotal = money(resolved.reduce((s, i) => s + i.total, 0));
  const tax = money(subtotal * (property?.taxRate ?? 0.08));
  const order = await prisma.posOrder.create({
    data: { propertyId, type, tableLabel, reservationId, items: JSON.stringify(resolved), subtotal, tax, total: subtotal + tax, createdBy },
  });
  await audit({ propertyId, action: 'order.created', entity: 'PosOrder', entityId: order.id, after: { type, total: subtotal + tax } });
  emitEvent('order.created', { propertyId, entityId: order.id });
  return { ...order, items: resolved };
}

// Descuenta insumos del inventario según la receta de cada ítem vendido.
async function consumeRecipes(propertyId, items, reference) {
  for (const it of items) {
    const mi = await prisma.menuItem.findUnique({ where: { id: it.menuItemId } });
    if (!mi?.recipe) continue;
    let recipe = [];
    try { recipe = JSON.parse(mi.recipe); } catch { recipe = []; }
    for (const r of recipe) {
      await registerMovement({
        propertyId, productId: r.productId, type: 'consumption',
        quantity: (+r.qty || 0) * it.qty, reason: `Venta POS: ${mi.name}`, reference,
        actor: 'system', allowNegative: true,
      }).catch(err => logger.warn({ err: err.message }, 'pos recipe consumption failed'));
    }
  }
}

// Room service conversacional: el agente toma un pedido por NOMBRE de plato,
// lo asocia a la estadía del huésped y lo carga a la habitación (§ restaurante).
const _norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
export async function orderRoomServiceByName({ propertyId, reservationCode = null, contactPhone = null, items }) {
  if (!Array.isArray(items) || !items.length) throw new Error('Indícame qué deseas pedir de la carta.');
  let reservation = null;
  if (reservationCode) reservation = await prisma.reservation.findUnique({ where: { code: String(reservationCode).toUpperCase() } });
  if (!reservation && contactPhone) {
    const guest = await prisma.guest.findFirst({ where: { propertyId, phone: contactPhone } });
    if (guest) reservation = await prisma.reservation.findFirst({ where: { propertyId, guestId: guest.id, status: 'checked_in' }, orderBy: { checkIn: 'desc' } });
  }
  if (!reservation || reservation.propertyId !== propertyId) throw new Error('No encontré tu reserva en estadía. Compárteme el código de tu reserva (ATR-…) para tomar el pedido.');
  if (reservation.status !== 'checked_in') throw new Error('El room service está disponible solo durante la estadía (después del check-in).');

  const menu = await prisma.menuItem.findMany({ where: { propertyId, active: true } });
  const resolvedItems = [], notFound = [];
  for (const it of items) {
    const q = _norm(it.name);
    const mi = menu.find(m => _norm(m.name) === q) || menu.find(m => _norm(m.name).includes(q) || q.includes(_norm(m.name)));
    if (mi) resolvedItems.push({ menuItemId: mi.id, qty: +it.qty || 1, name: mi.name });
    else notFound.push(it.name);
  }
  if (!resolvedItems.length) throw new Error(`No encontré en la carta: ${notFound.join(', ')}. ¿Quieres ver el menú?`);

  const order = await createOrder({ propertyId, type: 'room_service', reservationId: reservation.id, items: resolvedItems.map(({ menuItemId, qty }) => ({ menuItemId, qty })), createdBy: 'ai' });
  await chargeOrder(order.id, { user: { name: 'Atria IA' } });
  return { code: reservation.code, pedido: order.items.map(i => `${i.qty}× ${i.name}`), total: order.total, cargadoAHabitacion: true, noEncontrados: notFound };
}

export async function chargeOrder(orderId, { method = 'efectivo', user = null } = {}) {
  const order = await prisma.posOrder.findUnique({ where: { id: orderId } });
  if (!order) throw new Error('Comanda no encontrada');
  if (order.status !== 'open') throw new Error(`La comanda ya está ${order.status}`);
  const items = JSON.parse(order.items);

  // Descontar inventario según receta
  await consumeRecipes(order.propertyId, items, order.id);

  if (order.reservationId) {
    const r = await prisma.reservation.findUnique({ where: { id: order.reservationId }, include: { folio: true } });
    if (!r || r.status !== 'checked_in') throw new Error('La habitación no está en check-in; no se puede cargar al folio');
    const folio = r.folio || await prisma.folio.create({ data: { reservationId: r.id } });
    const concept = order.type === 'minibar' ? 'minibar' : order.type === 'room_service' ? 'room_service' : 'restaurante';
    await prisma.folioCharge.create({ data: { folioId: folio.id, concept, description: `Comanda POS ${order.id.slice(-6)}`, amount: order.subtotal, taxAmount: order.tax, postedBy: user?.name || 'POS' } });
    const updated = await prisma.posOrder.update({ where: { id: orderId }, data: { status: 'charged', chargedAt: new Date() } });
    await audit({ propertyId: order.propertyId, user, action: 'room_charge.added', entity: 'PosOrder', entityId: orderId, after: { reservation: r.code, total: order.total } });
    emitEvent('room_charge.added', { propertyId: order.propertyId, reservationId: r.id, entityId: orderId });
    return updated;
  }

  const updated = await prisma.posOrder.update({ where: { id: orderId }, data: { status: 'paid', method, chargedAt: new Date() } });
  await audit({ propertyId: order.propertyId, user, action: 'restaurant_cash.closed', entity: 'PosOrder', entityId: orderId, after: { method, total: order.total } });
  emitEvent('order.paid', { propertyId: order.propertyId, entityId: orderId });
  return updated;
}
