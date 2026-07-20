// Forecast de demanda de cocina / POS (§32). Proyecta los cubiertos y el consumo
// por plato para los próximos días a partir de la ocupación prevista y el mix
// histórico de ventas, y genera la lista de insumos a comprar (mise en place).
// Determinístico; mejora con el histórico real de comandas.
import { prisma } from '../../db.js';
import { money } from '../../lib/util.js';
import { forecast as occupancyForecast } from '../revenue.js';

// Cubiertos esperados por habitación ocupada y día (attach rate por defecto).
const DEFAULT_ATTACH = 0.6;

function parseItems(json) { try { return JSON.parse(json) || []; } catch { return []; } }

export async function kitchenForecast(propertyId, { days = 7, historyDays = 30 } = {}) {
  const since = new Date(Date.now() - historyDays * 86400_000);
  const [orders, menu, products, fc] = await Promise.all([
    prisma.posOrder.findMany({ where: { propertyId, status: { in: ['charged', 'paid'] }, createdAt: { gte: since } }, select: { items: true } }),
    prisma.menuItem.findMany({ where: { propertyId, active: true } }),
    prisma.product.findMany({ where: { propertyId } }),
    occupancyForecast(propertyId, days),
  ]);

  // Mix histórico: participación de cada plato en los cubiertos vendidos.
  const soldQty = new Map();
  let totalSold = 0;
  for (const o of orders) for (const it of parseItems(o.items)) {
    const q = +it.qty || 0; if (!it.menuItemId || q <= 0) continue;
    soldQty.set(it.menuItemId, (soldQty.get(it.menuItemId) || 0) + q); totalSold += q;
  }
  const menuById = new Map(menu.map(m => [m.id, m]));
  // Si no hay histórico, mix uniforme sobre la carta activa.
  const mix = new Map();
  if (totalSold > 0) for (const [id, q] of soldQty) mix.set(id, q / totalSold);
  else for (const m of menu) mix.set(m.id, 1 / Math.max(1, menu.length));

  // Proyección diaria de cubiertos = habitaciones ocupadas × attach rate. Si aún
  // no hay ocupación on-the-books para esas fechas, cae al promedio histórico.
  const histCoversPerDay = totalSold > 0 ? totalSold / historyDays : 0;
  const dayRows = fc.map(d => {
    const occBased = d.roomsSold * DEFAULT_ATTACH;
    const covers = occBased > 0 ? occBased : histCoversPerDay;
    return { date: d.date, occupancyPct: d.occupancyPct, projectedCovers: Math.round(covers * 10) / 10, basis: occBased > 0 ? 'occupancy' : 'history' };
  });
  const totalCovers = dayRows.reduce((s, d) => s + d.projectedCovers, 0);

  // Demanda por plato en la ventana.
  const itemDemand = [];
  const productNeed = new Map(); // productId → qty
  for (const [id, share] of mix) {
    const m = menuById.get(id); if (!m) continue;
    const qty = Math.round(totalCovers * share * 10) / 10;
    if (qty <= 0) continue;
    itemDemand.push({ menuItemId: id, name: m.name, category: m.category, projectedQty: qty, projectedRevenue: money(qty * m.price) });
    // Expandir receta → insumos necesarios.
    let recipe = []; try { recipe = m.recipe ? JSON.parse(m.recipe) : []; } catch { recipe = []; }
    for (const r of recipe) productNeed.set(r.productId, (productNeed.get(r.productId) || 0) + (+r.qty || 0) * qty);
  }
  itemDemand.sort((a, b) => b.projectedQty - a.projectedQty);

  // Lista de compras: insumos cuyo requerimiento supera el stock disponible.
  const prodById = new Map(products.map(p => [p.id, p]));
  const purchaseList = [];
  for (const [pid, needed] of productNeed) {
    const p = prodById.get(pid); if (!p) continue;
    const need = Math.round(needed * 100) / 100;
    const toBuy = Math.max(0, Math.round((need - p.stock) * 100) / 100);
    purchaseList.push({ productId: pid, name: p.name, unit: p.unit, needed: need, stock: p.stock, toBuy, shortage: toBuy > 0 });
  }
  purchaseList.sort((a, b) => (b.shortage - a.shortage) || (b.toBuy - a.toBuy));

  return {
    windowDays: days, historyDays, hasHistory: totalSold > 0, attachRate: DEFAULT_ATTACH,
    days: dayRows, totalCovers: Math.round(totalCovers * 10) / 10,
    itemDemand: itemDemand.slice(0, 30),
    purchaseList: purchaseList.slice(0, 40),
    shortages: purchaseList.filter(p => p.shortage).length,
  };
}
