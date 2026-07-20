// Centro de integraciones (§45): gobierna todos los conectores externos del
// ecosistema en una sola superficie — pasarelas, facturación, OTAs, mensajería,
// analítica y webhooks genéricos. Los secretos se enmascaran al leer.
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';
import { gatewaysStatus } from './gateways/index.js';
import { dataicoConfigured } from './invoicing.js';
import { whatsappStatus } from './whatsapp.js';

// Catálogo de integraciones conocidas. `env` = configurada por variables de
// entorno del servidor (no se editan aquí, solo se muestran).
export const CATALOG = [
  { provider: 'mercadopago', name: 'MercadoPago', category: 'payments', env: true, fields: [{ key: 'accessToken', label: 'Access Token', secret: true }] },
  { provider: 'bold', name: 'Bold', category: 'payments', env: true, fields: [{ key: 'apiKey', label: 'API Key', secret: true }, { key: 'secretKey', label: 'Secret Key', secret: true }] },
  { provider: 'stripe', name: 'Stripe', category: 'payments', env: true, fields: [{ key: 'secretKey', label: 'Secret Key', secret: true }, { key: 'webhookSecret', label: 'Webhook Secret', secret: true }] },
  { provider: 'wompi', name: 'Wompi', category: 'payments', env: true, fields: [{ key: 'privateKey', label: 'Private Key', secret: true }, { key: 'eventsSecret', label: 'Events Secret', secret: true }] },
  { provider: 'dataico', name: 'Dataico (Factura electrónica)', category: 'invoicing', env: true, fields: [{ key: 'apiKey', label: 'API Key', secret: true }, { key: 'account', label: 'Cuenta' }] },
  { provider: 'whatsapp', name: 'WhatsApp (Baileys)', category: 'messaging', live: true, fields: [] },
  { provider: 'booking', name: 'Booking.com', category: 'channel', fields: [{ key: 'hotelId', label: 'Hotel ID' }, { key: 'apiKey', label: 'API Key', secret: true }] },
  { provider: 'expedia', name: 'Expedia', category: 'channel', fields: [{ key: 'hotelId', label: 'Hotel ID' }, { key: 'apiKey', label: 'API Key', secret: true }] },
  { provider: 'ga4', name: 'Google Analytics 4', category: 'analytics', fields: [{ key: 'measurementId', label: 'Measurement ID' }, { key: 'apiSecret', label: 'API Secret', secret: true }] },
  { provider: 'webhook', name: 'Webhook saliente', category: 'other', fields: [{ key: 'url', label: 'URL' }, { key: 'token', label: 'Token', secret: true }] },
];

const CATALOG_BY_PROVIDER = Object.fromEntries(CATALOG.map(c => [c.provider, c]));

function maskConfig(catalogEntry, configJson) {
  if (!configJson) return {};
  let cfg = {};
  try { cfg = JSON.parse(configJson); } catch { return {}; }
  const out = {};
  for (const f of catalogEntry?.fields || []) {
    if (cfg[f.key] == null || cfg[f.key] === '') continue;
    out[f.key] = f.secret ? '••••••' + String(cfg[f.key]).slice(-2) : cfg[f.key];
  }
  return out;
}

// Estado en vivo desde los servicios reales (env, sesión de WhatsApp, etc.).
function liveStatusFor(provider, propertyId, envGatewayMap) {
  const cat = CATALOG_BY_PROVIDER[provider];
  if (!cat) return null;
  if (cat.category === 'payments') {
    const g = envGatewayMap[provider];
    return g?.configured ? 'connected' : 'disconnected';
  }
  if (provider === 'dataico') return dataicoConfigured() ? 'connected' : 'disconnected';
  if (provider === 'whatsapp') {
    const s = whatsappStatus(propertyId);
    return s.status === 'connected' ? 'connected' : (s.status === 'error' ? 'error' : 'disconnected');
  }
  return null;
}

