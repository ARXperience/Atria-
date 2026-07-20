// Atria Finance (§28): cartera (CxC), cuentas por pagar (CxP) y reportes.
// Agrega las transacciones reales de pagos, facturas, nómina, compras y POS.
import { prisma } from '../db.js';
import { money, fmtCOP } from '../lib/util.js';

// Copiloto financiero (IA determinística): resume el mes en lenguaje natural
// con una recomendación accionable, usando solo datos que el rol puede ver.
export async function financialNarrative(propertyId) {
  const ov = await financeOverview(propertyId);
  const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { name: true } });
  const hotel = prop?.name || 'la sede';
  const mes = new Date().toLocaleDateString('es-CO', { month: 'long' });
  const positivo = ov.monthNet >= 0;
  const margen = ov.monthIncome > 0 ? Math.round((ov.monthNet / ov.monthIncome) * 100) : 0;
  const partes = [];
  partes.push(`En ${mes}, ${hotel} registra ingresos por ${fmtCOP(ov.monthIncome)} y egresos por ${fmtCOP(ov.monthExpenses)}, con un resultado ${positivo ? 'positivo' : 'negativo'} de ${fmtCOP(Math.abs(ov.monthNet))}${ov.monthIncome > 0 ? ` (margen ${margen}%)` : ''}.`);
  if (ov.receivable > 0) partes.push(`Tienes ${fmtCOP(ov.receivable)} en cartera por cobrar: priorizar su recaudo mejora la liquidez de inmediato.`);
  else partes.push(`No hay cartera por cobrar pendiente: excelente gestión de recaudo.`);
  if (ov.payableOpen > 0) partes.push(`Quedan ${fmtCOP(ov.payableOpen)} en cuentas por pagar abiertas; programa los pagos para no afectar la relación con proveedores.`);
  // Recomendación accionable
  let consejo;
  if (!positivo) consejo = 'El mes va en rojo: revisa los egresos más grandes (nómina y compras) y acelera el cobro de cartera.';
  else if (ov.receivable > ov.monthNet) consejo = 'La cartera supera tu utilidad del mes: convertirla en caja es tu mayor palanca ahora.';
  else if (margen < 15) consejo = 'El margen es ajustado: evalúa tu estrategia de tarifas (revenue) o renegocia compras.';
  else consejo = 'Vas bien: mantén el control de gastos y considera reinvertir en ocupación (marketing) o experiencia.';
  partes.push(`💡 ${consejo}`);
  return { narrative: partes.join(' '), sentiment: positivo ? 'positive' : 'negative', overview: ov };
}

function monthStart() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

// Cuentas por cobrar: reservas con saldo pendiente (cargos de folio o total vs pagos).
export async function accountsReceivable(propertyId) {
  const reservations = await prisma.reservation.findMany({
    where: { propertyId, status: { in: ['confirmed', 'checked_in', 'checked_out'] } },
    include: { guest: true, folio: { include: { charges: true } }, payments: true },
    take: 500,
  });
  const rows = [];
  let total = 0;
  for (const r of reservations) {
    const charges = (r.folio?.charges || []).filter(c => !c.voided);
    const owed = r.folio ? charges.reduce((s, c) => s + c.amount + c.taxAmount, 0) : r.total;
    const paid = r.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0)
      - r.payments.filter(p => p.status === 'approved' && p.kind === 'refund').reduce((s, p) => s + p.amount, 0);
    const balance = money(owed - paid);
    if (balance > 0) {
      rows.push({ id: r.id, code: r.code, guest: r.guest.fullName, status: r.status, owed: money(owed), paid: money(paid), balance });
      total += balance;
    }
  }
  return { total: money(total), rows: rows.sort((a, b) => b.balance - a.balance).slice(0, 100) };
}

export async function financeOverview(propertyId) {
  const from = monthStart();
  const [income, refunds, apOpen, poReceived, payrollClosed, ar] = await Promise.all([
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'payment', createdAt: { gte: from } }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'refund', createdAt: { gte: from } }, _sum: { amount: true } }),
    prisma.accountPayable.aggregate({ where: { propertyId, status: 'open' }, _sum: { amount: true } }),
    prisma.purchaseOrder.aggregate({ where: { propertyId, status: 'received', receivedAt: { gte: from } }, _sum: { total: true } }),
    prisma.payrollPeriod.aggregate({ where: { propertyId, status: 'closed', closedAt: { gte: from } }, _sum: { totalNet: true } }),
    accountsReceivable(propertyId),
  ]);
  const apPaid = await prisma.accountPayable.aggregate({ where: { propertyId, status: 'paid', paidAt: { gte: from } }, _sum: { amount: true } });

  const monthIncome = money((income._sum.amount || 0) - (refunds._sum.amount || 0));
  const monthExpenses = money((apPaid._sum.amount || 0) + (poReceived._sum.total || 0) + (payrollClosed._sum.totalNet || 0));
  return {
    monthIncome, monthExpenses, monthNet: money(monthIncome - monthExpenses),
    receivable: ar.total, payableOpen: money(apOpen._sum.amount || 0),
    breakdown: { compras: money(poReceived._sum.total || 0), nomina: money(payrollClosed._sum.totalNet || 0), cxpPagadas: money(apPaid._sum.amount || 0) },
  };
}

export async function createPayable({ propertyId, supplierId = null, supplierName, concept, category = 'proveedores', amount, dueDate = null, createdBy }) {
  if (!supplierName || !concept || !(amount > 0)) throw new Error('supplierName, concept y amount > 0 requeridos');
  return prisma.accountPayable.create({ data: { propertyId, supplierId, supplierName, concept, category, amount: money(amount), dueDate: dueDate ? new Date(dueDate) : null, createdBy } });
}

export async function payPayable(id, { support = null } = {}) {
  const ap = await prisma.accountPayable.findUnique({ where: { id } });
  if (!ap) throw new Error('Cuenta por pagar no encontrada');
  if (ap.status === 'paid') return ap;
  return prisma.accountPayable.update({ where: { id }, data: { status: 'paid', paidAt: new Date(), paymentSupport: support } });
}

// P&G simplificado del mes: ingresos por concepto y egresos por categoría.
export async function profitAndLoss(propertyId) {
  const from = monthStart();
  const payments = await prisma.payment.findMany({ where: { propertyId, status: 'approved', kind: 'payment', createdAt: { gte: from } }, select: { amount: true, method: true } });
  const income = money(payments.reduce((s, p) => s + p.amount, 0));
  const poReceived = await prisma.purchaseOrder.aggregate({ where: { propertyId, status: 'received', receivedAt: { gte: from } }, _sum: { total: true } });
  const payroll = await prisma.payrollPeriod.aggregate({ where: { propertyId, status: 'closed', closedAt: { gte: from } }, _sum: { totalNet: true, totalEmployerCost: true } });
  const apByCat = await prisma.accountPayable.groupBy({ by: ['category'], where: { propertyId, status: 'paid', paidAt: { gte: from } }, _sum: { amount: true } });
  const expenses = {
    Nómina: money((payroll._sum.totalNet || 0) + (payroll._sum.totalEmployerCost || 0)),
    Compras: money(poReceived._sum.total || 0),
  };
  for (const c of apByCat) expenses[c.category] = money((expenses[c.category] || 0) + (c._sum.amount || 0));
  const totalExp = Object.values(expenses).reduce((s, v) => s + v, 0);
  return { income, expenses, totalExpenses: money(totalExp), result: money(income - totalExp) };
}
