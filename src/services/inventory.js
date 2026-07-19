// Atria Stock (§29): proveedores, productos, movimientos de inventario y
// órdenes de compra. Los movimientos actualizan el stock y disparan alerta de
// stock bajo. Órdenes de compra requieren aprobación (matriz §47).
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { notify } from './notifications.js';
import { money } from '../lib/util.js';

const SIGN = { in: 1, out: -1, consumption: -1, adjustment: 1 };

export async function registerMovement({ propertyId, productId, type, quantity, reason = null, reference = null, unitCost = null, createdBy = null, actor = 'human' }) {
  const product = await prisma.product.findUnique({ where: { id: productId } });
  if (!product || product.propertyId !== propertyId) throw new Error('Producto inválido');
  if (!(quantity > 0)) throw new Error('La cantidad debe ser mayor a cero');
  const delta = (SIGN[type] ?? 0) * quantity;
  if (delta === 0 && type !== 'adjustment') throw new Error(`Tipo de movimiento inválido: ${type}`);
  const newStock = Math.round((product.stock + delta) * 1000) / 1000;
  if (newStock < 0) throw new Error(`Stock insuficiente: hay ${product.stock} ${product.unit} de ${product.name}`);

  const movement = await prisma.$transaction(async tx => {
    const m = await tx.stockMovement.create({ data: { propertyId, productId, type, quantity, reason, reference, unitCost, createdBy } });
    await tx.product.update({ where: { id: productId }, data: { stock: newStock } });
    return m;
  });
  await audit({ propertyId, action: 'stock_movement.created', entity: 'StockMovement', entityId: movement.id, actor, after: { product: product.name, type, quantity, newStock } });
  emitEvent('stock_movement.created', { propertyId, entityId: movement.id });

  if (newStock <= product.stockMin) {
    emitEvent('stock.low_detected', { propertyId, entityId: productId });
    await notify({ propertyId, audienceRole: 'MANAGER', severity: 'warning', title: `Stock bajo: ${product.name}`, body: `Quedan ${newStock} ${product.unit} (mínimo ${product.stockMin}).`, entity: 'Product', entityId: productId });
  }
  return { movement, stock: newStock };
}

export async function receivePurchaseOrder(poId, { user }) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po) throw new Error('Orden de compra no encontrada');
  if (po.status !== 'approved') throw new Error('La orden debe estar aprobada para recibirse');
  const items = JSON.parse(po.items);
  for (const it of items) {
    await registerMovement({ propertyId: po.propertyId, productId: it.productId, type: 'in', quantity: it.qty, reason: `Recepción OC`, reference: po.id, unitCost: it.unitCost, createdBy: user?.name, actor: 'human' });
    if (it.unitCost) await prisma.product.update({ where: { id: it.productId }, data: { cost: it.unitCost } });
  }
  const updated = await prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'received', receivedAt: new Date() } });
  await audit({ propertyId: po.propertyId, user, action: 'purchase_order.received', entity: 'PurchaseOrder', entityId: poId, after: { items: items.length } });
  emitEvent('purchase_order.received', { propertyId: po.propertyId, entityId: poId });
  return updated;
}

// Ejecutor de aprobación: aprobar la orden de compra.
export async function approvePurchaseOrder(poId) {
  const po = await prisma.purchaseOrder.findUnique({ where: { id: poId } });
  if (!po) throw new Error('Orden no encontrada');
  return prisma.purchaseOrder.update({ where: { id: poId }, data: { status: 'approved' } });
}

export async function inventoryOverview(propertyId) {
  const [products, low, openPOs, suppliers] = await Promise.all([
    prisma.product.count({ where: { propertyId, active: true } }),
    prisma.product.findMany({ where: { propertyId, active: true }, select: { id: true, name: true, stock: true, stockMin: true, unit: true } }),
    prisma.purchaseOrder.count({ where: { propertyId, status: { in: ['draft', 'approved'] } } }),
    prisma.supplier.count({ where: { propertyId, active: true } }),
  ]);
  const lowStock = low.filter(p => p.stock <= p.stockMin);
  return { products, lowStock: lowStock.length, lowStockItems: lowStock, openPurchaseOrders: openPOs, suppliers };
}
