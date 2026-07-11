// Cumplimiento (secciones 17, 18 y 39): panel, TRA y SIRE.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { complianceOverview, updateTra, markSireStatus } from '../services/compliance.js';
import { badRequest } from '../lib/util.js';

export const complianceRouter = Router();

complianceRouter.get('/overview', requirePermission('compliance.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await complianceOverview(propertyId));
});

complianceRouter.get('/tra', requirePermission('compliance.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = status;
  res.json(await prisma.traRecord.findMany({ where, include: { reservation: { select: { code: true, checkIn: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }));
});

complianceRouter.patch('/tra/:id', requirePermission('compliance.tra'), async (req, res) => {
  const allowed = ['guestName', 'documentType', 'documentNumber', 'nationality', 'originCity', 'destinationCity', 'travelReason'];
  const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  try {
    res.json(await updateTra(req.params.id, data, { user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

complianceRouter.get('/sire', requirePermission('compliance.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = status;
  res.json(await prisma.sireReport.findMany({ where, include: { reservation: { select: { code: true, checkIn: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }));
});

complianceRouter.patch('/sire/:id/status', requirePermission('compliance.sire'), async (req, res) => {
  try {
    res.json(await markSireStatus(req.params.id, { status: req.body?.status, user: req.user, supportNote: req.body?.supportNote }));
  } catch (err) { badRequest(res, err.message); }
});
