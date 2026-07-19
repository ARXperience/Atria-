// Atria Revenue (§34): forecast de ocupación/ADR/RevPAR y recomendaciones de
// tarifa por reglas dinámicas. La IA/el sistema recomiendan; aplicar el cambio
// es una acción humana (auditada). Cambios masivos requieren aprobación.
import { prisma } from '../db.js';
import { addDays, dayStr, money } from '../lib/util.js';
import { audit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';

const BLOCKING = ['tentative', 'confirmed', 'checked_in'];

// Proyección diaria de ocupación, ADR y RevPAR para los próximos N días.
export async function forecast(propertyId, days = 14) {
  const totalRooms = await prisma.room.count({ where: { propertyId, active: true } });
  const oos = await prisma.room.count({ where: { propertyId, status: 'out_of_service' } });
  const sellable = Math.max(1, totalRooms - oos);

  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const horizon = addDays(start, days);
  const reservations = await prisma.reservation.findMany({
    where: { propertyId, status: { in: BLOCKING }, checkIn: { lt: horizon }, checkOut: { gt: start } },
    select: { checkIn: true, checkOut: true, nightlyRate: true, holdExpiresAt: true, status: true },
  });
  const active = reservations.filter(r => !(r.status === 'tentative' && r.holdExpiresAt && r.holdExpiresAt < now));

  const out = [];
  for (let i = 0; i < days; i++) {
    const d = addDays(start, i);
    const next = addDays(d, 1);
    const staying = active.filter(r => r.checkIn < next && r.checkOut > d);
    const occRooms = staying.length;
    const occupancy = occRooms / sellable;
    const adr = occRooms ? money(staying.reduce((s, r) => s + r.nightlyRate, 0) / occRooms) : 0;
    const revpar = money(occupancy * adr);
    out.push({ date: dayStr(d), occupancyPct: Math.round(occupancy * 100), roomsSold: occRooms, sellable, adr, revpar });
  }
  return out;
}

// Recomendaciones por fecha y tipo de habitación según ocupación + reglas.
export async function recommendations(propertyId, days = 14) {
  const fc = await forecast(propertyId, days);
  const roomTypes = await prisma.roomType.findMany({ where: { propertyId, active: true }, include: { ratePlans: { where: { active: true }, orderBy: { price: 'asc' }, take: 1 } } });
  const rules = await prisma.pricingRule.findMany({ where: { propertyId, active: true } });

  const now = new Date();
  const recs = [];
  for (const day of fc) {
    const occ = day.occupancyPct / 100;
    const daysAhead = Math.round((new Date(day.date) - now) / 86400000);
    for (const rt of roomTypes) {
      const plan = rt.ratePlans[0];
      if (!plan) continue;
      let adjust = 0, reason = null;

      // Reglas configuradas (tienen prioridad)
      const applicable = rules.filter(r => (!r.roomTypeId || r.roomTypeId === rt.id)
        && (r.occupancyGte == null || occ >= r.occupancyGte)
        && (r.occupancyLte == null || occ <= r.occupancyLte)
        && (r.daysAheadLte == null || daysAhead <= r.daysAheadLte));
      if (applicable.length) {
        const r = applicable.sort((a, b) => Math.abs(b.adjustPct) - Math.abs(a.adjustPct))[0];
        adjust = r.adjustPct; reason = `Regla "${r.name}"`;
      } else if (occ >= 0.8) { adjust = 0.15; reason = 'Alta demanda (ocupación ≥ 80%)'; }
      else if (occ <= 0.4 && day.roomsSold >= 0) { adjust = -0.10; reason = 'Baja demanda (ocupación ≤ 40%)'; }

      if (adjust !== 0) {
        recs.push({
          date: day.date, roomTypeId: rt.id, roomType: rt.name, ratePlanId: plan.id,
          currentPrice: plan.price, suggestedPrice: money(plan.price * (1 + adjust)),
          changePct: Math.round(adjust * 100), occupancyPct: day.occupancyPct, reason,
        });
      }
    }
  }
  return recs;
}

export async function applyRateChange({ propertyId, ratePlanId, newPrice, user }) {
  const plan = await prisma.ratePlan.findUnique({ where: { id: ratePlanId } });
  if (!plan || plan.propertyId !== propertyId) throw new Error('Plan tarifario inválido');
  if (!(newPrice > 0)) throw new Error('El precio debe ser mayor a cero');
  const updated = await prisma.ratePlan.update({ where: { id: ratePlanId }, data: { price: money(newPrice) } });
  await audit({ propertyId, user, action: 'rate.changed', entity: 'RatePlan', entityId: ratePlanId, before: { price: plan.price }, after: { price: money(newPrice) } });
  emitEvent('rate.changed', { propertyId, entityId: ratePlanId });
  return updated;
}
