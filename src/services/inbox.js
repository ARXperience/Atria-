// Inbox omnicanal (sección 13): conversaciones y mensajes unificados de
// WhatsApp y webchat, con IA, transferencia a humano y trazabilidad.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';

export async function upsertConversation({ propertyId, channel, contactId, contactName = null, contactPhone = null }) {
  const existing = await prisma.conversation.findUnique({
    where: { propertyId_channel_contactId: { propertyId, channel, contactId } },
  });
  if (existing) {
    if ((contactName && !existing.contactName) || (contactPhone && !existing.contactPhone)) {
      return prisma.conversation.update({
        where: { id: existing.id },
        data: {
          contactName: existing.contactName || contactName,
          contactPhone: existing.contactPhone || contactPhone,
        },
      });
    }
    return existing;
  }
  return prisma.conversation.create({
    data: { propertyId, channel, contactId, contactName, contactPhone },
  });
}

export async function saveInbound(conversationId, body, { intent = null } = {}) {
  const [message] = await Promise.all([
    prisma.message.create({ data: { conversationId, direction: 'in', sender: 'guest', body, intent } }),
    prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date(), status: 'open' } }),
  ]);
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  emitEvent('message.received', { propertyId: convo.propertyId, conversationId });
  return message;
}

// Envía un mensaje saliente por el canal correspondiente (WhatsApp real vía
// Baileys, o solo persistencia para webchat que hace polling).
export async function sendOutbound(conversationId, body, { sender = 'ai' } = {}) {
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!convo) throw new Error('Conversación no encontrada');

  const message = await prisma.message.create({
    data: { conversationId, direction: 'out', sender, body },
  });
  await prisma.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: new Date() } });

  if (convo.channel === 'whatsapp') {
    const { sendWhatsAppMessage } = await import('./whatsapp.js');
    await sendWhatsAppMessage(convo.propertyId, convo.contactId, body);
  }
  emitEvent('message.sent', { propertyId: convo.propertyId, conversationId });
  return message;
}

export async function setHumanTakeover(conversationId, { enabled, userName = null, reason = null }) {
  const convo = await prisma.conversation.update({
    where: { id: conversationId },
    data: { aiEnabled: !enabled, assignedTo: enabled ? userName : null },
  });
  if (enabled) {
    emitEvent('human_takeover.requested', { propertyId: convo.propertyId, conversationId, reason });
  }
  return convo;
}

export async function getContext(conversation) {
  try { return conversation.context ? JSON.parse(conversation.context) : {}; } catch { return {}; }
}

export async function setContext(conversationId, context) {
  return prisma.conversation.update({ where: { id: conversationId }, data: { context: JSON.stringify(context) } });
}
