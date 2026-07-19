// Marketing & campañas (§36).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { marketingOverview, buildAudience, createCampaign, sendCampaign, cancelCampaign } from '../services/marketing.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const marketingRouter = Router();

marketingRouter.get('/overview', requirePermission('marketing.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await marketingOverview(req.query.propertyId));
});

// Previsualiza el tamaño de la audiencia elegible (respetando consentimiento).
marketingRouter.get('/audience', requirePermission('marketing.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const { eligible, skippedNoConsent } = await buildAudience(req.query.propertyId, { channel: req.query.channel, audience: req.query.audience, segment: req.query.segment });
    res.json({ eligible: eligible.length, skippedNoConsent });
  } catch (err) { badRequest(res, err.message); }
});

marketingRouter.post('/campaigns', requirePermission('marketing.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const c = await createCampaign({ ...req.body, createdBy: req.user.name });
    await audit({ propertyId: c.propertyId, user: req.user, action: 'campaign.created', entity: 'Campaign', entityId: c.id, after: { name: c.name, channel: c.channel, audienceCount: c.audienceCount } });
    res.status(201).json(c);
  } catch (err) { badRequest(res, err.message); }
});

marketingRouter.post('/campaigns/:id/send', requirePermission('marketing.manage'), async (req, res) => {
  const c = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Campaña no encontrada' });
  try { res.json(await sendCampaign(c.id, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

marketingRouter.post('/campaigns/:id/cancel', requirePermission('marketing.manage'), async (req, res) => {
  const c = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Campaña no encontrada' });
  try { res.json(await cancelCampaign(c.id, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});
