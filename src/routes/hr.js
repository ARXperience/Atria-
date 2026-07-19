// Atria People (secciones 19-24): empleados, novedades y nómina.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { calculatePeriod, closePeriod, simulateLiquidation, noveltyTypes } from '../services/payroll.js';
import { createDraftContract, renderContractText } from '../services/contracts.js';
import { createShift, clockIn, clockOut } from '../services/shifts.js';
import { requestApproval } from '../services/approvals.js';
import { audit } from '../lib/audit.js';
import { badRequest, fmtCOP } from '../lib/util.js';

export const hrRouter = Router();

// ---- Empleados ----
hrRouter.get('/employees', requirePermission('hr.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = status;
  res.json(await prisma.employee.findMany({ where, orderBy: { fullName: 'asc' } }));
});

hrRouter.post('/employees', requirePermission('hr.manage'), async (req, res) => {
  const { propertyId, fullName, documentNumber, position, salary, hireDate } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!fullName || !documentNumber || !position || !(salary > 0) || !hireDate) {
    return badRequest(res, 'fullName, documentNumber, position, salary y hireDate son requeridos');
  }
  const allowed = ['documentType', 'email', 'phone', 'area', 'contractType', 'eps', 'afp', 'arl', 'ccf', 'cesantiasFund', 'riskClass', 'bankAccount'];
  const extra = Object.fromEntries(Object.entries(req.body).filter(([k]) => allowed.includes(k)));
  if (extra.riskClass) extra.riskClass = Math.min(5, Math.max(1, +extra.riskClass));
  try {
    const employee = await prisma.employee.create({
      data: {
        companyId: req.user.companyId, propertyId, fullName,
        documentNumber: String(documentNumber), position, salary: +salary,
        hireDate: new Date(hireDate), ...extra,
      },
    });
    await audit({ companyId: req.user.companyId, propertyId, user: req.user, action: 'employee.created', entity: 'Employee', entityId: employee.id, after: { fullName, position, salary: +salary } });
    res.status(201).json(employee);
  } catch (err) {
    if (String(err.message).includes('Unique constraint')) return badRequest(res, 'Ya existe un empleado con ese documento');
    badRequest(res, err.message);
  }
});

hrRouter.patch('/employees/:id', requirePermission('hr.manage'), async (req, res) => {
  const employee = await prisma.employee.findUnique({ where: { id: req.params.id } });
  if (!employee || !propertyScope(req, employee.propertyId)) return res.status(404).json({ error: 'Empleado no encontrado' });
  const allowed = ['fullName', 'email', 'phone', 'position', 'area', 'eps', 'afp', 'arl', 'ccf', 'cesantiasFund', 'bankAccount', 'riskClass', 'status'];
  const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  // Cambio de salario y terminación requieren dueño (matriz 47)
  if (req.body?.salary !== undefined || data.status === 'terminated' || req.body?.endDate) {
    const approval = await requestApproval({
      propertyId: employee.propertyId, type: 'employee_sensitive_change',
      summary: `Cambio sensible para ${employee.fullName}: ${req.body.salary !== undefined ? `salario ${fmtCOP(employee.salary)} → ${fmtCOP(+req.body.salary)}. ` : ''}${data.status === 'terminated' || req.body?.endDate ? `Terminación de contrato (${req.body.endDate || 'inmediata'}).` : ''}`,
      payload: { employeeId: employee.id, salary: req.body.salary !== undefined ? +req.body.salary : undefined, status: data.status, endDate: req.body.endDate },
      requiredRole: 'OWNER', user: req.user,
    });
    return res.status(202).json({ pendingApproval: approval });
  }
  const updated = await prisma.employee.update({ where: { id: employee.id }, data });
  await audit({ propertyId: employee.propertyId, user: req.user, action: 'employee.updated', entity: 'Employee', entityId: employee.id, before: employee, after: data });
  res.json(updated);
});

// ---- Novedades ----
hrRouter.get('/novelty-types', requirePermission('hr.view'), (_req, res) => res.json(noveltyTypes()));

hrRouter.get('/novelties', requirePermission('hr.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = status;
  res.json(await prisma.payrollNovelty.findMany({ where, include: { employee: { select: { fullName: true } } }, orderBy: { date: 'desc' }, take: 300 }));
});

