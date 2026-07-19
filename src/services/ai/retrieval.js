// Recuperación de conocimiento (RAG simple por palabras clave) para que el
// agente responda con datos reales del hotel sin inventar (IA-3/IA-5).
function norm(s) {
  return String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
}
const STOP = new Set(['el', 'la', 'los', 'las', 'un', 'una', 'de', 'del', 'y', 'o', 'que', 'en', 'a', 'con', 'para', 'por', 'me', 'mi', 'tu', 'su', 'es', 'son', 'hay', 'tienen', 'tiene', 'cual', 'cuales', 'como', 'donde', 'the']);

function tokens(s) {
  return norm(s).replace(/[^a-z0-9ñ ]/g, ' ').split(/\s+/).filter(t => t.length > 2 && !STOP.has(t));
}

// Devuelve la mejor respuesta del conocimiento para una consulta, o null.
// Puntúa con más peso las coincidencias en título/nombre que en el contenido.
export function searchKnowledge(snapshot, query) {
  const qt = tokens(query);
  if (!qt.length) return null;
  const candidates = [];

  for (const k of snapshot.knowledge || []) {
    const score = 2 * overlap(qt, tokens(k.title)) + 1.5 * overlap(qt, tokens(k.tags)) + overlap(qt, tokens(k.content));
    candidates.push({ score, type: 'knowledge', answer: k.content, title: k.title });
  }
  for (const p of snapshot.policies || []) {
    const score = 2 * overlap(qt, tokens(p.title)) + overlap(qt, tokens(p.text || '')) + overlap(qt, tokens(p.type));
    candidates.push({ score, type: 'policy', answer: p.text || p.title, title: p.title });
  }
  for (const r of snapshot.rooms || []) {
    const score = 2 * overlap(qt, tokens(r.name)) + overlap(qt, tokens(`${r.bedConfig || ''} ${r.view || ''} ${r.features || ''} ${r.amenities || ''} ${r.longDescription || r.description || ''}`));
    if (score > 0) {
      const parts = [`${r.name}: ${r.longDescription || r.description || ''}`.trim()];
      if (r.bedConfig) parts.push(`Camas: ${r.bedConfig}.`);
      if (r.view) parts.push(`Vista: ${r.view}.`);
      if (r.features) parts.push(`Incluye: ${r.features}.`);
      parts.push(`Desde ${Math.round(r.fromPrice).toLocaleString('es-CO')} COP/noche.`);
      candidates.push({ score, type: 'room', answer: parts.join(' '), title: r.name });
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best && best.score >= 1.5 ? best : null;
}

function overlap(q, hay) {
  const set = new Set(hay);
  let hits = 0;
  for (const t of q) if (set.has(t)) hits++;
  return hits;
}

// ¿La consulta parece una pregunta de información (no una acción de reserva)?
export function looksLikeQuestion(text) {
  return /\b(qu[eé]|cu[aá]l|cu[aá]les|c[oó]mo|d[oó]nde|tienen|tiene|hay|incluye|puedo|se puede|acepta|ofrecen|cuenta con)\b/i.test(text) || text.trim().endsWith('?');
}
