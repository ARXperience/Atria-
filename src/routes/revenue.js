// Atria Revenue (§34): forecast, recomendaciones, reglas de precio y aplicación.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { forecast, recommendations, applyRateChange } from '../services/revenue.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const revenueRouter = Router();

revenueRouter.get('/forecast', requirePermission('revenue.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await forecast(req.query.propertyId, Math.min(60, +req.query.days || 14)));
});

revenueRouter.get('/recommendations', requirePermission('revenue.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await recommendations(req.query.propertyId, Math.min(60, +req.query.days || 14)));
});

revenueRouter.post('/apply', requirePermission('revenue.manage'), async (req, res) => {
  const { propertyId, ratePlanId, newPrice } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    res.json(await applyRateChange({ propertyId, ratePlanId, newPrice: +newPrice, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

// ---- Reglas de precio ----
revenueRouter.get('/rules', requirePermission('revenue.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.pricingRule.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { createdAt: 'desc' } }));
});

revenueRouter.post('/rules', requirePermission('revenue.manage'), async (req, res) => {
  const { propertyId, name, roomTypeId, occupancyGte, occupancyLte, daysAheadLte, adjustPct } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!name || adjustPct === undefined) return badRequest(res, 'name y adjustPct requeridos');
  const rule = await prisma.pricingRule.create({
    data: {
      propertyId, name, roomTypeId: roomTypeId || null,
      occupancyGte: occupancyGte != null ? +occupancyGte : null,
      occupancyLte: occupancyLte != null ? +occupancyLte : null,
      daysAheadLte: daysAheadLte != null ? +daysAheadLte : null,
      adjustPct: +adjustPct,
    },
  });
  await audit({ propertyId, user: req.user, action: 'pricing_rule.created', entity: 'PricingRule', entityId: rule.id, after: { name, adjustPct } });
  res.status(201).json(rule);
});
