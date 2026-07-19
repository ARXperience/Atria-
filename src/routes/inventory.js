// Atria Stock (§29): proveedores, productos, movimientos y órdenes de compra.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { registerMovement, receivePurchaseOrder, inventoryOverview } from '../services/inventory.js';
import { requestApproval } from '../services/approvals.js';
import { audit } from '../lib/audit.js';
import { badRequest, money, fmtCOP } from '../lib/util.js';

export const inventoryRouter = Router();

inventoryRouter.get('/overview', requirePermission('inventory.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await inventoryOverview(req.query.propertyId));
});

// ---- Proveedores ----
inventoryRouter.get('/suppliers', requirePermission('inventory.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.supplier.findMany({ where: { propertyId: req.query.propertyId, active: true }, orderBy: { name: 'asc' } }));
});
inventoryRouter.post('/suppliers', requirePermission('inventory.manage'), async (req, res) => {
  const { propertyId, name, nit, contact, category, paymentTerms } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!name) return badRequest(res, 'name requerido');
  const s = await prisma.supplier.create({ data: { propertyId, name, nit, contact, category, paymentTerms } });
  await audit({ propertyId, user: req.user, action: 'supplier.created', entity: 'Supplier', entityId: s.id, after: { name } });
  res.status(201).json(s);
});

// ---- Productos ----
inventoryRouter.get('/products', requirePermission('inventory.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId: req.query.propertyId, active: true };
  if (req.query.category) where.category = req.query.category;
  res.json(await prisma.product.findMany({ where, orderBy: { name: 'asc' }, take: 500 }));
});
inventoryRouter.post('/products', requirePermission('inventory.manage'), async (req, res) => {
  const { propertyId, sku, name, category, unit, cost, stock, stockMin, warehouse } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!sku || !name) return badRequest(res, 'sku y name requeridos');
  try {
    const p = await prisma.product.create({ data: { propertyId, sku, name, category, unit: unit || 'unidad', cost: +cost || 0, stock: +stock || 0, stockMin: +stockMin || 0, warehouse } });
    await audit({ propertyId, user: req.user, action: 'product.created', entity: 'Product', entityId: p.id, after: { sku, name } });
    res.status(201).json(p);
  } catch (err) {
    if (String(err.message).includes('Unique constraint')) return badRequest(res, 'Ya existe un producto con ese SKU');
    badRequest(res, err.message);
  }
});

// ---- Movimientos de inventario ----
inventoryRouter.get('/movements', requirePermission('inventory.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.stockMovement.findMany({ where: { propertyId: req.query.propertyId }, include: { product: { select: { name: true, unit: true } } }, orderBy: { createdAt: 'desc' }, take: 200 }));
});
inventoryRouter.post('/movements', requirePermission('inventory.manage'), async (req, res) => {
  const { propertyId, productId, type, quantity, reason } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const result = await registerMovement({ propertyId, productId, type, quantity: +quantity, reason, createdBy: req.user.name });
    res.status(201).json(result);
  } catch (err) { badRequest(res, err.message); }
});

// ---- Órdenes de compra (con aprobación) ----
inventoryRouter.get('/purchase-orders', requirePermission('inventory.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const list = await prisma.purchaseOrder.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(list.map(p => ({ ...p, items: JSON.parse(p.items) })));
});
inventoryRouter.post('/purchase-orders', requirePermission('inventory.manage'), async (req, res) => {
  const { propertyId, supplierId, items } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!supplierId || !Array.isArray(items) || !items.length) return badRequest(res, 'supplierId e items requeridos');
  const supplier = await prisma.supplier.findUnique({ where: { id: supplierId } });
  if (!supplier || supplier.propertyId !== propertyId) return badRequest(res, 'Proveedor inválido');
  const norm = [];
  for (const it of items) {
    const product = await prisma.product.findUnique({ where: { id: it.productId } });
    if (!product || product.propertyId !== propertyId) return badRequest(res, 'Producto inválido en la orden');
    const qty = +it.qty, unitCost = +it.unitCost || product.cost;
    norm.push({ productId: product.id, name: product.name, qty, unitCost, total: money(qty * unitCost) });
  }
  const total = money(norm.reduce((s, i) => s + i.total, 0));
  const po = await prisma.purchaseOrder.create({ data: { propertyId, supplierId, supplierName: supplier.name, items: JSON.stringify(norm), total, createdBy: req.user.name } });
  await audit({ propertyId, user: req.user, action: 'purchase_order.created', entity: 'PurchaseOrder', entityId: po.id, after: { supplier: supplier.name, total } });
  res.status(201).json({ ...po, items: norm });
});
// Aprobar orden de compra → aprobación de gerente (matriz §47)
inventoryRouter.post('/purchase-orders/:id/approve', requirePermission('inventory.manage'), async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
  if (!po || !propertyScope(req, po.propertyId)) return res.status(404).json({ error: 'Orden no encontrada' });
  if (po.status !== 'draft') return badRequest(res, `La orden ya está ${po.status}`);
  const approval = await requestApproval({
    propertyId: po.propertyId, type: 'purchase_order',
    summary: `Aprobar orden de compra a ${po.supplierName} por ${fmtCOP(po.total)}`,
    payload: { purchaseOrderId: po.id }, requiredRole: 'MANAGER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});
inventoryRouter.post('/purchase-orders/:id/receive', requirePermission('inventory.manage'), async (req, res) => {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: req.params.id } });
  if (!po || !propertyScope(req, po.propertyId)) return res.status(404).json({ error: 'Orden no encontrada' });
  try {
    res.json(await receivePurchaseOrder(po.id, { user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});
