// IA-4 · Copiloto interno por área (§41). Asiste al equipo dentro del panel,
// respondiendo SOLO con datos que el rol del usuario puede ver. Determinístico
// por defecto; si hay ANTHROPIC_API_KEY, usa el motor de herramientas.
import { prisma } from '../../db.js';
import { hasPermission } from '../../middleware/auth.js';
import { getAgentProfile, buildSystemPrompt } from './agentProfile.js';
import { knowledgeSnapshot } from '../knowledge.js';
import { searchKnowledge } from './retrieval.js';
import { llmAvailable, llmToolLoop } from './claude.js';
import { buildTools, toolDefsForLLM } from './tools.js';
import { fmtCOP } from '../../lib/util.js';
import { audit } from '../../lib/audit.js';
import { financeOverview, financialNarrative } from '../finance.js';
import { reputationOverview } from '../reputation.js';
import { eventsOverview } from '../events.js';
import { fonturOverview } from '../fontur.js';
import { marketingOverview } from '../marketing.js';

const ROLE_SCOPE = {
  FRONTDESK: 'reception', HOUSEKEEPING: 'housekeeping', MAINTENANCE: 'maintenance',
  SALES: 'sales', ACCOUNTING: 'finance', HR: 'payroll', MANAGER: 'manager',
  OWNER: 'manager', AUDITOR: 'manager',
};

function todayRange() {
  const now = new Date();
  const a = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { a, b: new Date(a.getTime() + 86400000) };
}

