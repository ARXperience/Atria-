// Endpoints públicos (sin autenticación): checkout de links de pago,
// webhook de pasarela, webchat y portal del huésped por token de reserva.
import { Router } from 'express';
import { prisma } from '../db.js';
import { handleGatewayWebhook } from '../services/payments.js';
import { upsertConversation, saveInbound, sendOutbound } from '../services/inbox.js';
import { assistantReply } from '../services/ai/assistant.js';
import { createReview } from '../services/reputation.js';
import { submitPrecheckin, createGuestRequest, listGuestRequests, payBalanceLink, requestExpressCheckout } from '../services/guestPortal.js';
import { submitSurvey, getSurveyForReservation } from '../services/surveys.js';
import { fmtCOP, dayStr, parseDay } from '../lib/util.js';
import { GUEST_SERVICES, parseServiceList } from '../lib/services.js';
import { disabledFeatures } from '../services/platform.js';
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

// ---- Sitio web público del hotel (§9): hero + habitaciones + FAQs ----
publicRouter.get('/hotel/:propertyId/site', async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.propertyId } });
  if (!property) return res.status(404).json({ error: 'Sede no encontrada' });
  const [{ roomsContent, listKnowledge }, site] = await Promise.all([
    import('../services/knowledge.js'),
    prisma.siteSettings.findUnique({ where: { propertyId: property.id } }),
  ]);
  if (site && !site.published) return res.status(404).json({ error: 'Sitio no publicado' });
  const rooms = await roomsContent(property.id);
  const faqs = await listKnowledge(property.id, { visibility: 'public' });
  // Servicios del hotel de cara al cliente: los que la sede ofrece y no estén
  // apagados globalmente (§14/§55.1).
  const enabled = parseServiceList(property.enabledServices); // null = todos
  const disabled = await disabledFeatures();
  const services = GUEST_SERVICES.filter(s => (enabled == null || enabled.includes(s.key)) && !disabled.has(s.key));
  res.json({
    hotel: { name: property.name, city: property.city, address: property.address, checkInTime: property.checkInTime, checkOutTime: property.checkOutTime, rnt: property.rnt, whatsapp: property.whatsappNumber },
    site: site ? { heroTitle: site.heroTitle, heroSubtitle: site.heroSubtitle, aboutText: site.aboutText, promoText: site.promoText, heroImage: site.heroImageId ? `/api/public/media/${site.heroImageId}` : null } : {},
    rooms, services, faqs: faqs.map(f => ({ title: f.title, content: f.content, category: f.category })),
  });
});

// ---- Disponibilidad pública ----
publicRouter.post('/hotel/:propertyId/availability', async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.propertyId } });
  if (!property) return res.status(404).json({ error: 'Sede no encontrada' });
  const ci = parseDay(req.body?.checkIn), co = parseDay(req.body?.checkOut);
  if (!ci || !co || co <= ci) return res.status(400).json({ error: 'Fechas inválidas' });
  const { findAvailability } = await import('../services/availability.js');
  const options = await findAvailability({ propertyId: property.id, checkIn: ci, checkOut: co, adults: +(req.body?.adults || 2), children: +(req.body?.children || 0) });
  const { roomTypeImages } = await import('../services/knowledge.js');
  const enriched = [];
  for (const o of options) {
    const plan = o.ratePlans[0] || null;
    enriched.push({ roomTypeId: o.roomTypeId, roomType: o.roomType, capacity: o.capacity, description: o.description, available: o.availableRooms, price: plan?.price ?? o.baseRate, ratePlanId: plan?.ratePlanId || null, images: await roomTypeImages(o.roomTypeId) });
  }
  res.json(enriched);
});

