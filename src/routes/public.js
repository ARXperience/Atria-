// Endpoints públicos (sin autenticación): checkout de links de pago,
// webhook de pasarela, webchat y portal del huésped por token de reserva.
import { Router } from 'express';
import { prisma } from '../db.js';
import { handleGatewayWebhook } from '../services/payments.js';
import { upsertConversation, saveInbound, sendOutbound } from '../services/inbox.js';
import { assistantReply } from '../services/ai/assistant.js';
import { fmtCOP, dayStr } from '../lib/util.js';
import { logger } from '../lib/logger.js';

export const publicRouter = Router();

// ---- Media pública: imágenes de habitaciones (solo docType=image) ----
publicRouter.get('/media/:documentId', async (req, res) => {
  const doc = await prisma.document.findUnique({ where: { id: req.params.documentId } });
  if (!doc || doc.status !== 'active' || doc.docType !== 'image') return res.status(404).json({ error: 'Imagen no encontrada' });
  try {
    const { readDocumentFile } = await import('../services/documents.js');
    const buffer = await readDocumentFile(doc);
    res.setHeader('Content-Type', doc.mimeType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.end(buffer);
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// ---- Contenido público de habitaciones (web / motor de reservas) ----
publicRouter.get('/hotel/:propertyId/rooms', async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.propertyId } });
  if (!property) return res.status(404).json({ error: 'Sede no encontrada' });
  const { roomsContent } = await import('../services/knowledge.js');
  res.json({ hotel: { name: property.name, city: property.city }, rooms: await roomsContent(property.id) });
});

// ---- Webhook de pasarelas (mock, wompi, mercadopago, bold, stripe) ----
publicRouter.post('/webhooks/payments/:provider', async (req, res) => {
  try {
    const result = await handleGatewayWebhook(req.params.provider, req.body, req.headers, {
      query: req.query, rawBody: req.rawBody || null,
    });
    res.json({ received: true, result: result?.id || result });
  } catch (err) {
    logger.warn({ err: err.message, provider: req.params.provider }, 'payment webhook rejected');
    res.status(400).json({ error: err.message });
  }
});

// ---- Página de pago (simulador de checkout para PAYMENT_PROVIDER=mock) ----
publicRouter.get('/pay/:token/info', async (req, res) => {
  const link = await prisma.paymentLink.findUnique({
    where: { token: req.params.token },
    include: { reservation: { include: { guest: true, property: true } } },
  });
  if (!link) return res.status(404).json({ error: 'Link de pago no encontrado' });
  res.json({
    concept: link.concept, amount: link.amount, currency: link.currency,
    status: link.status, expiresAt: link.expiresAt, provider: link.provider,
    externalUrl: link.externalUrl || null,
    hotel: link.reservation?.property?.name || null,
    reservationCode: link.reservation?.code || null,
    guestName: link.reservation?.guest?.fullName || null,
  });
});

publicRouter.post('/pay/:token/confirm', async (req, res) => {
  // Solo válido para links del simulador: las pasarelas reales confirman por webhook.
  try {
    const link = await prisma.paymentLink.findUnique({ where: { token: req.params.token } });
    if (!link) return res.status(404).json({ error: 'Link de pago no encontrado' });
    if (link.provider !== 'mock') return res.status(400).json({ error: `Este cobro se procesa con ${link.provider}; usa el checkout de la pasarela.` });
    const result = await handleGatewayWebhook('mock', { reference: req.params.token, method: req.body?.method || 'card' });
    res.json({ ok: true, paymentId: result?.id || null });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Webchat público (mismo cerebro que WhatsApp) ----
publicRouter.post('/webchat/:propertyId/messages', async (req, res) => {
  const { sessionId, text, name } = req.body || {};
  if (!sessionId || !text) return res.status(400).json({ error: 'sessionId y text requeridos' });
  const property = await prisma.property.findUnique({ where: { id: req.params.propertyId } });
  if (!property) return res.status(404).json({ error: 'Sede no encontrada' });
  const conversation = await upsertConversation({
    propertyId: property.id, channel: 'webchat', contactId: String(sessionId), contactName: name || null,
  });
  await saveInbound(conversation.id, String(text));
  const fresh = await prisma.conversation.findUnique({ where: { id: conversation.id } });
  let replies = [];
  if (fresh.aiEnabled) {
    const out = await assistantReply({ propertyId: property.id, conversation: fresh, text: String(text) });
    for (const r of out.replies) await sendOutbound(conversation.id, r, { sender: 'ai' });
    replies = out.replies;
  }
  res.json({ conversationId: conversation.id, replies, aiEnabled: fresh.aiEnabled });
});

publicRouter.get('/webchat/:propertyId/messages', async (req, res) => {
  const { sessionId, after } = req.query;
  const conversation = await prisma.conversation.findUnique({
    where: { propertyId_channel_contactId: { propertyId: req.params.propertyId, channel: 'webchat', contactId: String(sessionId) } },
  });
  if (!conversation) return res.json({ messages: [] });
  const messages = await prisma.message.findMany({
    where: { conversationId: conversation.id, ...(after ? { createdAt: { gt: new Date(after) } } : {}) },
    orderBy: { createdAt: 'asc' }, take: 100,
  });
  res.json({ messages });
});

// ---- Portal del huésped (sección 14): consulta de reserva por código ----
publicRouter.get('/guest/reservation/:code', async (req, res) => {
  const r = await prisma.reservation.findUnique({
    where: { code: req.params.code },
    include: { guest: true, property: true, payments: true, paymentLinks: true },
  });
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  const paid = r.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0);
  res.json({
    code: r.code, status: r.status, hotel: r.property.name, city: r.property.city,
    guestName: r.guest.fullName,
    checkIn: dayStr(r.checkIn), checkOut: dayStr(r.checkOut),
    nights: r.nights, adults: r.adults, children: r.children,
    total: r.total, totalFmt: fmtCOP(r.total), paid, balance: r.total - paid,
    checkInTime: r.property.checkInTime, checkOutTime: r.property.checkOutTime,
    pendingLink: r.paymentLinks.find(l => l.status === 'active')?.token || null,
  });
});
