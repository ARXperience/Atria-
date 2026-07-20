// Atria Finance (§28): cartera, cuentas por pagar y reportes.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { financeOverview, accountsReceivable, createPayable, payPayable, profitAndLoss, financialNarrative } from '../services/finance.js';
import { currentCashPreview, openCashClosure, closeCashClosure, cashClosureHistory, reconcile } from '../services/cashier.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const financeRouter = Router();

financeRouter.get('/overview', requirePermission('finance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await financeOverview(req.query.propertyId));
});

financeRouter.get('/receivables', requirePermission('finance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await accountsReceivable(req.query.propertyId));
});

financeRouter.get('/report', requirePermission('finance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await profitAndLoss(req.query.propertyId));
});

// Copiloto financiero: resumen del mes en lenguaje natural con recomendación.
financeRouter.get('/summary', requirePermission('finance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await financialNarrative(req.query.propertyId));
});

// ---- Cierre de caja (§28) ----
financeRouter.get('/cash/current', requirePermission('finance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await currentCashPreview(req.query.propertyId));
});

financeRouter.get('/cash/history', requirePermission('finance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await cashClosureHistory(req.query.propertyId));
});

financeRouter.post('/cash/open', requirePermission('finance.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.status(201).json(await openCashClosure(req.body.propertyId, { openingBalance: +req.body.openingBalance || 0, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

financeRouter.post('/cash/:id/close', requirePermission('finance.manage'), async (req, res) => {
  const c = await prisma.cashClosure.findUnique({ where: { id: req.params.id } });
  if (!c || !propertyScope(req, c.propertyId)) return res.status(404).json({ error: 'Caja no encontrada' });
  try { res.json(await closeCashClosure(c.id, { countedAmount: +req.body?.countedAmount || 0, notes: req.body?.notes || null, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// ---- Conciliación de pagos (§28) ----
financeRouter.post('/reconcile', requirePermission('finance.manage'), async (req, res) => {
  if (!propertyScope(req, req.body?.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try { res.json(await reconcile(req.body.propertyId, { from: req.body.from, to: req.body.to, source: req.body.source, externalRefs: req.body.externalRefs, user: req.user })); }
  catch (err) { badRequest(res, err.message); }
});

// ---- Cuentas por pagar ----
financeRouter.get('/payables', requirePermission('finance.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const where = { propertyId: req.query.propertyId };
  if (req.query.status) where.status = req.query.status;
  res.json(await prisma.accountPayable.findMany({ where, orderBy: { createdAt: 'desc' }, take: 200 }));
});

financeRouter.post('/payables', requirePermission('finance.manage'), async (req, res) => {
  const { propertyId } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    const ap = await createPayable({ ...req.body, createdBy: req.user.name });
    await audit({ propertyId, user: req.user, action: 'ap.created', entity: 'AccountPayable', entityId: ap.id, after: { concept: ap.concept, amount: ap.amount } });
    res.status(201).json(ap);
  } catch (err) { badRequest(res, err.message); }
});

// Pagar proveedor requiere rol autorizado (matriz §47: contabilidad/dueño)
financeRouter.post('/payables/:id/pay', requirePermission('finance.manage'), async (req, res) => {
  const ap = await prisma.accountPayable.findUnique({ where: { id: req.params.id } });
  if (!ap || !propertyScope(req, ap.propertyId)) return res.status(404).json({ error: 'Cuenta no encontrada' });
  try {
    const paid = await payPayable(ap.id, { support: req.body?.support });
    await audit({ propertyId: ap.propertyId, user: req.user, action: 'ap.paid', entity: 'AccountPayable', entityId: ap.id, after: { support: req.body?.support } });
    res.json(paid);
  } catch (err) { badRequest(res, err.message); }
});
