// Consolidación multi-sede (§8): vista de portafolio para dueños/gerencia.
// Agrega los KPIs de cada sede a la que el usuario tiene acceso.
import { prisma } from '../db.js';
import { money } from '../lib/util.js';
import { accountsReceivable } from './finance.js';

// Sedes visibles para el usuario según su alcance (propertyIds).
export async function accessibleProperties(user) {
  const where = { companyId: user.companyId, active: true };
  if (user.propertyIds && user.propertyIds !== '*') {
    where.id = { in: user.propertyIds.split(',').map(s => s.trim()).filter(Boolean) };
  }
  return prisma.property.findMany({ where, orderBy: { name: 'asc' } });
}

// KPIs de una sede (ocupación, ingresos del mes, ADR, RevPAR, cartera, alertas).
export async function propertyKpis(propertyId) {
  const now = new Date();
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [totalRooms, occupiedRooms, oosRooms, inHouse, monthPayments, monthReservations, pendingApprovals, ar] = await Promise.all([
    prisma.room.count({ where: { propertyId, active: true } }),
    prisma.room.count({ where: { propertyId, status: 'occupied' } }),
    prisma.room.count({ where: { propertyId, status: 'out_of_service' } }),
    prisma.reservation.count({ where: { propertyId, status: 'checked_in' } }),
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'payment', createdAt: { gte: monthStart } }, _sum: { amount: true } }),
    prisma.reservation.findMany({ where: { propertyId, status: { in: ['confirmed', 'checked_in', 'checked_out'] }, checkIn: { gte: monthStart } }, select: { nights: true, subtotal: true } }),
    prisma.approvalRequest.count({ where: { propertyId, status: 'pending' } }),
    accountsReceivable(propertyId),
  ]);
  const sellable = Math.max(0, totalRooms - oosRooms);
  const occupancy = sellable > 0 ? occupiedRooms / sellable : 0;
  const roomNightsSold = monthReservations.reduce((s, r) => s + r.nights, 0);
  const roomRevenue = monthReservations.reduce((s, r) => s + r.subtotal, 0);
  const adr = roomNightsSold > 0 ? roomRevenue / roomNightsSold : 0;
  const daysElapsed = Math.max(1, Math.round((now - monthStart) / 86400000) + 1);
  const revpar = sellable > 0 ? roomRevenue / (sellable * daysElapsed) : 0;
  return {
    rooms: totalRooms, occupied: occupiedRooms, sellable, inHouse,
    occupancyPct: Math.round(occupancy * 100),
    monthRevenue: money(monthPayments._sum.amount || 0),
    adr: money(adr), revpar: money(revpar),
    receivable: ar.total, pendingApprovals,
    // Componentes crudos para ponderar KPIs a nivel de grupo.
    roomRevenue, roomNights: roomNightsSold, sellableNights: sellable * daysElapsed,
  };
}

export async function portfolioOverview(user) {
  const properties = await accessibleProperties(user);
  const sites = await Promise.all(properties.map(async p => ({
    id: p.id, name: p.name, city: p.city, rnt: p.rnt,
    ...(await propertyKpis(p.id)),
  })));
  const totals = sites.reduce((t, s) => ({
    rooms: t.rooms + s.rooms,
    occupied: t.occupied + s.occupied,
    sellable: t.sellable + s.sellable,
    inHouse: t.inHouse + s.inHouse,
    monthRevenue: t.monthRevenue + s.monthRevenue,
    receivable: t.receivable + s.receivable,
    pendingApprovals: t.pendingApprovals + s.pendingApprovals,
    roomRevenue: t.roomRevenue + s.roomRevenue,
    roomNights: t.roomNights + s.roomNights,
    sellableNights: t.sellableNights + s.sellableNights,
  }), { rooms: 0, occupied: 0, sellable: 0, inHouse: 0, monthRevenue: 0, receivable: 0, pendingApprovals: 0, roomRevenue: 0, roomNights: 0, sellableNights: 0 });
  totals.occupancyPct = totals.sellable > 0 ? Math.round((totals.occupied / totals.sellable) * 100) : 0;
  // ADR/RevPAR del portafolio ponderados por ingreso/noches, no promedio simple.
  totals.adr = totals.roomNights > 0 ? money(totals.roomRevenue / totals.roomNights) : 0;
  totals.revpar = totals.sellableNights > 0 ? money(totals.roomRevenue / totals.sellableNights) : 0;
  return { sites, totals, count: sites.length };
}
