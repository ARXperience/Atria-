// Cuentas corporativas / agencias y rooming lists (§35).
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { audit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';
import { createTentativeReservation, confirmReservation } from './reservations.js';

// ---- Cuentas corporativas ----
export async function createCorporateAccount({ propertyId, name, nit = null, contactName = null, contactEmail = null, contactPhone = null, discountPct = 0, creditEnabled = false, creditLimit = 0, paymentTermsDays = 30, notes = null, user = null }) {
  if (!name) throw new Error('El nombre de la cuenta es obligatorio');
  const pct = Math.min(Math.max(Number(discountPct) || 0, 0), 0.9);
  const acc = await prisma.corporateAccount.create({
    data: {
      propertyId, name, nit, contactName, contactEmail, contactPhone,
      discountPct: pct, creditEnabled: !!creditEnabled, creditLimit: money(creditLimit || 0),
      paymentTermsDays: parseInt(paymentTermsDays, 10) || 30, notes, createdBy: user?.name || null,
    },
  });
  await audit({ propertyId, user, action: 'corporate.account_created', entity: 'CorporateAccount', entityId: acc.id, after: { name, discountPct: pct } });
  return acc;
}

export async function updateCorporateAccount(id, { user = null, ...fields }) {
  const acc = await prisma.corporateAccount.findUnique({ where: { id } });
  if (!acc) throw new Error('Cuenta no encontrada');
  const data = {};
  for (const k of ['name', 'nit', 'contactName', 'contactEmail', 'contactPhone', 'status', 'notes']) {
    if (fields[k] !== undefined) data[k] = fields[k];
  }
  if (fields.discountPct !== undefined) data.discountPct = Math.min(Math.max(Number(fields.discountPct) || 0, 0), 0.9);
  if (fields.creditEnabled !== undefined) data.creditEnabled = !!fields.creditEnabled;
  if (fields.creditLimit !== undefined) data.creditLimit = money(fields.creditLimit || 0);
  if (fields.paymentTermsDays !== undefined) data.paymentTermsDays = parseInt(fields.paymentTermsDays, 10) || 30;
  const updated = await prisma.corporateAccount.update({ where: { id }, data });
  await audit({ propertyId: acc.propertyId, user, action: 'corporate.account_updated', entity: 'CorporateAccount', entityId: id, after: data });
  return updated;
}

export async function listCorporateAccounts(propertyId, { status } = {}) {
  const where = { propertyId };
  if (status) where.status = status;
  return prisma.corporateAccount.findMany({ where, orderBy: { name: 'asc' }, take: 200 });
}

// Estado de cuenta consolidado: reservas de la cuenta y saldo por cobrar (§35).
export async function accountStatement(accountId) {
  const acc = await prisma.corporateAccount.findUnique({ where: { id: accountId } });
  if (!acc) throw new Error('Cuenta no encontrada');
  const reservations = await prisma.reservation.findMany({
    where: { corporateAccountId: accountId, status: { in: ['tentative', 'confirmed', 'checked_in', 'checked_out'] } },
    include: { guest: { select: { fullName: true } } },
    orderBy: { checkIn: 'desc' }, take: 500,
  });
  const ids = reservations.map(r => r.id);
  const pays = ids.length
    ? await prisma.payment.groupBy({ by: ['reservationId'], where: { reservationId: { in: ids }, status: 'approved', kind: 'payment' }, _sum: { amount: true } })
    : [];
  const paidByRes = Object.fromEntries(pays.map(p => [p.reservationId, p._sum.amount || 0]));
  const rows = reservations.map(r => {
    const paid = money(paidByRes[r.id] || 0);
    return { id: r.id, code: r.code, guest: r.guest.fullName, checkIn: r.checkIn, checkOut: r.checkOut, status: r.status, total: r.total, paid, balance: money(r.total - paid) };
  });
  const totalBilled = money(rows.reduce((s, r) => s + r.total, 0));
  const totalPaid = money(rows.reduce((s, r) => s + r.paid, 0));
  const balance = money(totalBilled - totalPaid);
  return {
    account: { id: acc.id, name: acc.name, nit: acc.nit, discountPct: acc.discountPct, creditEnabled: acc.creditEnabled, creditLimit: acc.creditLimit, paymentTermsDays: acc.paymentTermsDays, status: acc.status },
    reservations: rows, totalBilled, totalPaid, balance,
    creditAvailable: acc.creditEnabled ? money(acc.creditLimit - balance) : null,
    overLimit: acc.creditEnabled && balance > acc.creditLimit,
  };
}

// ---- Rooming lists ----
export async function createRoomingList({ propertyId, corporateAccountId = null, name, checkIn, checkOut, roomTypeId, ratePlanId = null, entries = [], notes = null, user = null }) {
  if (!name) throw new Error('El rooming list requiere un nombre');
  if (!roomTypeId) throw new Error('Selecciona el tipo de habitación');
  if (!checkIn || !checkOut) throw new Error('Fechas requeridas');
  if (corporateAccountId) {
    const acc = await prisma.corporateAccount.findUnique({ where: { id: corporateAccountId } });
    if (!acc || acc.propertyId !== propertyId) throw new Error('Cuenta corporativa inválida');
  }
  const list = await prisma.roomingList.create({
    data: {
      propertyId, corporateAccountId, name, roomTypeId, ratePlanId,
      checkIn: new Date(checkIn), checkOut: new Date(checkOut), notes, createdBy: user?.name || null,
      entries: { create: (entries || []).map(e => ({ guestName: e.guestName, documentNumber: e.documentNumber || null, adults: e.adults || 1, children: e.children || 0 })) },
    },
    include: { entries: true },
  });
  await audit({ propertyId, user, action: 'corporate.rooming_created', entity: 'RoomingList', entityId: list.id, after: { name, count: list.entries.length } });
  return list;
}

export async function addRoomingEntry(listId, { guestName, documentNumber = null, adults = 1, children = 0 }) {
  if (!guestName) throw new Error('El nombre del huésped es obligatorio');
  const list = await prisma.roomingList.findUnique({ where: { id: listId } });
  if (!list) throw new Error('Rooming list no encontrado');
  if (list.status !== 'draft') throw new Error('Solo se pueden agregar huéspedes a un rooming list en borrador');
  return prisma.roomingEntry.create({ data: { roomingListId: listId, guestName, documentNumber, adults, children } });
}

export async function getRoomingList(listId) {
  return prisma.roomingList.findUnique({ where: { id: listId }, include: { entries: { orderBy: { createdAt: 'asc' } } } });
}

export async function listRoomingLists(propertyId) {
  return prisma.roomingList.findMany({ where: { propertyId }, include: { entries: true }, orderBy: { createdAt: 'desc' }, take: 100 });
}

// Materializa el rooming list: crea una reserva por huésped aplicando la tarifa
// negociada de la cuenta y confirmándola (bloque de grupo). Idempotente por
// entrada (no re-reserva las ya materializadas).
export async function materializeRoomingList(listId, { user = null } = {}) {
  const list = await prisma.roomingList.findUnique({ where: { id: listId }, include: { entries: true } });
  if (!list) throw new Error('Rooming list no encontrado');
  if (list.status === 'cancelled') throw new Error('El rooming list está cancelado');
  const pending = list.entries.filter(e => e.status === 'pending' && !e.reservationId);
  if (!pending.length) throw new Error('No hay huéspedes pendientes por reservar');

  let discountPct = 0;
  if (list.corporateAccountId) {
    const acc = await prisma.corporateAccount.findUnique({ where: { id: list.corporateAccountId } });
    if (acc?.status === 'suspended') throw new Error('La cuenta corporativa está suspendida');
    discountPct = acc?.discountPct || 0;
  }

  const results = [];
  for (const entry of pending) {
    try {
      const reservation = await createTentativeReservation({
        propertyId: list.propertyId,
        guest: { fullName: entry.guestName, documentNumber: entry.documentNumber },
        roomTypeId: list.roomTypeId, ratePlanId: list.ratePlanId,
        checkIn: list.checkIn, checkOut: list.checkOut,
        adults: entry.adults, children: entry.children,
        channel: 'direct', createdBy: user?.name || null,
        notes: `Grupo: ${list.name}`, discountPct, corporateAccountId: list.corporateAccountId,
      });
      // Bloque de grupo confirmado (la facturación puede ir a crédito de la cuenta).
      await confirmReservation(reservation.id, { actor: 'human', user });
      await prisma.roomingEntry.update({ where: { id: entry.id }, data: { status: 'reserved', reservationId: reservation.id } });
      results.push({ entryId: entry.id, code: reservation.code, ok: true });
    } catch (err) {
      results.push({ entryId: entry.id, guestName: entry.guestName, ok: false, error: err.message });
    }
  }

  const reservedCount = results.filter(r => r.ok).length;
  const allReserved = list.entries.every(e => e.status === 'reserved' || results.find(r => r.entryId === e.id && r.ok));
  await prisma.roomingList.update({ where: { id: listId }, data: { status: allReserved ? 'materialized' : list.status } });
  await audit({ propertyId: list.propertyId, user, action: 'corporate.rooming_materialized', entity: 'RoomingList', entityId: listId, after: { reserved: reservedCount } });
  emitEvent('corporate.rooming_materialized', { propertyId: list.propertyId, entityId: listId });
  return { reserved: reservedCount, total: pending.length, results };
}
