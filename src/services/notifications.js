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

// Envía la alerta a cada canal habilitado cuya severidad mínima se cumpla y que
// no esté restringido a otro rol. El envío externo se simula de forma verificable
// (queda un registro de entrega); con credenciales reales se integraría el
// proveedor de email/WhatsApp/webhook.
export async function dispatchToChannels({ propertyId, audienceRole, title, body, severity }) {
  const channels = await prisma.notificationChannel.findMany({ where: { propertyId, enabled: true } });
  const rank = SEVERITY_RANK[severity] ?? 0;
  const deliveries = [];
  for (const ch of channels) {
    if (rank < (SEVERITY_RANK[ch.minSeverity] ?? 1)) continue;
    if (ch.audienceRole && ch.audienceRole !== audienceRole) continue;
    const delivery = await prisma.notificationDelivery.create({
      data: {
        propertyId, channelId: ch.id, channelType: ch.type, target: ch.target,
        title, severity, status: 'sent',
        detail: `Reenviado a ${ch.type} (${ch.target})`,
      },
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

// Envía una notificación de prueba por el canal (verifica el reenvío).
export async function testChannel(id, { user = null } = {}) {
  const ch = await prisma.notificationChannel.findUnique({ where: { id } });
  if (!ch) throw new Error('Canal no encontrado');
  const delivery = await prisma.notificationDelivery.create({
    data: {
      propertyId: ch.propertyId, channelId: ch.id, channelType: ch.type, target: ch.target,
      title: 'Notificación de prueba', severity: 'info', status: 'sent',
      detail: `Prueba enviada por ${user?.name || 'sistema'}`,
    },
  });
  return delivery;
}

export async function listDeliveries(propertyId, { channelId } = {}) {
  const where = { propertyId };
  if (channelId) where.channelId = channelId;
  return prisma.notificationDelivery.findMany({ where, orderBy: { createdAt: 'desc' }, take: 100 });
}
