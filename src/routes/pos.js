// Atria Service — Restaurante/POS (§32).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { createOrder, chargeOrder } from '../services/pos.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const posRouter = Router();

// ---- Menú ----
posRouter.get('/menu', requirePermission('pos.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.menuItem.findMany({ where: { propertyId: req.query.propertyId, active: true }, orderBy: { name: 'asc' } }));
});
posRouter.post('/menu', requirePermission('pos.manage'), async (req, res) => {
  const { propertyId, name, category, price, recipe } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!name || !(price > 0)) return badRequest(res, 'name y price > 0 requeridos');
  const item = await prisma.menuItem.create({ data: { propertyId, name, category: category || 'comida', price: +price, recipe: recipe ? JSON.stringify(recipe) : null } });
  await audit({ propertyId, user: req.user, action: 'menu_item.created', entity: 'MenuItem', entityId: item.id, after: { name, price } });
  res.status(201).json(item);
});

// ---- Comandas ----
posRouter.get('/orders', requirePermission('pos.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId: req.query.propertyId };
  if (req.query.status) where.status = req.query.status;
  const list = await prisma.posOrder.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(list.map(o => ({ ...o, items: JSON.parse(o.items) })));
});

posRouter.post('/orders', requirePermission('pos.manage'), async (req, res) => {
  const { propertyId, type, tableLabel, reservationId, items } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    res.status(201).json(await createOrder({ propertyId, type, tableLabel, reservationId, items, createdBy: req.user.name }));
  } catch (err) { badRequest(res, err.message); }
});

posRouter.post('/orders/:id/charge', requirePermission('pos.manage'), async (req, res) => {
  const order = await prisma.posOrder.findUnique({ where: { id: req.params.id } });
  if (!order || !propertyScope(req, order.propertyId)) return res.status(404).json({ error: 'Comanda no encontrada' });
  try {
    res.json(await chargeOrder(order.id, { method: req.body?.method, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});
