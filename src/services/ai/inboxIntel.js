// Inteligencia del inbox (§13/§41): clasifica la conversación por intención y
// urgencia, la resume y sugiere una respuesta para el agente humano. Determinístico
// (léxico en español); si hay conocimiento del hotel, la respuesta de info se apoya
// en la base de conocimiento (RAG).
import { prisma } from '../../db.js';
import { summarizeConversation } from './memory.js';
import { knowledgeSnapshot } from '../knowledge.js';
import { searchKnowledge } from './retrieval.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

// Intenciones por prioridad (la primera que coincide gana).
const INTENTS = [
  { intent: 'queja', urgency: 'high', kws: ['queja', 'reclamo', 'pesimo', 'terrible', 'horrible', 'mal servicio', 'sucio', 'grosero', 'molesto', 'inaceptable', 'denuncia', 'estafa', 'nunca mas', 'demanda'] },
  { intent: 'cancelacion', urgency: 'high', kws: ['cancelar', 'cancelacion', 'anular', 'reembolso', 'devolucion', 'ya no voy', 'no podre'] },
  { intent: 'pago', urgency: 'medium', kws: ['pago', 'pagar', 'transferencia', 'tarjeta', 'link de pago', 'no me llego', 'factura', 'comprobante'] },
  { intent: 'evento', urgency: 'medium', kws: ['evento', 'salon', 'boda', 'matrimonio', 'reunion', 'conferencia', 'banquete', 'cumpleaños', 'grupo grande'] },
  { intent: 'reserva', urgency: 'medium', kws: ['reserva', 'reservar', 'disponibilidad', 'disponible', 'cotizar', 'cotizacion', 'precio', 'habitacion', 'noche', 'fechas', 'cuanto cuesta', 'quiero ir'] },
  { intent: 'info', urgency: 'low', kws: ['parqueadero', 'wifi', 'desayuno', 'piscina', 'mascota', 'ubicacion', 'como llego', 'horario', 'check', 'incluye', 'tienen', 'hay '] },
];

export function classifyIntent(text) {
  const n = norm(text);
  for (const def of INTENTS) {
    if (def.kws.some(k => n.includes(k))) return { intent: def.intent, urgency: def.urgency };
  }
  return { intent: 'otro', urgency: 'low' };
}

// Respuesta sugerida para el agente humano según la intención (y conocimiento).
async function suggestReply({ propertyId, intent, guestText, contactName }) {
  const hi = contactName ? `Hola ${contactName}, ` : 'Hola, ';
  if (intent === 'queja') return `${hi}lamentamos mucho lo sucedido y agradecemos que nos lo cuentes. Lo estamos revisando de inmediato y una persona del equipo te contactará para resolverlo. ¿Podrías darnos más detalles (habitación y momento)?`;
  if (intent === 'cancelacion') return `${hi}con gusto revisamos tu solicitud. ¿Me confirmas el código de tu reserva? Te indico las condiciones de cancelación aplicables y el proceso.`;
  if (intent === 'pago') return `${hi}con gusto te ayudo con el pago. Puedo generarte un link seguro para el anticipo/saldo. ¿Me confirmas el código de tu reserva?`;
  if (intent === 'evento') return `${hi}¡gracias por tu interés! Para tu evento, un asesor te contactará con una propuesta. ¿Fecha tentativa y número de personas?`;
  if (intent === 'reserva') return `${hi}con gusto te ayudo a reservar. ¿Me confirmas fechas de entrada y salida y número de personas para cotizarte disponibilidad?`;
  if (intent === 'info') {
    try {
      const snap = await knowledgeSnapshot(propertyId, { visibility: 'public' });
      const hit = searchKnowledge(snap, guestText);
      if (hit) return `${hi}${hit.answer}`;
    } catch { /* opcional */ }
    return `${hi}con gusto te damos esa información. ¿Podrías especificar un poco más tu consulta?`;
  }
  return `${hi}¿en qué te podemos ayudar hoy?`;
}

// Insights de una conversación: intención, urgencia, resumen y respuesta sugerida.
export async function conversationInsights(conversationId) {
  const convo = await prisma.conversation.findUnique({ where: { id: conversationId } });
  if (!convo) throw new Error('Conversación no encontrada');
  const inbound = await prisma.message.findMany({ where: { conversationId, direction: 'in' }, orderBy: { createdAt: 'desc' }, take: 5 });
  const guestText = inbound.map(m => m.body).join(' ');
  const { intent, urgency } = classifyIntent(guestText);
  const [summary, suggestedReply] = await Promise.all([
    summarizeConversation(conversationId),
    suggestReply({ propertyId: convo.propertyId, intent, guestText: inbound[0]?.body || '', contactName: convo.contactName }),
  ]);
  return { intent, urgency, summary, suggestedReply, lastGuestMessage: inbound[0]?.body || null };
}

// Clasificación ligera para la lista (sin resumen ni respuesta): usa el último
// mensaje entrante ya disponible.
export function quickClassify(lastMessage) {
  return classifyIntent(lastMessage || '');
}
