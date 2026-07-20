// Radar de anomalías (§42/§28): revisa datos operativos en busca de valores
// atípicos o inconsistentes (posibles errores o fraude) en pagos, nómina,
// inventario y reservas. Determinístico y explicable; cada hallazgo indica la
// entidad afectada para su revisión.
import { prisma } from '../../db.js';
import { money, fmtCOP } from '../../lib/util.js';

const DAY = 86400_000;
const OVERTIME_MONTHLY_FLAG = 40; // horas extra aprobadas/mes que se consideran atípicas

function monthStart() {
  const n = new Date();
  return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), 1));
}

// ---- Inventario: stock negativo ----
async function inventoryAnomalies(propertyId) {
  const out = [];
  const products = await prisma.product.findMany({ where: { propertyId } });
  for (const p of products) {
    if (p.stock < 0) out.push({ area: 'inventory', severity: 'high', title: `Stock negativo: ${p.name}`, detail: `El inventario de "${p.name}" está en ${p.stock} ${p.unit || ''}. Indica consumos sin reposición o un registro erróneo.`, entity: 'Product', entityId: p.id });
  }
  return out;
}

// ---- Nómina: horas extra atípicas por empleado (mes actual) ----
async function payrollAnomalies(propertyId) {
  const out = [];
  const nov = await prisma.payrollNovelty.findMany({
    where: { propertyId, status: 'approved', type: { in: ['overtime_day', 'overtime_night'] }, date: { gte: monthStart() } },
    include: { employee: { select: { fullName: true } } },
  });
  const byEmp = new Map();
  for (const n of nov) {
    const g = byEmp.get(n.employeeId) || { name: n.employee?.fullName || 'empleado', hours: 0 };
    g.hours += n.hours || 0; byEmp.set(n.employeeId, g);
  }
  for (const [id, g] of byEmp) {
    if (g.hours > OVERTIME_MONTHLY_FLAG) out.push({ area: 'payroll', severity: 'warning', title: `Horas extra atípicas: ${g.name}`, detail: `${g.name} acumula ${Math.round(g.hours)} h extra aprobadas este mes (umbral ${OVERTIME_MONTHLY_FLAG} h). Verifica antes de cerrar la nómina.`, entity: 'Employee', entityId: id });
  }
  return out;
}

// ---- Pagos: sobre-reembolso y posibles duplicados ----
async function paymentAnomalies(propertyId) {
  const out = [];
  const payments = await prisma.payment.findMany({
    where: { propertyId, status: 'approved', reservationId: { not: null } },
    select: { id: true, reservationId: true, amount: true, kind: true, createdAt: true, method: true },
    orderBy: { createdAt: 'asc' },
  });
  const byRes = new Map();
  for (const p of payments) {
    const g = byRes.get(p.reservationId) || { pay: 0, refund: 0, items: [] };
    if (p.kind === 'refund') g.refund += p.amount; else g.pay += p.amount;
    g.items.push(p); byRes.set(p.reservationId, g);
  }
  for (const [resId, g] of byRes) {
    // Sobre-reembolso: se devolvió más de lo cobrado.
    if (g.refund > money(g.pay) + 1) out.push({ area: 'payments', severity: 'high', title: 'Reembolso mayor a lo pagado', detail: `En una reserva se reembolsó ${fmtCOP(g.refund)} pero solo se cobró ${fmtCOP(g.pay)}. Revisa la operación.`, entity: 'Reservation', entityId: resId });
    // Posible duplicado: dos cobros iguales muy seguidos.
    const pays = g.items.filter(x => x.kind !== 'refund');
    for (let i = 1; i < pays.length; i++) {
      if (money(pays[i].amount) === money(pays[i - 1].amount) && (new Date(pays[i].createdAt) - new Date(pays[i - 1].createdAt)) < 5 * 60000) {
        out.push({ area: 'payments', severity: 'warning', title: 'Posible pago duplicado', detail: `Dos pagos de ${fmtCOP(pays[i].amount)} en la misma reserva con menos de 5 minutos de diferencia.`, entity: 'Reservation', entityId: resId });
        break;
      }
    }
  }
  return out;
}

// ---- Reservas: inconsistencia aritmética subtotal+impuestos ≠ total ----
async function reservationAnomalies(propertyId) {
  const out = [];
  const res = await prisma.reservation.findMany({ where: { propertyId, status: { in: ['confirmed', 'checked_in', 'checked_out'] } }, select: { id: true, code: true, subtotal: true, taxes: true, total: true } });
  for (const r of res) {
    if (Math.abs(money(r.subtotal + r.taxes) - money(r.total)) > 1) {
      out.push({ area: 'reservations', severity: 'warning', title: `Total inconsistente en ${r.code}`, detail: `subtotal ${fmtCOP(r.subtotal)} + impuestos ${fmtCOP(r.taxes)} ≠ total ${fmtCOP(r.total)}. Posible error de cálculo.`, entity: 'Reservation', entityId: r.id });
    }
  }
  return out;
}

export async function detectAnomalies(propertyId) {
  const groups = await Promise.all([
    inventoryAnomalies(propertyId).catch(() => []),
    payrollAnomalies(propertyId).catch(() => []),
    paymentAnomalies(propertyId).catch(() => []),
    reservationAnomalies(propertyId).catch(() => []),
  ]);
  const rank = { high: 3, warning: 2, info: 1 };
  const anomalies = groups.flat().sort((a, b) => rank[b.severity] - rank[a.severity]);
  const counts = { high: 0, warning: 0, info: 0 };
  for (const a of anomalies) counts[a.severity]++;
  return { anomalies, counts, total: anomalies.length, checkedAt: null };
}
