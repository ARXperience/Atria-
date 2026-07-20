// IA que ejecuta con vista previa (§41/§55.6). El copiloto interno interpreta
// una instrucción en lenguaje natural, arma una VISTA PREVIA de impacto (qué
// cambia: antes → después) y NO escribe nada. El humano confirma; si tiene la
// autoridad, se ejecuta de inmediato; si no, se envía al motor de aprobaciones.
import { prisma } from '../../db.js';
import { hasPermission } from '../../middleware/auth.js';
import { canApprove, executeAction, requestApproval } from '../approvals.js';
import { audit } from '../../lib/audit.js';
import { fmtCOP, money } from '../../lib/util.js';

const norm = (s) => s.toLowerCase().normalize('NFD').replace(/\p{Diacritic}/gu, '');
const RESV_RE = /ATR-\d{4}-\d{4,6}/i;
// Detecta montos como "50000", "50.000", "$50000", "50 mil".
function parseAmount(text) {
  const mil = text.match(/(\d[\d.,]*)\s*mil/i);
  if (mil) return money(parseFloat(mil[1].replace(/[.,]/g, '')) * 1000);
  const m = text.replace(/\$/g, '').match(/(\d[\d.]{2,})/);
  if (!m) return null;
  return money(parseFloat(m[1].replace(/\./g, '')));
}

async function findReservation(text, propertyId) {
  const m = text.match(RESV_RE);
  if (!m) return null;
  const r = await prisma.reservation.findUnique({ where: { code: m[0].toUpperCase() }, include: { guest: true } });
  return r && r.propertyId === propertyId ? r : null;
}

