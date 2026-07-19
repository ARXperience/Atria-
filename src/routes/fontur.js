// FONTUR — contribución parafiscal del turismo (§27).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { fonturOverview, previewContribution, generateContribution, fileContribution, payContribution } from '../services/fontur.js';
import { badRequest } from '../lib/util.js';

export const fonturRouter = Router();

fonturRouter.get('/overview', requirePermission('fontur.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await fonturOverview(req.query.propertyId));
});

fonturRouter.get('/preview', requirePermission('fontur.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.json(await previewContribution(req.query.propertyId)); }
  catch (err) { badRequest(res, err.message); }
});

fonturRouter.post('/generate', requirePermission('fontur.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.status(201).json(await generateContribution(req.body.propertyId, { createdBy: req.user.name, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

fonturRouter.post('/:id/file', requirePermission('fontur.manage'), async (req, res) => {
  const c = await prisma.fonturContribution.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Contribución no encontrada' });
  try { res.json(await fileContribution(c.id, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

fonturRouter.post('/:id/pay', requirePermission('fontur.manage'), async (req, res) => {
  const c = await prisma.fonturContribution.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Contribución no encontrada' });
  try { res.json(await payContribution(c.id, { support: req.body?.support, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});
