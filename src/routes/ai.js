// Atria Intelligence — recomendaciones y briefing transversal con IA (§38/§41).
import { Router } from 'express';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { buildInsights, insightsBriefing } from '../services/ai/advisor.js';
import { detectAnomalies } from '../services/ai/anomalies.js';
import { audit } from '../lib/audit.js';

export const aiRouter = Router();

// Radar de anomalías: valores atípicos/inconsistentes en pagos, nómina, inventario y reservas.
aiRouter.get('/anomalies', requirePermission('audit.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await detectAnomalies(req.query.propertyId));
});

// Recomendaciones priorizadas de la sede, filtradas por el rol del usuario.
aiRouter.get('/insights', requirePermission('dashboard.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await buildInsights(req.query.propertyId, { role: req.user.role }));
});

// Resumen ejecutivo en lenguaje natural ("qué hacer hoy").
aiRouter.get('/briefing', requirePermission('dashboard.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  await audit({ propertyId: req.query.propertyId, user: req.user, actor: 'ai', action: 'ai.briefing_requested' });
  res.json(await insightsBriefing(req.query.propertyId, { role: req.user.role, userName: req.user.name }));
});
