// Marketing & campañas (§36). El envío respeta el consentimiento de marketing
// del titular (§26): a los huéspedes sin consentimiento no se les contacta.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { getAgentProfile } from './ai/agentProfile.js';

const CHANNELS = ['email', 'whatsapp', 'sms'];
const AUDIENCES = ['guests', 'leads'];

// Redactor asistido (IA determinística) con el tono de la persona del hotel.
// Detecta la intención de la meta y adapta el formato al canal.
export async function draftCampaignMessage(propertyId, { goal = '', channel = 'email' } = {}) {
  const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { name: true } });
  const profile = await getAgentProfile(propertyId, 'sales').catch(() => null);
  const hotel = prop?.name || 'nuestro hotel';
  const cercano = !profile || /cercan|amig|cálid|calid|informal|divertid/i.test(profile.tone || '');
  const g = (goal || '').toLowerCase();
  let intent = 'promo';
  if (/fideliz|vuelv|regres|repet|cliente frecuente/.test(g)) intent = 'loyalty';
  else if (/event|salón|salon|boda|corporativ|reunión|reunion/.test(g)) intent = 'events';
  else if (/reactiv|hace tiempo|inactiv|no vien/.test(g)) intent = 'winback';
  else if (/temporada|vacacion|puente|festiv|fin de semana/.test(g)) intent = 'season';

  const saludo = cercano ? '¡Hola! 👋' : 'Estimado huésped,';
  const firma = cercano ? `Te esperamos en ${hotel} 💛` : `Cordialmente, el equipo de ${hotel}.`;
  const cuerpos = {
    promo: `Tenemos una tarifa especial pensada para ti. Reserva directo con nosotros y aprovecha el mejor precio garantizado.`,
    loyalty: `Gracias por preferirnos. Como huésped especial, queremos consentirte en tu próxima estadía con un beneficio exclusivo.`,
    events: `¿Planeas un evento o reunión? En ${hotel} tenemos salones equipados y montajes a tu medida. Cuéntanos tu idea y te armamos una propuesta.`,
    winback: `¡Te extrañamos! Ha pasado un tiempo desde tu última visita y queremos darte una razón para volver con una oferta especial.`,
    season: `Se acerca la temporada y las mejores fechas se agotan. Asegura tu estadía en ${hotel} con condiciones preferenciales por reservar con anticipación.`,
  };
  const cuerpo = cuerpos[intent];
  const subject = { promo: `Tarifa especial en ${hotel}`, loyalty: `Un detalle para ti en ${hotel}`, events: `Tu próximo evento en ${hotel}`, winback: `Te extrañamos en ${hotel}`, season: `Reserva tu temporada en ${hotel}` }[intent];

  if (channel === 'sms') {
    return { subject: null, message: `${hotel}: ${cuerpo.split('.')[0]}. Responde SÍ para más info. Cancela con NO.`.slice(0, 300) };
  }
  if (channel === 'whatsapp') {
    return { subject: null, message: `${saludo}\n\n${cuerpo}\n\n${firma}` };
  }
  return { subject, message: `${saludo}\n\n${cuerpo}\n\nEscríbenos o reserva en línea cuando quieras.\n\n${firma}` };
}

function parseSegment(segment) {
  if (!segment) return {};
  if (typeof segment === 'object') return segment;
  try { return JSON.parse(segment); } catch { return {}; }
}

// Canal → campo de contacto requerido en el destinatario.
function contactField(channel) {
  return channel === 'email' ? 'email' : 'phone';
}

// Construye la audiencia elegible. Para huéspedes exige marketingConsent salvo
// que la campaña sea transaccional (no aplica aquí: marketing siempre lo exige).
export async function buildAudience(propertyId, { channel = 'email', audience = 'guests', segment = null } = {}) {
  const seg = parseSegment(segment);
  const field = contactField(channel);
  if (audience === 'leads') {
    const where = { propertyId, [field]: { not: null } };
    if (seg.stage) where.stage = seg.stage;
    if (seg.channel) where.channel = seg.channel;
    const leads = await prisma.lead.findMany({ where, select: { id: true, name: true, email: true, phone: true }, take: 5000 });
    return { eligible: leads, skippedNoConsent: 0 };
  }
  // Huéspedes: contacto presente + consentimiento de marketing.
  const where = { propertyId, [field]: { not: null } };
  if (seg.city) where.city = seg.city;
  const guests = await prisma.guest.findMany({ where, select: { id: true, fullName: true, email: true, phone: true, marketingConsent: true }, take: 5000 });
  const eligible = guests.filter(g => g.marketingConsent);
  return { eligible, skippedNoConsent: guests.length - eligible.length };
}

