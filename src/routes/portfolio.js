// Consolidación multi-sede (§8): portafolio del dueño/gerencia.
import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';
import { portfolioOverview } from '../services/portfolio.js';

export const portfolioRouter = Router();

// Consolida los KPIs de todas las sedes a las que el usuario tiene acceso.
// No recibe propertyId: el alcance lo define el propio usuario (propertyIds).
portfolioRouter.get('/overview', requirePermission('dashboard.view'), async (req, res) => {
  res.json(await portfolioOverview(req.user));
});