export async function internalAssistantReply({ user, propertyId, text }) {
  const scope = ROLE_SCOPE[user.role] || 'reception';
  const profile = await getAgentProfile(propertyId, scope);
  const t = text.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
  const can = (p) => hasPermission(user.role, p);
  await audit({ propertyId, user, actor: 'human', action: 'ai.internal_query', reason: text.slice(0, 200) });

  // 1) Búsqueda de reserva por código
  const codeM = text.match(/ATR-\d{4}-\d{4,6}/i);
  if (codeM && can('reservations.view')) {
    const r = await prisma.reservation.findUnique({ where: { code: codeM[0].toUpperCase() }, include: { guest: true, room: true } });
    if (!r || r.propertyId !== propertyId) return { reply: `No encontré la reserva ${codeM[0]} en esta sede.` };
    const estados = { tentative: 'tentativa', confirmed: 'confirmada', checked_in: 'en casa', checked_out: 'finalizada', cancelled: 'cancelada' };
    return { reply: `📅 *${r.code}* — ${r.guest.fullName}\nEstado: ${estados[r.status] || r.status}\nFechas: ${r.checkIn.toISOString().slice(0, 10)} → ${r.checkOut.toISOString().slice(0, 10)}\nHabitación: ${r.room?.number || 'sin asignar'}\nTotal: ${fmtCOP(r.total)}` };
  }

  // 2) Estado de habitaciones
  if (/habitaci|ocupaci|sucia|limpia|disponible|mapa|piso/.test(t) && can('rooms.view')) {
    const grp = await prisma.room.groupBy({ by: ['status'], where: { propertyId, active: true }, _count: true });
    const c = Object.fromEntries(grp.map((g) => [g.status, g._count]));
    const total = grp.reduce((s, g) => s + g._count, 0);
    return { reply: `🛏️ Habitaciones (${total}): ${c.clean || 0} limpias, ${c.inspected || 0} inspeccionadas, ${c.occupied || 0} ocupadas, ${c.dirty || 0} sucias, ${c.out_of_service || 0} fuera de servicio.` };
  }

  // 3) Llegadas / salidas de hoy
  if (/llegada|entrada|arrib|salida|checkout|check.?out|check.?in/.test(t) && can('reservations.view')) {
    const { a, b } = todayRange();
    const [arr, dep] = await Promise.all([
      prisma.reservation.findMany({ where: { propertyId, status: 'confirmed', checkIn: { gte: a, lt: b } }, include: { guest: true } }),
      prisma.reservation.findMany({ where: { propertyId, status: 'checked_in', checkOut: { gte: a, lt: b } }, include: { guest: true, room: true } }),
    ]);
    const l1 = arr.length ? arr.map((r) => `• ${r.guest.fullName} (${r.code})`).join('\n') : 'sin llegadas';
    const l2 = dep.length ? dep.map((r) => `• ${r.guest.fullName} — hab ${r.room?.number || '?'}`).join('\n') : 'sin salidas';
    return { reply: `📥 *Llegadas hoy* (${arr.length}):\n${l1}\n\n📤 *Salidas hoy* (${dep.length}):\n${l2}` };
  }

  // 4) Aprobaciones pendientes
  if (/aprobaci|autoriza|pendiente/.test(t) && can('approvals.view')) {
    const list = await prisma.approvalRequest.findMany({ where: { propertyId, status: 'pending' }, take: 8, orderBy: { createdAt: 'desc' } });
    if (!list.length) return { reply: '✅ No hay aprobaciones pendientes.' };
    return { reply: `⏳ *${list.length} aprobación(es) pendiente(s):*\n${list.map((a) => `• ${a.type} — ${a.summary}`).join('\n')}` };
  }

  // 5) Housekeeping
  if (/limpieza|housekeeping|camarera|aseo|tarea/.test(t) && can('housekeeping.view')) {
    const tasks = await prisma.housekeepingTask.findMany({ where: { propertyId, status: { in: ['pending', 'in_progress'] } }, include: { room: true }, take: 12 });
    if (!tasks.length) return { reply: '🧹 No hay tareas de limpieza pendientes.' };
    return { reply: `🧹 *${tasks.length} limpieza(s) pendiente(s):*\n${tasks.map((x) => `• Hab ${x.room.number} — ${x.type} (${x.priority})`).join('\n')}` };
  }

  // 6) Mantenimiento
  if (/mantenimiento|dano|averi|orden de trabajo|reparaci/.test(t) && can('maintenance.view')) {
    const orders = await prisma.maintenanceOrder.findMany({ where: { propertyId, status: { in: ['open', 'in_progress'] } }, include: { room: true }, take: 12 });
    if (!orders.length) return { reply: '🔧 No hay órdenes de mantenimiento abiertas.' };
    return { reply: `🔧 *${orders.length} orden(es) abierta(s):*\n${orders.map((o) => `• ${o.title}${o.room ? ` (hab ${o.room.number})` : ''} — ${o.priority}`).join('\n')}` };
  }

  // 7) Pagos / caja del día
  if (/pago|caja|ingreso|recaudo/.test(t) && can('payments.view')) {
    const { a, b } = todayRange();
    const agg = await prisma.payment.aggregate({ where: { propertyId, status: 'approved', kind: 'payment', createdAt: { gte: a, lt: b } }, _sum: { amount: true }, _count: true });
    return { reply: `💳 Hoy se han registrado ${agg._count} pago(s) por un total de ${fmtCOP(agg._sum.amount || 0)}.` };
  }

  // 8) Nómina / empleados
  if (/nomina|empleado|personal|contrato/.test(t) && can('hr.view')) {
    const [emps, periods] = await Promise.all([
      prisma.employee.count({ where: { propertyId, status: 'active' } }),
      prisma.payrollPeriod.findMany({ where: { propertyId }, orderBy: [{ year: 'desc' }, { month: 'desc' }], take: 1 }),
    ]);
    const p = periods[0];
    return { reply: `👔 Empleados activos: ${emps}.${p ? ` Último periodo de nómina: ${p.month}/${p.year} (${p.status}).` : ' Aún no hay periodos de nómina.'}` };
  }

  // 9) Finanzas: resumen del mes y cartera (copiloto financiero)
  if (/finanza|resultado|utilidad|cartera|estado de resultado|p&g|pyg|egreso|rentab/.test(t) && can('finance.view')) {
    const nar = await financialNarrative(propertyId);
    return { reply: `🤖 *Copiloto financiero*\n${nar.narrative}` };
  }

  // 10) Reputación: calificación y reseñas
  if (/reputaci|reseña|resena|calificaci|estrella|opinion|review|nps/.test(t) && can('reputation.view')) {
    const rep = await reputationOverview(propertyId);
    return { reply: `⭐ Calificación media: *${rep.avg || '—'}/5* (${rep.count} reseña(s)). Sin responder: ${rep.pending}. Tasa de respuesta: ${rep.responseRate}%. NPS aprox.: ${rep.nps}.` };
  }

  // 11) Eventos & salones
  if (/evento|salon|salón|montaje|banquete|cotizaci.*event|reserva de sal/.test(t) && can('events.view')) {
    const ev = await eventsOverview(propertyId);
    return { reply: `🎉 Eventos: ${ev.upcomingCount} próximo(s), ${ev.confirmed} confirmado(s). Pipeline en cotizaciones: ${fmtCOP(ev.pipeline)}. Ingresos por eventos del mes: ${fmtCOP(ev.monthRevenue)}.` };
  }

  // 12) FONTUR (parafiscal)
  if (/fontur|parafiscal|contribucion.*turismo|turismo/.test(t) && can('fontur.view')) {
    const f = await fonturOverview(propertyId);
    return { reply: `🏝️ FONTUR ${f.current.period}: base ${fmtCOP(f.current.operatingIncome)} × ${(f.current.rate * 1000).toLocaleString('es-CO', { maximumFractionDigits: 2 })} por mil = *${fmtCOP(f.current.amount)}*. Pagado en el año: ${fmtCOP(f.paidYtd)}.` };
  }

  // 13) Marketing: alcance y campañas
  if (/marketing|campaña|campana|opt.?in|consentimiento.*market|contactable/.test(t) && can('marketing.view')) {
    const m = await marketingOverview(propertyId);
    return { reply: `📣 Contactables (opt-in): ${m.reachable} (${m.optInRate}% de la base). Campañas enviadas: ${m.campaignsSent}, mensajes: ${m.totalSent}.` };
  }

  // 14) Ocupación / KPIs gerenciales
  if (/ocupaci|adr|revpar|kpi|indicador|como vamos|desempeño|desempeno/.test(t) && can('dashboard.view') && can('finance.view')) {
    const fo = await financeOverview(propertyId);
    const grp = await prisma.room.groupBy({ by: ['status'], where: { propertyId, active: true }, _count: true });
    const c = Object.fromEntries(grp.map((g) => [g.status, g._count]));
    const total = grp.reduce((s, g) => s + g._count, 0);
    const oos = c.out_of_service || 0;
    const occ = total - oos > 0 ? Math.round(((c.occupied || 0) / (total - oos)) * 100) : 0;
    return { reply: `📊 Ocupación: *${occ}%* (${c.occupied || 0}/${total - oos}). Ingresos del mes: ${fmtCOP(fo.monthIncome)}, resultado: ${fmtCOP(fo.monthNet)}. Cartera por cobrar: ${fmtCOP(fo.receivable)}.` };
  }

  // 14.5) Recomendaciones / "qué hago hoy" (Atria Intelligence)
  if (/(que hago|prioridad|recomiend|recomendaci|que hacer hoy|briefing|en que me enfoco|foco de hoy)/.test(t) && can('dashboard.view')) {
    const { insightsBriefing } = await import('./advisor.js');
    const b = await insightsBriefing(propertyId, { role: user.role, userName: user.name });
    return { reply: `🧠 *Atria Intelligence*\n${b.summary}` };
  }

  // 15) Conocimiento interno
  const snap = await knowledgeSnapshot(propertyId, { visibility: 'internal' });
  const hit = searchKnowledge(snap, text);
  if (hit) return { reply: hit.answer };

  // 16) Motor de herramientas con LLM (si hay API key)
  if (profile.llmEnabled && llmAvailable()) {
    const tools = buildTools({ propertyId, profile, conversation: null });
    const reply = await llmToolLoop({
      system: buildSystemPrompt(profile, snap, { userRole: user.role }) +
        `\nEres el copiloto interno de ${user.name} (rol ${user.role}). Responde breve y operativo. No reveles datos fuera de su rol.`,
      messages: [{ role: 'user', content: text }],
      tools, toolDefs: toolDefsForLLM(tools),
    });
    if (reply) return { reply };
  }

  // 17) Ayuda según rol
  return { reply: helpFor(user.role) };
}

