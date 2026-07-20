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

// Los pasos de una regla: usa la secuencia multi-paso si existe, o cae al modo
// simple de una sola acción (compatibilidad hacia atrás).
export function ruleSteps(rule) {
  const steps = parse(rule.steps, null);
  if (Array.isArray(steps) && steps.length) return steps;
  return [{ type: rule.actionType, params: parse(rule.actionParams, {}) }];
}

// Ejecuta un paso individual de la regla.
async function runStep(step, rule, payload) {
  const params = step.params || {};
  const propertyId = payload.propertyId || rule.propertyId;
  if (step.type === 'notify') {
    await notify({ propertyId, audienceRole: params.role || 'MANAGER', title: params.title || rule.name, body: params.body || null, severity: params.severity || 'info', entity: rule.trigger, entityId: payload.entityId || payload.reservationId || null });
  } else if (step.type === 'housekeeping_task') {
    const roomId = payload.roomId || null;
    if (roomId) await prisma.housekeepingTask.create({ data: { propertyId, roomId, type: 'auto_rule', priority: params.priority || 'normal', notes: params.notes || `Regla: ${rule.name}` } });
    else await notify({ propertyId, audienceRole: 'HOUSEKEEPING', title: `Regla ${rule.name}`, body: params.notes || 'Tarea automática (sin habitación en el evento).' });
  } else if (step.type === 'log') {
    await audit({ propertyId, actor: 'system', action: 'automation.rule_fired', entity: 'AutomationRule', entityId: rule.id, reason: params.note || rule.name });
  }
}

// Ejecuta todos los pasos de la regla en orden. Un paso que falla no impide
// los siguientes (registra el error y continúa).
async function runAction(rule, payload) {
  const steps = ruleSteps(rule);
  for (const step of steps) {
    if (!ACTION_TYPES.has(step.type)) continue;
    try { await runStep(step, rule, payload); }
    catch (err) { logger.error({ err, rule: rule.id, step: step.type }, 'automation step failed'); }
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

export async function createRule({ propertyId, name, trigger, conditions = [], actionType, actionParams = {}, steps = null, createdBy = null }) {
  if (!name) throw new Error('name requerido');
  if (!TRIGGER_EVENTS.has(trigger)) throw new Error('Disparador inválido');
  // Modo multi-paso: una secuencia de acciones válidas.
  if (Array.isArray(steps) && steps.length) {
    const clean = steps.map((s) => {
      if (!ACTION_TYPES.has(s.type)) throw new Error(`Acción inválida en un paso: ${s.type}`);
      return { type: s.type, params: s.params || {} };
    });
    return prisma.automationRule.create({
      data: {
        propertyId, name, trigger, conditions: JSON.stringify(conditions || []),
        actionType: 'multi', actionParams: null, steps: JSON.stringify(clean), createdBy,
      },
    });
  }
  // Modo simple: una sola acción.
  if (!ACTION_TYPES.has(actionType)) throw new Error('Acción inválida');
  return prisma.automationRule.create({
    data: { propertyId, name, trigger, conditions: JSON.stringify(conditions || []), actionType, actionParams: JSON.stringify(actionParams || {}), steps: null, createdBy },
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

// Sugerencias inteligentes de reglas según el estado actual de la sede.
// No propone reglas ya configuradas (dedupe por disparador + acción).
export async function suggestRules(propertyId) {
  const existing = await prisma.automationRule.findMany({ where: { propertyId }, select: { trigger: true, actionType: true } });
  const has = (t, a) => existing.some(r => r.trigger === t && r.actionType === a);
  const [negativeReviews, venues, abandoned] = await Promise.all([
    prisma.review.count({ where: { propertyId, rating: { lte: 2 } } }),
    prisma.venue.count({ where: { propertyId } }),
    prisma.reservation.count({ where: { propertyId, status: 'expired' } }),
  ]);
  const catalog = [
    { when: negativeReviews > 0, name: 'Reseña negativa → alertar gerencia', trigger: 'review.created', conditions: [{ field: 'rating', op: 'lt', value: 3 }], actionType: 'notify', actionParams: { role: 'MANAGER', title: 'Reseña negativa', severity: 'warning', body: 'Un huésped dejó una reseña baja: revisar y responder.' }, reason: `Tienes ${negativeReviews} reseña(s) de 2★ o menos sin regla de alerta.` },
    { when: abandoned > 0, name: 'Reserva abandonada → seguimiento comercial', trigger: 'booking.abandoned', conditions: [], actionType: 'notify', actionParams: { role: 'SALES', title: 'Reserva abandonada', severity: 'warning', body: 'Oportunidad de recuperación: contactar al cliente.' }, reason: `Hay ${abandoned} reserva(s) vencida(s) sin pago: automatiza la recuperación.` },
    { when: venues > 0, name: 'Evento confirmado → avisar a gerencia', trigger: 'event.confirmed', conditions: [], actionType: 'notify', actionParams: { role: 'MANAGER', title: 'Evento confirmado', severity: 'info' }, reason: 'Tienes salones activos: mantén a gerencia al tanto de cada evento cerrado.' },
    { when: true, name: 'Huésped extranjero → recordar SIRE', trigger: 'foreign_guest.detected', conditions: [], actionType: 'notify', actionParams: { role: 'FRONTDESK', title: 'Reporte SIRE pendiente', severity: 'warning' }, reason: 'Cumplimiento migratorio: recuerda el SIRE a recepción automáticamente.' },
  ];
  return catalog.filter(s => s.when && !has(s.trigger, s.actionType)).map(({ when, ...s }) => s);
}

export async function automationsOverview(propertyId) {
  const rules = await prisma.automationRule.findMany({ where: { propertyId }, orderBy: { createdAt: 'desc' }, take: 200 });
  return {
    total: rules.length,
    active: rules.filter(r => r.enabled).length,
    totalRuns: rules.reduce((s, r) => s + r.runCount, 0),
    // Enriquece cada regla con su secuencia de pasos resuelta para la UI.
    rules: rules.map(r => ({ ...r, stepList: ruleSteps(r) })),
    triggers: TRIGGERS, actions: ACTIONS,
  };
}
