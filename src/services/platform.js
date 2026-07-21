// Interruptores globales de funciones del sistema (§55.1). El superadministrador
// activa/desactiva un servicio para toda la plataforma. Este es el nivel más alto
// del control de acceso: global > sede > usuario.
import { prisma } from '../db.js';
import { SERVICE_KEYS } from '../lib/services.js';
import { audit } from '../lib/audit.js';

let cache = null; // Set<string> de claves DESHABILITADAS globalmente
let cacheAt = 0;
const TTL = 30_000;

export function invalidatePlatformFeatures() { cache = null; }

// Conjunto de claves de servicio deshabilitadas globalmente (con caché corta).
export async function disabledFeatures() {
  if (cache && Date.now() - cacheAt < TTL) return cache;
  const rows = await prisma.platformFeature.findMany({ where: { enabled: false }, select: { key: true } }).catch(() => []);
  cache = new Set(rows.map((r) => r.key));
  cacheAt = Date.now();
  return cache;
}

export async function isFeatureEnabled(key) {
  if (!key) return true;
  return !(await disabledFeatures()).has(key);
}

// Estado de cada servicio del catálogo (para la consola del superadmin).
export async function featureStates() {
  const disabled = await disabledFeatures();
  return SERVICE_KEYS.map((key) => ({ key, enabled: !disabled.has(key) }));
}

// Activa/desactiva un servicio globalmente. Sólo el superadmin (validado en la ruta).
export async function setFeature(key, enabled, { user, note } = {}) {
  if (!SERVICE_KEYS.includes(key)) throw new Error(`Servicio desconocido: ${key}`);
  const value = enabled !== false;
  await prisma.platformFeature.upsert({
    where: { key },
    update: { enabled: value, note: note ?? undefined },
    create: { key, enabled: value, note: note ?? null },
  });
  invalidatePlatformFeatures();
  await audit({ user, action: 'platform.feature', entity: 'PlatformFeature', entityId: key, after: { key, enabled: value } });
  return { key, enabled: value };
}
