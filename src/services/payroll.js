// Atria People (secciones 19-24) — nómina colombiana con parámetros legales
// versionados por vigencia (nada quemado en código, sección 3 del documento).
// La IA/el sistema calculan y explican; cerrar nómina exige aprobación humana.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { money } from '../lib/util.js';

// Parámetro legal vigente a una fecha (versionado)
export async function getParam(companyId, key, date = new Date(), fallback = null) {
  const p = await prisma.legalParameter.findFirst({
    where: {
      companyId, key,
      validFrom: { lte: date },
      OR: [{ validTo: null }, { validTo: { gte: date } }],
    },
    orderBy: { validFrom: 'desc' },
  });
  if (!p && fallback === null) throw new Error(`Parámetro legal ${key} sin vigencia para ${date.toISOString().slice(0, 10)}. Regístralo en Configuración.`);
  return p ? p.value : fallback;
}

const NOVELTY_TYPES = {
  overtime_day: { label: 'Hora extra diurna', unit: 'hours', paramKey: 'HORA_EXTRA_DIURNA' },
  overtime_night: { label: 'Hora extra nocturna', unit: 'hours', paramKey: 'HORA_EXTRA_NOCTURNA' },
  night_surcharge: { label: 'Recargo nocturno', unit: 'hours', paramKey: 'RECARGO_NOCTURNO' },
  sunday_holiday: { label: 'Dominical/festivo', unit: 'hours', paramKey: 'RECARGO_DOMINICAL' },
  absence: { label: 'Ausencia no remunerada', unit: 'days' },
  incapacity: { label: 'Incapacidad', unit: 'days' },
  vacation: { label: 'Vacaciones', unit: 'days' },
  bonus: { label: 'Bonificación', unit: 'amount' },
  commission: { label: 'Comisión', unit: 'amount' },
  deduction: { label: 'Deducción', unit: 'amount' },
  loan: { label: 'Préstamo/anticipo', unit: 'amount' },
};

export function noveltyTypes() {
  return Object.entries(NOVELTY_TYPES).map(([k, v]) => ({ type: k, ...v }));
}

