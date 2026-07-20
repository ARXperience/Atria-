// TOTP (RFC 6238) implementado con crypto nativo — sin dependencias externas.
// Compatible con Google Authenticator, Authy, 1Password, etc.
import crypto from 'node:crypto';

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function generateSecret(bytes = 20) {
  const buf = crypto.randomBytes(bytes);
  let bits = '';
  for (const b of buf) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function base32Decode(secret) {
  const clean = secret.replace(/=+$/, '').toUpperCase().replace(/\s/g, '');
  let bits = '';
  for (const c of clean) {
    const idx = B32.indexOf(c);
    if (idx === -1) continue;
    bits += idx.toString(2).padStart(5, '0');
  }
  const bytes = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) bytes.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(bytes);
}

function hotp(secret, counter) {
  const key = base32Decode(secret);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const hmac = crypto.createHmac('sha1', key).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
  return (bin % 1_000_000).toString().padStart(6, '0');
}

// Código actual para un secreto (útil en pruebas y para mostrar en dev).
export function totpCode(secret, forTime = 0, step = 30) {
  const t = Math.floor((forTime || nowSeconds()) / step);
  return hotp(secret, t);
}

// Verifica un código con tolerancia de ±window pasos (deriva de reloj).
export function verifyTotp(secret, code, { window = 1, step = 30, forTime = 0 } = {}) {
  if (!secret || !/^\d{6}$/.test(String(code || ''))) return false;
  const counter = Math.floor((forTime || nowSeconds()) / step);
  for (let w = -window; w <= window; w++) {
    if (hotp(secret, counter + w) === String(code)) return true;
  }
  return false;
}

export function otpauthUrl(secret, { label = 'Atria', issuer = 'Atria Hospitality OS' } = {}) {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(label)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

// `new Date()` sin argumentos está prohibido en algunos entornos; Date.now sí.
function nowSeconds() { return Math.floor(Date.now() / 1000); }
