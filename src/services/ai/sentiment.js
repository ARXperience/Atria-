// Análisis de sentimiento por tema (§37/§41). Clasifica reseñas y quejas por
// tema (limpieza, servicio, ruido, comida…) y calcula la tendencia por tema para
// detectar problemas ANTES de que caiga la calificación. Determinístico: léxico
// en español con manejo simple de negación.
import { prisma } from '../../db.js';

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');

// Temas y sus palabras clave (raíces, sin tildes).
const TOPICS = {
  limpieza: ['limpi', 'aseo', 'sucio', 'sucia', 'polvo', 'mugre', 'impecable', 'higien'],
  servicio: ['servicio', 'atencion', 'atendi', 'amable', 'grosero', 'lento', 'eficiente', 'trato', 'personal', 'staff'],
  ruido: ['ruido', 'ruidos', 'silencio', 'escandalo', 'bulla', 'tranquil'],
  habitacion: ['habitacion', 'cama', 'colchon', 'almohada', 'comod', 'incomod', 'espacios', 'amplia', 'pequeñ', 'confort'],
  comida: ['comida', 'desayuno', 'restaurante', 'plato', 'sabor', 'delicios', 'cena', 'buffet'],
  wifi: ['wifi', 'internet', 'señal', 'conexion', 'red'],
  ubicacion: ['ubicacion', 'ubicad', 'cerca', 'lejos', 'central', 'zona', 'localiz'],
  precio: ['precio', 'caro', 'costos', 'economic', 'vale la pena', 'relacion calidad'],
  mantenimiento: ['dañ', 'roto', 'averi', 'aire acondicionado', 'ducha', 'agua caliente', 'no funciona', 'no servia', 'gotea'],
  recepcion: ['recepcion', 'check-in', 'checkin', 'ingreso', 'registro', 'fila', 'espera', 'demora'],
};
// Mapea la categoría de una queja al tema correspondiente.
const COMPLAINT_TOPIC = { limpieza: 'limpieza', servicio: 'servicio', ruido: 'ruido', mantenimiento: 'mantenimiento', facturacion: 'precio', otro: null };

const POS = ['excelente', 'genial', 'increible', 'perfecto', 'impecable', 'comod', 'amable', 'delicios', 'rapido', 'limpio', 'limpia', 'recomend', 'encanto', 'espectacular', 'buenisim', 'tranquil', 'espacios', 'eficiente'];
const NEG = ['sucio', 'sucia', 'malo', 'mala', 'pesimo', 'terrible', 'horrible', 'grosero', 'lento', 'ruidos', 'roto', 'dañ', 'averi', 'incomod', 'caro', 'costos', 'demora', 'fila', 'mugre', 'polvo', 'no funciona', 'no servia', 'gotea', 'frio', 'escandalo', 'bulla', 'pequeñ', 'decepcion'];
const NEGATORS = ['no', 'nunca', 'sin', 'tampoco', 'jamas'];

// Polaridad de un texto: suma señales +/- con inversión simple por negadores.
// Las señales multi-palabra ("no funciona", "vale la pena") se cuentan una vez
// sobre el texto completo; las de una palabra, token a token.
function polarity(text) {
  const n = norm(text);
  let score = 0;
  // Frases (multi-palabra): una pasada sobre el texto completo.
  for (const p of POS) if (p.includes(' ') && n.includes(p)) score += 1;
  for (const w of NEG) if (w.includes(' ') && n.includes(w)) score -= 1;
  // Palabras sueltas: por token, con inversión si va precedido de un negador.
  const toks = n.split(/[^a-z0-9ñ]+/).filter(Boolean);
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    const negated = i > 0 && NEGATORS.includes(toks[i - 1]);
    if (POS.some(p => !p.includes(' ') && t.startsWith(p))) score += negated ? -1 : 1;
    else if (NEG.some(w => !w.includes(' ') && t.startsWith(w))) score += negated ? 1 : -1;
  }
  return score;
}

function topicsIn(text) {
  const n = norm(text);
  const found = [];
  for (const [topic, kws] of Object.entries(TOPICS)) {
    if (kws.some(k => n.includes(k))) found.push(topic);
  }
  return found;
}

// Sentimiento por tema en una ventana, con tendencia (mitad reciente vs anterior).
export async function topicSentiment(propertyId, { windowDays = 90 } = {}) {
  const since = new Date(Date.now() - windowDays * 86400_000);
  const [reviews, complaints] = await Promise.all([
    prisma.review.findMany({ where: { propertyId, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } }),
    prisma.complaint.findMany({ where: { propertyId, createdAt: { gte: since } }, orderBy: { createdAt: 'asc' } }),
  ]);

  // Cada mención: { topic, sentiment(-1..1), at }.
  const mentions = [];
  for (const rv of reviews) {
    const text = `${rv.title || ''} ${rv.comment || ''}`.trim();
    const ts = topicsIn(text);
    const base = rv.rating >= 4 ? 1 : rv.rating <= 2 ? -1 : 0;
    for (const topic of ts) {
      const p = polarity(text);
      const s = p !== 0 ? Math.sign(p) : base; // polaridad textual; si es neutra, usa la calificación
      mentions.push({ topic, sentiment: s, at: rv.createdAt, sample: text.slice(0, 120) });
    }
    // Si no detecta tema pero es negativa, cuenta como "general".
    if (!ts.length && base < 0) mentions.push({ topic: 'general', sentiment: -1, at: rv.createdAt, sample: text.slice(0, 120) });
  }
  for (const c of complaints) {
    const topic = COMPLAINT_TOPIC[c.category] || 'servicio';
    mentions.push({ topic, sentiment: -1, at: c.createdAt, sample: (c.detail || c.category).slice(0, 120) });
  }

  const mid = since.getTime() + (Date.now() - since.getTime()) / 2;
  const byTopic = {};
  for (const m of mentions) {
    const g = byTopic[m.topic] || (byTopic[m.topic] = { topic: m.topic, mentions: 0, positive: 0, negative: 0, neutral: 0, recent: [], older: [], sample: null });
    g.mentions++;
    if (m.sentiment > 0) g.positive++; else if (m.sentiment < 0) g.negative++; else g.neutral++;
    (new Date(m.at).getTime() >= mid ? g.recent : g.older).push(m.sentiment);
    if (m.sentiment < 0 && !g.sample) g.sample = m.sample; // muestra un comentario negativo representativo
  }

  const avg = (arr) => arr.length ? arr.reduce((s, x) => s + x, 0) / arr.length : 0;
  const rows = Object.values(byTopic).map(g => {
    const score = Math.round(((g.positive - g.negative) / g.mentions) * 100) / 100;
    const recentAvg = avg(g.recent), olderAvg = avg(g.older);
    let trend = 'stable';
    if (g.recent.length && g.older.length) {
      if (recentAvg < olderAvg - 0.25) trend = 'worsening';
      else if (recentAvg > olderAvg + 0.25) trend = 'improving';
    }
    return { topic: g.topic, mentions: g.mentions, positive: g.positive, negative: g.negative, neutral: g.neutral, score, trend, sample: g.sample };
  });
  // Prioriza lo más problemático: primero lo que empeora, luego el peor score.
  rows.sort((a, b) => (a.trend === 'worsening' ? -1 : 0) - (b.trend === 'worsening' ? -1 : 0) || a.score - b.score);

  // Alertas tempranas: temas negativos o que empeoran con evidencia suficiente.
  const alerts = rows.filter(r => r.mentions >= 2 && (r.trend === 'worsening' || r.score <= -0.3));
  return { windowDays, topics: rows, alerts, totalMentions: mentions.length };
}
