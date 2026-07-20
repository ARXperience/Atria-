// Scoring de leads (§12): puntúa la probabilidad/valor de un lead a partir de
// señales determinísticas para priorizar la gestión comercial.
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';

const DAY = 86400_000;

// Devuelve un puntaje 0..100 y el detalle de las señales que lo componen.
export function computeLeadScore(lead) {
  const signals = [];
  let score = 0;
  const add = (label, pts) => { if (pts) { score += pts; signals.push({ label, pts }); } };

  // Intención declarada
  if (lead.intent === 'reserva') add('Intención de reserva', 30);
  else if (lead.intent === 'evento') add('Intención de evento', 25);
  else if (lead.intent === 'info') add('Solicita información', 8);

  // Fechas concretas → mayor madurez
  if (lead.checkIn && lead.checkOut) {
    add('Fechas definidas', 20);
    const nights = Math.max(1, Math.round((new Date(lead.checkOut) - new Date(lead.checkIn)) / DAY));
    if (nights >= 3) add('Estadía larga (3+ noches)', 8);
    // Cercanía de la llegada
    const daysToArrival = Math.round((new Date(lead.checkIn) - Date.now()) / DAY);
    if (daysToArrival >= 0 && daysToArrival <= 14) add('Llegada próxima (≤14 días)', 12);
  }

  // Tamaño del grupo
  if (lead.adults && lead.adults >= 3) add('Grupo (3+ adultos)', 8);

  // Datos de contacto completos → accionable
  if (lead.phone) add('Teléfono disponible', 8);
  if (lead.email) add('Email disponible', 6);

  // Canal de mayor conversión
  if (lead.channel === 'whatsapp') add('Canal WhatsApp', 6);
  else if (lead.channel === 'phone') add('Contacto telefónico', 5);

  // Etapa avanzada del embudo
  if (lead.stage === 'qualified') add('Lead calificado', 6);
  else if (lead.stage === 'quoted') add('Cotización enviada', 12);

  return { score: Math.min(100, score), signals };
}

export function leadGrade(score) {
  if (score >= 60) return 'hot';
  if (score >= 30) return 'warm';
  return 'cold';
}

// Recalcula y persiste el score de un lead.
export async function rescoreLead(leadId) {
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return null;
  const { score } = computeLeadScore(lead);
  if (score === lead.score) return lead;
  return prisma.lead.update({ where: { id: leadId }, data: { score } });
}

// Recalcula el score de todos los leads abiertos de la sede.
export async function rescoreAllLeads(propertyId, { user = null } = {}) {
  const leads = await prisma.lead.findMany({ where: { propertyId, stage: { in: ['new', 'qualified', 'quoted'] } }, take: 5000 });
  let updated = 0;
  for (const lead of leads) {
    const { score } = computeLeadScore(lead);
    if (score !== lead.score) { await prisma.lead.update({ where: { id: lead.id }, data: { score } }); updated++; }
  }
  await audit({ propertyId, user, action: 'crm.leads_rescored', entity: 'Lead', after: { updated, total: leads.length } });
  return { updated, total: leads.length };
}
