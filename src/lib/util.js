import crypto from 'node:crypto';

// Fecha "solo día" en UTC a partir de "YYYY-MM-DD"
export function parseDay(s) {
  if (s instanceof Date) return new Date(Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate()));
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || '').trim());
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return isNaN(d) ? null : d;
}

export function dayStr(d) {
  return d.toISOString().slice(0, 10);
}

export function nightsBetween(checkIn, checkOut) {
  return Math.round((checkOut - checkIn) / 86400000);
}

export function addDays(d, n) {
  return new Date(d.getTime() + n * 86400000);
}

export function token(len = 24) {
  return crypto.randomBytes(len).toString('base64url');
}

export function money(n) {
  return Math.round(n);
}

export function fmtCOP(n) {
  return new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n);
}

let seq = Date.now() % 100000;
export function reservationCode() {
  seq = (seq + 1) % 1000000;
  const y = new Date().getFullYear();
  return `ATR-${y}-${String(seq).padStart(6, '0')}`;
}

export function badRequest(res, message) {
  return res.status(400).json({ error: message });
}