export async function createCampaign({ propertyId, name, channel = 'email', audience = 'guests', segment = null, subject = null, message, scheduledAt = null, createdBy = null }) {
  if (!name || !message) throw new Error('name y message requeridos');
  if (!CHANNELS.includes(channel)) throw new Error(`channel inválido (${CHANNELS.join(', ')})`);
  if (!AUDIENCES.includes(audience)) throw new Error(`audience inválida (${AUDIENCES.join(', ')})`);
  const { eligible, skippedNoConsent } = await buildAudience(propertyId, { channel, audience, segment });
  const segStr = segment && typeof segment === 'object' ? JSON.stringify(segment) : segment;
  return prisma.campaign.create({
    data: {
      propertyId, name, channel, audience, segment: segStr, subject, message,
      status: scheduledAt ? 'scheduled' : 'draft',
      scheduledAt: scheduledAt ? new Date(scheduledAt) : null,
      audienceCount: eligible.length, skippedNoConsent, createdBy,
    },
  });
}

// "Envía" la campaña (mock verificable): recalcula audiencia elegible en el
// momento, cuenta enviados vs. omitidos por falta de consentimiento y emite
// un evento de dominio por el que otros módulos podrían integrarse.
export async function sendCampaign(id, { user } = {}) {
  const c = await prisma.campaign.findUnique({ where: { id } });
  if (!c) throw new Error('Campaña no encontrada');
  if (c.status === 'sent') throw new Error('La campaña ya fue enviada');
  if (c.status === 'cancelled') throw new Error('La campaña está cancelada');
  const { eligible, skippedNoConsent } = await buildAudience(c.propertyId, { channel: c.channel, audience: c.audience, segment: c.segment });
  const updated = await prisma.campaign.update({
    where: { id },
    data: { status: 'sent', sentAt: new Date(), sentCount: eligible.length, audienceCount: eligible.length, skippedNoConsent },
  });
  emitEvent('campaign.sent', { propertyId: c.propertyId, entityId: c.id, channel: c.channel, sent: eligible.length });
  await audit({ propertyId: c.propertyId, user, actor: user ? 'human' : 'system', action: 'campaign.sent', entity: 'Campaign', entityId: c.id, after: { name: c.name, channel: c.channel, sent: eligible.length, skippedNoConsent } });
  return updated;
}

export async function cancelCampaign(id, { user } = {}) {
  const c = await prisma.campaign.findUnique({ where: { id } });
  if (!c) throw new Error('Campaña no encontrada');
  if (c.status === 'sent') throw new Error('No se puede cancelar una campaña ya enviada');
  const updated = await prisma.campaign.update({ where: { id }, data: { status: 'cancelled' } });
  await audit({ propertyId: c.propertyId, user, action: 'campaign.cancelled', entity: 'Campaign', entityId: c.id });
  return updated;
}

export async function marketingOverview(propertyId) {
  const [campaigns, sent, guestsConsent, guestsTotal] = await Promise.all([
    prisma.campaign.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 100 }),
    prisma.campaign.aggregate({ where: { propertyId, status: 'sent' }, _sum: { sentCount: true }, _count: true }),
    prisma.guest.count({ where: { propertyId, marketingConsent: true } }),
    prisma.guest.count({ where: { propertyId } }),
  ]);
  return {
    campaigns,
    totalSent: sent._sum.sentCount || 0,
    campaignsSent: sent._count || 0,
    reachable: guestsConsent,
    optInRate: guestsTotal > 0 ? Math.round((guestsConsent / guestsTotal) * 100) : 0,
  };
}
