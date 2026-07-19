// SG-SST (§25): matriz de riesgos, incidentes, exámenes médicos, EPP y
// capacitaciones. Cerrar un incidente/plan requiere responsable SG-SST/gerente.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';
import { badRequest, parseDay } from '../lib/util.js';

export const sgsstRouter = Router();

// ---- Panel ----
sgsstRouter.get('/overview', requirePermission('sgsst.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const soon = new Date(Date.now() + 45 * 86400000);
  const [risks, openIncidents, exams, examsExpiring, ppe, trainings] = await Promise.all([
    prisma.sgsstRiskItem.count({ where: { propertyId } }),
    prisma.sgsstIncident.count({ where: { propertyId, status: 'open' } }),
    prisma.medicalExam.count({ where: { propertyId } }),
    prisma.medicalExam.count({ where: { propertyId, validUntil: { not: null, lte: soon } } }),
    prisma.ppeDelivery.count({ where: { propertyId } }),
    prisma.sgsstTraining.count({ where: { propertyId } }),
  ]);
  res.json({ risks, openIncidents, exams, examsExpiring, ppe, trainings });
});

// ---- Matriz de riesgos ----
sgsstRouter.get('/risks', requirePermission('sgsst.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.sgsstRiskItem.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { createdAt: 'desc' } }));
});
sgsstRouter.post('/risks', requirePermission('sgsst.manage'), async (req, res) => {
  const { propertyId, area, hazard, risk, control, position, responsible } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!area || !hazard || !risk) return badRequest(res, 'area, hazard y risk requeridos');
  const item = await prisma.sgsstRiskItem.create({ data: { propertyId, area, hazard, risk, control, position, responsible } });
  await audit({ propertyId, user: req.user, action: 'sgsst.risk_created', entity: 'SgsstRiskItem', entityId: item.id, after: { area, risk } });
  res.status(201).json(item);
});

// ---- Incidentes ----
sgsstRouter.get('/incidents', requirePermission('sgsst.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId: req.query.propertyId };
  if (req.query.status) where.status = req.query.status;
  res.json(await prisma.sgsstIncident.findMany({ where, orderBy: { date: 'desc' }, take: 200 }));
});
sgsstRouter.post('/incidents', requirePermission('sgsst.manage'), async (req, res) => {
  const { propertyId, employeeId, employeeName, date, type, description, severity } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!date || !type || !description) return badRequest(res, 'date, type y description requeridos');
  const inc = await prisma.sgsstIncident.create({ data: { propertyId, employeeId: employeeId || null, employeeName: employeeName || null, date: parseDay(date), type, description, severity: severity || 'leve', createdBy: req.user.name } });
  await audit({ propertyId, user: req.user, action: 'sgsst.incident_reported', entity: 'SgsstIncident', entityId: inc.id, after: { type, severity } });
  emitEvent('sgsst.incident_reported', { propertyId, entityId: inc.id });
  res.status(201).json(inc);
});
sgsstRouter.post('/incidents/:id/close', requirePermission('sgsst.manage'), async (req, res) => {
  const inc = await prisma.sgsstIncident.findUnique({ where: { id: req.params.id } });
  if (!inc || !propertyScope(req, inc.propertyId)) return res.status(404).json({ error: 'Incidente no encontrado' });
  if (!req.body?.actions) return badRequest(res, 'actions (plan de mejora) requerido para cerrar');
  const updated = await prisma.sgsstIncident.update({ where: { id: inc.id }, data: { status: 'closed', actions: req.body.actions, closedAt: new Date() } });
  await audit({ propertyId: inc.propertyId, user: req.user, action: 'sgsst.incident_closed', entity: 'SgsstIncident', entityId: inc.id, after: { actions: req.body.actions } });
  res.json(updated);
});

// ---- Exámenes médicos ----
sgsstRouter.get('/exams', requirePermission('sgsst.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.medicalExam.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { date: 'desc' }, take: 200 }));
});
sgsstRouter.post('/exams', requirePermission('sgsst.manage'), async (req, res) => {
  const { propertyId, employeeId, type, date, validUntil, result, restrictions } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const emp = await prisma.employee.findUnique({ where: { id: employeeId || '' } });
  if (!emp || emp.propertyId !== propertyId) return badRequest(res, 'Empleado inválido');
  if (!type || !date) return badRequest(res, 'type y date requeridos');
  const exam = await prisma.medicalExam.create({ data: { propertyId, employeeId, employeeName: emp.fullName, type, date: parseDay(date), validUntil: validUntil ? parseDay(validUntil) : null, result, restrictions } });
  await audit({ propertyId, user: req.user, action: 'sgsst.exam_created', entity: 'MedicalExam', entityId: exam.id, after: { type, employee: emp.fullName } });
  res.status(201).json(exam);
});

// ---- EPP ----
sgsstRouter.get('/ppe', requirePermission('sgsst.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.ppeDelivery.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { date: 'desc' }, take: 200 }));
});
sgsstRouter.post('/ppe', requirePermission('sgsst.manage'), async (req, res) => {
  const { propertyId, employeeId, item, quantity, date, notes } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const emp = await prisma.employee.findUnique({ where: { id: employeeId || '' } });
  if (!emp || emp.propertyId !== propertyId) return badRequest(res, 'Empleado inválido');
  if (!item) return badRequest(res, 'item requerido');
  const d = await prisma.ppeDelivery.create({ data: { propertyId, employeeId, employeeName: emp.fullName, item, quantity: +quantity || 1, date: date ? parseDay(date) : new Date(), notes } });
  await audit({ propertyId, user: req.user, action: 'sgsst.ppe_delivered', entity: 'PpeDelivery', entityId: d.id, after: { item, employee: emp.fullName } });
  res.status(201).json(d);
});

// ---- Capacitaciones ----
sgsstRouter.get('/trainings', requirePermission('sgsst.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.sgsstTraining.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { date: 'desc' }, take: 200 }));
});
sgsstRouter.post('/trainings', requirePermission('sgsst.manage'), async (req, res) => {
  const { propertyId, title, date, attendees, validUntil } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!title || !date) return badRequest(res, 'title y date requeridos');
  const t = await prisma.sgsstTraining.create({ data: { propertyId, title, date: parseDay(date), attendees: attendees ? JSON.stringify(attendees) : null, validUntil: validUntil ? parseDay(validUntil) : null } });
  await audit({ propertyId, user: req.user, action: 'sgsst.training_created', entity: 'SgsstTraining', entityId: t.id, after: { title } });
  res.status(201).json(t);
});