// ---- Reserva directa pública (crea tentativa + link de pago) ----
publicRouter.post('/hotel/:propertyId/book', async (req, res) => {
  const property = await prisma.property.findUnique({ where: { id: req.params.propertyId } });
  if (!property) return res.status(404).json({ error: 'Sede no encontrada' });
  const { checkIn, checkOut, adults = 2, children = 0, roomTypeId, ratePlanId, guest, couponCode } = req.body || {};
  const ci = parseDay(checkIn), co = parseDay(checkOut);
  if (!ci || !co || co <= ci) return res.status(400).json({ error: 'Fechas inválidas' });
  if (!roomTypeId || !guest?.fullName) return res.status(400).json({ error: 'Habitación y nombre del huésped requeridos' });
  try {
    const { createTentativeReservation } = await import('../services/reservations.js');
    const { createPaymentLink } = await import('../services/payments.js');
    const reservation = await createTentativeReservation({
      propertyId: property.id, guest: { fullName: guest.fullName, phone: guest.phone || null, email: guest.email || null },
      roomTypeId, ratePlanId: ratePlanId || null, checkIn: ci, checkOut: co,
      adults: +adults, children: +children, channel: 'web', createdBy: 'web', couponCode: couponCode || null,
    });
    const link = await createPaymentLink({ propertyId: property.id, reservationId: reservation.id, concept: `Anticipo reserva ${reservation.code}`, amount: reservation.depositRequired });
    res.status(201).json({ code: reservation.code, total: reservation.total, deposit: reservation.depositRequired, paymentUrl: link.url });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// ---- Webhook de OTA (channel manager §35): recibe reservas externas ----
publicRouter.post('/channels/:channelCode/webhook', async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyId) return res.status(400).json({ error: 'propertyId requerido' });
  try {
    const { receiveChannelReservation } = await import('../services/channels.js');
    const result = await receiveChannelReservation({ propertyId, channelCode: req.params.channelCode, payload: req.body || {} });
    res.status(201).json({ received: true, code: result.reservation.code, overbooking: result.overbooking });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
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
    propertyId: property.id, channel: 'webchat', contactId: String(sessionId),
    contactName: name || null, contactPhone: req.body?.phone || null,
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
  const paid = r.payments.filter(p => p.status === 'approved' && p.kind !== 'refund').reduce((s, p) => s + p.amount, 0)
    - r.payments.filter(p => p.status === 'approved' && p.kind === 'refund').reduce((s, p) => s + p.amount, 0);
  res.json({
    code: r.code, status: r.status, hotel: r.property.name, city: r.property.city,
    guestName: r.guest.fullName,
    checkIn: dayStr(r.checkIn), checkOut: dayStr(r.checkOut),
    nights: r.nights, adults: r.adults, children: r.children,
    total: r.total, totalFmt: fmtCOP(r.total), paid, balance: Math.round(r.total - paid),
    checkInTime: r.property.checkInTime, checkOutTime: r.property.checkOutTime,
    pendingLink: r.paymentLinks.find(l => l.status === 'active')?.token || null,
    precheckinDone: !!r.precheckinAt, arrivalTime: r.arrivalTime,
    guestDoc: r.guest.documentNumber, guestEmail: r.guest.email, guestPhone: r.guest.phone, guestNationality: r.guest.nationality,
    survey: r.status === 'checked_out' ? await getSurveyForReservation(r.id).then(s => s ? { status: s.status } : null).catch(() => null) : null,
  });
});

// Encuesta post-estadía (§37) respondida desde el portal
publicRouter.post('/guest/reservation/:code/survey', async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { code: req.params.code } });
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  try { res.json(await submitSurvey(r.id, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Pre-check-in / check-in digital (§48.2)
publicRouter.post('/guest/reservation/:code/precheckin', async (req, res) => {
  try { res.json(await submitPrecheckin(req.params.code, req.body || {})); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Solicitudes de servicio del huésped
publicRouter.post('/guest/reservation/:code/request', async (req, res) => {
  try { res.status(201).json(await createGuestRequest(req.params.code, { type: req.body?.type, detail: req.body?.detail })); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
publicRouter.get('/guest/reservation/:code/requests', async (req, res) => {
  try { res.json(await listGuestRequests(req.params.code)); }
  catch (err) { res.status(404).json({ error: err.message }); }
});

// Pagar saldo desde el portal
publicRouter.post('/guest/reservation/:code/pay', async (req, res) => {
  try { res.json(await payBalanceLink(req.params.code)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Check-out express
publicRouter.post('/guest/reservation/:code/express-checkout', async (req, res) => {
  try { res.json(await requestExpressCheckout(req.params.code)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// Ofertas de upsell personalizadas para el huésped (§12/§41)
publicRouter.get('/guest/reservation/:code/upsell', async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { code: String(req.params.code).toUpperCase() } });
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  try { const { upsellOffers } = await import('../services/ai/upsell.js'); res.json(await upsellOffers(r.id)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});
publicRouter.post('/guest/reservation/:code/upsell/accept', async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { code: String(req.params.code).toUpperCase() } });
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  try { const { acceptUpsell } = await import('../services/ai/upsell.js'); res.json(await acceptUpsell(r.id, req.body?.offerId)); }
  catch (err) { res.status(400).json({ error: err.message }); }
});

// El huésped deja una reseña post-estancia desde su portal (con el código).
publicRouter.post('/guest/reservation/:code/review', async (req, res) => {
  const r = await prisma.reservation.findUnique({ where: { code: req.params.code }, include: { guest: true } });
  if (!r) return res.status(404).json({ error: 'Reserva no encontrada' });
  const existing = await prisma.review.findFirst({ where: { reservationId: r.id, source: 'direct' } });
  if (existing) return res.status(409).json({ error: 'Ya registramos tu reseña. ¡Gracias!' });
  try {
    const review = await createReview({
      propertyId: r.propertyId, reservationId: r.id, guestId: r.guestId, guestName: r.guest.fullName,
      source: 'direct', rating: req.body?.rating, title: req.body?.title || null, comment: req.body?.comment || null,
    });
    res.status(201).json({ ok: true, rating: review.rating });
  } catch (err) { res.status(400).json({ error: err.message }); }
});