function helpFor(role) {
  const base = ['el estado de las habitaciones', 'las llegadas y salidas de hoy', 'una reserva por su código (ATR-...)'];
  const extra = [];
  if (hasPermission(role, 'approvals.view')) extra.push('las aprobaciones pendientes');
  if (hasPermission(role, 'housekeeping.view')) extra.push('las limpiezas pendientes');
  if (hasPermission(role, 'maintenance.view')) extra.push('las órdenes de mantenimiento');
  if (hasPermission(role, 'payments.view')) extra.push('la caja del día');
  if (hasPermission(role, 'finance.view')) extra.push('el resumen financiero y la cartera');
  if (hasPermission(role, 'reputation.view')) extra.push('la reputación y reseñas');
  if (hasPermission(role, 'events.view')) extra.push('los eventos y salones');
  if (hasPermission(role, 'fontur.view')) extra.push('la contribución FONTUR');
  if (hasPermission(role, 'marketing.view')) extra.push('el alcance de marketing');
  if (hasPermission(role, 'hr.view')) extra.push('empleados y nómina');
  const actions = hasPermission(role, 'reservations.edit')
    ? '\n\nTambién puedo *ejecutar acciones con vista previa*: aplicar un descuento, cambiar la tarifa, exonerar el anticipo o cancelar una reserva (ej: "aplica un descuento de 50000 a ATR-2026-1234"). Verás el impacto antes de confirmar.'
    : '';
  return `Soy tu copiloto interno 🧭. Puedo consultarte, por ejemplo:\n${[...base, ...extra].map((x) => `• ${x}`).join('\n')}${actions}\n\n¿Qué necesitas?`;
}
