// Automatizador visual (§40): reglas no-code que el usuario define en el panel
// y que reaccionan a los eventos de dominio. Solo se permiten acciones de bajo
// riesgo (matriz §47): notificar, crear tarea de limpieza o registrar en log.
// Las acciones sensibles (cobros, reembolsos…) siguen exigiendo aprobación.
import { bus } from '../lib/events.js';
import { prisma } from '../db.js';
import { logger } from '../lib/logger.js';
import { notify } from './notifications.js';
import { audit } from '../lib/audit.js';

// Catálogo de disparadores (eventos) y acciones disponibles para la UI.
export const TRIGGERS = [
  { event: 'reservation.confirmed', label: 'Reserva confirmada' },
  { event: 'checkout.completed', label: 'Check-out completado' },
  { event: 'payment.succeeded', label: 'Pago recibido' },
  { event: 'booking.abandoned', label: 'Reserva abandonada' },
  { event: 'foreign_guest.detected', label: 'Huésped extranjero detectado' },
  { event: 'human_takeover.requested', label: 'Escalamiento a humano' },
  { event: 'campaign.sent', label: 'Campaña enviada' },
  { event: 'review.created', label: 'Nueva reseña' },
  { event: 'event.confirmed', label: 'Evento confirmado' },
];
const TRIGGER_EVENTS = new Set(TRIGGERS.map(t => t.event));

export const ACTIONS = [
  { type: 'notify', label: 'Notificar a un rol', params: [{ key: 'role', label: 'Rol', options: ['MANAGER', 'FRONTDESK', 'SALES', 'ACCOUNTING', 'HOUSEKEEPING', 'HR'] }, { key: 'title', label: 'Título' }, { key: 'body', label: 'Mensaje' }, { key: 'severity', label: 'Severidad', options: ['info', 'warning', 'critical'] }] },
  { type: 'housekeeping_task', label: 'Crear tarea de limpieza', params: [{ key: 'notes', label: 'Nota' }, { key: 'priority', label: 'Prioridad', options: ['low', 'normal', 'high'] }] },
  { type: 'log', label: 'Registrar en auditoría', params: [{ key: 'note', label: 'Nota' }] },
];
const ACTION_TYPES = new Set(ACTIONS.map(a => a.type));

function parse(json, fallback) { try { return json ? JSON.parse(json) : fallback; } catch { return fallback; } }

// Evalúa condiciones simples sobre el payload del evento.
function conditionsMatch(conditions, payload) {
  const conds = Array.isArray(conditions) ? conditions : [];
  return conds.every(c => {
    const val = payload?.[c.field];
    switch (c.op) {
      case 'eq': return String(val) === String(c.value);
      case 'neq': return String(val) !== String(c.value);
      case 'gt': return Number(val) > Number(c.value);
      case 'lt': return Number(val) < Number(c.value);
      case 'exists': return val != null;
      default: return true;
    }
  });
}

async function runAction(rule, payload) {
  const params = parse(rule.actionParams, {});
  const propertyId = payload.propertyId || rule.propertyId;
  if (rule.actionType === 'notify') {
    await notify({ propertyId, audienceRole: params.role || 'MANAGER', title: params.title || rule.name, body: params.body || null, severity: params.severity || 'info', entity: rule.trigger, entityId: payload.entityId || payload.reservationId || null });
  } else if (rule.actionType === 'housekeeping_task') {
    const roomId = payload.roomId || null;
    if (roomId) await prisma.housekeepingTask.create({ data: { propertyId, roomId, type: 'auto_rule', priority: params.priority || 'normal', notes: params.notes || `Regla: ${rule.name}` } });
    else await notify({ propertyId, audienceRole: 'HOUSEKEEPING', title: `Regla ${rule.name}`, body: params.notes || 'Tarea automática (sin habitación en el evento).' });
  } else if (rule.actionType === 'log') {
    await audit({ propertyId, actor: 'system', action: 'automation.rule_fired', entity: 'AutomationRule', entityId: rule.id, reason: params.note || rule.name });
  }
}

// Ejecuta las reglas habilitadas que coinciden con un evento dado.
export async function runRulesForEvent(name, payload) {
  if (!payload?.propertyId) return 0;
  const rules = await prisma.automationRule.findMany({ where: { propertyId: payload.propertyId, trigger: name, enabled: true } });
  let fired = 0;
  for (const rule of rules) {
    try {
      if (!conditionsMatch(parse(rule.conditions, []), payload)) continue;
      await runAction(rule, payload);
      await prisma.automationRule.update({ where: { id: rule.id }, data: { runCount: { increment: 1 }, lastRunAt: new Date() } });
      fired++;
    } catch (err) { logger.error({ err, rule: rule.id }, 'automation rule failed'); }
  }
  return fired;
}

let registered = false;
export function registerRuleEngine() {
  if (registered) return;
  registered = true;
  bus.on('*', ({ name, payload }) => {
    if (!TRIGGER_EVENTS.has(name)) return;
    runRulesForEvent(name, payload).catch(err => logger.error({ err, name }, 'rule engine dispatch failed'));
  });
  logger.info('automation rule engine registered');
}

export async function createRule({ propertyId, name, trigger, conditions = [], actionType, actionParams = {}, createdBy = null }) {
  if (!name) throw new Error('name requerido');
  if (!TRIGGER_EVENTS.has(trigger)) throw new Error('Disparador inválido');
  if (!ACTION_TYPES.has(actionType)) throw new Error('Acción inválida');
  return prisma.automationRule.create({
    data: { propertyId, name, trigger, conditions: JSON.stringify(conditions || []), actionType, actionParams: JSON.stringify(actionParams || {}), createdBy },
  });
}

export async function toggleRule(id, enabled) {
  return prisma.automationRule.update({ where: { id }, data: { enabled: !!enabled } });
}

// Ejecuta una regla con un payload de prueba (para validarla desde el panel).
export async function testRule(id, samplePayload = {}) {
  const rule = await prisma.automationRule.findUnique({ where: { id } });
  if (!rule) throw new Error('Regla no encontrada');
  const payload = { propertyId: rule.propertyId, ...samplePayload };
  const matched = conditionsMatch(parse(rule.conditions, []), payload);
  if (matched) await runAction(rule, payload);
  return { matched, executed: matched };
}

export async function automationsOverview(propertyId) {
  const rules = await prisma.automationRule.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 200 });
  return {
    total: rules.length,
    active: rules.filter(r => r.enabled).length,
    totalRuns: rules.reduce((s, r) => s + r.runCount, 0),
    rules, triggers: TRIGGERS, actions: ACTIONS,
  };
}
