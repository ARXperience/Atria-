// IA-2 · Persona del agente por hotel (la "mascota"). Cada sede configura
// nombre, tono, idiomas, guardrails y ámbito de conocimiento de su agente.
import { prisma } from '../../db.js';

export const AGENT_SCOPES = ['guest', 'reception', 'housekeeping', 'maintenance', 'sales', 'finance', 'payroll', 'manager'];

// Configuración proactiva por defecto del asistente de huéspedes en el sitio (§14).
export const GUEST_PROACTIVE_DEFAULT = {
  welcomeMessage: '¿Necesitas ayuda? Pregúntame por habitaciones, precios, servicios o cómo reservar. 😊',
  suggestions: ['Ver disponibilidad', 'Servicios del hotel', '¿Dónde están ubicados?', 'Hablar con una persona'],
};

// Normaliza las sugerencias almacenadas (JSON array o CSV) a un array de textos.
export function parseSuggestions(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!s) return null;
  try { const p = JSON.parse(s); if (Array.isArray(p)) return p.map(x => String(x).trim()).filter(Boolean).slice(0, 6); } catch { /* CSV */ }
  return s.split(/[\n,]/).map(x => x.trim()).filter(Boolean).slice(0, 6);
}

// Config efectiva (proactivo + bienvenida + sugerencias) para el sitio público.
export function guestAssistantConfig(profile) {
  return {
    displayName: profile.displayName,
    proactive: profile.proactive !== false,
    welcome: profile.welcomeMessage || GUEST_PROACTIVE_DEFAULT.welcomeMessage,
    suggestions: parseSuggestions(profile.suggestions) || GUEST_PROACTIVE_DEFAULT.suggestions,
  };
}

const DEFAULTS = {
  guest: {
    displayName: 'Atria',
    tone: 'cálido, cercano y profesional',
    greeting: null,
    knowledgeScope: 'public',
    persona: 'Eres el anfitrión virtual del hotel. Ayudas a los huéspedes a resolver dudas, consultar habitaciones, cotizar y reservar.',
  },
  reception: {
    displayName: 'Copiloto de Recepción',
    tone: 'directo y operativo',
    knowledgeScope: 'internal',
    persona: 'Asistes a recepción con reservas, check-in/out, folios y datos de huéspedes.',
  },
};

export async function getAgentProfile(propertyId, scope = 'guest') {
  let profile = await prisma.agentProfile.findUnique({ where: { propertyId_scope: { propertyId, scope } } });
  if (!profile) {
    const d = DEFAULTS[scope] || DEFAULTS.guest;
    profile = await prisma.agentProfile.create({
      data: {
        propertyId, scope,
        displayName: d.displayName, tone: d.tone, persona: d.persona,
        greeting: d.greeting || null, knowledgeScope: d.knowledgeScope || (scope === 'guest' ? 'public' : 'internal'),
      },
    });
  }
  return profile;
}

// Construye el "system prompt" del agente a partir de su persona + conocimiento.
export function buildSystemPrompt(profile, snapshot, { userRole = null } = {}) {
  const lines = [];
  lines.push(`Eres ${profile.displayName}, asistente del hotel ${snapshot.hotel.name || ''} en ${snapshot.hotel.city || 'Colombia'}.`);
  if (profile.persona) lines.push(profile.persona);
  lines.push(`Tono: ${profile.tone}. Idiomas: ${profile.languages}. ${profile.emojis ? 'Puedes usar emojis con moderación.' : 'No uses emojis.'}`);
  lines.push(`Check-in: ${snapshot.hotel.checkInTime}. Check-out: ${snapshot.hotel.checkOutTime}.`);
  if (profile.domainOnly) {
    lines.push('IMPORTANTE: responde ÚNICAMENTE sobre este hotel (habitaciones, servicios, reservas, pagos, ubicación, políticas). Si te preguntan por otros temas, redirige amablemente al hotel y no respondas el tema ajeno.');
  }
  if (profile.scope === 'guest') {
    lines.push('Nunca ofrezcas reembolsos, descuentos especiales ni compensaciones: para eso indica que transfieres con una persona del equipo.');
  }
  lines.push('Si no encuentras la información en el conocimiento del hotel, dilo y ofrece transferir con una persona. No inventes datos.');

  // Conocimiento embebido (RAG simple por inyección de contexto)
  if (snapshot.rooms?.length) {
    lines.push('\nHABITACIONES:');
    for (const r of snapshot.rooms) {
      lines.push(`- ${r.name} (${r.capacity} pax, desde ${Math.round(r.fromPrice)} COP/noche)${r.bedConfig ? `, ${r.bedConfig}` : ''}${r.view ? `, vista ${r.view}` : ''}${r.features ? `. Incluye: ${r.features}` : ''}. ${r.longDescription || r.description || ''}`.trim());
    }
  }
  if (snapshot.knowledge?.length) {
    lines.push('\nCONOCIMIENTO DEL HOTEL:');
    for (const k of snapshot.knowledge) lines.push(`- [${k.category}] ${k.title}: ${k.content}`);
  }
  if (snapshot.policies?.length) {
    lines.push('\nPOLÍTICAS:');
    for (const p of snapshot.policies) lines.push(`- ${p.title}: ${p.text || ''}`);
  }
  if (snapshot.menu?.length) {
    lines.push('\nCARTA DEL RESTAURANTE / ROOM SERVICE (puedes sugerir platos y precios; si el huésped desea pedir, ofrece tomar el pedido y avisa que se cargará a la habitación):');
    for (const m of snapshot.menu) lines.push(`- ${m.name} (${m.category}): ${Math.round(m.price).toLocaleString('es-CO')} COP`);
  }
  return lines.join('\n');
}
