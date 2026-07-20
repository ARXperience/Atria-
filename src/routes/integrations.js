// Centro de integraciones (§45).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { integrationsOverview, CATALOG, connectIntegration, testIntegration, toggleIntegration } from '../services/integrations.js';
import { badRequest } from '../lib/util.js';

export const integrationsRouter = Router();

integrationsRouter.get('/catalog', requirePermission('integrations.view'), (_req, res) => {
  res.json(CATALOG.map(({ provider, name, category, env, live, fields }) => ({ provider, name, category, managedByEnv: !!env, live: !!live, fields })));
});

integrationsRouter.get('/overview', requirePermission('integrations.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await integrationsOverview(req.query.propertyId));
});

integrationsRouter.post('/:provider/connect', requirePermission('integrations.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.status(201).json(await connectIntegration({ propertyId: req.body.propertyId, provider: req.params.provider, config: req.body.config || {}, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

integrationsRouter.post('/:provider/test', requirePermission('integrations.view'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.json(await testIntegration(req.body.propertyId, req.params.provider, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

integrationsRouter.patch('/:id', requirePermission('integrations.manage'), async (req, res) => {
  const row = await prisma.integration.findUnique({ where: { id: req.params.id } });
  if (!row || !propertyScope(req, row.propertyId)) return res.status(404).json({ error: 'Integración no encontrada' });
  try { res.json(await toggleIntegration(row.id, req.body?.enabled, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});
