// Predicción de fuga (churn) y win-back (§12/§36). Puntúa la probabilidad de que
// un huésped no vuelva a partir de recencia, frecuencia y sentimiento, y permite
// lanzar una campaña de reactivación con cupón (reusa segmentos+cupones+campañas).
import { prisma } from '../../db.js';
import { money } from '../../lib/util.js';
import { audit } from '../../lib/audit.js';
import { createSegment } from '../segments.js';
import { createCoupon } from '../coupons.js';
import { createCampaign } from '../marketing.js';

const DAY = 86400_000;
const STAY_STATUSES = ['checked_out', 'checked_in', 'confirmed'];

// Puntaje 0..100 (más alto = más riesgo de fuga) con las razones que lo componen.
export function scoreChurn({ stays, daysSince, hasNegative, lowNps }) {
  let risk = 0; const reasons = [];
  // Recencia: hasta 50 puntos según el tiempo desde la última estadía.
  if (daysSince != null) {
    const rec = Math.min(50, Math.round((daysSince / 365) * 50));
    if (rec > 0) { risk += rec; if (daysSince >= 180) reasons.push(`Sin volver hace ${Math.round(daysSince)} días`); }
  }
  // Frecuencia: los de una sola estadía son más volátiles; los recurrentes, leales.
  if (stays <= 1) { risk += 15; reasons.push('Solo una estadía'); }
  else if (stays >= 3) { risk -= 15; reasons.push(`Cliente recurrente (${stays} estadías)`); }
  // Señal de insatisfacción.
  if (hasNegative) { risk += 25; reasons.push('Dejó una reseña/queja negativa'); }
  if (lowNps) { risk += 15; reasons.push('Detractor en la encuesta (NPS bajo)'); }
  risk = Math.max(0, Math.min(100, risk));
  const tier = risk >= 60 ? 'high' : risk >= 35 ? 'medium' : 'low';
  return { risk, tier, reasons };
}

export async function churnScores(propertyId) {
  const [guests, reservations, reviews, complaints] = await Promise.all([
    prisma.guest.findMany({ where: { propertyId } }),
    prisma.reservation.findMany({ where: { propertyId, status: { in: STAY_STATUSES } }, select: { guestId: true, checkOut: true } }),
    prisma.review.findMany({ where: { propertyId, rating: { lte: 2 }, guestId: { not: null } }, select: { guestId: true } }),
    prisma.complaint.findMany({ where: { propertyId }, select: { guestName: true } }),
  ]);
  const stayMap = new Map();
  for (const r of reservations) {
    const a = stayMap.get(r.guestId) || { stays: 0, lastStay: null };
    a.stays++; if (!a.lastStay || r.checkOut > a.lastStay) a.lastStay = r.checkOut;
    stayMap.set(r.guestId, a);
  }
  const negGuestIds = new Set(reviews.map(r => r.guestId));
  const complaintNames = new Set(complaints.map(c => c.guestName));
  const now = Date.now();

  const rows = [];
  for (const g of guests) {
    const a = stayMap.get(g.id);
    if (!a || a.stays === 0) continue; // solo huéspedes con historial
    const daysSince = a.lastStay ? (now - a.lastStay.getTime()) / DAY : null;
    const hasNegative = negGuestIds.has(g.id) || complaintNames.has(g.fullName);
    const { risk, tier, reasons } = scoreChurn({ stays: a.stays, daysSince, hasNegative, lowNps: false });
    rows.push({
      guestId: g.id, name: g.fullName, stays: a.stays, lastStay: a.lastStay,
      daysSince: daysSince == null ? null : Math.round(daysSince),
      risk, tier, reasons,
      reachable: !!(g.marketingConsent && (g.email || g.phone)),
    });
  }
  rows.sort((x, y) => y.risk - x.risk);
  return rows;
}

export async function churnOverview(propertyId) {
  const rows = await churnScores(propertyId);
  const counts = { high: 0, medium: 0, low: 0 };
  for (const r of rows) counts[r.tier]++;
  const atRisk = rows.filter(r => r.tier !== 'low');
  const reachableAtRisk = atRisk.filter(r => r.reachable).length;
  return { counts, total: rows.length, atRisk: atRisk.slice(0, 50), reachableAtRisk };
}

// Lanza una reactivación: crea el cupón, el segmento de inactivos y una campaña
// (borrador) que lo usa. Cierra el ciclo comercial de forma automática.
export async function launchWinback(propertyId, { discountPct = 0.15, inactiveDays = 120, channel = 'email', user = null } = {}) {
  const pct = Math.min(Math.max(Number(discountPct) || 0.15, 0.05), 0.5);
  const code = `WINBACK${Math.round(pct * 100)}`;
  // Cupón (idempotente por código: si ya existe, se reutiliza).
  let coupon = await prisma.coupon.findFirst({ where: { propertyId, code } });
  if (!coupon) {
    coupon = await createCoupon({ propertyId, code, description: 'Reactivación de huéspedes inactivos', discountType: 'percent', discountValue: pct * 100, minNights: 1, user });
  }
  // Segmento de en-riesgo: recurrentes/inactivos con consentimiento.
  const segment = await createSegment({ propertyId, name: `Reactivación (${inactiveDays}d)`, description: 'Huéspedes con estadía previa e inactivos, contactables', criteria: { minStays: 1, inactiveDays, marketingConsent: true }, user });
  // Campaña (borrador) apuntando al segmento con el cupón.
  const campaign = await createCampaign({
    propertyId, name: 'Win-back — te extrañamos', channel, audience: 'guests', segmentId: segment.id,
    subject: 'Te extrañamos — vuelve con un beneficio especial',
    message: `¡Hola! Queremos verte de nuevo. Usa el código ${code} y disfruta un ${Math.round(pct * 100)}% de descuento en tu próxima estadía. Te esperamos.`,
    createdBy: user?.name || null,
  });
  // Atribuye el cupón a la campaña para medir el ROI de la reactivación.
  await prisma.coupon.update({ where: { id: coupon.id }, data: { campaignId: campaign.id } });
  await audit({ propertyId, user, action: 'crm.winback_launched', entity: 'Campaign', entityId: campaign.id, after: { coupon: code, segment: segment.id } });
  return { campaign, coupon: { id: coupon.id, code }, segment: { id: segment.id, count: campaign.audienceCount } };
}
