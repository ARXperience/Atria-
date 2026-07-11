// Motor de reservas (sección 10): búsqueda, cotización y reserva tentativa.
import { Router } from 'express';
import { findAvailability } from '../services/availability.js';
import { buildQuote } from '../services/quote.js';
import { createTentativeReservation } from '../services/reservations.js';
import { createPaymentLink } from '../services/payments.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { parseDay, badRequest } from '../lib/util.js';

export const bookingRouter = Router();

function parseSearch(req, res) {
  const { propertyId, checkIn, checkOut, adults = 2, children = 0 } = { ...req.query, ...req.body };
  const ci = parseDay(checkIn), co = parseDay(checkOut);
  if (!propertyId) { badRequest(res, 'propertyId requerido'); return null; }
  if (!ci || !co || co <= ci) { badRequest(res, 'Fechas inválidas (checkIn/checkOut como YYYY-MM-DD, salida posterior a llegada)'); return null; }
  return { propertyId, checkIn: ci, checkOut: co, adults: +adults, children: +children };
}

bookingRouter.post('/search', requirePermission('booking.search'), async (req, res) => {
  const params = parseSearch(req, res);
  if (!params) return;
  if (!propertyScope(req, params.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await findAvailability(params));
});

bookingRouter.post('/quote', requirePermission('booking.quote'), async (req, res) => {
  const params = parseSearch(req, res);
  if (!params) return;
  if (!propertyScope(req, params.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const { roomTypeId, ratePlanId } = req.body;
  if (!roomTypeId) return badRequest(res, 'roomTypeId requerido');
  try {
    res.json(await buildQuote({ ...params, roomTypeId, ratePlanId: ratePlanId || null }));
  } catch (err) {
    badRequest(res, err.message);
  }
});

bookingRouter.post('/reservations', requirePermission('reservations.create'), async (req, res) => {
  const params = parseSearch(req, res);
  if (!params) return;
  if (!propertyScope(req, params.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const { roomTypeId, ratePlanId, guest, channel = 'direct', withPaymentLink = true, notes } = req.body;
  if (!roomTypeId || !guest?.fullName) return badRequest(res, 'roomTypeId y guest.fullName son requeridos');
  try {
    const reservation = await createTentativeReservation({
      ...params, roomTypeId, ratePlanId: ratePlanId || null, guest, channel,
      createdBy: req.user.id, notes,
    });
    let paymentLink = null;
    if (withPaymentLink && reservation.depositRequired > 0) {
      paymentLink = await createPaymentLink({
        propertyId: params.propertyId, reservationId: reservation.id,
        concept: `Anticipo reserva ${reservation.code}`, amount: reservation.depositRequired,
        createdBy: req.user.id,
      });
    }
    res.status(201).json({ reservation, paymentLink });
  } catch (err) {
    badRequest(res, err.message);
  }
});
