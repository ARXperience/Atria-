// Reputación & reseñas (§37). Recolecta reseñas (directas, portal del huésped
// o importadas de OTAs), agrega la calificación y permite responder. El sistema
// sugiere un borrador de respuesta con el tono de la persona/mascota del hotel
// (IA como ayudante interno, con acceso solo a lo que le corresponde).
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { getAgentProfile } from './ai/agentProfile.js';

const SOURCES = ['direct', 'google', 'booking', 'tripadvisor', 'expedia'];

export function sentimentOf(rating) {
  if (rating >= 4) return 'positive';
  if (rating <= 2) return 'negative';
  return 'neutral';
}

export async function createReview({ propertyId, reservationId = null, guestId = null, guestName, source = 'direct', rating, title = null, comment = null }) {
  const r = Math.round(Number(rating));
  if (!(r >= 1 && r <= 5)) throw new Error('rating debe estar entre 1 y 5');
  if (!guestName) throw new Error('guestName requerido');
  if (!SOURCES.includes(source)) throw new Error(`source inválida (${SOURCES.join(', ')})`);
  return prisma.review.create({
    data: { propertyId, reservationId, guestId, guestName, source, rating: r, title, comment, sentiment: sentimentOf(r) },
  });
}

// Borrador de respuesta sugerido, con el tono del perfil de reputación del hotel.
export async function draftResponse(propertyId, review) {
  const profile = await getAgentProfile(propertyId, 'manager').catch(() => null);
  const firma = profile?.displayName ? `— ${profile.displayName}, equipo del hotel` : '— El equipo del hotel';
  const nombre = review.guestName?.split(' ')[0] || 'Hola';
  if (review.sentiment === 'positive') {
    return `¡${nombre}, mil gracias por tu reseña y tu calificación de ${review.rating}/5! 🌟 Nos alegra muchísimo que hayas disfrutado tu estadía. Será un placer recibirte de nuevo muy pronto.\n${firma}`;
  }
  if (review.sentiment === 'negative') {
    return `${nombre}, lamentamos sinceramente que tu experiencia no haya estado a la altura. Agradecemos que nos lo cuentes: tomamos nota de lo sucedido y ya lo estamos revisando con el equipo para mejorar. Nos encantaría poder compensarte y recuperar tu confianza.\n${firma}`;
  }
  return `${nombre}, gracias por tomarte el tiempo de compartir tu opinión. Tus comentarios nos ayudan a mejorar cada día. Esperamos darte una experiencia aún mejor en tu próxima visita.\n${firma}`;
}

export async function respondReview(id, { response, user }) {
  const rev = await prisma.review.findUnique({ where: { id } });
  if (!rev) throw new Error('Reseña no encontrada');
  if (!response || !response.trim()) throw new Error('La respuesta no puede estar vacía');
  const updated = await prisma.review.update({
    where: { id },
    data: { response: response.trim(), status: 'responded', respondedBy: user?.name || null, respondedAt: new Date() },
  });
  await audit({ propertyId: rev.propertyId, user, action: 'review.responded', entity: 'Review', entityId: id, after: { rating: rev.rating } });
  return updated;
}

export async function reputationOverview(propertyId) {
  const reviews = await prisma.review.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 300 });
  const count = reviews.length;
  const avg = count ? reviews.reduce((s, r) => s + r.rating, 0) / count : 0;
  const distribution = [1, 2, 3, 4, 5].reduce((o, n) => (o[n] = reviews.filter(r => r.rating === n).length, o), {});
  const bySource = {};
  for (const r of reviews) bySource[r.source] = (bySource[r.source] || 0) + 1;
  const responded = reviews.filter(r => r.status === 'responded').length;
  const pending = reviews.filter(r => r.status === 'published').length;
  // NPS aproximado: promotores (5) − detractores (1-3) sobre el total.
  const promoters = reviews.filter(r => r.rating === 5).length;
  const detractors = reviews.filter(r => r.rating <= 3).length;
  const nps = count ? Math.round(((promoters - detractors) / count) * 100) : 0;
  return {
    count, avg: Math.round(avg * 10) / 10, distribution, bySource,
    responded, pending,
    responseRate: count ? Math.round((responded / count) * 100) : 0,
    nps,
    recent: reviews.slice(0, 40),
  };
}
