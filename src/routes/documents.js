// Centro documental (§43), plantillas y políticas (§7), motor de reglas (§39).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { storeDocument, readDocumentFile, softDeleteDocument, isLegalDoc, checkExpiringDocuments } from '../services/documents.js';
import { runComplianceRules, ensureDefaultRules } from '../services/rulesEngine.js';
import { requestApproval } from '../services/approvals.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const documentsRouter = Router();

// ---- Documentos ----
documentsRouter.get('/', requirePermission('documents.view'), async (req, res) => {
  const { entityType, entityId, docType, expiring, q } = req.query;
  const where = { companyId: req.user.companyId, status: { notIn: ['deleted', 'superseded'] } };
  if (entityType) where.entityType = entityType;
  if (entityId) where.entityId = entityId;
  if (docType) where.docType = docType;
  if (expiring === 'true') {
    where.expiryDate = { not: null, lte: new Date(Date.now() + 45 * 86400000) };
    where.status = 'active';
  }
  if (q) where.title = { contains: q };
  res.json(await prisma.document.findMany({ where, orderBy: { createdAt: 'desc' }, take: 300 }));
});

documentsRouter.post('/', requirePermission('documents.manage'), async (req, res) => {
  const { propertyId, entityType, entityId, docType, title, fileName, mimeType, base64, issueDate, expiryDate, supersedesId } = req.body || {};
  if (propertyId && !propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const doc = await storeDocument({
      companyId: req.user.companyId, propertyId: propertyId || null,
      entityType, entityId, docType: docType || 'other', title, fileName, mimeType, base64,
      issueDate, expiryDate, supersedesId: supersedesId || null, uploadedBy: req.user.name,
    });
    res.status(201).json(doc);
  } catch (err) { badRequest(res, err.message); }
});

documentsRouter.get('/:id/download', requirePermission('documents.view'), async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc || doc.companyId !== req.user.companyId || doc.status === 'deleted') return res.status(404).json({ error: 'Documento no encontrado' });
  try {
    const buffer = await readDocumentFile(doc);
    res.setHeader('Content-Type', doc.mimeType || 'application/octet-stream');
    res.setHeader('Content-Disposition', `inline; filename="${encodeURIComponent(doc.fileName)}"`);
    res.end(buffer);
  } catch (err) { res.status(404).json({ error: err.message }); }
});

documentsRouter.delete('/:id', requirePermission('documents.manage'), async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.id } });
  if (!doc || doc.companyId !== req.user.companyId) return res.status(404).json({ error: 'Documento no encontrado' });
  // Eliminar documento legal requiere aprobación (§43)
  if (isLegalDoc(doc.docType)) {
    const approval = await requestApproval({
      propertyId: doc.propertyId || (await prisma.property.findFirst({ where: { companyId: req.user.companyId } }))?.id,
      type: 'document_delete',
      summary: `Eliminar documento legal "${doc.title}" (${doc.docType})`,
      payload: { documentId: doc.id },
      requiredRole: 'OWNER', user: req.user,
    });
    return res.status(202).json({ pendingApproval: approval });
  }
  res.json(await softDeleteDocument(doc.id, { user: req.user }));
});

// ---- Plantillas de mensajes ----
documentsRouter.get('/templates/list', requirePermission('settings.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.messageTemplate.findMany({ where: { propertyId }, orderBy: { name: 'asc' } }));
});

documentsRouter.post('/templates', requirePermission('settings.edit'), async (req, res) => {
  const { propertyId, channel, name, subject, body, lang } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!channel || !name || !body) return badRequest(res, 'channel, name y body son requeridos');
  try {
    const tpl = await prisma.messageTemplate.upsert({
      where: { propertyId_name: { propertyId, name } },
      update: { channel, subject, body, lang: lang || 'es' },
      create: { propertyId, channel, name, subject, body, lang: lang || 'es' },
    });
    await audit({ propertyId, user: req.user, action: 'template.saved', entity: 'MessageTemplate', entityId: tpl.id, after: { name, channel } });
    res.status(201).json(tpl);
  } catch (err) { badRequest(res, err.message); }
});

// ---- Políticas hoteleras ----
documentsRouter.get('/policies/list', requirePermission('settings.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.hotelPolicy.findMany({ where: { propertyId }, orderBy: { type: 'asc' } }));
});

documentsRouter.post('/policies', requirePermission('settings.edit'), async (req, res) => {
  const { propertyId, type, title, conditions, penalty, publicText } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!type || !title) return badRequest(res, 'type y title son requeridos');
  const policy = await prisma.hotelPolicy.create({ data: { propertyId, type, title, conditions, penalty, publicText, validFrom: new Date() } });
  // Cambiar/crear política pública es sensible: se registra en auditoría (§9/§7)
  await audit({ propertyId, user: req.user, action: 'policy.created', entity: 'HotelPolicy', entityId: policy.id, after: { type, title } });
  res.status(201).json(policy);
});

// ---- Motor de reglas (§39) ----
documentsRouter.get('/rules/list', requirePermission('compliance.view'), async (req, res) => {
  await ensureDefaultRules(req.user.companyId);
  res.json(await prisma.complianceRule.findMany({ where: { companyId: req.user.companyId }, orderBy: { key: 'asc' } }));
});

documentsRouter.patch('/rules/:id', requirePermission('settings.edit'), async (req, res) => {
  const rule = await prisma.complianceRule.findUnique({ where: { id: req.params.id } });
  if (!rule || rule.companyId !== req.user.companyId) return res.status(404).json({ error: 'Regla no encontrada' });
  const allowed = ['name', 'severity', 'thresholdDays', 'audienceRole', 'active'];
  const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  if (data.thresholdDays !== undefined) data.thresholdDays = data.thresholdDays === null ? null : +data.thresholdDays;
  const updated = await prisma.complianceRule.update({ where: { id: rule.id }, data });
  await audit({ companyId: req.user.companyId, user: req.user, action: 'rule.updated', entity: 'ComplianceRule', entityId: rule.id, before: rule, after: data });
  res.json(updated);
});

documentsRouter.post('/rules/run', requirePermission('compliance.view'), async (req, res) => {
  await ensureDefaultRules(req.user.companyId);
  const findings = await runComplianceRules(req.user.companyId);
  res.json({ findings: findings.length, detail: findings });
});
