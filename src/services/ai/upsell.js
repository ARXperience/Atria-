// Upsell personalizado (§12/§41): a partir de la reserva, la disponibilidad real
// y la memoria del huésped, propone ofertas de mayor valor (upgrade de categoría,
// late/early check-in, experiencias) con su precio. Determinístico; captura la
// intención del huésped y avisa a recepción para materializarla.
import { prisma } from '../../db.js';
import { money, fmtCOP } from '../../lib/util.js';
import { findAvailability } from '../availability.js';
import { getGuestMemory } from './memory.js';
import { notify } from '../notifications.js';
import { emitEvent } from '../../lib/events.js';
import { audit } from '../../lib/audit.js';

// Complementos de estadía con precio por defecto (parametrizable a futuro).
const ADDONS = [
  { id: 'late_checkout', type: 'addon', title: 'Late check-out (hasta 3:00 pm)', detail: 'Sal sin prisa el último día de tu estadía.', price: 45000 },
  { id: 'early_checkin', type: 'addon', title: 'Early check-in (desde 11:00 am)', detail: 'Entra antes a tu habitación al llegar.', price: 45000 },
];

export async function upsellOffers(reservationId) {
  const r = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { guest: true } });
  if (!r) throw new Error('Reserva no encontrada');
  if (['cancelled', 'no_show', 'checked_out'].includes(r.status)) return { offers: [], returning: false };

  const currentType = await prisma.roomType.findUnique({ where: { id: r.roomTypeId } });
  const stays = await prisma.reservation.count({ where: { guestId: r.guestId, status: { in: ['confirmed', 'checked_in', 'checked_out'] }, id: { not: r.id } } });
  const returning = stays > 0;
  const memory = await getGuestMemory(r.guestId).catch(() => null);

  const offers = [];

  // 1) Upgrade de categoría: tipos superiores disponibles en las mismas fechas.
  try {
    const avail = await findAvailability({ propertyId: r.propertyId, checkIn: r.checkIn, checkOut: r.checkOut, adults: r.adults, children: r.children });
    const upgrades = [];
    for (const opt of avail) {
      if (opt.roomTypeId === r.roomTypeId || opt.availableRooms <= 0) continue;
      // Tarifa representativa = plan más económico disponible (no uno arbitrario).
      const optRate = opt.ratePlans?.length ? Math.min(...opt.ratePlans.map(p => p.price)) : opt.baseRate;
      if (optRate > r.nightlyRate) {
        const deltaPerNight = money(optRate - r.nightlyRate);
        upgrades.push({
          id: `upgrade:${opt.roomTypeId}`, type: 'upgrade', roomTypeId: opt.roomTypeId,
          title: `Sube a ${opt.roomType}`,
          detail: `${returning ? 'Como cliente que vuelve, ' : ''}disfruta una ${opt.roomType} por ${fmtCOP(deltaPerNight)}/noche adicional.`,
          deltaPerNight, price: money(deltaPerNight * r.nights),
        });
      }
    }
    upgrades.sort((a, b) => a.deltaPerNight - b.deltaPerNight); // el salto más pequeño primero (más fácil de aceptar)
    offers.push(...upgrades.slice(0, 2));
  } catch { /* disponibilidad opcional */ }

  // 2) Complementos de estadía.
  for (const a of ADDONS) offers.push({ ...a });

  // 3) Experiencia por estadía larga (personalización simple).
  if (r.nights >= 3) offers.push({ id: 'experience_late', type: 'experience', title: 'Cena romántica o spa', detail: 'Realza tu estadía con una experiencia; recepción coordina disponibilidad.', price: null });

  return {
    reservation: { code: r.code, roomType: currentType?.name, nights: r.nights },
    returning, guestPrefs: memory?.preferences || null, offers,
  };
}

// El huésped acepta una oferta: se registra la intención y se avisa a recepción
// para materializarla (upgrade/cargo se confirman con el proceso correspondiente).
export async function acceptUpsell(reservationId, offerId, { actor = 'human' } = {}) {
  const { offers, reservation } = await upsellOffers(reservationId);
  const offer = offers.find(o => o.id === offerId);
  if (!offer) throw new Error('Oferta no disponible');
  const r = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { guest: true, room: true } });
  const priceText = offer.price != null ? ` (${fmtCOP(offer.price)})` : '';
  const req = await prisma.guestRequest.create({
    data: { propertyId: r.propertyId, reservationId: r.id, guestName: r.guest.fullName, roomNumber: r.room?.number || null, type: 'other', detail: `Upsell aceptado: ${offer.title}${priceText}`, channel: 'portal' },
  });
  await notify({ propertyId: r.propertyId, audienceRole: 'FRONTDESK', severity: 'info', title: `Upsell aceptado · ${reservation.code}`, body: `${r.guest.fullName} aceptó: ${offer.title}${priceText}. Confirmar y aplicar.`, entity: 'GuestRequest', entityId: req.id });
  await audit({ propertyId: r.propertyId, actor, action: 'upsell.accepted', entity: 'Reservation', entityId: r.id, after: { offer: offer.id, price: offer.price } });
  emitEvent('upsell.accepted', { propertyId: r.propertyId, reservationId: r.id, entityId: req.id });
  return { accepted: true, offer: offer.title, requestId: req.id };
}
