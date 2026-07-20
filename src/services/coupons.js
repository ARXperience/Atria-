// Cupones promocionales y ROI de campañas (§36).
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { audit } from '../lib/audit.js';
import { emitEvent } from '../lib/events.js';

export async function createCoupon({ propertyId, code, description = null, discountType = 'percent', discountValue, campaignId = null, maxRedemptions = null, minNights = 1, validFrom = null, validTo = null, user = null }) {
  if (!code) throw new Error('El cupón requiere un código');
  if (!['percent', 'fixed'].includes(discountType)) throw new Error('discountType inválido');
  const value = Number(discountValue);
  if (!(value > 0)) throw new Error('El valor del descuento debe ser mayor a cero');
  if (discountType === 'percent' && value > 90) throw new Error('El descuento porcentual no puede superar 90%');
  const normalized = String(code).trim().toUpperCase();
  const existing = await prisma.coupon.findFirst({ where: { propertyId, code: normalized } });
  if (existing) throw new Error('Ya existe un cupón con ese código');
  const coupon = await prisma.coupon.create({
    data: {
      propertyId, code: normalized, description, discountType, discountValue: value,
      campaignId, maxRedemptions: maxRedemptions ? parseInt(maxRedemptions, 10) : null,
      minNights: parseInt(minNights, 10) || 1,
      validFrom: validFrom ? new Date(validFrom) : null, validTo: validTo ? new Date(validTo) : null,
      createdBy: user?.name || null,
    },
  });
  await audit({ propertyId, user, action: 'coupon.created', entity: 'Coupon', entityId: coupon.id, after: { code: normalized } });
  return coupon;
}

export async function listCoupons(propertyId) {
  return prisma.coupon.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 200 });
}

export async function setCouponActive(id, active, { user = null } = {}) {
  const coupon = await prisma.coupon.findUnique({ where: { id } });
  if (!coupon) throw new Error('Cupón no encontrado');
  const updated = await prisma.coupon.update({ where: { id }, data: { active: !!active } });
  await audit({ propertyId: coupon.propertyId, user, action: active ? 'coupon.activated' : 'coupon.deactivated', entity: 'Coupon', entityId: id });
  return updated;
}

// Valida un cupón para una reserva y devuelve el cupón + el % de descuento
// efectivo sobre un subtotal dado (los fijos se convierten a proporción).
export async function resolveCoupon(propertyId, code, { nights = 1, subtotal = 0 } = {}) {
  if (!code) return null;
  const coupon = await prisma.coupon.findFirst({ where: { propertyId, code: String(code).trim().toUpperCase() } });
  if (!coupon) throw new Error('Cupón inexistente');
  if (!coupon.active) throw new Error('El cupón no está activo');
  const now = new Date();
  if (coupon.validFrom && now < coupon.validFrom) throw new Error('El cupón aún no es válido');
  if (coupon.validTo && now > coupon.validTo) throw new Error('El cupón está vencido');
  if (nights < coupon.minNights) throw new Error(`El cupón exige mínimo ${coupon.minNights} noche(s)`);
  if (coupon.maxRedemptions != null && coupon.redemptions >= coupon.maxRedemptions) throw new Error('El cupón agotó sus redenciones');
  let pct = 0;
  if (coupon.discountType === 'percent') pct = coupon.discountValue / 100;
  else if (subtotal > 0) pct = Math.min(coupon.discountValue / subtotal, 0.9);
  return { coupon, discountPct: pct };
}

// Registra la redención una vez creada la reserva (para ROI).
export async function redeemCoupon(couponId, { propertyId, reservationId = null, guestName = null, amountDiscounted = 0, reservationTotal = 0 }) {
  const red = await prisma.$transaction(async (tx) => {
    const r = await tx.couponRedemption.create({
      data: { couponId, propertyId, reservationId, guestName, amountDiscounted: money(amountDiscounted), reservationTotal: money(reservationTotal) },
    });
    await tx.coupon.update({ where: { id: couponId }, data: { redemptions: { increment: 1 } } });
    return r;
  });
  emitEvent('coupon.redeemed', { propertyId, entityId: couponId, reservationId });
  return red;
}

// ROI por cupón: redenciones, descuento otorgado e ingresos atribuidos.
export async function couponsOverview(propertyId) {
  const coupons = await prisma.coupon.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 200 });
  const agg = await prisma.couponRedemption.groupBy({
    by: ['couponId'], where: { propertyId },
    _sum: { amountDiscounted: true, reservationTotal: true }, _count: true,
  });
  const byCoupon = Object.fromEntries(agg.map(a => [a.couponId, a]));
  const rows = coupons.map(c => {
    const a = byCoupon[c.id];
    const discount = money(a?._sum.amountDiscounted || 0);
    const revenue = money(a?._sum.reservationTotal || 0);
    return {
      id: c.id, code: c.code, description: c.description, active: c.active,
      discountType: c.discountType, discountValue: c.discountValue, campaignId: c.campaignId,
      redemptions: c.redemptions, maxRedemptions: c.maxRedemptions,
      discountGiven: discount, revenueAttributed: revenue,
      roi: discount > 0 ? Math.round(((revenue - discount) / discount) * 100) : null,
    };
  });
  const totals = {
    redemptions: rows.reduce((s, r) => s + r.redemptions, 0),
    discountGiven: money(rows.reduce((s, r) => s + r.discountGiven, 0)),
    revenueAttributed: money(rows.reduce((s, r) => s + r.revenueAttributed, 0)),
  };
  totals.netRevenue = money(totals.revenueAttributed - totals.discountGiven);
  return { coupons: rows, totals };
}

// ROI de una campaña: cruza envíos con las redenciones de sus cupones.
export async function campaignRoi(campaignId) {
  const campaign = await prisma.campaign.findUnique({ where: { id: campaignId } });
  if (!campaign) throw new Error('Campaña no encontrada');
  const coupons = await prisma.coupon.findMany({ where: { campaignId } });
  const couponIds = coupons.map(c => c.id);
  const reds = couponIds.length
    ? await prisma.couponRedemption.findMany({ where: { couponId: { in: couponIds } } })
    : [];
  const revenue = money(reds.reduce((s, r) => s + r.reservationTotal, 0));
  const discount = money(reds.reduce((s, r) => s + r.amountDiscounted, 0));
  const sent = campaign.sentCount || 0;
  return {
    campaign: { id: campaign.id, name: campaign.name, sentCount: sent, status: campaign.status },
    coupons: coupons.map(c => ({ id: c.id, code: c.code, redemptions: c.redemptions })),
    redemptions: reds.length,
    conversionRate: sent > 0 ? Math.round((reds.length / sent) * 1000) / 10 : null,
    revenueAttributed: revenue, discountGiven: discount, netRevenue: money(revenue - discount),
  };
}
