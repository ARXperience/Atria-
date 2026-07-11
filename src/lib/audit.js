// Auditoría transversal (sección 42): toda acción crítica queda registrada
// con actor (humano/IA/sistema), before/after y trazabilidad.
import { prisma } from '../db.js';
import { logger } from './logger.js';

export async function audit({
  companyId = null, propertyId = null, user = null, actor = 'human',
  action, entity = null, entityId = null, before = null, after = null, reason = null, ip = null,
}) {
  try {
    await prisma.auditLog.create({
      data: {
        companyId, propertyId,
        userId: user?.id || null,
        userName: user?.name || (actor === 'ai' ? 'Atria IA' : actor === 'system' ? 'Sistema' : null),
        actor, action, entity, entityId,
        before: before ? JSON.stringify(before) : null,
        after: after ? JSON.stringify(after) : null,
        reason, ip,
      },
    });
  } catch (err) {
    logger.error({ err, action }, 'audit write failed');
  }
}