// Interpreta la instrucción. Devuelve null si no reconoce una acción sensible.
export async function interpretAction({ user, propertyId, text }) {
  const t = norm(text);
  const can = (p) => hasPermission(user.role, p);

  // Descuento al folio
  if (/(descuent|descont|rebaj|cortesia)/.test(t) && can('reservations.edit')) {
    const r = await findReservation(text, propertyId);
    const amount = parseAmount(text);
    if (!r) return needCode('un descuento');
    if (!amount) return { error: 'Indica el valor del descuento (ej: "descuento de 50000 a ATR-...").' };
    return buildAction({
      type: 'discount', requiredRole: 'MANAGER', user,
      payload: { propertyId, reservationId: r.id, amount, reason: reasonFrom(text), approvedByName: user.name },
      title: `Descuento en ${r.code}`,
      impact: [
        { label: 'Huésped', before: r.guest.fullName, after: r.guest.fullName },
        { label: 'Total actual de la reserva', before: fmtCOP(r.total), after: fmtCOP(r.total) },
        { label: 'Cargo a publicar en el folio', before: '—', after: `− ${fmtCOP(amount)}` },
      ],
    });
  }

  // Cambio de tarifa
  if (/(tarifa|precio.*noche|rate|nightly)/.test(t) && can('reservations.edit')) {
    const r = await findReservation(text, propertyId);
    const amount = parseAmount(text);
    if (!r) return needCode('un cambio de tarifa');
    if (!amount) return { error: 'Indica la nueva tarifa por noche (ej: "tarifa 120000 para ATR-...").' };
    const subtotal = money(amount * r.nights);
    const taxRate = r.subtotal > 0 ? r.taxes / r.subtotal : 0;
    const total = money(subtotal + subtotal * taxRate);
    return buildAction({
      type: 'rate_override', requiredRole: 'MANAGER', user,
      payload: { reservationId: r.id, nightlyRate: amount, reason: reasonFrom(text) },
      title: `Cambio de tarifa en ${r.code}`,
      impact: [
        { label: 'Tarifa por noche', before: fmtCOP(r.nightlyRate), after: fmtCOP(amount) },
        { label: `Subtotal (${r.nights} noche/s)`, before: fmtCOP(r.subtotal), after: fmtCOP(subtotal) },
        { label: 'Total de la reserva', before: fmtCOP(r.total), after: fmtCOP(total) },
      ],
    });
  }

  // Exonerar anticipo
  if (/(exoner|sin anticipo|sin deposito|waive|no exigir.*anticipo)/.test(t) && can('reservations.edit')) {
    const r = await findReservation(text, propertyId);
    if (!r) return needCode('exonerar el anticipo');
    return buildAction({
      type: 'reservation_no_deposit', requiredRole: 'MANAGER', user,
      payload: { reservationId: r.id, reason: reasonFrom(text) },
      title: `Exonerar anticipo de ${r.code}`,
      impact: [
        { label: 'Anticipo requerido', before: fmtCOP(r.depositRequired), after: fmtCOP(0) },
      ],
    });
  }

  // Cancelación
  if (/(cancel|anula.*reserva)/.test(t) && can('reservations.edit')) {
    const r = await findReservation(text, propertyId);
    if (!r) return needCode('una cancelación');
    return buildAction({
      type: 'cancellation', requiredRole: 'MANAGER', user,
      payload: { reservationId: r.id, reason: reasonFrom(text) },
      title: `Cancelar reserva ${r.code}`,
      impact: [
        { label: 'Estado', before: estado(r.status), after: 'cancelada' },
        { label: 'Huésped', before: r.guest.fullName, after: r.guest.fullName },
      ],
    });
  }

  // Bloqueo de habitación (fuera de servicio)
  if (/(bloque|fuera de servicio|out of service|inhabilit)/.test(t) && /habitaci|hab\.?\s*\d|room/.test(t) && can('rooms.status')) {
    const numM = text.match(/(?:hab\.?|habitaci[oó]n|room)\s*#?\s*(\w+)/i) || text.match(/\b(\d{2,4})\b/);
    const number = numM ? numM[1] : null;
    if (!number) return { error: 'Indica el número de habitación a bloquear.' };
    const room = await prisma.room.findFirst({ where: { propertyId, number: String(number) } });
    if (!room) return { error: `No encontré la habitación ${number} en esta sede.` };
    return buildAction({
      type: 'room_block', requiredRole: 'MANAGER', user,
      payload: { propertyId, roomId: room.id, reason: reasonFrom(text) },
      title: `Bloquear habitación ${room.number}`,
      impact: [
        { label: 'Estado de la habitación', before: room.status, after: 'out_of_service' },
      ],
    });
  }

  return null; // no es una acción; el copiloto responderá como consulta
}

function reasonFrom(text) {
  const m = text.match(/(?:porque|por|motivo:?|razon:?|debido a)\s+(.{4,120})/i);
  return m ? m[1].trim() : null;
}
function estado(s) {
  return ({ tentative: 'tentativa', confirmed: 'confirmada', checked_in: 'en casa', checked_out: 'finalizada', cancelled: 'cancelada', no_show: 'no-show' })[s] || s;
}
function needCode(what) {
  return { error: `Para ${what} indícame el código de la reserva (formato ATR-2026-1234).` };
}
function buildAction({ type, requiredRole, user, payload, title, impact }) {
  const requiresApproval = !canApprove(user.role, requiredRole);
  return {
    action: { type, requiredRole, payload },
    preview: {
      title, impact, requiresApproval, requiredRole,
      note: requiresApproval
        ? `Tu rol ${user.role} no puede ejecutar esto directamente; se enviará a aprobación de ${requiredRole}.`
        : 'Revisa el impacto y confirma para ejecutar.',
    },
  };
}

// Ejecuta la acción confirmada por el humano. Si el usuario tiene autoridad, la
// aplica de inmediato; si no, la envía al motor de aprobaciones.
export async function runConfirmedAction({ user, propertyId, action }) {
  const { type, requiredRole = 'MANAGER', payload } = action || {};
  if (!type || !payload) throw new Error('Acción inválida');
  // Sólo tipos sensibles conocidos.
  if (!['discount', 'rate_override', 'reservation_no_deposit', 'cancellation', 'room_block'].includes(type)) {
    throw new Error('Acción no permitida por el copiloto');
  }
  if (canApprove(user.role, requiredRole)) {
    const result = await executeAction(type, payload);
    await audit({ propertyId, user, actor: 'ai', action: `copilot.executed.${type}`, entity: 'CopilotAction', reason: `Ejecutada por ${user.name} vía copiloto` });
    return { executed: true, result };
  }
  const approval = await requestApproval({
    propertyId, type,
    summary: `Solicitud del copiloto (${user.name}): ${type}`,
    payload, requiredRole, user, actor: 'ai',
  });
  return { executed: false, pendingApproval: approval };
}
