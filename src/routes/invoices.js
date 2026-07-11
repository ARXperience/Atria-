// Atria Fiscal (sección 16): facturas con Dataico.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { createInvoiceFromReservation, issueInvoice, dataicoConfigured } from '../services/invoicing.js';
import { badRequest } from '../lib/util.js';

export const invoicesRouter = Router();

invoicesRouter.get('/', requirePermission('invoices.view'), async (req, res) => {
  const { propertyId, status } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId };
  if (status) where.status = status;
  const invoices = await prisma.invoice.findMany({
    where, include: { reservation: { select: { code: true } } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json({ dataicoConfigured: dataicoConfigured(), invoices: invoices.map(i => ({ ...i, items: JSON.parse(i.items) })) });
});

invoicesRouter.post('/from-reservation', requirePermission('invoices.create'), async (req, res) => {
  const { reservationId } = req.body || {};
  if (!reservationId) return badRequest(res, 'reservationId requerido');
  const r = await prisma.reservation.findUnique({ where: { id: reservationId } });
  if (!r || !propertyScope(req, r.propertyId)) return res.status(404).json({ error: 'Reserva no encontrada' });
  try {
    res.status(201).json(await createInvoiceFromReservation(reservationId, { user: req.user, actor: 'human' }));
  } catch (err) { badRequest(res, err.message); }
});

invoicesRouter.post('/:id/issue', requirePermission('invoices.issue'), async (req, res) => {
  const invoice = await prisma.invoice.findUnique({ where: { id: req.params.id } });
  if (!invoice || !propertyScope(req, invoice.propertyId)) return res.status(404).json({ error: 'Factura no encontrada' });
  try {
    res.json(await issueInvoice(invoice.id, { user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});