// Liquida un empleado en un periodo. Devuelve breakdown transparente para
// revisión del contador (criterio 50.9: cálculos con tablas parametrizadas).
export async function calculateEmployee({ employee, companyId, periodStart, periodEnd, novelties }) {
  const at = periodEnd;
  const SMMLV = await getParam(companyId, 'SMMLV', at);
  const AUX = await getParam(companyId, 'AUX_TRANSPORTE', at);
  const HORAS_MES = await getParam(companyId, 'HORAS_MES', at, 220);

  const monthDays = 30; // convención laboral colombiana
  // Días del mes cubiertos por el contrato
  let contractDays = monthDays;
  if (employee.hireDate > periodStart) {
    contractDays = Math.max(0, monthDays - Math.floor((employee.hireDate - periodStart) / 86400000));
  }
  if (employee.endDate && employee.endDate < periodEnd) {
    contractDays = Math.min(contractDays, Math.max(0, Math.floor((employee.endDate - periodStart) / 86400000) + 1));
  }

  const absenceDays = novelties.filter(n => n.type === 'absence').reduce((s, n) => s + (n.days || 0), 0);
  const incapacityDays = novelties.filter(n => n.type === 'incapacity').reduce((s, n) => s + (n.days || 0), 0);
  const daysWorked = Math.max(0, contractDays - absenceDays - incapacityDays);

  const dailySalary = employee.salary / monthDays;
  const hourlyRate = employee.salary / HORAS_MES;

  // ---- Devengados ----
  const earned = [];
  earned.push({ concept: 'Salario básico', detail: `${daysWorked} día(s)`, amount: money(dailySalary * daysWorked), salarial: true });

  // Incapacidad: 66.67% del salario (a cargo del empleador/EPS según el caso)
  if (incapacityDays > 0) {
    earned.push({ concept: 'Auxilio incapacidad (66.67%)', detail: `${incapacityDays} día(s)`, amount: money(dailySalary * incapacityDays * (2 / 3)), salarial: true });
  }

  // Horas extras y recargos con tarifas parametrizadas
  for (const [type, def] of Object.entries(NOVELTY_TYPES)) {
    if (def.unit !== 'hours') continue;
    const hours = novelties.filter(n => n.type === type).reduce((s, n) => s + (n.hours || 0), 0);
    if (hours > 0) {
      const pct = await getParam(companyId, def.paramKey, at);
      const isExtra = type.startsWith('overtime');
      // Hora extra: hora completa + recargo. Recargo: solo el porcentaje.
      const rate = isExtra ? hourlyRate * (1 + pct) : hourlyRate * pct;
      earned.push({ concept: def.label, detail: `${hours} h × ${money(rate)}`, amount: money(rate * hours), salarial: true });
    }
  }

  for (const type of ['bonus', 'commission']) {
    const amount = novelties.filter(n => n.type === type).reduce((s, n) => s + (n.amount || 0), 0);
    if (amount > 0) earned.push({ concept: NOVELTY_TYPES[type].label, amount: money(amount), salarial: true });
  }

  const salarialEarned = earned.filter(e => e.salarial).reduce((s, e) => s + e.amount, 0);

  // Auxilio de transporte: si salario ≤ 2 SMMLV
  if (employee.salary <= 2 * SMMLV && daysWorked > 0) {
    earned.push({ concept: 'Auxilio de transporte', detail: `${daysWorked} día(s)`, amount: money((AUX / monthDays) * daysWorked), salarial: false });
  }
  const totalEarned = earned.reduce((s, e) => s + e.amount, 0);

  // ---- Deducciones del empleado ----
  const IBC = Math.max(salarialEarned, daysWorked > 0 ? SMMLV * (daysWorked / monthDays) : 0);
  const saludPct = await getParam(companyId, 'SALUD_EMPLEADO', at);
  const pensionPct = await getParam(companyId, 'PENSION_EMPLEADO', at);
  const fspUmbral = await getParam(companyId, 'FSP_UMBRAL_SMMLV', at, 4);

  const deductions = [
    { concept: 'Salud empleado', detail: `${saludPct * 100}% de IBC`, amount: money(IBC * saludPct) },
    { concept: 'Pensión empleado', detail: `${pensionPct * 100}% de IBC`, amount: money(IBC * pensionPct) },
  ];
  if (IBC >= fspUmbral * SMMLV) {
    deductions.push({ concept: 'Fondo de Solidaridad Pensional', detail: '1% de IBC', amount: money(IBC * 0.01) });
  }
  for (const type of ['deduction', 'loan']) {
    const amount = novelties.filter(n => n.type === type).reduce((s, n) => s + (n.amount || 0), 0);
    if (amount > 0) deductions.push({ concept: NOVELTY_TYPES[type].label, amount: money(amount) });
  }
  const totalDeductions = deductions.reduce((s, d) => s + d.amount, 0);

  // ---- Costos patronales + provisiones (informativos para gerencia) ----
  const arlPct = await getParam(companyId, `ARL_CLASE_${employee.riskClass}`, at);
  const employer = [
    { concept: 'Salud empleador', amount: money(IBC * await getParam(companyId, 'SALUD_EMPLEADOR', at)) },
    { concept: 'Pensión empleador', amount: money(IBC * await getParam(companyId, 'PENSION_EMPLEADOR', at)) },
    { concept: `ARL clase ${employee.riskClass}`, amount: money(IBC * arlPct) },
    { concept: 'Caja de compensación', amount: money(IBC * await getParam(companyId, 'CCF', at)) },
    { concept: 'SENA', amount: money(IBC * await getParam(companyId, 'SENA', at)) },
    { concept: 'ICBF', amount: money(IBC * await getParam(companyId, 'ICBF', at)) },
  ];
  const provisionBase = salarialEarned + (earned.find(e => e.concept === 'Auxilio de transporte')?.amount || 0);
  const provisions = [
    { concept: 'Provisión prima', amount: money(provisionBase * await getParam(companyId, 'PRIMA_PCT', at)) },
    { concept: 'Provisión cesantías', amount: money(provisionBase * await getParam(companyId, 'CESANTIAS_PCT', at)) },
    { concept: 'Provisión intereses cesantías', amount: money(provisionBase * await getParam(companyId, 'INT_CESANTIAS_PCT', at)) },
    { concept: 'Provisión vacaciones', amount: money(salarialEarned * await getParam(companyId, 'VACACIONES_PCT', at)) },
  ];
  const employerCost = employer.reduce((s, e) => s + e.amount, 0) + provisions.reduce((s, p) => s + p.amount, 0);

  return {
    daysWorked,
    breakdown: { earned, deductions, employer, provisions, IBC: money(IBC) },
    earned: money(totalEarned),
    deductions: money(totalDeductions),
    net: money(totalEarned - totalDeductions),
    employerCost: money(employerCost),
  };
}

