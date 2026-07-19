// FONTUR — contribución parafiscal para la promoción del turismo (§27).
// Base: ingresos operacionales del trimestre; tarifa versionada en
// LegalParameter FONTUR_TARIFA (2.5 por mil para hoteles, Ley 2068/2020).
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { audit } from '../lib/audit.js';

const DEFAULT_RATE = 0.0025; // 2.5 por mil (hoteles) — se siembra si no existe.

// Tarifa vigente; se crea de forma perezosa si la empresa aún no la tiene.
export async function getFonturRate(companyId, date = new Date()) {
  let p = await prisma.legalParameter.findFirst({
    where: { companyId, key: 'FONTUR_TARIFA', validFrom: { lte: date }, OR: [{ validTo: null }, { validTo: { gte: date } }] },
    orderBy: { validFrom: 'desc' },
  });
  if (!p) {
    p = await prisma.legalParameter.create({
      data: { companyId, key: 'FONTUR_TARIFA', value: DEFAULT_RATE, unit: '%', validFrom: new Date(Date.UTC(date.getUTCFullYear(), 0, 1)), source: 'Contribución parafiscal FONTUR 2.5 por mil - hoteles (Ley 2068/2020)', updatedBy: 'system' },
    });
  }
  return p.value;
}

// Trimestre calendario que contiene la fecha dada.
export function quarterOf(date = new Date()) {
  const y = date.getUTCFullYear();
  const q = Math.floor(date.getUTCMonth() / 3); // 0..3
  const start = new Date(Date.UTC(y, q * 3, 1));
  const end = new Date(Date.UTC(y, q * 3 + 3, 1)); // exclusivo
  return { period: `${y}-T${q + 1}`, start, end };
}

// Ingresos operacionales del periodo (pagos aprobados menos reembolsos).
export async function operatingIncome(propertyId, start, end) {
  const [inc, ref] = await Promise.all([
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'payment', createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'refund', createdAt: { gte: start, lt: end } }, _sum: { amount: true } }),
  ]);
  return money((inc._sum.amount || 0) - (ref._sum.amount || 0));
}

async function companyOf(propertyId) {
  const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { companyId: true } });
  if (!prop) throw new Error('Sede no encontrada');
  return prop.companyId;
}

// Previsualiza (sin guardar) la contribución del trimestre indicado o el actual.
export async function previewContribution(propertyId, refDate = new Date()) {
  const companyId = await companyOf(propertyId);
  const { period, start, end } = quarterOf(refDate);
  const base = await operatingIncome(propertyId, start, end);
  const rate = await getFonturRate(companyId, start);
  return { period, periodStart: start, periodEnd: end, operatingIncome: base, rate, amount: money(base * rate) };
}

// Genera o actualiza la contribución del trimestre (idempotente por periodo).
export async function generateContribution(propertyId, { refDate = new Date(), createdBy = null, user = null } = {}) {
  const pre = await previewContribution(propertyId, refDate);
  const existing = await prisma.fonturContribution.findUnique({ where: { propertyId_period: { propertyId, period: pre.period } } });
  if (existing && existing.status !== 'draft') {
    throw new Error(`El periodo ${pre.period} ya fue ${existing.status === 'paid' ? 'pagado' : 'presentado'} y no puede recalcularse`);
  }
  const row = await prisma.fonturContribution.upsert({
    where: { propertyId_period: { propertyId, period: pre.period } },
    update: { operatingIncome: pre.operatingIncome, rate: pre.rate, amount: pre.amount },
    create: { propertyId, period: pre.period, periodStart: pre.periodStart, periodEnd: pre.periodEnd, operatingIncome: pre.operatingIncome, rate: pre.rate, amount: pre.amount, createdBy },
  });
  await audit({ propertyId, user, action: 'fontur.generated', entity: 'FonturContribution', entityId: row.id, after: { period: row.period, amount: row.amount } });
  return row;
}

export async function fileContribution(id, { user } = {}) {
  const c = await prisma.fonturContribution.findUnique({ where: { id } });
  if (!c) throw new Error('Contribución no encontrada');
  if (c.status === 'paid') throw new Error('La contribución ya está pagada');
  const row = await prisma.fonturContribution.update({ where: { id }, data: { status: 'filed', filedAt: new Date() } });
  await audit({ propertyId: c.propertyId, user, action: 'fontur.filed', entity: 'FonturContribution', entityId: id, after: { period: c.period } });
  return row;
}

export async function payContribution(id, { support = null, user } = {}) {
  const c = await prisma.fonturContribution.findUnique({ where: { id } });
  if (!c) throw new Error('Contribución no encontrada');
  if (c.status === 'paid') return c;
  const row = await prisma.fonturContribution.update({ where: { id }, data: { status: 'paid', paidAt: new Date(), support } });
  await audit({ propertyId: c.propertyId, user, action: 'fontur.paid', entity: 'FonturContribution', entityId: id, after: { period: c.period, support } });
  return row;
}

export async function fonturOverview(propertyId) {
  const current = await previewContribution(propertyId);
  const contributions = await prisma.fonturContribution.findMany({ where: { propertyId }, orderBy: { period: 'desc' }, take: 24 });
  const year = new Date().getUTCFullYear();
  const paidYtd = contributions
    .filter(c => c.status === 'paid' && c.period.startsWith(String(year)))
    .reduce((s, c) => s + c.amount, 0);
  const pending = contributions.filter(c => c.status !== 'paid').reduce((s, c) => s + c.amount, 0);
  return { current, paidYtd: money(paidYtd), pending: money(pending), contributions };
}
