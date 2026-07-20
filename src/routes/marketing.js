// Marketing & campañas (§36).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { marketingOverview, buildAudience, createCampaign, sendCampaign, cancelCampaign, draftCampaignMessage } from '../services/marketing.js';
import { createCoupon, listCoupons, setCouponActive, couponsOverview, campaignRoi } from '../services/coupons.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const marketingRouter = Router();

// ---- Cupones y ROI (§36) ----
marketingRouter.get('/coupons', requirePermission('marketing.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await couponsOverview(req.query.propertyId));
});

marketingRouter.post('/coupons', requirePermission('marketing.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.status(201).json(await createCoupon({ ...req.body, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

marketingRouter.patch('/coupons/:id', requirePermission('marketing.manage'), async (req, res) => {
  const c = await prisma.coupon.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Cupón no encontrado' });
  try { res.json(await setCouponActive(c.id, req.body?.active, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

marketingRouter.get('/campaigns/:id/roi', requirePermission('marketing.view'), async (req, res) => {
  const c = await prisma.campaign.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Campaña no encontrada' });
  res.json(await campaignRoi(c.id));
});

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

// Redactor asistido (IA) del mensaje de campaña con el tono del hotel.
marketingRouter.get('/draft', requirePermission('marketing.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await draftCampaignMessage(req.query.propertyId, { goal: req.query.goal, channel: req.query.channel }));
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
