// Reputación & reseñas (§37) — panel del equipo.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { reputationOverview, createReview, respondReview, draftResponse } from '../services/reputation.js';
import { surveysOverview, createComplaint, updateComplaint } from '../services/surveys.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const reputationRouter = Router();

reputationRouter.get('/overview', requirePermission('reputation.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await reputationOverview(req.query.propertyId));
});

// ---- Encuestas y quejas (§37) ----
reputationRouter.get('/surveys', requirePermission('reputation.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await surveysOverview(req.query.propertyId));
});

reputationRouter.post('/complaints', requirePermission('reputation.respond'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.status(201).json(await createComplaint({ ...req.body, source: 'manual', user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

reputationRouter.patch('/complaints/:id', requirePermission('reputation.respond'), async (req, res) => {
  const c = await prisma.complaint.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Queja no encontrada' });
  try { res.json(await updateComplaint(c.id, { ...req.body, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// Registro manual (p.ej. importar una reseña de una OTA).
reputationRouter.post('/reviews', requirePermission('reputation.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const r = await createReview(req.body);
    await audit({ propertyId: r.propertyId, user: req.user, action: 'review.created', entity: 'Review', entityId: r.id, after: { rating: r.rating, source: r.source } });
    res.status(201).json(r);
  } catch (err) { badRequest(res, err.message); }
});

// Sugerencia de respuesta (IA/ayudante interno) con el tono del hotel.
reputationRouter.get('/reviews/:id/draft', requirePermission('reputation.respond'), async (req, res) => {
  const rev = await prisma.review.findUnique({ where: { id: req.params.id } });
  if (!rev || !propertyScope(req, rev.propertyId)) return res.status(404).json({ error: 'Reseña no encontrada' });
  res.json({ draft: await draftResponse(rev.propertyId, rev) });
});

reputationRouter.post('/reviews/:id/respond', requirePermission('reputation.respond'), async (req, res) => {
  const rev = await prisma.review.findUnique({ where: { id: req.params.id } });
  if (!rev || !propertyScope(req, rev.propertyId)) return res.status(404).json({ error: 'Reseña no encontrada' });
  try { res.json(await respondReview(rev.id, { response: req.body?.response, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});
