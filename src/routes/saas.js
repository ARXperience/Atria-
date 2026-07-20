// Multi-tenant, planes y facturación del software (§55.1).
import { Router } from 'express';
import { requireSuperAdmin } from '../middleware/saas.js';
import { badRequest } from '../lib/util.js';
import { prisma } from '../db.js';
import {
  listPlans, subscriptionOverview, listCompanies, setCompanyPlan, setCompanyStatus, updateBranding,
} from '../services/saas.js';
import {
  companyInvoices, payInvoice, generateAllInvoices, billingOverview, runOverdueSweep,
} from '../services/saasBilling.js';

export const saasRouter = Router();

// ---- Facturación del software (tenant) ----
saasRouter.get('/invoices', async (req, res) => res.json(await companyInvoices(req.user.companyId)));

// Un administrador del hotel puede pagar su propia factura; el superadmin, cualquiera.
saasRouter.post('/invoices/:id/pay', async (req, res) => {
  const inv = await prisma.saasInvoice.findUnique({ where: { id: req.params.id } });
  if (!inv) return res.status(404).json({ error: 'Factura no encontrada' });
  const ownAdmin = inv.companyId === req.user.companyId && ['OWNER', 'MANAGER'].includes(req.user.role);
  if (!ownAdmin && !req.user.isSuperAdmin) return res.status(403).json({ error: 'Sin permiso para pagar esta factura' });
  try { res.json(await payInvoice(inv.id, { ref: req.body?.ref || `PAY-${Date.now()}`, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// Catálogo de planes (visible para cualquier usuario autenticado).
saasRouter.get('/plans', async (_req, res) => res.json(await listPlans()));

// Suscripción y consumo de MI empresa.
saasRouter.get('/subscription', async (req, res) => res.json(await subscriptionOverview(req.user.companyId)));

// White-label de mi empresa (administradores del tenant).
saasRouter.post('/branding', async (req, res) => {
  if (!['OWNER', 'MANAGER'].includes(req.user.role)) return res.status(403).json({ error: 'Solo un administrador del hotel puede cambiar la marca.' });
  try { res.json(await updateBranding(req.user.companyId, req.body || {}, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// ---- Consola del superadministrador SaaS ----
saasRouter.get('/companies', requireSuperAdmin, async (_req, res) => res.json(await listCompanies()));

saasRouter.post('/companies/:id/plan', requireSuperAdmin, async (req, res) => {
  try { res.json(await setCompanyPlan(req.params.id, req.body?.planCode, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

saasRouter.post('/companies/:id/status', requireSuperAdmin, async (req, res) => {
  try { res.json(await setCompanyStatus(req.params.id, req.body?.status, { user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// Facturación del software (superadmin)
saasRouter.get('/billing', requireSuperAdmin, async (_req, res) => res.json(await billingOverview()));

saasRouter.post('/billing/generate', requireSuperAdmin, async (_req, res) => res.json(await generateAllInvoices()));

saasRouter.post('/billing/sweep', requireSuperAdmin, async (req, res) => res.json(await runOverdueSweep({ autoSuspend: req.body?.autoSuspend !== false })));
