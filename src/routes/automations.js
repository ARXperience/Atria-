// Automatizador visual (§40) — reglas no-code definidas por el usuario.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { automationsOverview, TRIGGERS, ACTIONS, createRule, toggleRule, testRule, suggestRules } from '../services/automationRules.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const automationsRouter = Router();

automationsRouter.get('/catalog', requirePermission('automations.view'), (_req, res) => {
  res.json({ triggers: TRIGGERS, actions: ACTIONS });
});

automationsRouter.get('/overview', requirePermission('automations.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await automationsOverview(req.query.propertyId));
});

// Sugerencias de reglas según el estado actual de la sede (IA).
automationsRouter.get('/suggestions', requirePermission('automations.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await suggestRules(req.query.propertyId));
});

automationsRouter.post('/rules', requirePermission('automations.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const r = await createRule({ ...req.body, createdBy: req.user.name });
    await audit({ propertyId: r.propertyId, user: req.user, action: 'automation.rule_created', entity: 'AutomationRule', entityId: r.id, after: { name: r.name, trigger: r.trigger, action: r.actionType } });
    res.status(201).json(r);
  } catch (err) { badRequest(res, err.message); }
});

automationsRouter.patch('/rules/:id', requirePermission('automations.manage'), async (req, res) => {
  const r = await prisma.automationRule.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Regla no encontrada' });
  try { res.json(await toggleRule(r.id, req.body?.enabled)); }
  catch (err) { badRequest(res, err.message); }
});

automationsRouter.post('/rules/:id/test', requirePermission('automations.manage'), async (req, res) => {
  const r = await prisma.automationRule.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Regla no encontrada' });
  try { res.json(await testRule(r.id, req.body?.payload || {})); }
  catch (err) { badRequest(res, err.message); }
});

automationsRouter.delete('/rules/:id', requirePermission('automations.manage'), async (req, res) => {
  const r = await prisma.automationRule.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Regla no encontrada' });
  await prisma.automationRule.delete({ where: { id: r.id } });
  await audit({ propertyId: r.propertyId, user: req.user, action: 'automation.rule_deleted', entity: 'AutomationRule', entityId: r.id });
  res.json({ ok: true });
});
