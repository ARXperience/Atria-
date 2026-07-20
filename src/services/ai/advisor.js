// Atria Intelligence (§38/§41) — motor central de recomendaciones que lee TODOS
// los módulos y produce un "qué hacer hoy" priorizado y accionable. Determinístico
// por defecto (señales reales del sistema); si hay ANTHROPIC_API_KEY, sintetiza un
// resumen en lenguaje natural. Respeta el rol: solo incluye áreas que el rol ve.
import { prisma } from '../../db.js';
import { hasPermission } from '../../middleware/auth.js';
import { fmtCOP } from '../../lib/util.js';
import { financeOverview } from '../finance.js';
import { reputationOverview } from '../reputation.js';
import { recommendations as revenueRecs } from '../revenue.js';
import { knowledgeReview } from '../knowledge.js';
import { dueAssets } from '../maintenance.js';
import { llmAvailable, llmComplete } from './claude.js';

const SEV_RANK = { critical: 3, warning: 2, info: 1 };
const DAY = 86400_000;

// Cada colector devuelve 0..N recomendaciones {area, permission, severity, title, detail, action, metric}.
async function revenueSignals(propertyId) {
  const out = [];
  try {
    const recs = await revenueRecs(propertyId, 14);
    const ups = recs.filter(r => r.changePct > 0).sort((a, b) => b.changePct - a.changePct).slice(0, 2);
    const downs = recs.filter(r => r.changePct < 0).slice(0, 1);
    for (const r of ups) out.push({ area: 'revenue', permission: 'revenue.view', severity: 'warning', title: `Sube tarifa ${r.roomType} ${r.changePct > 0 ? '+' : ''}${r.changePct}%`, detail: `${r.date}: ocupación ${r.occupancyPct}%. ${r.reason}. ${fmtCOP(r.currentPrice)} → ${fmtCOP(r.suggestedPrice)}.`, action: 'Revisar en Revenue y aplicar el cambio de tarifa.', metric: r.changePct });
    for (const r of downs) out.push({ area: 'revenue', permission: 'revenue.view', severity: 'info', title: `Estimula demanda en ${r.roomType} (${r.changePct}%)`, detail: `${r.date}: ocupación baja (${r.occupancyPct}%). ${r.reason}.`, action: 'Considerar promoción o cupón para esas fechas.', metric: r.changePct });
  } catch { /* módulo opcional */ }
  return out;
}

async function financeSignals(propertyId) {
  const out = [];
  try {
    const fo = await financeOverview(propertyId);
    if (fo.receivable > 0) {
      const withBalance = await prisma.reservation.count({ where: { propertyId, status: { in: ['confirmed', 'checked_in', 'checked_out'] } } });
      out.push({ area: 'finance', permission: 'finance.view', severity: fo.receivable > 2_000_000 ? 'warning' : 'info', title: `Cartera por cobrar: ${fmtCOP(fo.receivable)}`, detail: `Hay saldos pendientes en reservas activas. Gestiona el recaudo para mejorar el flujo de caja.`, action: 'Abrir Finanzas → Cartera y enviar links de pago del saldo.', metric: fo.receivable });
    }
    if (fo.monthNet < 0) out.push({ area: 'finance', permission: 'finance.view', severity: 'warning', title: `Resultado del mes en negativo (${fmtCOP(fo.monthNet)})`, detail: `Los egresos superan los ingresos del mes. Revisa cuentas por pagar y ocupación.`, action: 'Revisar estado de resultados y controlar gastos.', metric: fo.monthNet });
  } catch { /* */ }
  return out;
}

