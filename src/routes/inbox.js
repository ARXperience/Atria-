// Inbox omnicanal + WhatsApp (sección 13).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { sendOutbound, setHumanTakeover } from '../services/inbox.js';
import { whatsappStatus, startWhatsApp, logoutWhatsApp } from '../services/whatsapp.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const inboxRouter = Router();

inboxRouter.get('/conversations', requirePermission('inbox.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const conversations = await prisma.conversation.findMany({
    where: { propertyId },
    orderBy: { lastMessageAt: 'desc' },
    take: 100,
    include: { messages: { orderBy: { createdAt: 'desc' }, take: 1 } },
  });
  res.json(conversations.map(c => ({
    id: c.id, channel: c.channel, contactName: c.contactName, contactPhone: c.contactPhone,
    status: c.status, aiEnabled: c.aiEnabled, assignedTo: c.assignedTo,
    lastMessageAt: c.lastMessageAt, lastMessage: c.messages[0]?.body?.slice(0, 120) || null,
  })));
});

inboxRouter.get('/conversations/:id/messages', requirePermission('inbox.view'), async (req, res) => {
  const convo = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!convo || !propertyScope(req, convo.propertyId)) return res.status(404).json({ error: 'Conversación no encontrada' });
  const messages = await prisma.message.findMany({
    where: { conversationId: convo.id }, orderBy: { createdAt: 'asc' }, take: 500,
  });
  res.json({ conversation: convo, messages });
});

inboxRouter.post('/conversations/:id/messages', requirePermission('inbox.send'), async (req, res) => {
  const { text } = req.body || {};
  if (!text) return badRequest(res, 'text requerido');
  const convo = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!convo || !propertyScope(req, convo.propertyId)) return res.status(404).json({ error: 'Conversación no encontrada' });
  try {
    const message = await sendOutbound(convo.id, text, { sender: req.user.name });
    res.status(201).json(message);
  } catch (err) { badRequest(res, err.message); }
});

// Transferencia a humano / devolver a la IA (sección 13)
inboxRouter.post('/conversations/:id/takeover', requirePermission('inbox.send'), async (req, res) => {
  const convo = await prisma.conversation.findUnique({ where: { id: req.params.id } });
  if (!convo || !propertyScope(req, convo.propertyId)) return res.status(404).json({ error: 'Conversación no encontrada' });
  const enabled = req.body?.release !== true;
  const updated = await setHumanTakeover(convo.id, { enabled, userName: req.user.name, reason: req.body?.reason || `Tomada por ${req.user.name}` });
  await audit({ propertyId: convo.propertyId, user: req.user, action: enabled ? 'conversation.takeover' : 'conversation.released_to_ai', entity: 'Conversation', entityId: convo.id });
  res.json(updated);
});

// ---- WhatsApp (Baileys) ----
inboxRouter.get('/whatsapp/status', requirePermission('whatsapp.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(whatsappStatus(propertyId));
});

inboxRouter.post('/whatsapp/connect', requirePermission('whatsapp.manage'), async (req, res) => {
  const { propertyId } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  try {
    await audit({ propertyId, user: req.user, action: 'whatsapp.connect_requested' });
    res.json(await startWhatsApp(propertyId));
  } catch (err) { badRequest(res, err.message); }
});

inboxRouter.post('/whatsapp/logout', requirePermission('whatsapp.manage'), async (req, res) => {
  const { propertyId } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  await audit({ propertyId, user: req.user, action: 'whatsapp.logout' });
  res.json(await logoutWhatsApp(propertyId));
});
