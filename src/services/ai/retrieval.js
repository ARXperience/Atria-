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
// Construye la lista de "documentos" recuperables a partir del snapshot, cada
// uno con campos ponderados (título/etiquetas pesan más que el cuerpo).
function buildDocs(snapshot) {
  const docs = [];
  for (const k of snapshot.knowledge || []) {
    docs.push({ type: 'knowledge', title: k.title, strong: `${k.title} ${k.tags || ''}`, body: k.content, answer: k.content, updatedAt: k.updatedAt });
  }
  for (const p of snapshot.policies || []) {
    docs.push({ type: 'policy', title: p.title, strong: `${p.title} ${p.type || ''}`, body: p.text || '', answer: p.text || p.title });
  }
  for (const r of snapshot.rooms || []) {
    const parts = [`${r.name}: ${r.longDescription || r.description || ''}`.trim()];
    if (r.bedConfig) parts.push(`Camas: ${r.bedConfig}.`);
    if (r.view) parts.push(`Vista: ${r.view}.`);
    if (r.features) parts.push(`Incluye: ${r.features}.`);
    parts.push(`Desde ${Math.round(r.fromPrice).toLocaleString('es-CO')} COP/noche.`);
    docs.push({ type: 'room', title: r.name, strong: r.name, body: `${r.bedConfig || ''} ${r.view || ''} ${r.features || ''} ${r.amenities || ''} ${r.longDescription || r.description || ''}`, answer: parts.join(' ') });
  }
  return docs;
}

// ¿Coincide el término de consulta con algún token del documento? Admite
// coincidencia exacta o por prefijo (parqueo ↔ parqueadero, wifi ↔ wifi).
function termHits(qt, docTokens) {
  const set = new Set(docTokens);
  let hits = 0;
  for (const t of qt) {
    if (set.has(t)) { hits += 1; continue; }
    for (const d of docTokens) {
      if (d.length >= 4 && t.length >= 4 && (d.startsWith(t) || t.startsWith(d))) { hits += 0.6; break; }
    }
  }
  return hits;
}

// Puntúa cada documento con pesos por campo e IDF (los términos raros en la
// base pesan más), y ordena de mayor a menor relevancia.
function scoreDocs(snapshot, query) {
  const qt = [...new Set(tokens(query))];
  if (!qt.length) return [];
  const docs = buildDocs(snapshot);
  if (!docs.length) return [];
  // Frecuencia documental por término para IDF.
  const df = Object.fromEntries(qt.map(t => [t, 0]));
  const docTok = docs.map(d => {
    const strong = tokens(d.strong);
    const body = tokens(d.body);
    const all = new Set([...strong, ...body]);
    for (const t of qt) if ([...all].some(x => x === t || (x.length >= 4 && t.length >= 4 && (x.startsWith(t) || t.startsWith(x))))) df[t]++;
    return { strong, body };
  });
  const N = docs.length;
  const idf = t => Math.log((N + 1) / ((df[t] || 0) + 1)) + 1;
  const scored = docs.map((d, i) => {
    let score = 0;
    for (const t of qt) {
      const w = idf(t);
      score += 2 * termHits([t], docTok[i].strong) * w;
      score += termHits([t], docTok[i].body) * w;
    }
    return { ...d, score };
  });
  return scored.sort((a, b) => b.score - a.score);
}

export function searchKnowledge(snapshot, query) {
  const ranked = scoreDocs(snapshot, query);
  const best = ranked[0];
  return best && best.score >= 1.5 ? best : null;
}

// RAG: devuelve los K fragmentos más relevantes para construir el contexto que
// se le pasa al LLM (respuesta apoyada en varias fuentes, no una sola).
export function retrieveContext(snapshot, query, { k = 3, minScore = 1.2 } = {}) {
  return scoreDocs(snapshot, query).filter(d => d.score >= minScore).slice(0, k)
    .map(d => ({ type: d.type, title: d.title, answer: d.answer, score: Math.round(d.score * 100) / 100 }));
}

// ¿La consulta parece una pregunta de información (no una acción de reserva)?
export function looksLikeQuestion(text) {
  return /\b(qu[eé]|cu[aá]l|cu[aá]les|c[oó]mo|d[oó]nde|tienen|tiene|hay|incluye|puedo|se puede|acepta|ofrecen|cuenta con)\b/i.test(text) || text.trim().endsWith('?');
}