async function reputationSignals(propertyId) {
  const out = [];
  try {
    const rep = await reputationOverview(propertyId);
    if (rep.pending > 0) out.push({ area: 'reputation', permission: 'reputation.view', severity: rep.pending >= 3 ? 'warning' : 'info', title: `${rep.pending} reseña(s) sin responder`, detail: `Responder reseñas mejora la reputación y el posicionamiento. Calificación media ${rep.avg || '—'}/5, NPS ${rep.nps}.`, action: 'Abrir Reputación y responder (la IA sugiere el borrador).', metric: rep.pending });
    if (rep.count >= 3 && rep.avg && rep.avg < 3.5) out.push({ area: 'reputation', permission: 'reputation.view', severity: 'warning', title: `Calificación media baja (${rep.avg}/5)`, detail: `La percepción de los huéspedes está por debajo del objetivo. Revisa quejas con causa raíz.`, action: 'Revisar quejas abiertas y acciones correctivas.', metric: rep.avg });
  } catch { /* */ }
  // Alerta temprana por tema (antes de que caiga la calificación).
  try {
    const { topicSentiment } = await import('./sentiment.js');
    const { alerts } = await topicSentiment(propertyId);
    for (const a of alerts.slice(0, 2)) {
      out.push({ area: 'reputation', permission: 'reputation.view', severity: a.trend === 'worsening' ? 'warning' : 'info', title: `Tema "${a.topic}" ${a.trend === 'worsening' ? 'empeorando' : 'con quejas'} (${a.negative} negativas)`, detail: `Se detecta sentimiento negativo en "${a.topic}"${a.sample ? `: "${a.sample}"` : ''}. Actúa antes de que impacte la calificación.`, action: `Revisar el tema "${a.topic}" con el equipo responsable.`, metric: a.score });
    }
  } catch { /* */ }
  return out;
}

async function retentionUpsellSignals(propertyId) {
  const out = [];
  try {
    const { a } = { a: new Date(new Date().toISOString().slice(0, 10)) };
    const b = new Date(a.getTime() + DAY);
    // Llegadas de hoy sin pre-check-in → oportunidad de agilizar y hacer upsell.
    const arrivals = await prisma.reservation.count({ where: { propertyId, status: 'confirmed', checkIn: { gte: a, lt: b } } });
    const noPre = await prisma.reservation.count({ where: { propertyId, status: 'confirmed', checkIn: { gte: a, lt: b }, precheckinAt: null } });
    if (noPre > 0) out.push({ area: 'guest', permission: 'reservations.view', severity: 'info', title: `${noPre} de ${arrivals} llegada(s) de hoy sin pre-check-in`, detail: `Enviar el enlace de pre-check-in agiliza la recepción y habilita upsell (upgrade, late checkout, room service).`, action: 'Enviar pre-check-in desde el portal del huésped.', metric: noPre });
  } catch { /* */ }
  // Riesgo de fuga (churn): huéspedes en riesgo alto y contactables → win-back.
  try {
    const { churnOverview } = await import('./churn.js');
    const ch = await churnOverview(propertyId);
    if (ch.counts.high > 0) out.push({ area: 'marketing', permission: 'marketing.view', severity: ch.counts.high >= 5 ? 'warning' : 'info', title: `${ch.counts.high} huésped(es) en riesgo alto de fuga`, detail: `${ch.reachableAtRisk} en riesgo son contactables. Una campaña win-back con cupón puede recuperarlos.`, action: 'CRM → Riesgo de fuga → Lanzar win-back.', metric: ch.counts.high });
  } catch { /* */ }
  return out;
}

