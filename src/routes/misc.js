// Aprobaciones, auditoría, notificaciones y dashboard gerencial.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { decideApproval } from '../services/approvals.js';
import { badRequest, dayStr, addDays } from '../lib/util.js';

export const miscRouter = Router();

// ---- Aprobaciones (sección 47) ----
miscRouter.get('/approvals', requirePermission('approvals.view'), async (req, res) => {
  const { propertyId, status = 'pending' } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.approvalRequest.findMany({ where: { propertyId, status }, orderBy: { createdAt: 'desc' }, take: 100 }));
});

miscRouter.post('/approvals/:id/decide', requirePermission('approvals.decide'), async (req, res) => {
  const { approve, note } = req.body || {};
  if (typeof approve !== 'boolean') return badRequest(res, 'approve (true/false) requerido');
  try {
    res.json(await decideApproval(req.params.id, { approve, user: req.user, note }));
  } catch (err) { badRequest(res, err.message); }
});

// ---- Auditoría (sección 42) ----
miscRouter.get('/audit-logs', requirePermission('audit.view'), async (req, res) => {
  const { propertyId, entity, action, actor, take = 100 } = req.query;
  const where = { companyId: req.user.companyId };
  if (propertyId) {
    if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
    where.OR = [{ propertyId }, { propertyId: null }];
    delete where.companyId;
  }
  if (entity) where.entity = entity;
  if (action) where.action = { contains: action };
  if (actor) where.actor = actor;
  res.json(await prisma.auditLog.findMany({ where, orderBy: { createdAt: 'desc' }, take: Math.min(+take, 500) }));
});

// ---- Notificaciones (sección 44) ----
miscRouter.get('/notifications', requirePermission('notifications.view'), async (req, res) => {
  const { propertyId, unread } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (unread === 'true') where.readAt = null;
  res.json(await prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 }));
});

miscRouter.post('/notifications/:id/read', requirePermission('notifications.view'), async (req, res) => {
  const n = await prisma.notification.findUnique({ where: { id: req.params.id } });
  if (!n || !propertyScope(req, n.propertyId)) return res.status(404).json({ error: 'No encontrada' });
  res.json(await prisma.notification.update({ where: { id: n.id }, data: { readAt: new Date() } }));
});

// ---- Dashboard gerencial (sección 38): ocupación, ADR, RevPAR, llegadas ----
miscRouter.get('/dashboard', requirePermission('dashboard.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });

  const now = new Date();
  const today = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  const tomorrow = addDays(today, 1);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  const [totalRooms, occupiedRooms, oosRooms, arrivals, departures, inHouse, tentativeCount, monthPayments, monthReservations, pendingApprovals, hkPending, openLeads] = await Promise.all([
    prisma.room.count({ where: { propertyId, active: true } }),
    prisma.room.count({ where: { propertyId, status: 'occupied' } }),
    prisma.room.count({ where: { propertyId, status: 'out_of_service' } }),
    prisma.reservation.findMany({ where: { propertyId, status: 'confirmed', checkIn: { gte: today, lt: tomorrow } }, include: { guest: true } }),
    prisma.reservation.findMany({ where: { propertyId, status: 'checked_in', checkOut: { gte: today, lt: tomorrow } }, include: { guest: true, room: true } }),
    prisma.reservation.count({ where: { propertyId, status: 'checked_in' } }),
    prisma.reservation.count({ where: { propertyId, status: 'tentative' } }),
    prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'payment', createdAt: { gte: monthStart } }, _sum: { amount: true } }),
    prisma.reservation.findMany({ where: { propertyId, status: { in: ['confirmed', 'checked_in', 'checked_out'] }, checkIn: { gte: monthStart } }, select: { nights: true, subtotal: true } }),
    prisma.approvalRequest.count({ where: { propertyId, status: 'pending' } }),
    prisma.housekeepingTask.count({ where: { propertyId, status: { in: ['pending', 'in_progress'] } } }),
    prisma.lead.count({ where: { propertyId, stage: { in: ['new', 'qualified', 'quoted'] } } }),
  ]);

  const sellable = totalRooms - oosRooms;
  const occupancy = sellable > 0 ? occupiedRooms / sellable : 0;
  const roomNightsSold = monthReservations.reduce((s, r) => s + r.nights, 0);
  const roomRevenue = monthReservations.reduce((s, r) => s + r.subtotal, 0);
  const adr = roomNightsSold > 0 ? roomRevenue / roomNightsSold : 0;
  const daysInMonth = Math.max(1, Math.round((now - monthStart) / 86400000) + 1);
  const revpar = sellable > 0 ? roomRevenue / (sellable * daysInMonth) : 0;

  // Señales cruzadas del ecosistema (reputación, eventos, cartera, datos).
  const [reviews, upcomingEvents, dsrOpen, apOpen] = await Promise.all([
    prisma.review.findMany({ where: { propertyId }, select: { rating: true, status: true } }),
    prisma.eventBooking.count({ where: { propertyId, status: { in: ['quote', 'confirmed', 'in_progress'] }, date: { gte: today } } }),
    prisma.dataSubjectRequest.count({ where: { propertyId, status: { in: ['received', 'in_progress'] } } }),
    prisma.accountPayable.aggregate({ where: { propertyId, status: 'open' }, _sum: { amount: true } }),
  ]);
  const reputationAvg = reviews.length ? Math.round((reviews.reduce((s, r) => s + r.rating, 0) / reviews.length) * 10) / 10 : 0;
  const reviewsPending = reviews.filter(r => r.status === 'published').length;

  res.json({
    ecosystem: {
      reputationAvg, reviewsPending, upcomingEvents,
      dataRequestsOpen: dsrOpen, payableOpen: Math.round(apOpen._sum.amount || 0),
    },
    date: dayStr(today),
    rooms: { total: totalRooms, occupied: occupiedRooms, outOfService: oosRooms, occupancyPct: Math.round(occupancy * 100) },
    kpis: { adr: Math.round(adr), revpar: Math.round(revpar), monthRevenue: monthPayments._sum.amount || 0, roomNightsSold },
    today: {
      arrivals: arrivals.map(r => ({ id: r.id, code: r.code, guest: r.guest.fullName, adults: r.adults })),
      departures: departures.map(r => ({ id: r.id, code: r.code, guest: r.guest.fullName, room: r.room?.number })),
      inHouse,
    },
    alerts: { pendingApprovals, tentativeReservations: tentativeCount, housekeepingPending: hkPending, openLeads },
  });
});