export async function listIntegrations(propertyId) {
  const stored = await prisma.integration.findMany({ where: { propertyId } });
  const byProvider = Object.fromEntries(stored.map(s => [s.provider, s]));
  const gwMap = Object.fromEntries(gatewaysStatus().map(g => [g.name, g]));
  return CATALOG.map(cat => {
    const row = byProvider[cat.provider];
    const live = (cat.env || cat.live) ? liveStatusFor(cat.provider, propertyId, gwMap) : null;
    const status = live || row?.status || 'disconnected';
    return {
      provider: cat.provider, name: cat.name, category: cat.category,
      managedByEnv: !!cat.env, live: !!cat.live,
      status, enabled: row ? row.enabled : true,
      config: row ? maskConfig(cat, row.config) : {},
      fields: cat.fields,
      lastCheckedAt: row?.lastCheckedAt || null, lastError: row?.lastError || null,
      id: row?.id || null,
    };
  });
}

export async function connectIntegration({ propertyId, provider, config = {}, user }) {
  const cat = CATALOG_BY_PROVIDER[provider];
  if (!cat) throw new Error('Integración desconocida');
  if (cat.env) throw new Error('Esta integración se configura por variables de entorno del servidor');
  // Valida campos requeridos mínimos (todos los no-secretos declarados).
  const missing = (cat.fields || []).filter(f => !f.secret && !config[f.key]).map(f => f.label);
  if (missing.length) throw new Error(`Faltan datos: ${missing.join(', ')}`);
  const row = await prisma.integration.upsert({
    where: { propertyId_provider: { propertyId, provider } },
    update: { config: JSON.stringify(config), status: 'connected', name: cat.name, category: cat.category, lastError: null, lastCheckedAt: new Date() },
    create: { propertyId, provider, name: cat.name, category: cat.category, config: JSON.stringify(config), status: 'connected', createdBy: user?.name || null, lastCheckedAt: new Date() },
  });
  await audit({ propertyId, user, action: 'integration.connected', entity: 'Integration', entityId: row.id, after: { provider } });
  return { ...row, config: maskConfig(cat, row.config) };
}

export async function testIntegration(propertyId, provider, { user } = {}) {
  const cat = CATALOG_BY_PROVIDER[provider];
  if (!cat) throw new Error('Integración desconocida');
  const gwMap = Object.fromEntries(gatewaysStatus().map(g => [g.name, g]));
  const live = (cat.env || cat.live) ? liveStatusFor(provider, propertyId, gwMap) : null;
  let ok, message;
  if (live) { ok = live === 'connected'; message = ok ? 'Conexión activa' : 'Sin credenciales/servidor no conectado'; }
  else {
    const row = await prisma.integration.findUnique({ where: { propertyId_provider: { propertyId, provider } } });
    ok = !!row && row.status === 'connected' && !!row.config;
    message = ok ? 'Credenciales presentes (ping simulado correcto)' : 'Integración no configurada';
    if (row) await prisma.integration.update({ where: { id: row.id }, data: { lastCheckedAt: new Date(), status: ok ? 'connected' : 'error', lastError: ok ? null : message } });
  }
  await audit({ propertyId, user, action: 'integration.tested', entity: 'Integration', entityId: provider, after: { ok } });
  return { ok, status: ok ? 'connected' : 'error', message };
}

export async function toggleIntegration(id, enabled, { user } = {}) {
  const row = await prisma.integration.findUnique({ where: { id } });
  if (!row) throw new Error('Integración no encontrada');
  const updated = await prisma.integration.update({ where: { id }, data: { enabled: !!enabled } });
  await audit({ propertyId: row.propertyId, user, action: enabled ? 'integration.enabled' : 'integration.disabled', entity: 'Integration', entityId: id });
  return updated;
}

export async function integrationsOverview(propertyId) {
  const list = await listIntegrations(propertyId);
  return {
    total: list.length,
    connected: list.filter(i => i.status === 'connected').length,
    byCategory: list.reduce((o, i) => (o[i.category] = (o[i.category] || 0) + 1, o), {}),
    items: list,
  };
}
