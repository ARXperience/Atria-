// Atria IA — Asistente externo para huéspedes (secciones 5, 13 y 48.1).
// Flujo completo: intención → fechas/personas → disponibilidad → cotización →
// reserva tentativa → link de pago. Escala a humano en quejas/excepciones.
// Funciona 100% determinístico; si hay ANTHROPIC_API_KEY, Claude refuerza la
// extracción de entidades en mensajes ambiguos.
import { prisma } from '../../db.js';
import { extractDates, extractGuests } from './dates.js';
import { llmAvailable, llmExtractBooking, llmComplete, llmToolLoop } from './claude.js';
import { findAvailability } from '../availability.js';
import { buildQuote } from '../quote.js';
import { createTentativeReservation } from '../reservations.js';
import { createPaymentLink } from '../payments.js';
import { getContext, setContext, setHumanTakeover } from '../inbox.js';
import { getAgentProfile, buildSystemPrompt } from './agentProfile.js';
import { knowledgeSnapshot } from '../knowledge.js';
import { searchKnowledge, looksLikeQuestion } from './retrieval.js';
import { buildTools, toolDefsForLLM } from './tools.js';
import { guestRecall, summarizeConversation, saveConversationSummary, updateGuestMemory } from './memory.js';
import { fmtCOP, dayStr, parseDay, nightsBetween } from '../../lib/util.js';
import { audit } from '../../lib/audit.js';
import { notify } from '../notifications.js';
import { logger } from '../../lib/logger.js';

const ESCALATION = /\b(queja|reclamo|reembolso|devoluci[oó]n|demanda|abogado|p[eé]simo|horrible|indignad|estafa|hablar con (un |una )?(humano|persona|asesor|agente|recepci[oó]n)|asesor humano)\b/i;
const GREETING = /^(hola|buenas|buenos d[ií]as|buenas tardes|buenas noches|hey|hi|hello|saludos)[\s!.,]*$/i;
// El cliente pregunta qué puede hacer el asistente → se listan las capacidades.
const CAPABILITIES = /\b(qu[eé] (puedes|sabes|pod[eé]s) hacer|en qu[eé] (me )?(puedes |pod[eé]s )?ayud|ayuda(rme)?|opciones|men[uú]|para qu[eé] sirves|qu[eé] mas puedes|qu[eé] más puedes)\b/i;
// Solicitudes de servicio/agenda (no-alojamiento): requieren un verbo de acción
// junto a un servicio, para no confundir preguntas informativas ("¿tienen spa?").
const SERVICE_REQUEST = /\b(agenda|agendar|ag[eé]ndame|coordina|coordinar|solic|pedir|reserv|quiero|quisiera|necesito|me gustar[ií]a|podr[ií]an?)\b[\s\S]{0,40}\b(transporte|traslado|taxi|recogida|aeropuerto|late ?check|check.?out tarde|early ?check|spa|masaje|tour|paseo|excursi[oó]n|decoraci[oó]n|celebraci[oó]n|cumplea[nñ]os|anivers|cuna|toallas?|almohadas?|amenit|room ?service|servicio a la habitaci[oó]n|una mesa|cena rom[aá]ntica|evento|sal[oó]n de eventos|reuni[oó]n)\b/i;

