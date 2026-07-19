// IA-5 · Memoria por huésped y por conversación (§55.5, §55.8).
// - Reconoce huéspedes recurrentes para personalizar.
// - Guarda memoria del huésped (preferencias, etiquetas, resumen).
// - Genera un resumen de la conversación para el escalamiento a humano.
import { prisma } from '../../db.js';

function parseMem(s) { try { return s ? JSON.parse(s) : {}; } catch { return {}; } }

export async function getGuestMemory(guestId) {
  const g = await prisma.guest.findUnique({ where: { id: guestId } });
  return parseMem(g?.memory);
}

export async function updateGuestMemory(guestId, patch) {
  const g = await prisma.guest.findUnique({ where: { id: guestId } });
  if (!g) return null;
  const mem = { ...parseMem(g.memory), ...patch };
  await prisma.guest.update({ where: { id: guestId }, data: { memory: JSON.stringify(mem) } });
  return mem;
}

// Reconoce a un huésped por teléfono y recupera su historial (para personalizar).
export async function guestRecall({ propertyId, phone }) {
  if (!phone) return null;
  const guest = await prisma.guest.findFirst({ where: { propertyId, phone } });
  if (!guest) return null;
  const past = await prisma.reservation.findMany({
    where: { guestId: guest.id, status: { in: ['confirmed', 'checked_in', 'checked_out'] } },
    orderBy: { checkIn: 'desc' }, take: 5,
  });
  return { guest, isReturning: past.length > 0, count: past.length, last: past[0] || null, memory: parseMem(guest.memory) };
}

// Resumen de la conversación para entregar a la persona que la recibe (§55.8).
export async function summarizeConversation(conversationId, { reason = null } = {}) {
  const c = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!c) return reason || '';
  let ctx = {};
  try { ctx = c.context ? JSON.parse(c.context) : {}; } catch { ctx = {}; }
  const msgs = await prisma.message.findMany({ where: { conversationId }, orderBy: { createdAt: 'desc' }, take: 8 });
  const lastGuest = msgs.find(m => m.direction === 'in');

  const parts = [`Contacto: ${c.contactName || c.contactPhone || 'visitante'} (${c.channel}).`];
  if (ctx.guestName) parts.push(`Nombre: ${ctx.guestName}.`);
  if (ctx.checkIn) parts.push(`Fechas de interés: ${ctx.checkIn}${ctx.checkOut ? ` → ${ctx.checkOut}` : ''}${ctx.adults ? `, ${ctx.adults} pax` : ''}.`);
  if (ctx.reservationId) parts.push('Ya se creó una reserva pendiente de pago.');
  else if (ctx.state === 'quoted') parts.push('Se cotizó pero no confirmó.');
  else if (ctx.state === 'offered') parts.push('Se ofrecieron opciones de habitación.');
  if (lastGuest) parts.push(`Último mensaje del huésped: "${lastGuest.body.slice(0, 140)}".`);
  if (reason) parts.push(`Motivo de escalamiento: ${reason.slice(0, 140)}.`);
  return parts.join(' ');
}

export async function saveConversationSummary(conversationId, summary) {
  await prisma.conversation.update({ where: { id: conversationId }, data: { summary } });
  return summary;
}
