// Bus de eventos internos (sección 45 del documento funcional).
// Los módulos emiten eventos de dominio (reservation.confirmed, checkout.completed...)
// y otros módulos reaccionan (housekeeping, notificaciones, WhatsApp, CRM).
import { EventEmitter } from 'node:events';
import { logger } from './logger.js';

class AtriaBus extends EventEmitter {}
export const bus = new AtriaBus();
bus.setMaxListeners(50);

export function emitEvent(name, payload) {
  logger.info({ event: name, ...summarize(payload) }, 'domain event');
  bus.emit(name, payload);
  bus.emit('*', { name, payload });
}

function summarize(payload = {}) {
  const out = {};
  for (const k of ['propertyId', 'reservationId', 'conversationId', 'entityId', 'code']) {
    if (payload[k]) out[k] = payload[k];
  }
  return out;
}
