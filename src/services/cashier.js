// Cierres de caja y conciliación de pagos (§28).
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { audit } from '../lib/audit.js';

export async function currentCashClosure(propertyId) {
  return prisma.cashClosure.findFirst({ where: { propertyId, status: 'open' }, orderBy: { openedAt: 'desc' } });
}

export async function openCashClosure(propertyId, { openingBalance = 0, user } = {}) {
  const open = await currentCashClosure(propertyId);
  if (open) throw new Error('Ya hay una caja abierta. Ciérrala antes de abrir otra.');
  const c = await prisma.cashClosure.create({ data: { propertyId, openingBalance: money(openingBalance), openedBy: user?.name || null } });
  await audit({ propertyId, user, action: 'cash.opened', entity: 'CashClosure', entityId: c.id, after: { openingBalance: c.openingBalance } });
  return c;
}

// Efectivo recaudado (pagos aprobados en efectivo menos reembolsos en efectivo)
// desde la apertura de la caja.
async function cashCollected(propertyId, since) {
  const [pay, ref] = await Promise.all([
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'payment', method: 'cash', createdAt: { gte: since } }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'refund', method: 'cash', createdAt: { gte: since } }, _sum: { amount: true } }),
  ]);
  return money((pay._sum.amount || 0) - (ref._sum.amount || 0));
}

export async function closeCashClosure(id, { countedAmount = 0, notes = null, user } = {}) {
  const c = await prisma.cashClosure.findUnique({ where: { id } });
  if (!c) throw new Error('Caja no encontrada');
  if (c.status === 'closed') throw new Error('La caja ya está cerrada');
  const cashPayments = await cashCollected(c.propertyId, c.openedAt);
  const expectedCash = money(c.openingBalance + cashPayments);
  const difference = money(Number(countedAmount) - expectedCash);
  const closed = await prisma.cashClosure.update({
    where: { id },
    data: { status: 'closed', closedBy: user?.name || null, closedAt: new Date(), cashPayments, expectedCash, countedAmount: money(countedAmount), difference, notes },
  });
  await audit({ propertyId: c.propertyId, user, action: 'cash.closed', entity: 'CashClosure', entityId: id, after: { expectedCash, countedAmount: money(countedAmount), difference } });
  return closed;
}

export async function cashClosureHistory(propertyId) {
  return prisma.cashClosure.findMany({ where: { propertyId }, orderBy: { openedAt: 'desc' }, take: 60 });
}

// Vista previa del turno actual (esperado hasta el momento).
export async function currentCashPreview(propertyId) {
  const c = await currentCashClosure(propertyId);
  if (!c) return { open: false };
  const cashPayments = await cashCollected(propertyId, c.openedAt);
  return { open: true, id: c.id, openedBy: c.openedBy, openedAt: c.openedAt, openingBalance: c.openingBalance, cashPayments, expectedCash: money(c.openingBalance + cashPayments) };
}

// Conciliación: cruza los pagos del sistema (por pasarela) en un rango contra
// una lista de referencias externas {ref, amount}. Empareja por referencia o
// por monto exacto.
export async function reconcile(propertyId, { from, to, source = 'gateway', externalRefs = [], user } = {}) {
  const fromDate = from ? new Date(from) : new Date(Date.now() - 30 * 86400_000);
  const toDate = to ? new Date(to) : new Date();
  const payments = await prisma.payment.findMany({
    where: { propertyId, status: 'approved', kind: 'payment', createdAt: { gte: fromDate, lte: toDate }, ...(source === 'gateway' ? { provider: { not: null } } : {}) },
    select: { id: true, amount: true, providerRef: true, method: true, createdAt: true },
  });
  const ext = (Array.isArray(externalRefs) ? externalRefs : []).map(e => ({ ref: String(e.ref || ''), amount: money(e.amount || 0), used: false }));
  const matchedPayments = []; const unmatchedSystem = [];
  for (const p of payments) {
    const hit = ext.find(e => !e.used && ((p.providerRef && e.ref && p.providerRef === e.ref) || e.amount === money(p.amount)));
    if (hit) { hit.used = true; matchedPayments.push(p.id); }
    else unmatchedSystem.push({ id: p.id, amount: money(p.amount), ref: p.providerRef, date: p.createdAt });
  }
  const unmatchedExternal = ext.filter(e => !e.used).map(({ used, ...e }) => e);
  const totalSystem = money(payments.reduce((s, p) => s + p.amount, 0));
  const totalExternal = money(ext.reduce((s, e) => s + e.amount, 0));
  const rec = await prisma.reconciliation.create({
    data: { propertyId, source, fromDate, toDate, totalSystem, totalExternal, matched: matchedPayments.length, unmatched: unmatchedSystem.length + unmatchedExternal.length, createdBy: user?.name || null },
  });
  await audit({ propertyId, user, action: 'finance.reconciled', entity: 'Reconciliation', entityId: rec.id, after: { matched: matchedPayments.length, unmatched: rec.unmatched } });
  return { id: rec.id, source, totalSystem, totalExternal, matched: matchedPayments.length, unmatchedSystem, unmatchedExternal, balanced: unmatchedSystem.length === 0 && unmatchedExternal.length === 0 };
}