function capabilitiesMessage(propertyName) {
  return `Puedo ayudarte con todo esto aquí mismo por el chat 💬:\n`
    + `🛏️ *Reservar* — busco disponibilidad, te cotizo con impuestos incluidos y creo tu reserva con link de pago.\n`
    + `🧳 *Agendar y coordinar* — late check-out, transporte al aeropuerto, spa, tour, una cena o un evento: lo dejo listo con el equipo.\n`
    + `🍽️ *Room service* — si ya estás con nosotros, tomo tu pedido y lo cargo a tu habitación.\n`
    + `📍 *Información* — habitaciones, servicios, ubicación y políticas de *${propertyName}*.\n`
    + `🙋 *Hablar con una persona* cuando lo prefieras.\n\n`
    + `¿Con qué empezamos? 😊`;
}
const CONFIRM = /\b(s[ií]|confirmo|confirmar|dale|listo|ok|okay|de acuerdo|acepto|reservar|res[eé]rvala|hazla|perfecto|claro)\b/i;
const CANCEL_FLOW = /\b(cancelar|ya no|olv[ií]dalo|no gracias|d[eé]jalo as[ií])\b/i;
const ASK_LOCATION = /\b(ubicaci[oó]n|direcci[oó]n|d[oó]nde (est[aá]n?|queda)|como llegar|cómo llegar)\b/i;
const ASK_CHECKIN = /\b(hora.*(check.?in|entrada|llegada)|check.?in.*hora|a qu[eé] hora)\b/i;
const BOOKING_HINT = /\b(reserv|habitaci[oó]n|disponib|cotiz|precio|tarifa|cu[aá]nto (vale|cuesta)|hospeda|alojar|noche)/i;

function pickOption(text, options) {
  const t = text.toLowerCase().trim();
  const num = t.match(/(?:^|\b(?:opci[oó]n|la|el|n[uú]mero)\s*)(\d)\b/);
  if (num) {
    const i = +num[1] - 1;
    if (options[i]) return options[i];
  }
  for (const opt of options) {
    if (t.includes(opt.roomType.toLowerCase())) return opt;
  }
  return null;
}

