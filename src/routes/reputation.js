// Reputación & reseñas (§37) — panel del equipo.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { reputationOverview, createReview, respondReview, draftResponse } from '../services/reputation.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const reputationRouter = Router();

reputationRouter.get('/overview', requirePermission('reputation.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await reputationOverview(req.query.propertyId));
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
