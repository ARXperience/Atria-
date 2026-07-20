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

// Curva de pickup (booking curve): fracción de la demanda final que suele estar
// reservada según los días que faltan para la llegada. Heurística estándar del
// sector; parametrizable a futuro con histórico real de pickup por temporada.
function pickupCurve(leadDays) {
  if (leadDays >= 45) return 0.18;
  if (leadDays >= 30) return 0.28;
  if (leadDays >= 21) return 0.40;
  if (leadDays >= 14) return 0.52;
  if (leadDays >= 7) return 0.68;
  if (leadDays >= 3) return 0.82;
  return 0.93;
}
const TARGET_FINAL_OCC = 0.72; // objetivo de ocupación final (parametrizable)

// Clasifica el ritmo de una fecha comparando su ocupación on-the-books contra la
// ocupación esperada por la curva de pickup (con premium de fin de semana/evento).
export function paceFor({ occupancy, leadDays, weekend = false, hasEvent = false }) {
  const expected = TARGET_FINAL_OCC * pickupCurve(leadDays) * (weekend ? 1.1 : 1) * (hasEvent ? 1.25 : 1);
  const paceRatio = expected > 0 ? Math.round((occupancy / expected) * 100) / 100 : 1;
  let pace = 'on_pace';
  if (paceRatio >= 1.15 || (hasEvent && occupancy >= 0.5)) pace = 'ahead';
  else if (paceRatio <= 0.6) pace = 'behind';
  return { expectedPct: Math.round(expected * 100), paceRatio, pace };
}

// Análisis de ritmo de reservas (pace): compara la ocupación on-the-books contra
// la curva de pickup esperada según anticipación, con premium de fin de semana y
// demanda por eventos confirmados. Base del pricing dinámico (§34).
export async function pacingAnalysis(propertyId, days = 30) {
  const fc = await forecast(propertyId, days);
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  let eventDates = new Set();
  try {
    const events = await prisma.eventBooking.findMany({ where: { propertyId, status: { in: ['confirmed', 'in_progress'] }, date: { gte: start, lt: addDays(start, days) } }, select: { date: true } });
    eventDates = new Set(events.map(e => dayStr(e.date)));
  } catch { /* módulo opcional */ }

  return fc.map((day) => {
    const leadDays = Math.max(0, Math.round((new Date(day.date + 'T00:00:00Z').getTime() - start.getTime()) / 86400000));
    const dow = new Date(day.date + 'T00:00:00Z').getUTCDay(); // 5=vie, 6=sáb
    const weekend = dow === 5 || dow === 6;
    const hasEvent = eventDates.has(day.date);
    const { expectedPct, paceRatio, pace } = paceFor({ occupancy: day.occupancyPct / 100, leadDays, weekend, hasEvent });
    return { ...day, leadDays, weekend, hasEvent, expectedPct, paceRatio, pace };
  });
}

// Recomendaciones por fecha y tipo de habitación. Prioridad: reglas configuradas
// → ritmo de reservas (pace) → ocupación. El pace ajusta la tarifa según si la
// fecha va adelantada o rezagada respecto a su curva de pickup (§34).
export async function recommendations(propertyId, days = 14) {
  const [pacing, roomTypes, rules] = await Promise.all([
    pacingAnalysis(propertyId, days),
    prisma.roomType.findMany({ where: { propertyId, active: true }, include: { ratePlans: { where: { active: true }, orderBy: { price: 'asc' }, take: 1 } } }),
    prisma.pricingRule.findMany({ where: { propertyId, active: true } }),
  ]);

  const recs = [];
  for (const day of pacing) {
    const occ = day.occupancyPct / 100;
    const daysAhead = day.leadDays;
    for (const rt of roomTypes) {
      const plan = rt.ratePlans[0];
      if (!plan) continue;
      let adjust = 0, reason = null;

      // 1) Reglas configuradas (tienen prioridad)
      const applicable = rules.filter(r => (!r.roomTypeId || r.roomTypeId === rt.id)
        && (r.occupancyGte == null || occ >= r.occupancyGte)
        && (r.occupancyLte == null || occ <= r.occupancyLte)
        && (r.daysAheadLte == null || daysAhead <= r.daysAheadLte));
      if (applicable.length) {
        const r = applicable.sort((a, b) => Math.abs(b.adjustPct) - Math.abs(a.adjustPct))[0];
        adjust = r.adjustPct; reason = `Regla "${r.name}"`;
      // 2) Pace: adelantado → subir; rezagado → estimular
      } else if (day.pace === 'ahead') {
        adjust = day.hasEvent ? 0.20 : (day.paceRatio >= 1.4 ? 0.18 : 0.12);
        reason = `Ritmo adelantado (${day.occupancyPct}% vendido vs. ${day.expectedPct}% esperado a ${daysAhead}d${day.hasEvent ? ', evento en la fecha' : day.weekend ? ', fin de semana' : ''})`;
      } else if (day.pace === 'behind') {
        adjust = -0.12; reason = `Ritmo rezagado (${day.occupancyPct}% vendido vs. ${day.expectedPct}% esperado a ${daysAhead}d) — estimular demanda`;
      // 3) Respaldo por ocupación absoluta
      } else if (occ >= 0.85) { adjust = 0.10; reason = 'Ocupación muy alta (≥ 85%)'; }

      if (adjust !== 0) {
        recs.push({
          date: day.date, roomTypeId: rt.id, roomType: rt.name, ratePlanId: plan.id,
          currentPrice: plan.price, suggestedPrice: money(plan.price * (1 + adjust)),
          changePct: Math.round(adjust * 100), occupancyPct: day.occupancyPct,
          pace: day.pace, paceRatio: day.paceRatio, reason,
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