function looksLikeName(text) {
  const t = text.trim().replace(/^me llamo\s+|^soy\s+|^mi nombre es\s+/i, '');
  if (!/^[a-záéíóúñü]+(\s+[a-záéíóúñü]+){1,4}$/i.test(t)) return null;
  return t.split(/\s+/).map(w => w[0].toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

async function propertyInfo(propertyId) {
  return prisma.property.findUnique({ where: { id: propertyId } });
}

/**
 * Procesa un mensaje entrante y devuelve la(s) respuesta(s) del asistente.
 * No envía nada: el llamador (inbox/whatsapp/webchat) decide el canal.
 */
export async function assistantReply({ propertyId, conversation, text }) {
  const ctx = await getContext(conversation);
  const property = await propertyInfo(propertyId);
  const profile = await getAgentProfile(propertyId, 'guest');
  const replies = [];
  const say = r => replies.push(r);

  // Conocimiento del hotel (habitaciones + FAQs + políticas) para este agente.
  let snapshot = null;
  const getSnapshot = async () => (snapshot ||= await knowledgeSnapshot(propertyId, { visibility: profile.knowledgeScope }));

  try {
    // 1) Escalamiento a humano con resumen (§13 + §55.8: la persona recibe contexto)
    if (ESCALATION.test(text)) {
      const summary = await summarizeConversation(conversation.id, { reason: text });
      await saveConversationSummary(conversation.id, summary);
      await setHumanTakeover(conversation.id, { enabled: true, reason: summary });
      say('Entiendo, ya mismo te comunico con una persona de nuestro equipo. En un momento te atienden. 🙏');
      await persist(conversation.id, ctx, 'escalated');
      return finish(replies, conversation, text, 'escalation');
    }

    // 1b) Si el agente tiene LLM y hay API key: conversación natural con
    // control de herramientas (IA-3/§55.6). Si falla, cae al motor determinístico.
    if (profile.llmEnabled && llmAvailable()) {
      const handled = await runLlmAgent({ propertyId, profile, conversation, text, getSnapshot, say });
      if (handled) return finish(replies, conversation, text, 'llm_agent');
    }

    // 2) Captura de nombre pendiente para crear la reserva
    if (ctx.state === 'awaiting_name') {
      const name = looksLikeName(text);
      if (name) {
        ctx.guestName = name;
        return await createBookingAndLink({ propertyId, conversation, ctx, property, say, replies, text });
      }
      say('Para completar la reserva necesito tu nombre completo, por favor. 😊');
      return finish(replies, conversation, text, 'awaiting_name');
    }

    // 3) Extraer fechas y huéspedes del mensaje (determinístico + LLM opcional)
    const dates = extractDates(text);
    const guests = extractGuests(text);
    if (dates?.checkIn) ctx.checkIn = dayStr(dates.checkIn);
    if (dates?.checkOut) ctx.checkOut = dayStr(dates.checkOut);
    if (guests.adults) ctx.adults = guests.adults;
    if (guests.children) ctx.children = guests.children;

    if (!dates && llmAvailable() && BOOKING_HINT.test(text)) {
      const ext = await llmExtractBooking(text);
      if (ext?.checkIn && !ctx.checkIn) ctx.checkIn = ext.checkIn;
      if (ext?.checkOut && !ctx.checkOut) ctx.checkOut = ext.checkOut;
      if (ext?.adults && !ctx.adults) ctx.adults = ext.adults;
      if (ext?.name && !ctx.guestName) ctx.guestName = ext.name;
    }

    // 4) Cancelar flujo en curso
    if (CANCEL_FLOW.test(text) && ctx.state && ctx.state !== 'idle') {
      await setContext(conversation.id, {});
      say('Listo, no hay problema. Si quieres retomar la reserva o consultar algo más, aquí estoy. 😊');
      return finish(replies, conversation, text, 'cancelled_flow');
    }

    // 5) Selección de opción cuando ya se ofrecieron habitaciones
    if (ctx.state === 'offered' && Array.isArray(ctx.options) && ctx.options.length) {
      const chosen = pickOption(text, ctx.options);
      if (chosen) {
        const quote = await buildQuote({
          propertyId, roomTypeId: chosen.roomTypeId, ratePlanId: chosen.ratePlanId || null,
          checkIn: parseDay(ctx.checkIn), checkOut: parseDay(ctx.checkOut),
        });
        ctx.selected = { roomTypeId: chosen.roomTypeId, ratePlanId: chosen.ratePlanId || null };
        ctx.quote = { total: quote.total, deposit: quote.depositRequired, nights: quote.nights };
        ctx.state = 'quoted';
        say(`Excelente elección: *${quote.roomTypeName}* 🛏️\n\n📅 ${ctx.checkIn} → ${ctx.checkOut} (${quote.nights} noche${quote.nights > 1 ? 's' : ''})\n💵 Tarifa: ${fmtCOP(quote.nightlyRate)}/noche\n🧾 Subtotal: ${fmtCOP(quote.subtotal)} + impuestos ${fmtCOP(quote.taxes)}\n*Total: ${fmtCOP(quote.total)}*\n\nPara confirmar se requiere un anticipo de ${fmtCOP(quote.depositRequired)}. ¿Confirmo la reserva? (sí/no)`);
        return finish(replies, conversation, text, 'quote_presented');
      }
    }

    // 6) Confirmación de cotización → crear reserva
    if (ctx.state === 'quoted' && CONFIRM.test(text)) {
      if (!ctx.guestName) {
        const knownName = conversation.contactName && looksLikeName(conversation.contactName);
        if (knownName) ctx.guestName = knownName;
      }
      if (!ctx.guestName) {
        ctx.state = 'awaiting_name';
        say('¡Perfecto! Para crear la reserva, ¿me regalas tu nombre completo?');
        return finish(replies, conversation, text, 'ask_name');
      }
      return await createBookingAndLink({ propertyId, conversation, ctx, property, say, replies, text });
    }

    // 7) Si hay fechas → buscar disponibilidad y ofrecer opciones
    if (ctx.checkIn && ctx.checkOut) {
      if (!ctx.adults) {
        ctx.state = 'need_guests';
        say(`¡Claro! Para el ${ctx.checkIn} al ${ctx.checkOut}, ¿para cuántas personas sería la reserva?`);
        return finish(replies, conversation, text, 'ask_guests');
      }
      const ci = parseDay(ctx.checkIn), co = parseDay(ctx.checkOut);
      if (nightsBetween(ci, co) < 1) {
        ctx.checkOut = null;
        say('La fecha de salida debe ser posterior a la de llegada. ¿Hasta qué día te quedarías?');
        return finish(replies, conversation, text, 'bad_dates');
      }
      const availability = await findAvailability({ propertyId, checkIn: ci, checkOut: co, adults: ctx.adults, children: ctx.children || 0 });
      if (!availability.length) {
        ctx.state = 'idle';
        say(`Lo siento, no tenemos disponibilidad del ${ctx.checkIn} al ${ctx.checkOut} para ${ctx.adults} persona(s). 😔 ¿Quieres que revise otras fechas?`);
        await ensureLead({ propertyId, conversation, ctx, stage: 'lost', lostReason: 'sin disponibilidad' });
        return finish(replies, conversation, text, 'no_availability');
      }
      const options = availability.slice(0, 3).map(a => {
        const plan = a.ratePlans[0] || null;
        return {
          roomTypeId: a.roomTypeId, roomType: a.roomType,
          ratePlanId: plan?.ratePlanId || null,
          price: plan?.price ?? a.baseRate, capacity: a.capacity,
        };
      });
      ctx.options = options;
      ctx.state = 'offered';
      const lines = options.map((o, i) => `*${i + 1}. ${o.roomType}* — ${fmtCOP(o.price)}/noche (hasta ${o.capacity} personas)`);
      say(`¡Tenemos disponibilidad del ${ctx.checkIn} al ${ctx.checkOut} para ${ctx.adults} persona(s)! 🎉\n\n${lines.join('\n')}\n\nResponde con el número de la opción que prefieras y te paso la cotización completa.`);
      await ensureLead({ propertyId, conversation, ctx, stage: 'qualified' });
      return finish(replies, conversation, text, 'options_offered');
    }

    // 8) Preguntas frecuentes
    if (ASK_LOCATION.test(text)) {
      say(`📍 Estamos ubicados en ${property.address || 'nuestra sede principal'}, ${property.city || ''}. ¿Te gustaría reservar o necesitas algo más?`);
      return finish(replies, conversation, text, 'faq_location');
    }
    if (ASK_CHECKIN.test(text)) {
      say(`🕒 El check-in es a partir de las ${property.checkInTime} y el check-out hasta las ${property.checkOutTime}. ¿Te ayudo con una reserva?`);
      return finish(replies, conversation, text, 'faq_checkin');
    }

    // 8b) Respuesta con conocimiento del hotel (habitaciones, servicios, FAQs).
    // Solo para preguntas informativas, sin secuestrar el flujo de reserva.
    if (looksLikeQuestion(text)) {
      const hit = searchKnowledge(await getSnapshot(), text);
      if (hit) {
        say(`${hit.answer}${profile.scope === 'guest' ? '\n\n¿Te ayudo con una reserva o algo más? 😊' : ''}`);
        return finish(replies, conversation, text, 'knowledge_answer');
      }
    }

    // 8b) El cliente pregunta qué puede hacer → listamos capacidades (incluye agendar).
    if (CAPABILITIES.test(text)) {
      say(capabilitiesMessage(property.name));
      return finish(replies, conversation, text, 'capabilities');
    }

    // 8c) Solicitud de servicio/agenda (no-alojamiento) → se coordina con el equipo.
    if (SERVICE_REQUEST.test(text)) {
      await notify({ propertyId, audienceRole: 'FRONTDESK', severity: 'info', title: 'Solicitud vía asistente IA', body: text.slice(0, 400) });
      await audit({ propertyId, actor: 'ai', action: 'ai.request_scheduled', entity: 'Conversation', entityId: conversation.id, after: { text: text.slice(0, 200) } });
      say('¡Listo! 📝 Tomé tu solicitud y la dejé coordinada con nuestro equipo; te contactarán para confirmar los detalles. ¿Te ayudo con algo más — una reserva, precios o información del hotel?');
      return finish(replies, conversation, text, 'service_request');
    }

    // 9) Intención de reserva sin fechas → pedirlas
    if (BOOKING_HINT.test(text)) {
      ctx.state = 'need_dates';
      say('¡Con gusto te ayudo con tu reserva! 🏨 ¿Para qué fechas te gustaría hospedarte y para cuántas personas? (por ejemplo: "del 20 al 23 de diciembre para 2 adultos")');
      await ensureLead({ propertyId, conversation, ctx, stage: 'new' });
      return finish(replies, conversation, text, 'ask_dates');
    }

    // 10) Saludo / fallback (persona del hotel + memoria de huésped recurrente)
    if (GREETING.test(text)) {
      const recall = await guestRecall({ propertyId, phone: conversation.contactPhone });
      if (recall?.isReturning) {
        const first = recall.guest.fullName.split(' ')[0];
        say(`¡Hola de nuevo, ${first}! 👋 Qué gusto tenerte otra vez con nosotros en *${property.name}*. ¿Te ayudo con una nueva reserva o con algo de tu estadía?`);
        return finish(replies, conversation, text, 'greeting_returning');
      }
      const name = profile.displayName || 'Atria';
      say(profile.greeting
        || `¡Hola! 👋 Bienvenido(a) a *${property.name}*. Soy ${name}, tu asistente virtual. Puedo reservar por ti, agendar servicios (transporte, spa, late check-out, eventos), pedir room service y resolver tus dudas — todo por aquí. ¿En qué te ayudo? Si buscas hospedarte, dime las fechas. 😊`);
      return finish(replies, conversation, text, 'greeting');
    }

    // 10b) Guardrail de dominio: si no matchea nada del hotel y el agente es
    // "solo dominio", redirige amablemente (no responde temas ajenos).
    {
      const hit = searchKnowledge(await getSnapshot(), text);
      if (hit) {
        say(hit.answer);
        return finish(replies, conversation, text, 'knowledge_answer');
      }
    }

    // Fallback: menú guiado con la identidad del hotel (incluye agendar servicios)
    say(`Puedo ayudarte con:\n1️⃣ Consultar disponibilidad y *reservar*\n2️⃣ *Agendar servicios*: transporte, spa, late check-out, una cena o un evento\n3️⃣ *Room service* si ya estás con nosotros\n4️⃣ Información de *${property.name}* (habitaciones, servicios, ubicación)\n5️⃣ Hablar con una persona\n\nCuéntame, ¿qué necesitas? Si es una reserva, dime las fechas y número de personas. 😊`);
    return finish(replies, conversation, text, 'fallback');
  } catch (err) {
    logger.error({ err }, 'assistant error');
    say('Ups, tuve un inconveniente procesando tu mensaje. Ya notifiqué a nuestro equipo; también puedes escribir "asesor" para hablar con una persona.');
    return finish(replies, conversation, text, 'error');
  }

  async function persist(conversationId, context, state) {
    if (state) context.state = context.state || state;
    await setContext(conversationId, context);
  }

  async function finish(replies, conversation, text, intent) {
    await setContext(conversation.id, ctx);
    return { replies, intent };
  }
}

// IA-3 · Agente natural con control de herramientas. Devuelve true si respondió.
async function runLlmAgent({ propertyId, profile, conversation, text, getSnapshot, say }) {
  try {
    const snapshot = await getSnapshot();
    const system = buildSystemPrompt(profile, snapshot);
    const tools = buildTools({ propertyId, profile, conversation });
    const toolDefs = toolDefsForLLM(tools);

    // Historial reciente para continuidad conversacional
    const history = await prisma.message.findMany({
      where: { conversationId: conversation.id },
      orderBy: { createdAt: 'desc' }, take: 10,
    });
    const messages = history.reverse().map(m => ({
      role: m.direction === 'in' ? 'user' : 'assistant',
      content: m.body,
    }));
    if (!messages.length || messages[messages.length - 1].content !== text) {
      messages.push({ role: 'user', content: text });
    }

    const reply = await llmToolLoop({ system, messages, tools, toolDefs });
    if (reply) { say(reply); return true; }
  } catch (err) {
    logger.warn({ err }, 'llm agent failed, falling back to deterministic');
  }
  return false;
}

async function createBookingAndLink({ propertyId, conversation, ctx, property, say, replies, text }) {
  const reservation = await createTentativeReservation({
    propertyId,
    guest: { fullName: ctx.guestName, phone: conversation.contactPhone || null },
    roomTypeId: ctx.selected.roomTypeId,
    ratePlanId: ctx.selected.ratePlanId,
    checkIn: parseDay(ctx.checkIn),
    checkOut: parseDay(ctx.checkOut),
    adults: ctx.adults || 2,
    children: ctx.children || 0,
    channel: conversation.channel,
    createdBy: 'ai',
    actor: 'ai',
  });
  const link = await createPaymentLink({
    propertyId, reservationId: reservation.id,
    concept: `Anticipo reserva ${reservation.code}`,
    amount: reservation.depositRequired,
    createdBy: 'ai',
  });
  await audit({ propertyId, actor: 'ai', action: 'ai.action_executed', entity: 'Reservation', entityId: reservation.id, after: { code: reservation.code, via: conversation.channel } });

  // Memoria del huésped (IA-5): recuerda su última intención de viaje.
  await updateGuestMemory(reservation.guestId, {
    lastTravel: { checkIn: ctx.checkIn, checkOut: ctx.checkOut, adults: ctx.adults || 2 },
    lastChannel: conversation.channel,
  }).catch(() => {});

  ctx.state = 'awaiting_payment';
  ctx.reservationId = reservation.id;
  await ensureLead({ propertyId, conversation, ctx, stage: 'quoted' });

  say(`¡Listo, ${ctx.guestName.split(' ')[0]}! 🎉 Creé tu reserva *${reservation.code}* (pendiente de pago):\n\n📅 ${ctx.checkIn} → ${ctx.checkOut}\n💰 Total: ${fmtCOP(reservation.total)}\n💳 Anticipo para confirmar: ${fmtCOP(reservation.depositRequired)}\n\nPaga aquí de forma segura:\n${link.url}\n\n⏳ El cupo queda bloqueado por ${Math.round((reservation.holdExpiresAt - Date.now()) / 3600000)} horas. Al recibir el pago te envío el voucher de confirmación. ✨`);
  await setContext(conversation.id, ctx);
  return { replies, intent: 'reservation_created' };
}

async function ensureLead({ propertyId, conversation, ctx, stage = 'new', lostReason = null }) {
  try {
    let lead = ctx.leadId ? await prisma.lead.findUnique({ where: { id: ctx.leadId } }) : null;
    if (!lead) {
      lead = await prisma.lead.findFirst({
        where: { propertyId, phone: conversation.contactPhone || undefined, stage: { notIn: ['won', 'lost'] } },
        orderBy: { createdAt: 'desc' },
      });
    }
    const data = {
      name: ctx.guestName || conversation.contactName || null,
      phone: conversation.contactPhone || null,
      channel: conversation.channel,
      intent: 'reserva',
      checkIn: ctx.checkIn ? parseDay(ctx.checkIn) : null,
      checkOut: ctx.checkOut ? parseDay(ctx.checkOut) : null,
      adults: ctx.adults || null,
      stage, lostReason,
      score: stage === 'quoted' ? 80 : stage === 'qualified' ? 60 : 30,
    };
    if (lead) {
      lead = await prisma.lead.update({ where: { id: lead.id }, data });
    } else {
      lead = await prisma.lead.create({ data: { propertyId, ...data } });
    }
    ctx.leadId = lead.id;
  } catch (err) {
    logger.warn({ err }, 'lead upsert failed');
  }
}
