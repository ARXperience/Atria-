// PMS (sección 11): reservas, check-in/out, folios y cargos.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { checkIn, checkOut, cancelReservation, confirmReservation } from '../services/reservations.js';
import { reservationBalance } from '../services/payments.js';
import { requestApproval } from '../services/approvals.js';
import { audit } from '../lib/audit.js';
import { badRequest, fmtCOP } from '../lib/util.js';
import { emitEvent } from '../lib/events.js';

export const reservationsRouter = Router();

reservationsRouter.get('/', requirePermission('reservations.view'), async (req, res) => {
  const { propertyId, status, q, from, to } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = { in: String(status).split(',') };
  if (from) where.checkIn = { gte: new Date(from) };
  if (to) where.checkOut = { ...(where.checkOut || {}), lte: new Date(to) };
  if (q) where.OR = [{ code: { contains: q } }, { guest: { fullName: { contains: q } } }];
  const list = await prisma.reservation.findMany({
    where, include: { guest: true, room: true }, orderBy: { checkIn: 'asc' }, take: 200,
  });
  res.json(list);
});

reservationsRouter.get('/:id', requirePermission('reservations.view'), async (req, res) => {
  const r = await prisma.reservation.findUnique({
    where: { id: req.params.id },
    include: {
      guest: true, room: { include: { roomType: true } },
      folio: { include: { charges: true } }, payments: true, paymentLinks: true,
      traRecords: true, sireReports: true,
    },
  });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  const roomType = await prisma.roomType.findUnique({ where: { id: r.roomTypeId } });
  const balance = await reservationBalance(r.id);
  res.json({ ...r, roomType, balance });
});

// Oportunidades de upsell de la reserva (para ofrecer en recepción)
reservationsRouter.get('/:id/upsell', requirePermission('reservations.view'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  const { upsellOffers } = await import('../services/ai/upsell.js');
  res.json(await upsellOffers(r.id));
});