hrRouter.post('/novelties', requirePermission('hr.create'), async (req, res) => {
  const { propertyId, employeeId, type, date, hours, days, amount, notes } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const valid = noveltyTypes().map(t => t.type);
  if (!valid.includes(type)) return badRequest(res, `Tipo inválido. Use: ${valid.join(', ')}`);
  if (!employeeId || !date) return badRequest(res, 'employeeId y date requeridos');
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee || employee.propertyId !== propertyId) return badRequest(res, 'Empleado inválido');
  const novelty = await prisma.payrollNovelty.create({
    data: {
      propertyId, employeeId, type, date: new Date(date),
      hours: hours ? +hours : null, days: days ? +days : null, amount: amount ? +amount : null, notes,
    },
  });
  await audit({ propertyId, user: req.user, action: 'novelty.created', entity: 'PayrollNovelty', entityId: novelty.id, after: req.body });
  res.status(201).json(novelty);
});

// Aprobar novedad antes de nómina (sección 21)
hrRouter.post('/novelties/:id/decide', requirePermission('hr.approve'), async (req, res) => {
  const novelty = await prisma.payrollNovelty.findUnique({ where: { id: req.params.id } });
  if (!novelty || !propertyScope(req, novelty.propertyId)) return res.status(404).json({ error: 'Novedad no encontrada' });
  if (novelty.status !== 'pending') return badRequest(res, `La novedad ya fue ${novelty.status}`);
  const approve = req.body?.approve !== false;
  const updated = await prisma.payrollNovelty.update({
    where: { id: novelty.id },
    data: { status: approve ? 'approved' : 'rejected', approvedBy: req.user.name },
  });
  await audit({ propertyId: novelty.propertyId, user: req.user, action: approve ? 'novelty.approved' : 'novelty.rejected', entity: 'PayrollNovelty', entityId: novelty.id });
  res.json(updated);
});

// ---- Nómina ----
hrRouter.get('/payroll/periods', requirePermission('payroll.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.payrollPeriod.findMany({ where: { propertyId }, orderBy: [{ year: 'desc' }, { month: 'desc' }], include: { _count: { select: { items: true } } } }));
});

hrRouter.post('/payroll/periods', requirePermission('payroll.manage'), async (req, res) => {
  const { propertyId, year, month } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!year || !month || month < 1 || month > 12) return badRequest(res, 'year y month (1-12) requeridos');
  try {
    const period = await prisma.payrollPeriod.create({ data: { companyId: req.user.companyId, propertyId, year: +year, month: +month } });
    await audit({ propertyId, user: req.user, action: 'payroll.period_created', entity: 'PayrollPeriod', entityId: period.id, after: { year, month } });
    res.status(201).json(period);
  } catch (err) {
    if (String(err.message).includes('Unique constraint')) return badRequest(res, 'Ya existe un periodo para ese mes');
    badRequest(res, err.message);
  }
});

