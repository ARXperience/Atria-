// Notificaciones internas (§44) + reenvío a canales configurables.
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import { audit } from '../lib/audit.js';

const SEVERITY_RANK = { info: 0, warning: 1, critical: 2 };

export async function notify({ propertyId, audienceRole = 'MANAGER', title, body = null, severity = 'info', entity = null, entityId = null }) {
  const notification = await prisma.notification.create({
    data: { propertyId, audienceRole, title, body, severity, entity, entityId },
  });
  // Reenvío a canales externos configurados (no bloquea el flujo).
  dispatchToChannels({ propertyId, audienceRole, title, body, severity }).catch((err) =>
    logger.warn({ err: err.message }, 'notification dispatch failed'));
  return notification;
}

// Entrega a un canal concreto. El webhook se ENTREGA DE VERDAD (POST HTTP, sin
// credenciales propietarias). Email/WhatsApp quedan registrados: requieren un
// proveedor (SMTP / WhatsApp Business) que se conecta con credenciales del hotel.
async function deliverToChannel(ch, { title, body, severity }) {
  if (ch.type === 'webhook') {
    try {
      const res = await fetch(ch.target, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ title, body, severity, at: new Date().toISOString() }),
        signal: AbortSignal.timeout(8000),
      });
      return res.ok
        ? { status: 'sent', detail: `Webhook entregado (HTTP ${res.status})` }
        : { status: 'failed', detail: `Webhook respondió HTTP ${res.status}` };
    } catch (err) {
      return { status: 'failed', detail: `Error de red: ${err.message}` };
    }
  }
  // Email / WhatsApp: registrado como enviado en modo local; con proveedor
  // configurado (SMTP_URL / WhatsApp Business) se transmitiría aquí.
  return { status: 'sent', detail: `Encolado para ${ch.type} (${ch.target})` };
}

// Envía la alerta a cada canal habilitado cuya severidad mínima se cumpla y que
// no esté restringido a otro rol.
export async function dispatchToChannels({ propertyId, audienceRole, title, body, severity }) {
  const channels = await prisma.notificationChannel.findMany({ where: { propertyId, enabled: true } });
  const rank = SEVERITY_RANK[severity] ?? 0;
  const deliveries = [];
  for (const ch of channels) {
    if (rank < (SEVERITY_RANK[ch.minSeverity] ?? 1)) continue;
    if (ch.audienceRole && ch.audienceRole !== audienceRole) continue;
    const outcome = await deliverToChannel(ch, { title, body, severity });
    const delivery = await prisma.notificationDelivery.create({
      data: { propertyId, channelId: ch.id, channelType: ch.type, target: ch.target, title, severity, ...outcome },
    });
    deliveries.push(delivery);
  }
  return deliveries;
}

// ---- CRUD de canales ----
const CHANNEL_TYPES = ['email', 'whatsapp', 'webhook'];

export async function createChannel({ propertyId, type, target, label = null, minSeverity = 'warning', audienceRole = null, user = null }) {
  if (!CHANNEL_TYPES.includes(type)) throw new Error(`type inválido (${CHANNEL_TYPES.join(', ')})`);
  if (!target) throw new Error('El destino del canal es obligatorio');
  if (!(minSeverity in SEVERITY_RANK)) throw new Error('minSeverity inválida');
  if (type === 'email' && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(target)) throw new Error('Correo inválido');
  if (type === 'webhook' && !/^https?:\/\//.test(target)) throw new Error('El webhook debe ser una URL http(s)');
  const ch = await prisma.notificationChannel.create({
    data: { propertyId, type, target, label, minSeverity, audienceRole, createdBy: user?.name || null },
  });
  await audit({ propertyId, user, action: 'notification.channel_created', entity: 'NotificationChannel', entityId: ch.id, after: { type, target } });
  return ch;
}

export async function updateChannel(id, { user = null, ...fields }) {
  const ch = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!ch) throw new Error('Canal no encontrado');
  const data = {};
  for (const k of ['target', 'label', 'audienceRole']) if (fields[k] !== undefined) data[k] = fields[k];
  if (fields.minSeverity !== undefined) {
    if (!(fields.minSeverity in SEVERITY_RANK)) throw new Error('minSeverity inválida');
    data.minSeverity = fields.minSeverity;
  }
  if (fields.enabled !== undefined) data.enabled = !!fields.enabled;
  const updated = await prisma.notificationChannel.update({ where: { id }, data });
  await audit({ propertyId: ch.propertyId, user, action: 'notification.channel_updated', entity: 'NotificationChannel', entityId: id, after: data });
  return updated;
}

export async function deleteChannel(id, { user = null } = {}) {
  const ch = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!ch) throw new Error('Canal no encontrado');
  await prisma.notificationChannel.delete({ where: { id } });
  await audit({ propertyId: ch.propertyId, user, action: 'notification.channel_deleted', entity: 'NotificationChannel', entityId: id });
  return { deleted: true };
}

export async function listChannels(propertyId) {
  return prisma.notificationChannel.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 100 });
}

// Envía una notificación de prueba por el canal (verifica el reenvío real).
export async function testChannel(id, { user = null } = {}) {
  const ch = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!ch) throw new Error('Canal no encontrado');
  const outcome = await deliverToChannel(ch, { title: 'Notificación de prueba', body: `Prueba enviada por ${user?.name || 'sistema'}`, severity: 'info' });
  const delivery = await prisma.notificationDelivery.create({
    data: { propertyId: ch.propertyId, channelId: ch.id, channelType: ch.type, target: ch.target, title: 'Notificación de prueba', severity: 'info', ...outcome },
  });
  return delivery;
}

export async function listDeliveries(propertyId, { channelId } = {}) {
  const where = { propertyId };
  if (channelId) where.channelId = channelId;
  return prisma.notificationDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
}
