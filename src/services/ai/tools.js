// IA-3 · Herramientas que el agente puede ejecutar (function-calling), con
// ámbito por perfil (§55.6/§55.7). Cada herramienta valida y audita; las
// acciones sensibles nunca están disponibles para el agente externo.
import { findAvailability } from '../availability.js';
import { buildQuote } from '../quote.js';
import { createTentativeReservation } from '../reservations.js';
import { createPaymentLink } from '../payments.js';
import { knowledgeSnapshot } from '../knowledge.js';
import { orderRoomServiceByName } from '../pos.js';
import { notify } from '../notifications.js';
import { parseDay, dayStr, fmtCOP } from '../../lib/util.js';
import { audit } from '../../lib/audit.js';

// Construye el catálogo de herramientas permitidas para un agente/contexto.
export function buildTools({ propertyId, profile, conversation }) {
  const all = {
    buscar_disponibilidad: {
      description: 'Consulta habitaciones disponibles entre dos fechas para cierto número de personas.',
      input_schema: {
        type: 'object',
        properties: {
          checkIn: { type: 'string', description: 'Fecha de llegada YYYY-MM-DD' },
          checkOut: { type: 'string', description: 'Fecha de salida YYYY-MM-DD' },
          adults: { type: 'number' }, children: { type: 'number' },
        },
        required: ['checkIn', 'checkOut'],
      },
      async run({ checkIn, checkOut, adults = 2, children = 0 }) {
        const ci = parseDay(checkIn), co = parseDay(checkOut);
        if (!ci || !co || co <= ci) return { error: 'Fechas inválidas' };
        const opts = await findAvailability({ propertyId, checkIn: ci, checkOut: co, adults, children });
        return {
          available: opts.map(o => ({ roomTypeId: o.roomTypeId, tipo: o.roomType, disponibles: o.availableRooms, desde: o.ratePlans[0]?.price ?? o.baseRate, ratePlanId: o.ratePlans[0]?.ratePlanId || null })),
        };
      },
    },
    cotizar: {
      description: 'Calcula el precio total (con impuestos y anticipo) de un tipo de habitación en unas fechas.',
      input_schema: {
        type: 'object',
        properties: { roomTypeId: { type: 'string' }, ratePlanId: { type: 'string' }, checkIn: { type: 'string' }, checkOut: { type: 'string' } },
        required: ['roomTypeId', 'checkIn', 'checkOut'],
      },
      async run({ roomTypeId, ratePlanId, checkIn, checkOut }) {
        const q = await buildQuote({ propertyId, roomTypeId, ratePlanId: ratePlanId || null, checkIn: parseDay(checkIn), checkOut: parseDay(checkOut) });
        return { tipo: q.roomTypeName, noches: q.nights, total: q.total, totalTexto: fmtCOP(q.total), anticipo: q.depositRequired };
      },
    },
    crear_reserva: {
      description: 'Crea una reserva tentativa (bloqueo temporal) y genera el link de pago del anticipo. Requiere nombre del huésped.',
      input_schema: {
        type: 'object',
        properties: {
          roomTypeId: { type: 'string' }, ratePlanId: { type: 'string' },
          checkIn: { type: 'string' }, checkOut: { type: 'string' },
          adults: { type: 'number' }, children: { type: 'number' }, guestName: { type: 'string' },
        },
        required: ['roomTypeId', 'checkIn', 'checkOut', 'guestName'],
      },
      async run({ roomTypeId, ratePlanId, checkIn, checkOut, adults = 2, children = 0, guestName }) {
        const reservation = await createTentativeReservation({
          propertyId, guest: { fullName: guestName, phone: conversation?.contactPhone || null },
          roomTypeId, ratePlanId: ratePlanId || null,
          checkIn: parseDay(checkIn), checkOut: parseDay(checkOut), adults, children,
          channel: conversation?.channel || 'whatsapp', createdBy: 'ai', actor: 'ai',
        });
        const link = await createPaymentLink({ propertyId, reservationId: reservation.id, concept: `Anticipo reserva ${reservation.code}`, amount: reservation.depositRequired, createdBy: 'ai' });
        await audit({ propertyId, actor: 'ai', action: 'ai.action_executed', entity: 'Reservation', entityId: reservation.id, after: { code: reservation.code, tool: 'crear_reserva' } });
        return { codigo: reservation.code, total: fmtCOP(reservation.total), anticipo: fmtCOP(reservation.depositRequired), linkPago: link.url, vence: dayStr(reservation.holdExpiresAt) };
      },
    },
    datos_hotel: {
      description: 'Devuelve datos generales del hotel: servicios, ubicación, horarios, FAQs y políticas.',
      input_schema: { type: 'object', properties: { tema: { type: 'string', description: 'palabra clave opcional' } } },
      async run() {
        const snap = await knowledgeSnapshot(propertyId, { visibility: profile.knowledgeScope });
        return { hotel: snap.hotel, servicios: snap.knowledge, politicas: snap.policies };
      },
    },
    datos_habitacion: {
      description: 'Devuelve el detalle de las habitaciones: descripción, camas, vista, amenidades y precio desde.',
      input_schema: { type: 'object', properties: {} },
      async run() {
        const snap = await knowledgeSnapshot(propertyId, { visibility: profile.knowledgeScope });
        return { habitaciones: snap.rooms.map(r => ({ tipo: r.name, capacidad: r.capacity, desde: r.fromPrice, camas: r.bedConfig, vista: r.view, incluye: r.features, descripcion: r.longDescription || r.description })) };
      },
    },
    notificar_equipo: {
      description: 'Envía una notificación interna al equipo del hotel (p.ej. una solicitud especial del huésped).',
      input_schema: { type: 'object', properties: { mensaje: { type: 'string' }, area: { type: 'string', description: 'FRONTDESK|HOUSEKEEPING|MAINTENANCE|MANAGER' } }, required: ['mensaje'] },
      async run({ mensaje, area = 'FRONTDESK' }) {
        await notify({ propertyId, audienceRole: area, severity: 'info', title: 'Solicitud vía agente IA', body: mensaje });
        return { ok: true };
      },
    },
    pedir_room_service: {
      description: 'Toma un pedido de room service de la carta para un huésped EN ESTADÍA y lo carga a su habitación. Usa los nombres de los platos tal como los dice el huésped. Si no está identificado, pide el código de reserva (ATR-…).',
      input_schema: {
        type: 'object',
        properties: {
          reservationCode: { type: 'string', description: 'Código de la reserva del huésped, opcional si ya está identificado' },
          items: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, qty: { type: 'number' } }, required: ['name'] } },
        },
        required: ['items'],
      },
      async run({ reservationCode, items }) {
        try {
          const r = await orderRoomServiceByName({ propertyId, reservationCode: reservationCode || null, contactPhone: conversation?.contactPhone || null, items });
          await audit({ propertyId, actor: 'ai', action: 'ai.action_executed', entity: 'PosOrder', after: { tool: 'pedir_room_service', reserva: r.code } });
          await notify({ propertyId, audienceRole: 'FRONTDESK', severity: 'info', title: `Room service · ${r.code}`, body: `Pedido por el agente: ${r.pedido.join(', ')}.` });
          return r;
        } catch (err) { return { error: err.message }; }
      },
    },
  };

  // Filtrar por herramientas habilitadas en el perfil
  const enabled = profile.enabledTools === '*' ? Object.keys(all) : profile.enabledTools.split(',').map(s => s.trim());
  const tools = {};
  for (const name of enabled) if (all[name]) tools[name] = all[name];
  return tools;
}

// Formato de definiciones para la API de Anthropic (tool use).
export function toolDefsForLLM(tools) {
  return Object.entries(tools).map(([name, t]) => ({ name, description: t.description, input_schema: t.input_schema }));
}
