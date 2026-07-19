// PILA y seguridad social (§23): construye la planilla de aportes a partir de
// un periodo de nómina liquidado (IBC y aportes ya calculados). Valida
// afiliaciones y controla el soporte de pago. La IA/el sistema preparan;
// presentar/pagar es acción humana.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { money } from '../lib/util.js';

function pick(list, re) {
  const item = (list || []).find((x) => re.test(x.concept));
  return item ? item.amount : 0;
}

export async function preparePila(periodId, { user }) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new Error('Periodo no encontrado');
  if (!['calculated', 'closed'].includes(period.status)) throw new Error('Calcula la nómina del periodo antes de preparar PILA');

  const items = await prisma.payrollItem.findMany({ where: { periodId }, include: { employee: true } });
  if (!items.length) throw new Error('El periodo no tiene empleados liquidados');

  const rows = [];
  const inconsistencies = [];
  let totalIBC = 0, totalContrib = 0;

  for (const it of items) {
    let b = {};
    try { b = JSON.parse(it.breakdown); } catch { b = {}; }
    const ded = b.deductions || [], emp = b.employer || [];
    const ibc = b.IBC || 0;
    const salud = pick(ded, /Salud empleado/) + pick(emp, /Salud empleador/);
    const pension = pick(ded, /Pensi[oó]n empleado/) + pick(emp, /Pensi[oó]n empleador/);
    const fsp = pick(ded, /Solidaridad/);
    const arl = pick(emp, /ARL/);
    const ccf = pick(emp, /Caja de compensaci/);
    const sena = pick(emp, /SENA/);
    const icbf = pick(emp, /ICBF/);
    const total = money(salud + pension + fsp + arl + ccf + sena + icbf);

    const e = it.employee;
    const missing = [];
    if (!e.eps) missing.push('EPS');
    if (!e.afp) missing.push('AFP');
    if (!e.arl) missing.push('ARL');
    if (missing.length) inconsistencies.push({ employee: e.fullName, missing });

    rows.push({
      employee: e.fullName, document: e.documentNumber,
      eps: e.eps, afp: e.afp, arl: e.arl, ccf: e.ccf,
      ibc: money(ibc), salud: money(salud), pension: money(pension), fsp: money(fsp),
      arlAmt: money(arl), ccf: money(ccf), sena: money(sena), icbf: money(icbf), total,
    });
    totalIBC += ibc; totalContrib += total;
  }

  const pila = await prisma.pilaFile.upsert({
    where: { periodId },
    create: {
      companyId: period.companyId, propertyId: period.propertyId, periodId,
      year: period.year, month: period.month, employeeCount: items.length,
      totalIBC: money(totalIBC), totalContributions: money(totalContrib),
      rows: JSON.stringify(rows), inconsistencies: inconsistencies.length ? JSON.stringify(inconsistencies) : null,
      preparedBy: user?.name || null,
    },
    update: {
      employeeCount: items.length, totalIBC: money(totalIBC), totalContributions: money(totalContrib),
      rows: JSON.stringify(rows), inconsistencies: inconsistencies.length ? JSON.stringify(inconsistencies) : null,
      status: 'prepared', paidAt: null, paymentSupport: null,
    },
  });
  await audit({ companyId: period.companyId, propertyId: period.propertyId, user, action: 'pila.prepared', entity: 'PilaFile', entityId: pila.id, after: { period: `${period.month}/${period.year}`, total: money(totalContrib) } });
  emitEvent('pila.prepared', { propertyId: period.propertyId, entityId: pila.id });
  if (inconsistencies.length) emitEvent('pila.inconsistency_detected', { propertyId: period.propertyId, entityId: pila.id });
  return pila;
}

export async function registerPilaPayment(pilaId, { support, user }) {
  const pila = await prisma.pilaFile.findUnique({ where: { id: pilaId } });
  if (!pila) throw new Error('Planilla PILA no encontrada');
  const updated = await prisma.pilaFile.update({ where: { id: pilaId }, data: { status: 'paid', paymentSupport: support || null, paidAt: new Date() } });
  await audit({ companyId: pila.companyId, propertyId: pila.propertyId, user, action: 'pila.payment_registered', entity: 'PilaFile', entityId: pilaId, after: { support } });
  emitEvent('pila.payment_registered', { propertyId: pila.propertyId, entityId: pilaId });
  return updated;
}

export function pilaCsv(pila) {
  const rows = JSON.parse(pila.rows);
  const header = ['Documento', 'Empleado', 'EPS', 'AFP', 'ARL', 'IBC', 'Salud', 'Pension', 'FSP', 'ARL$', 'CCF', 'SENA', 'ICBF', 'Total'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([r.document, `"${r.employee}"`, `"${r.eps || ''}"`, `"${r.afp || ''}"`, `"${r.arl || ''}"`, r.ibc, r.salud, r.pension, r.fsp, r.arlAmt, r.ccf, r.sena, r.icbf, r.total].join(','));
  }
  return lines.join('\n');
}
