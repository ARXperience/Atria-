// Encuestas post-estadía y gestión de quejas (§37). NPS + dimensiones; las
// respuestas bajas abren un caso interno (queja) con causa raíz y acción
// correctiva. Filtro: alto → invitar a reseña pública, bajo → caso interno.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { notify } from './notifications.js';
import { audit } from '../lib/audit.js';

const CATEGORIES = ['limpieza', 'servicio', 'ruido', 'facturacion', 'mantenimiento', 'otro'];

// Crea (idempotente) la encuesta de una reserva; se dispara al hacer check-out.
export async function ensureSurvey(reservationId) {
  const r = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { guest: true } });
  if (!r) return null;
  return prisma.survey.upsert({
    where: { reservationId },
    update: {},
    create: { propertyId: r.propertyId, reservationId, guestName: r.guest.fullName, status: 'sent' },
  });
}

export async function getSurveyForReservation(reservationId) {
  return prisma.survey.findUnique({ where: { reservationId } });
}

// El huésped responde la encuesta desde su portal.
export async function submitSurvey(reservationId, { nps, ratingClean, ratingService, ratingComfort, comment } = {}) {
  const survey = await ensureSurvey(reservationId);
  if (!survey) throw new Error('Encuesta no disponible');
  if (survey.status === 'responded') throw new Error('Ya registramos tu encuesta. ¡Gracias!');
  const npsN = nps == null ? null : Math.max(0, Math.min(10, Math.round(Number(nps))));
  const clamp5 = v => v == null ? null : Math.max(1, Math.min(5, Math.round(Number(v))));
  const updated = await prisma.survey.update({
    where: { id: survey.id },
    data: { status: 'responded', nps: npsN, ratingClean: clamp5(ratingClean), ratingService: clamp5(ratingService), ratingComfort: clamp5(ratingComfort), comment: comment ? String(comment).slice(0, 800) : null, respondedAt: new Date() },
  });
  emitEvent('survey.responded', { propertyId: survey.propertyId, reservationId, entityId: survey.id, nps: npsN });

  // Filtro: detractor (NPS ≤ 6) o dimensión baja → abre caso interno.
  const low = (npsN != null && npsN <= 6) || [updated.ratingClean, updated.ratingService, updated.ratingComfort].some(v => v != null && v <= 2);
  if (low) {
    const category = updated.ratingClean != null && updated.ratingClean <= 2 ? 'limpieza'
      : updated.ratingService != null && updated.ratingService <= 2 ? 'servicio' : 'otro';
    await createComplaint({ propertyId: survey.propertyId, reservationId, surveyId: survey.id, guestName: survey.guestName, category, detail: comment || `Encuesta con NPS ${npsN ?? '—'}`, severity: npsN != null && npsN <= 3 ? 'high' : 'medium', source: 'survey' });
  }
  return { ok: true, promoter: npsN != null && npsN >= 9, invitePublicReview: npsN != null && npsN >= 9 };
}

export async function createComplaint({ propertyId, reservationId = null, surveyId = null, guestName, category = 'otro', detail = null, severity = 'medium', source = 'manual', user = null }) {
  if (!guestName) throw new Error('guestName requerido');
  if (!CATEGORIES.includes(category)) category = 'otro';
  const c = await prisma.complaint.create({ data: { propertyId, reservationId, surveyId, guestName, category, detail, severity, source } });
  await notify({ propertyId, audienceRole: 'MANAGER', severity: severity === 'high' ? 'critical' : 'warning', title: `Nueva queja · ${category}`, body: `${guestName}: ${detail || category}`, entity: 'Complaint', entityId: c.id });
  emitEvent('complaint.created', { propertyId, entityId: c.id, category, severity });
  await audit({ propertyId, user, actor: user ? 'human' : 'system', action: 'complaint.created', entity: 'Complaint', entityId: c.id, after: { category, severity } });
  return c;
}

export async function updateComplaint(id, { status, rootCause, correctiveAction, user } = {}) {
  const c = await prisma.complaint.findUnique({ where: { id } });
  if (!c) throw new Error('Queja no encontrada');
  const data = {};
  if (status && ['open', 'in_progress', 'resolved'].includes(status)) {
    data.status = status;
    if (status === 'resolved') { data.resolvedBy = user?.name || null; data.resolvedAt = new Date(); }
  }
  if (rootCause !== undefined) data.rootCause = rootCause || null;
  if (correctiveAction !== undefined) data.correctiveAction = correctiveAction || null;
  const updated = await prisma.complaint.update({ where: { id }, data });
  await audit({ propertyId: c.propertyId, user, action: `complaint.${data.status || 'updated'}`, entity: 'Complaint', entityId: id });
  return updated;
}

export async function surveysOverview(propertyId) {
  const [surveys, complaints] = await Promise.all([
    prisma.survey.findMany({ where: { propertyId }, orderBy: { sentAt: 'desc' }, take: 500 }),
    prisma.complaint.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 200 }),
  ]);
  const responded = surveys.filter(s => s.status === 'responded' && s.nps != null);
  const promoters = responded.filter(s => s.nps >= 9).length;
  const detractors = responded.filter(s => s.nps <= 6).length;
  const nps = responded.length ? Math.round(((promoters - detractors) / responded.length) * 100) : 0;
  const avg = (key) => { const v = responded.map(s => s[key]).filter(x => x != null); return v.length ? Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 10) / 10 : 0; };
  return {
    sent: surveys.length, responded: responded.length,
    responseRate: surveys.length ? Math.round((responded.length / surveys.length) * 100) : 0,
    nps,
    dimensions: { clean: avg('ratingClean'), service: avg('ratingService'), comfort: avg('ratingComfort') },
    complaints: complaints.map(c => ({ id: c.id, guestName: c.guestName, category: c.category, detail: c.detail, severity: c.severity, status: c.status, rootCause: c.rootCause, correctiveAction: c.correctiveAction, createdAt: c.createdAt })),
    openComplaints: complaints.filter(c => c.status !== 'resolved').length,
    recentSurveys: responded.slice(0, 20).map(s => ({ guestName: s.guestName, nps: s.nps, comment: s.comment, respondedAt: s.respondedAt })),
  };
}
