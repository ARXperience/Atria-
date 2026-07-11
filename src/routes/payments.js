// Atria Pay (sección 15): links, pagos manuales (con aprobación),
// reembolsos (con aprobación) y listado.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { createPaymentLink, paymentLinkUrl } from '../services/payments.js';
import { requestApproval } from '../services/approvals.js';
import { badRequest, fmtCOP } from '../lib/util.js';

export const paymentsRouter = Router();

paymentsRouter.get('/', requirePermission('payments.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const payments = await prisma.payment.findMany({
    where: { propertyId },
    include: { reservation: { select: { code: true } } },
    orderBy: { createdAt: 'desc' }, take: 200,
  });
  res.json(payments);
});

paymentsRouter.post('/links', requirePermission('payments.link'), async (req, res) => {
  const { propertyId, reservationId, concept, amount } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!concept || !(amount > 0)) return badRequest(res, 'concept y amount > 0 requeridos');
  try {
    res.status(201).json(await createPaymentLink({ propertyId, reservationId: reservationId || null, concept, amount: +amount, createdBy: req.user.id }));
  } catch (err) { badRequest(res, err.message); }
});

paymentsRouter.get('/links', requirePermission('payments.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const links = await prisma.paymentLink.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 100 });
  res.json(links.map(l => ({ ...l, url: paymentLinkUrl(l) })));
});

// Pago manual (efectivo/transferencia/datáfono) → requiere aprobación (matriz 47)
paymentsRouter.post('/manual', requirePermission('payments.manual_request'), async (req, res) => {
  const { propertyId, reservationId, amount, method, supportRef } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!(amount > 0) || !method) return badRequest(res, 'amount > 0 y method requeridos');
  const r = reservationId ? await prisma.reservation.findUnique({ where: { id: reservationId } }) : null;
  const approval = await requestApproval({
    propertyId, type: 'manual_payment',
    summary: `Registrar pago manual de ${fmtCOP(+amount)} (${method})${r ? ` para reserva ${r.code}` : ''}${supportRef ? ` — soporte ${supportRef}` : ''}`,
    payload: { propertyId, reservationId: reservationId || null, amount: +amount, method, supportRef, registeredByName: req.user.name },
    requiredRole: 'MANAGER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});

// Reembolso → requiere aprobación de dueño/gerente (matriz 47)
paymentsRouter.post('/refunds', requirePermission('payments.manual_request'), async (req, res) => {
  const { propertyId, reservationId, amount, reason, method } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!(amount > 0)) return badRequest(res, 'amount > 0 requerido');
  const approval = await requestApproval({
    propertyId, type: 'refund',
    summary: `Reembolso de ${fmtCOP(+amount)}${reason ? ` — motivo: ${reason}` : ''}`,
    payload: { propertyId, reservationId: reservationId || null, amount: +amount, reason, method, registeredByName: req.user.name },
    requiredRole: 'OWNER', user: req.user,
  });
  res.status(202).json({ pendingApproval: approval });
});