reservationsRouter.post('/:id/confirm', requirePermission('reservations.edit'), async (req, res) => {
  try {
    res.json(await confirmReservation(req.params.id, { actor: 'human', user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

reservationsRouter.post('/:id/cancel', requirePermission('reservations.edit'), async (req, res) => {
  try {
    res.json(await cancelReservation(req.params.id, { reason: req.body?.reason, user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

// Descuento sobre el folio → requiere aprobación de gerente (matriz §47).
reservationsRouter.post('/:id/discount', requirePermission('reservations.edit'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  const amount = +req.body?.amount;
  if (!(amount > 0)) return badRequest(res, 'amount > 0 requerido');
  const approval = await requestApproval({
    propertyId: r.propertyId, type: 'discount',
    summary: `Descuento de ${fmtCOP(amount)} en reserva ${r.code}${req.body?.reason ? ` — ${req.body.reason}` : ''}.`,
    payload: { propertyId: r.propertyId, reservationId: r.id, amount, reason: req.body?.reason || null, approvedByName: req.user?.name },
    requiredRole: 'MANAGER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

// Cambio de tarifa fuera de la lista → aprobación de gerente.
reservationsRouter.post('/:id/rate-override', requirePermission('reservations.edit'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  const nightlyRate = +req.body?.nightlyRate;
  if (!(nightlyRate > 0)) return badRequest(res, 'nightlyRate > 0 requerido');
  const approval = await requestApproval({
    propertyId: r.propertyId, type: 'rate_override',
    summary: `Cambio de tarifa a ${fmtCOP(nightlyRate)}/noche en reserva ${r.code} (actual ${fmtCOP(r.nightlyRate)}).`,
    payload: { reservationId: r.id, nightlyRate, reason: req.body?.reason || null },
    requiredRole: 'MANAGER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

// Exonerar anticipo de la reserva → aprobación de gerente.
reservationsRouter.post('/:id/waive-deposit', requirePermission('reservations.edit'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  const approval = await requestApproval({
    propertyId: r.propertyId, type: 'reservation_no_deposit',
    summary: `Exonerar anticipo (${fmtCOP(r.depositRequired)}) de la reserva ${r.code}.`,
    payload: { reservationId: r.id, reason: req.body?.reason || null },
    requiredRole: 'MANAGER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

// Cancelación fuera de política (con penalidad / estadía en curso) → aprobación.
reservationsRouter.post('/:id/request-cancellation', requirePermission('reservations.edit'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  const approval = await requestApproval({
    propertyId: r.propertyId, type: 'cancellation',
    summary: `Cancelación de la reserva ${r.code} (estado ${r.status})${req.body?.reason ? ` — ${req.body.reason}` : ''}.`,
    payload: { reservationId: r.id, reason: req.body?.reason || null },
    requiredRole: 'MANAGER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

reservationsRouter.post('/:id/checkin', requirePermission('reservations.checkin'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  try {
    res.json(await checkIn(req.params.id, { roomId: req.body?.roomId || null, user: req.user }));
  } catch (err) {
    // Check-in sin pago suficiente → solicitud de aprobación a gerente (sección 11)
    if (/Pago insuficiente/.test(err.message)) {
      const approval = await requestApproval({
        propertyId: r.propertyId, type: 'checkin_override',
        summary: `Check-in sin anticipo completo para reserva ${r.code}. ${err.message}`,
        payload: { reservationId: r.id, roomId: req.body?.roomId || null },
        requiredRole: 'MANAGER', user: req.user,
      });
      return res.status(202).json({ pendingApproval: approval });
    }
    badRequest(res, err.message);
  }
});

reservationsRouter.post('/:id/checkout', requirePermission('reservations.checkout'), async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  try {
    res.json(await checkOut(req.params.id, { user: req.user }));
  } catch (err) {
    if (/Saldo pendiente/.test(err.message)) {
      const approval = await requestApproval({
        propertyId: r.propertyId, type: 'checkout_with_balance',
        summary: `Check-out con saldo pendiente para reserva ${r.code}. ${err.message}`,
        payload: { reservationId: r.id },
        requiredRole: 'MANAGER', user: req.user,
      });
      return res.status(202).json({ pendingApproval: approval });
    }
    badRequest(res, err.message);
  }
});

// Cargos al folio (restaurante, minibar, room service, daños...)
reservationsRouter.post('/:id/charges', requirePermission('reservations.edit'), async (req, res) => {
  const { concept, description, amount, taxAmount = 0 } = req.body || {};
  if (!concept || !(amount > 0)) return badRequest(res, 'concept y amount > 0 requeridos');
  const r = await prisma.reservation.findUnique({ where: { id: req.params.id }, include: { folio: true } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  if (r.status !== 'checked_in') return badRequest(res, 'Solo se pueden cargar consumos con la estadía en curso');
  const folio = r.folio || await prisma.folio.create({ data: { reservationId: r.id } });
  const charge = await prisma.folioCharge.create({
    data: { folioId: folio.id, concept, description, amount: +amount, taxAmount: +taxAmount, postedBy: req.user.name },
  });
  await audit({ propertyId: r.propertyId, user: req.user, action: 'folio.charge_added', entity: 'FolioCharge', entityId: charge.id, after: { concept, amount: +amount, reservation: r.code } });
  emitEvent('folio.charge_added', { propertyId: r.propertyId, reservationId: r.id });
  res.status(201).json(charge);
});

// Mapa de habitaciones (sección 11): estado + reserva en curso por habitación
reservationsRouter.get('/map/rooms', requirePermission('rooms.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const rooms = await prisma.room.findMany({
    where: { propertyId, active: true },
    include: {
      roomType: true,
      reservations: {
        where: { status: 'checked_in' },
        include: { guest: true },
        take: 1,
      },
    },
    orderBy: { number: 'asc' },
  });
  res.json(rooms.map(r => ({
    id: r.id, number: r.number, floor: r.floor, status: r.status,
    roomType: r.roomType.name, capacity: r.roomType.capacity,
    currentGuest: r.reservations[0] ? {
      reservationId: r.reservations[0].id,
      code: r.reservations[0].code,
      name: r.reservations[0].guest.fullName,
      checkOut: r.reservations[0].checkOut,
    } : null,
  })));
});
