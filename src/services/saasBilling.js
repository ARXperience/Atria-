// Facturación del software SaaS (§55.1): emisión mensual, pago, mora y
// suspensión automática por impago. Solo cubre suscripciones (no las ventas
// del hotel, que van por el motor de pagos de huéspedes).
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { audit } from '../lib/audit.js';
import { getPlanForCompany } from './saas.js';

function periodKey(date = new Date()) {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
}

// Emite (idempotente) la factura del periodo para una empresa activa.
export async function generateInvoiceForCompany(companyId, { refDate = new Date() } = {}) {
  const { company, plan } = await getPlanForCompany(companyId);
  if (!company || company.subStatus === 'cancelled') return null;
  const period = periodKey(refDate);
  const amount = money(plan.priceMonthly || 0);
  const dueDate = new Date(Date.UTC(refDate.getUTCFullYear(), refDate.getUTCMonth(), refDate.getUTCDate() + 15));
  return prisma.saasInvoice.upsert({
    where: { companyId_period: { companyId, period } },
    update: {}, // no re-emitir si ya existe
    create: { companyId, period, planCode: company.planCode, amount, dueDate, status: amount > 0 ? 'pending' : 'paid', paidAt: amount > 0 ? null : new Date() },
  });
}

// Emite las facturas del periodo para todas las empresas activas (job/superadmin).
export async function generateAllInvoices({ refDate = new Date() } = {}) {
  const companies = await prisma.company.findMany({ where: { subStatus: { in: ['active', 'trial'] } }, select: { id: true } });
  let created = 0;
  for (const c of companies) { const inv = await generateInvoiceForCompany(c.id, { refDate }); if (inv) created++; }
  return { companies: companies.length, created };
}

export async function payInvoice(invoiceId, { ref = null, user } = {}) {
  const inv = await prisma.saasInvoice.findUnique({ where: { id: invoiceId } });
  if (!inv) throw new Error('Factura no encontrada');
  if (inv.status === 'paid') return inv;
  const paid = await prisma.saasInvoice.update({ where: { id: invoiceId }, data: { status: 'paid', paidAt: new Date(), paymentRef: ref } });
  // Pagar reactiva/extiende la suscripción un mes.
  await prisma.company.update({
    where: { id: inv.companyId },
    data: { subStatus: 'active', currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) },
  });
  await audit({ companyId: inv.companyId, user, actor: user ? 'human' : 'system', action: 'saas.invoice_paid', entity: 'SaasInvoice', entityId: inv.id, after: { period: inv.period, amount: inv.amount } });
  return paid;
}

// Marca vencidas las facturas pendientes pasadas de fecha y suspende empresas
// con facturas en mora (política simple; el superadmin puede reactivar).
export async function runOverdueSweep({ now = new Date(), autoSuspend = true } = {}) {
  const overdue = await prisma.saasInvoice.findMany({ where: { status: 'pending', dueDate: { lt: now } } });
  let suspended = 0;
  for (const inv of overdue) {
    await prisma.saasInvoice.update({ where: { id: inv.id }, data: { status: 'overdue' } });
    if (autoSuspend) {
      await prisma.company.update({ where: { id: inv.companyId }, data: { subStatus: 'suspended' } }).catch(() => {});
      suspended++;
    }
  }
  return { overdue: overdue.length, suspended };
}

export async function companyInvoices(companyId) {
  return prisma.saasInvoice.findMany({ where: { companyId }, orderBy: { period: 'desc' }, take: 24 });
}

// Panel de facturación del superadministrador.
export async function billingOverview() {
  const invoices = await prisma.saasInvoice.findMany({ take: 1000, orderBy: { issuedAt: 'desc' } });
  const sum = (st) => invoices.filter(i => i.status === st).reduce((s, i) => s + i.amount, 0);
  const companies = await prisma.company.findMany({ select: { id: true, name: true } });
  const nameOf = Object.fromEntries(companies.map(c => [c.id, c.name]));
  return {
    pending: money(sum('pending')), paid: money(sum('paid')), overdue: money(sum('overdue')),
    counts: { pending: invoices.filter(i => i.status === 'pending').length, paid: invoices.filter(i => i.status === 'paid').length, overdue: invoices.filter(i => i.status === 'overdue').length },
    invoices: invoices.slice(0, 100).map(i => ({ id: i.id, company: nameOf[i.companyId] || i.companyId, period: i.period, planCode: i.planCode, amount: i.amount, status: i.status, dueDate: i.dueDate })),
  };
}