async function opsRiskSignals(propertyId) {
  const out = [];
  try {
    const pendingApprovals = await prisma.approvalRequest.count({ where: { propertyId, status: 'pending' } });
    if (pendingApprovals > 0) out.push({ area: 'approvals', permission: 'approvals.view', severity: pendingApprovals >= 3 ? 'warning' : 'info', title: `${pendingApprovals} aprobación(es) pendiente(s)`, detail: `Hay acciones sensibles esperando decisión. Retrasos frenan la operación.`, action: 'Abrir Aprobaciones y decidir.', metric: pendingApprovals });
  } catch { /* */ }
  try {
    const kr = await knowledgeReview(propertyId);
    if (kr.counts.expired > 0) out.push({ area: 'knowledge', permission: 'content.view', severity: 'warning', title: `${kr.counts.expired} ítem(s) de conocimiento vencido(s)`, detail: `La IA ya no los usa; actualízalos para no dejar huecos en las respuestas al huésped.`, action: 'Habitaciones & Conocimiento → revisar vigencia.', metric: kr.counts.expired });
  } catch { /* */ }
  try {
    const due = await dueAssets(propertyId);
    if (due.length > 0) out.push({ area: 'maintenance', permission: 'maintenance.view', severity: 'warning', title: `${due.length} activo(s) con mantenimiento vencido`, detail: `El mantenimiento preventivo atrasado eleva el riesgo de fallas en habitación.`, action: 'Mantenimiento → Generar preventivas.', metric: due.length });
  } catch { /* */ }
  try {
    const low = await prisma.product.count({ where: { propertyId } });
    const lowStock = low ? await prisma.$queryRawUnsafe(`SELECT COUNT(*) as c FROM Product WHERE propertyId = ? AND stock <= stockMin`, propertyId).then(r => Number(r?.[0]?.c || 0)).catch(() => 0) : 0;
    if (lowStock > 0) out.push({ area: 'inventory', permission: 'inventory.view', severity: 'info', title: `${lowStock} producto(s) en o bajo el mínimo`, detail: `Reponer a tiempo evita quiebres de stock en amenidades y minibar.`, action: 'Inventario → generar orden de compra.', metric: lowStock });
  } catch { /* */ }
  // Cocina: insumos que no alcanzan para la demanda proyectada.
  try {
    const { kitchenForecast } = await import('./kitchen.js');
    const kf = await kitchenForecast(propertyId, { days: 7 });
    if (kf.shortages > 0) out.push({ area: 'pos', permission: 'pos.view', severity: 'info', title: `${kf.shortages} insumo(s) de cocina no alcanzan para la demanda`, detail: `Se proyectan ${kf.totalCovers} cubiertos en 7 días; algunos insumos quedan por debajo del requerimiento.`, action: 'Restaurante → Forecast de cocina → generar compras.', metric: kf.shortages });
  } catch { /* */ }
  return out;
}

// Construye las recomendaciones priorizadas para la sede, filtradas por rol.
export async function buildInsights(propertyId, { role = 'OWNER' } = {}) {
  const groups = await Promise.all([
    revenueSignals(propertyId), financeSignals(propertyId), reputationSignals(propertyId),
    retentionUpsellSignals(propertyId), opsRiskSignals(propertyId),
  ]);
  let insights = groups.flat().filter(i => !i.permission || hasPermission(role, i.permission));
  insights.sort((a, b) => (SEV_RANK[b.severity] - SEV_RANK[a.severity]));
  insights = insights.slice(0, 12);
  const counts = { critical: insights.filter(i => i.severity === 'critical').length, warning: insights.filter(i => i.severity === 'warning').length, info: insights.filter(i => i.severity === 'info').length };
  return { generatedAt: null, counts, insights };
}

// Resumen ejecutivo en lenguaje natural. Determinístico; si hay LLM, lo redacta.
export async function insightsBriefing(propertyId, { role = 'OWNER', userName = null } = {}) {
  const { insights, counts } = await buildInsights(propertyId, { role });
  if (!insights.length) return { summary: 'Todo en orden por ahora: no hay recomendaciones prioritarias. 👍', insights, counts };
  const top = insights.slice(0, 5);
  let summary;
  if (llmAvailable()) {
    summary = await llmComplete({
      system: 'Eres el asesor operativo de un hotel. Respondes en español, tono directo y accionable, sin inventar datos: solo priorizas y aconsejas sobre las señales dadas.',
      messages: [{ role: 'user', content: `Resume en 3-4 frases las prioridades de hoy para ${userName || 'el equipo'}:\n${top.map((i, n) => `${n + 1}. [${i.area}] ${i.title} — ${i.detail}`).join('\n')}` }],
      maxTokens: 300,
    }).catch(() => null);
  }
  if (!summary) {
    const bullets = top.map(i => `• ${i.title} — ${i.action}`).join('\n');
    summary = `Prioridades de hoy (${counts.critical} críticas, ${counts.warning} importantes):\n${bullets}`;
  }
  return { summary, insights, counts };
}
