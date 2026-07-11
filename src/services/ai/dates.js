// Parser de fechas en español para el asistente conversacional.
// Soporta: "del 20 al 23 de diciembre", "20/12 al 23/12", "2026-08-01 a 2026-08-05",
// "mañana por 2 noches", "hoy", "este fin de semana".
import { parseDay, addDays } from '../../lib/util.js';

const MONTHS = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6,
  julio: 7, agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};

function today() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function buildDate(day, month, year) {
  const base = today();
  let y = year || base.getUTCFullYear();
  let d = new Date(Date.UTC(y, month - 1, day));
  // Si la fecha ya pasó y no se dio año, asumir el próximo año
  if (!year && d < base) d = new Date(Date.UTC(y + 1, month - 1, day));
  return d;
}

export function extractDates(textRaw) {
  const text = textRaw.toLowerCase().replace(/\s+/g, ' ');

  // ISO: 2026-08-01 (a|al|hasta) 2026-08-05
  let m = text.match(/(\d{4}-\d{2}-\d{2})\s*(?:a|al|hasta|-|–)\s*(\d{4}-\d{2}-\d{2})/);
  if (m) {
    const ci = parseDay(m[1]), co = parseDay(m[2]);
    if (ci && co && co > ci) return { checkIn: ci, checkOut: co };
  }

  // "del 20 al 23 de diciembre [de 2026]"
  m = text.match(/(?:del?\s+)?(\d{1,2})\s+(?:de\s+([a-zá]+)\s+)?(?:al?|hasta el?)\s+(\d{1,2})\s+de\s+([a-zá]+)(?:\s+(?:de\s+|del\s+)?(\d{4}))?/);
  if (m) {
    const d1 = +m[1], mon1Name = m[2], d2 = +m[3], mon2Name = m[4], year = m[5] ? +m[5] : null;
    const mon2 = MONTHS[mon2Name.normalize('NFD').replace(/\p{Diacritic}/gu, '')] || MONTHS[mon2Name];
    const mon1 = mon1Name ? (MONTHS[mon1Name.normalize('NFD').replace(/\p{Diacritic}/gu, '')] || MONTHS[mon1Name]) : mon2;
    if (mon1 && mon2) {
      const ci = buildDate(d1, mon1, year);
      let co = buildDate(d2, mon2, year);
      if (co <= ci) co = new Date(Date.UTC(co.getUTCFullYear() + 1, co.getUTCMonth(), co.getUTCDate()));
      return { checkIn: ci, checkOut: co };
    }
  }

  // "20/12 al 23/12" o "20/12/2026 - 23/12/2026"
  m = text.match(/(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\s*(?:a|al|hasta|-|–)\s*(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?/);
  if (m) {
    const y1 = m[3] ? (+m[3] < 100 ? 2000 + +m[3] : +m[3]) : null;
    const y2 = m[6] ? (+m[6] < 100 ? 2000 + +m[6] : +m[6]) : y1;
    const ci = buildDate(+m[1], +m[2], y1);
    let co = buildDate(+m[4], +m[5], y2);
    if (co <= ci) co = new Date(Date.UTC(co.getUTCFullYear() + 1, co.getUTCMonth(), co.getUTCDate()));
    return { checkIn: ci, checkOut: co };
  }

  // "mañana|hoy ... por N noches" / "N noches desde el 20 de julio"
  const nightsMatch = text.match(/(\d{1,2})\s+noches?/);
  let start = null;
  if (/\bhoy\b/.test(text)) start = today();
  else if (/\bmañana\b/.test(text)) start = addDays(today(), 1);
  else {
    m = text.match(/(?:desde el|el|para el)\s+(\d{1,2})\s+de\s+([a-zá]+)(?:\s+(?:de\s+)?(\d{4}))?/);
    if (m) {
      const mon = MONTHS[m[2].normalize('NFD').replace(/\p{Diacritic}/gu, '')] || MONTHS[m[2]];
      if (mon) start = buildDate(+m[1], mon, m[3] ? +m[3] : null);
    }
  }
  if (start && nightsMatch) return { checkIn: start, checkOut: addDays(start, +nightsMatch[1]) };
  if (start) return { checkIn: start, checkOut: null };

  // "este fin de semana" → viernes a domingo
  if (/fin de semana/.test(text)) {
    const base = today();
    const dow = base.getUTCDay();
    const friday = addDays(base, ((5 - dow) + 7) % 7 || 7);
    return { checkIn: friday, checkOut: addDays(friday, 2) };
  }

  return null;
}

export function extractGuests(textRaw) {
  const text = textRaw.toLowerCase();
  let adults = null, children = null;
  let m = text.match(/(\d{1,2})\s*(?:adultos?|personas?|pax|huéspedes|huespedes)/);
  if (m) adults = +m[1];
  m = text.match(/(\d{1,2})\s*(?:niños?|ninos?|menores|hijos?)/);
  if (m) children = +m[1];
  if (adults === null) {
    m = text.match(/para\s+(\d{1,2})\b/);
    if (m) adults = +m[1];
  }
  if (adults === null && /\bpareja\b|\bdos personas\b|para dos\b/.test(text)) adults = 2;
  return { adults, children: children ?? 0 };
}
