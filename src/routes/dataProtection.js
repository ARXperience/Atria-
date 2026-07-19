// Protección de datos / Habeas Data (§26): consentimientos, solicitudes ARCO,
// inventario RNBD y ejercicio de derechos de acceso/supresión.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import {
  dataProtectionOverview, recordConsent, revokeConsent, createSubjectRequest,
  resolveSubjectRequest, exportSubjectData, eraseSubjectData, ensureTreatments,
} from '../services/dataProtection.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const dataProtectionRouter = Router();

dataProtectionRouter.get('/overview', requirePermission('dataprotection.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await dataProtectionOverview(req.query.propertyId));
});

// ---- Consentimientos ----
dataProtectionRouter.get('/consents', requirePermission('dataprotection.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId: req.query.propertyId };
  if (req.query.purpose) where.purpose = req.query.purpose;
  res.json(await prisma.dataConsent.findMany({ where, orderBy: { grantedAt: 'desc' }, take: 200 }));
});

dataProtectionRouter.post('/consents', requirePermission('dataprotection.consent'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const c = await recordConsent({ ...req.body, createdBy: req.user.name });
    await audit({ propertyId: c.propertyId, user: req.user, action: 'consent.recorded', entity: 'DataConsent', entityId: c.id, after: { purpose: c.purpose, granted: c.granted, subject: c.subjectName } });
    res.status(201).json(c);
  } catch (err) { badRequest(res, err.message); }
});

dataProtectionRouter.post('/consents/:id/revoke', requirePermission('dataprotection.consent'), async (req, res) => {
  const c = await prisma.dataConsent.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Consentimiento no encontrado' });
  try { res.json(await revokeConsent(c.id, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// ---- Solicitudes del titular (ARCO / habeas data) ----
dataProtectionRouter.get('/requests', requirePermission('dataprotection.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId: req.query.propertyId };
  if (req.query.status) where.status = req.query.status;
  res.json(await prisma.dataSubjectRequest.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }));
});

dataProtectionRouter.post('/requests', requirePermission('dataprotection.view'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const r = await createSubjectRequest({ ...req.body, createdBy: req.user.name });
    await audit({ propertyId: r.propertyId, user: req.user, action: 'dsr.created', entity: 'DataSubjectRequest', entityId: r.id, after: { type: r.type, subject: r.subjectName } });
    res.status(201).json(r);
  } catch (err) { badRequest(res, err.message); }
});

dataProtectionRouter.post('/requests/:id/resolve', requirePermission('dataprotection.manage'), async (req, res) => {
  const r = await prisma.dataSubjectRequest.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Solicitud no encontrada' });
  try { res.json(await resolveSubjectRequest(r.id, { status: req.body?.status, resolution: req.body?.resolution, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// Derecho de acceso: exporta la información del titular.
dataProtectionRouter.get('/export', requirePermission('dataprotection.manage'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const data = await exportSubjectData(req.query.propertyId, { documentNumber: req.query.documentNumber });
    await audit({ propertyId: req.query.propertyId, user: req.user, action: 'dsr.export', entity: 'Guest', entityId: req.query.documentNumber, reason: 'Derecho de acceso (Ley 1581)' });
    res.json(data);
  } catch (err) { badRequest(res, err.message); }
});

// Derecho de supresión: anonimiza al titular conservando registros legales.
dataProtectionRouter.post('/erase', requirePermission('dataprotection.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.json(await eraseSubjectData(req.body.propertyId, { documentNumber: req.body.documentNumber, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// ---- Inventario de bases de datos (RNBD) ----
dataProtectionRouter.get('/treatments', requirePermission('dataprotection.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  await ensureTreatments(req.query.propertyId);
  res.json(await prisma.dataTreatment.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { name: 'asc' } }));
});

dataProtectionRouter.post('/treatments', requirePermission('dataprotection.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const { propertyId, name, purpose } = req.body || {};
  if (!name || !purpose) return badRequest(res, 'name y purpose requeridos');
  try {
    const t = await prisma.dataTreatment.upsert({
      where: { propertyId_name: { propertyId, name } },
      update: { purpose: req.body.purpose, legalBasis: req.body.legalBasis, categories: req.body.categories, retention: req.body.retention, security: req.body.security, responsible: req.body.responsible, registeredRnbd: !!req.body.registeredRnbd },
      create: { propertyId, name, purpose, legalBasis: req.body.legalBasis, categories: req.body.categories, retention: req.body.retention, security: req.body.security, responsible: req.body.responsible, registeredRnbd: !!req.body.registeredRnbd },
    });
    res.status(201).json(t);
  } catch (err) { badRequest(res, err.message); }
});
