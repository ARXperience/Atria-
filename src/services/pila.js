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

// Archivo plano PILA en estructura de Registro Tipo 1 (control) + Registro
// Tipo 2 (liquidación por cotizante), fiel al ordenamiento de la Resolución
// 1388/2016. Los campos que no expone el perfil de empleado (subtipo, novedades,
// exterior) usan los valores por defecto del cotizante dependiente (tipo 01);
// para 100% de compatibilidad con un operador se enriquece el expediente con
// apellidos/nombres separados y tipo de cotizante. Formato: campos delimitados.
function padNum(n, width) { return String(Math.round(Number(n) || 0)).padStart(width, '0'); }
function padStr(s, width) { return String(s || '').slice(0, width).padEnd(width, ' '); }
function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  // Heurística CO: los 2 últimos tokens son apellidos, el resto nombres.
  const ap1 = parts.length >= 2 ? parts[parts.length - 2] : (parts[0] || '');
  const ap2 = parts.length >= 2 ? parts[parts.length - 1] : '';
  const nombres = parts.slice(0, Math.max(1, parts.length - 2)).join(' ') || parts[0] || '';
  return { ap1, ap2, nombres };
}

export function pilaFlatFile(pila, company) {
  const rows = JSON.parse(pila.rows);
  const periodo = `${pila.year}-${String(pila.month).padStart(2, '0')}`;
  // Registro Tipo 1 — control del aportante.
  const t1 = [
    '1',                                   // tipo de registro
    'E',                                   // modalidad de la planilla (E: empresas)
    padNum(1, 10),                         // secuencia de la planilla
    'NI',                                  // tipo de documento del aportante
    padStr(company?.nit || '', 16),        // número de documento del aportante
    padStr(company?.name || '', 200),      // razón social
    periodo,                               // periodo de pago pensiones/salud (AAAA-MM)
    padNum(pila.employeeCount, 5),         // total de cotizantes
    padNum(pila.totalIBC, 12),             // total IBC
    padNum(pila.totalContributions, 12),   // total aportes
  ].join('|');
  // Registro Tipo 2 — liquidación de aportes por cotizante.
  const t2 = rows.map((r, i) => {
    const { ap1, ap2, nombres } = splitName(r.employee);
    return [
      '2',                        // tipo de registro
      padNum(i + 1, 5),           // secuencia del cotizante
      'CC',                       // tipo de documento del cotizante
      padStr(r.document, 16),     // número de documento
      '01',                       // tipo de cotizante (01: dependiente)
      '00',                       // subtipo de cotizante
      padStr(ap1, 20),            // primer apellido
      padStr(ap2, 30),            // segundo apellido
      padStr(nombres, 30),        // nombres
      padNum(30, 2),              // días cotizados (mes completo)
      padNum(r.ibc, 12),          // IBC
      padStr(r.eps || '', 6),     // código EPS
      padNum(r.salud, 12),        // cotización salud
      padStr(r.afp || '', 6),     // código AFP
      padNum(r.pension, 12),      // cotización pensión
      padNum(r.fsp, 12),          // fondo de solidaridad pensional
      padStr(r.arl || '', 6),     // código ARL
      padNum(r.arlAmt, 12),       // cotización riesgos laborales
      padStr(r.ccf || '', 6),     // código CCF
      padNum(r.ccf, 12),          // aporte CCF
      padNum(r.sena, 12),         // aporte SENA
      padNum(r.icbf, 12),         // aporte ICBF
      padNum(r.total, 12),        // total aportes del cotizante
    ].join('|');
  });
  return [t1, ...t2].join('\r\n');
}