export async function calculatePeriod(periodId, { user = null } = {}) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId }, include: { property: true } });
  if (!period) throw new Error('Periodo no encontrado');
  if (period.status === 'closed') throw new Error('El periodo ya está cerrado');

  const periodStart = new Date(Date.UTC(period.year, period.month - 1, 1));
  const periodEnd = new Date(Date.UTC(period.year, period.month, 0));

  const employees = await prisma.employee.findMany({
    where: {
      propertyId: period.propertyId,
      status: 'active',
      hireDate: { lte: periodEnd },
      OR: [{ endDate: null }, { endDate: { gte: periodStart } }],
    },
  });
  if (!employees.length) throw new Error('No hay empleados activos para liquidar en este periodo');

  // Recalcular desde cero (idempotente mientras el periodo esté abierto)
  await prisma.payrollItem.deleteMany({ where: { periodId } });

  let totals = { earned: 0, deductions: 0, net: 0, employerCost: 0 };
  const warnings = [];
  for (const employee of employees) {
    const novelties = await prisma.payrollNovelty.findMany({
      where: {
        employeeId: employee.id, status: 'approved',
        date: { gte: periodStart, lte: new Date(periodEnd.getTime() + 86399000) },
      },
    });
    const pendingCount = await prisma.payrollNovelty.count({
      where: { employeeId: employee.id, status: 'pending', date: { gte: periodStart, lte: periodEnd } },
    });
    if (pendingCount > 0) warnings.push(`${employee.fullName}: ${pendingCount} novedad(es) sin aprobar no incluidas`);
    if (!employee.eps || !employee.afp) warnings.push(`${employee.fullName}: afiliaciones incompletas (EPS/AFP)`);

    const calc = await calculateEmployee({ employee, companyId: period.companyId, periodStart, periodEnd, novelties });
    await prisma.payrollItem.create({
      data: {
        periodId, employeeId: employee.id,
        daysWorked: calc.daysWorked,
        breakdown: JSON.stringify(calc.breakdown),
        earned: calc.earned, deductions: calc.deductions, net: calc.net, employerCost: calc.employerCost,
      },
    });
    // Marcar novedades como liquidadas en este periodo
    await prisma.payrollNovelty.updateMany({ where: { id: { in: novelties.map(n => n.id) } }, data: { periodId } });
    totals.earned += calc.earned; totals.deductions += calc.deductions;
    totals.net += calc.net; totals.employerCost += calc.employerCost;
  }

  const updated = await prisma.payrollPeriod.update({
    where: { id: periodId },
    data: {
      status: 'calculated',
      totalEarned: money(totals.earned), totalDeductions: money(totals.deductions),
      totalNet: money(totals.net), totalEmployerCost: money(totals.employerCost),
      calculatedAt: new Date(),
    },
  });
  await audit({ companyId: period.companyId, propertyId: period.propertyId, user, action: 'payroll.calculated', entity: 'PayrollPeriod', entityId: periodId, after: { employees: employees.length, net: money(totals.net) } });
  emitEvent('payroll.calculated', { propertyId: period.propertyId, entityId: periodId });
  return { period: updated, warnings, employees: employees.length };
}

