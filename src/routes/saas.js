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
import { SERVICES, SERVICE_KEYS, serializeServiceList, parseServiceList } from '../lib/services.js';
import { invalidatePropertyServices } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';

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

// ---- Áreas/servicios: catálogo, por sede y por usuario (§55.1) ----

// Catálogo de servicios disponibles (para armar la consola del superadmin).
saasRouter.get('/services', requireSuperAdmin, async (_req, res) => res.json({ services: SERVICES }));

// Sedes de una empresa con sus servicios habilitados (null => todos).
saasRouter.get('/companies/:id/properties', requireSuperAdmin, async (req, res) => {
  const props = await prisma.property.findMany({
    where: { companyId: req.params.id },
    select: { id: true, name: true, city: true, active: true, enabledServices: true },
    orderBy: { name: 'asc' },
  });
  res.json(props.map((p) => ({ id: p.id, name: p.name, city: p.city, active: p.active, enabledServices: parseServiceList(p.enabledServices) ?? SERVICE_KEYS })));
});

// Definir qué servicios ofrece una sede. body.enabledServices = array de claves,
// o null/"all" para habilitar todos.
saasRouter.post('/properties/:id/services', requireSuperAdmin, async (req, res) => {
  const prop = await prisma.property.findUnique({ where: { id: req.params.id }, select: { id: true, companyId: true } });
  if (!prop) return res.status(404).json({ error: 'Sede no encontrada' });
  const body = req.body || {};
  const all = body.enabledServices == null || body.enabledServices === 'all' || body.all === true;
  const value = all ? null : serializeServiceList(body.enabledServices);
  await prisma.property.update({ where: { id: prop.id }, data: { enabledServices: value } });
  invalidatePropertyServices(prop.id);
  await audit({ companyId: prop.companyId, propertyId: prop.id, user: req.user, action: 'saas.property_services', after: { enabledServices: all ? 'all' : parseServiceList(value) } });
  res.json({ ok: true, propertyId: prop.id, enabledServices: all ? SERVICE_KEYS : parseServiceList(value) });
});

// Usuarios de una empresa con sus áreas asignadas (null => todas las del rol).
saasRouter.get('/companies/:id/users', requireSuperAdmin, async (req, res) => {
  const users = await prisma.user.findMany({
    where: { companyId: req.params.id },
    select: { id: true, name: true, email: true, role: true, active: true, isSuperAdmin: true, propertyIds: true, allowedServices: true },
    orderBy: { name: 'asc' },
  });
  res.json(users.map((u) => ({ ...u, allowedServices: parseServiceList(u.allowedServices) })));
});

// Definir a qué áreas accede un usuario. body.allowedServices = array de claves,
// o null/"all" para todas las que su rol permite. Opcional: propertyIds, active.
saasRouter.post('/users/:id/access', requireSuperAdmin, async (req, res) => {
  const user = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, companyId: true, isSuperAdmin: true } });
  if (!user) return res.status(404).json({ error: 'Usuario no encontrado' });
  const body = req.body || {};
  const data = {};
  if ('allowedServices' in body) {
    const all = body.allowedServices == null || body.allowedServices === 'all';
    data.allowedServices = all ? null : serializeServiceList(body.allowedServices);
  }
  if (typeof body.propertyIds === 'string' && body.propertyIds.trim()) data.propertyIds = body.propertyIds.trim();
  if (typeof body.active === 'boolean') data.active = body.active;
  if (!Object.keys(data).length) return badRequest(res, 'Nada que actualizar');
  await prisma.user.update({ where: { id: user.id }, data });
  await audit({ companyId: user.companyId, user: req.user, action: 'saas.user_access', entity: 'User', entityId: user.id, after: { ...data, allowedServices: 'allowedServices' in data ? parseServiceList(data.allowedServices) : undefined } });
  res.json({ ok: true, userId: user.id, allowedServices: 'allowedServices' in data ? parseServiceList(data.allowedServices) : undefined });
});

// Facturación del software (superadmin)
saasRouter.get('/billing', requireSuperAdmin, async (_req, res) => res.json(await billingOverview()));

saasRouter.post('/billing/generate', requireSuperAdmin, async (_req, res) => res.json(await generateAllInvoices()));

saasRouter.post('/billing/sweep', requireSuperAdmin, async (req, res) => res.json(await runOverdueSweep({ autoSuspend: req.body?.autoSuspend !== false })));