hrRouter.post('/payroll/periods/:id/calculate', requirePermission('payroll.manage'), async (req, res) => {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: req.params.id } });
  if (!period || !propertyScope(req, period.propertyId)) return res.status(404).json({ error: 'Periodo no encontrado' });
  try {
    res.json(await calculatePeriod(period.id, { user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

hrRouter.get('/payroll/periods/:id', requirePermission('payroll.view'), async (req, res) => {
  const period = await prisma.payrollPeriod.findUnique({
    where: { id: req.params.id },
    include: { items: { include: { employee: { select: { fullName: true, position: true, documentNumber: true } } } } },
  });
  if (!period || !propertyScope(req, period.propertyId)) return res.status(404).json({ error: 'Periodo no encontrado' });
  res.json({
    ...period,
    items: period.items.map(i => ({ ...i, breakdown: JSON.parse(i.breakdown) })),
  });
});

// Cerrar nómina exige aprobación del dueño (matriz 47)
hrRouter.post('/payroll/periods/:id/close', requirePermission('payroll.manage'), async (req, res) => {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: req.params.id } });
  if (!period || !propertyScope(req, period.propertyId)) return res.status(404).json({ error: 'Periodo no encontrado' });
  if (period.status !== 'calculated') return badRequest(res, 'Calcula el periodo antes de cerrarlo');
  const approval = await requestApproval({
    propertyId: period.propertyId, type: 'payroll_close',
    summary: `Cerrar nómina ${period.month}/${period.year}: neto a pagar ${fmtCOP(period.totalNet || 0)} + costo patronal ${fmtCOP(period.totalEmployerCost || 0)}`,
    payload: { periodId: period.id },
    requiredRole: 'OWNER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

// ---- Contratos laborales (§20) ----
hrRouter.get('/contracts', requirePermission('hr.view'), async (req, res) => {
  const { propertyId, employeeId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (employeeId) where.employeeId = employeeId;
  const contracts = await prisma.employmentContract.findMany({
    where, include: { employee: { select: { fullName: true } }, _count: { select: { amendments: true } } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json(contracts);
});

hrRouter.get('/contracts/:id/text', requirePermission('hr.view'), async (req, res) => {
  const c = await prisma.employmentContract.findUnique({ where: { id: req.params.id }, include: { amendments: true } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Contrato no encontrado' });
  try {
    res.json({ contract: c, text: await renderContractText(c.id) });
  } catch (err) { badRequest(res, err.message); }
});

hrRouter.post('/contracts', requirePermission('hr.manage'), async (req, res) => {
  const { employeeId } = req.body || {};
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee || !propertyScope(req, employee.propertyId)) return res.status(404).json({ error: 'Empleado no encontrado' });
  const contract = await createDraftContract({ companyId: req.user.companyId, employee, data: req.body, createdBy: req.user.name });
  res.status(201).json(contract);
});

// Activar contrato → aprobación de RR. HH. (matriz §47)
hrRouter.post('/contracts/:id/activate', requirePermission('hr.manage'), async (req, res) => {
  const c = await prisma.employmentContract.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Contrato no encontrado' });
  if (c.status !== 'draft') return badRequest(res, `El contrato ya está ${c.status}`);
  const approval = await requestApproval({
    propertyId: c.propertyId, type: 'contract_activate',
    summary: `Activar contrato ${c.type} de ${c.employee.fullName} — cargo ${c.position}, ${fmtCOP(c.salary)}`,
    payload: { contractId: c.id }, requiredRole: 'HR', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

// Otrosí → aprobación de RR. HH.
hrRouter.post('/contracts/:id/amendments', requirePermission('hr.manage'), async (req, res) => {
  const { changeType, newValue, detail, reason, effectiveDate } = req.body || {};
  const valid = ['salary', 'position', 'workday', 'functions', 'extension'];
  if (!valid.includes(changeType)) return badRequest(res, `changeType inválido. Use: ${valid.join(', ')}`);
  if (newValue === undefined || newValue === '') return badRequest(res, 'newValue requerido');
  const c = await prisma.employmentContract.findUnique({ where: { id: req.params.id }, include: { employee: true } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Contrato no encontrado' });
  const approval = await requestApproval({
    propertyId: c.propertyId, type: 'contract_amend',
    summary: `Otrosí (${changeType}) al contrato de ${c.employee.fullName}: ${detail || newValue}`,
    payload: { contractId: c.id, changeType, newValue, detail, reason, effectiveDate, createdBy: req.user.name },
    requiredRole: 'HR', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

// ---- Turnos y asistencia (§21) ----
hrRouter.get('/shifts', requirePermission('hr.view'), async (req, res) => {
  const { propertyId, from, to } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (from) where.date = { gte: new Date(from) };
  if (to) where.date = { ...(where.date || {}), lte: new Date(to) };
  res.json(await prisma.shiftAssignment.findMany({ where, include: { employee: { select: { fullName: true } } }, orderBy: { date: 'asc' }, take: 300 }));
});

hrRouter.post('/shifts', requirePermission('hr.manage'), async (req, res) => {
  const { propertyId, employeeId, date, startTime, endTime, area, notes } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!employeeId || !date || !startTime || !endTime) return badRequest(res, 'employeeId, date, startTime y endTime requeridos');
  try {
    res.status(201).json(await createShift({ propertyId, employeeId, date, startTime, endTime, area, notes, createdBy: req.user.name }));
  } catch (err) { badRequest(res, err.message); }
});

hrRouter.get('/attendance', requirePermission('hr.view'), async (req, res) => {
  const { propertyId, date } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (date) where.date = new Date(date);
  res.json(await prisma.attendanceRecord.findMany({ where, include: { employee: { select: { fullName: true } } }, orderBy: { clockIn: 'desc' }, take: 200 }));
});

hrRouter.post('/attendance/clock', requirePermission('hr.create'), async (req, res) => {
  const { propertyId, employeeId, type, at } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!employeeId || !['in', 'out'].includes(type)) return badRequest(res, 'employeeId y type (in|out) requeridos');
  try {
    const result = type === 'in'
      ? await clockIn({ propertyId, employeeId, at: at || null })
      : await clockOut({ propertyId, employeeId, at: at || null });
    res.status(201).json(result);
  } catch (err) { badRequest(res, err.message); }
});

// Simulador de liquidación (sección 24)
hrRouter.post('/liquidations/simulate', requirePermission('hr.view'), async (req, res) => {
  const { employeeId, endDate, cause } = req.body || {};
  if (!employeeId) return badRequest(res, 'employeeId requerido');
  const employee = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!employee || !propertyScope(req, employee.propertyId)) return res.status(404).json({ error: 'Empleado no encontrado' });
  try {
    res.json(await simulateLiquidation({ employeeId, endDate, cause }));
  } catch (err) { badRequest(res, err.message); }
});