export async function closePeriod(periodId, { user }) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new Error('Periodo no encontrado');
  if (period.status !== 'calculated') throw new Error('El periodo debe estar calculado antes de cerrar');
  const updated = await prisma.payrollPeriod.update({
    where: { id: periodId },
    data: { status: 'closed', closedAt: new Date(), closedBy: user?.name || null },
  });
  await audit({ companyId: period.companyId, propertyId: period.propertyId, user, action: 'payroll.closed', entity: 'PayrollPeriod', entityId: periodId });
  emitEvent('payroll.closed', { propertyId: period.propertyId, entityId: periodId });
  return updated;
}

// Simulador de liquidación de contrato (sección 24) — solo preliminar
export async function simulateLiquidation({ employeeId, endDate, cause = 'renuncia' }) {
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee) throw new Error('Empleado no encontrado');
  const companyId = employee.companyId;
  const end = endDate ? new Date(endDate) : new Date();
  const SMMLV = await getParam(companyId, 'SMMLV', end);
  const AUX = await getParam(companyId, 'AUX_TRANSPORTE', end);

  const base = employee.salary + (employee.salary <= 2 * SMMLV ? AUX : 0);
  const yearStart = new Date(Date.UTC(end.getUTCFullYear(), 0, 1));
  const semStart = end.getUTCMonth() < 6 ? yearStart : new Date(Date.UTC(end.getUTCFullYear(), 6, 1));
  const from = employee.hireDate > yearStart ? employee.hireDate : yearStart;
  const semFrom = employee.hireDate > semStart ? employee.hireDate : semStart;

  const days360 = (a, b) => Math.max(0, Math.round((b - a) / 86400000) * (360 / 365));
  const daysYear = days360(from, end);
  const daysSem = days360(semFrom, end);
  const totalDays = days360(employee.hireDate, end);

  const cesantias = money(base * daysYear / 360);
  const intCesantias = money(cesantias * 0.12 * daysYear / 360);
  const prima = money(base * daysSem / 360);
  const vacaciones = money(employee.salary * totalDays / 720); // 15 días por año sobre salario (sin haber tomado)

  let indemnizacion = 0;
  if (cause === 'sin_justa_causa' && employee.contractType === 'indefinido') {
    const years = totalDays / 360;
    const dias = employee.salary < 10 * SMMLV
      ? 30 + Math.max(0, Math.ceil(years - 1)) * 20
      : 20 + Math.max(0, Math.ceil(years - 1)) * 15;
    indemnizacion = money((employee.salary / 30) * dias);
  }

  const items = [
    { concept: 'Cesantías (año en curso)', amount: cesantias },
    { concept: 'Intereses de cesantías (12% anual)', amount: intCesantias },
    { concept: 'Prima proporcional (semestre)', amount: prima },
    { concept: 'Vacaciones no disfrutadas (estimado)', amount: vacaciones },
    ...(indemnizacion ? [{ concept: `Indemnización (${cause})`, amount: indemnizacion }] : []),
  ];
  return {
    employee: { id: employee.id, name: employee.fullName, salary: employee.salary, hireDate: employee.hireDate, contractType: employee.contractType },
    endDate: end, cause,
    items,
    total: money(items.reduce((s, i) => s + i.amount, 0)),
    note: 'Cálculo preliminar de simulación. La liquidación definitiva requiere revisión del contador y aprobación del dueño (matriz de autorización, sección 47).',
  };
}
