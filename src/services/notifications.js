// Notificaciones internas (sección 44).
import { prisma } from '../db.js';

export async function notify({ propertyId, audienceRole = 'MANAGER', title, body = null, severity = 'info', entity = null, entityId = null }) {
  return prisma.notification.create({
    data: { propertyId, audienceRole, title, body, severity, entity, entityId },
  });
}
