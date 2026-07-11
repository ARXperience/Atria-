// Cotización con noches, impuestos y anticipo (sección 10: cotizar reserva).
import { prisma } from '../db.js';
import { nightsBetween, money } from '../lib/util.js';

export async function buildQuote({ propertyId, roomTypeId, ratePlanId, checkIn, checkOut }) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  if (!property) throw new Error('Sede no encontrada');
  const roomType = await prisma.roomType.findUnique({ where: { id: roomTypeId } });
  if (!roomType || roomType.propertyId !== propertyId) throw new Error('Tipo de habitación inválido');

  let ratePlan = null;
  if (ratePlanId) {
    ratePlan = await prisma.ratePlan.findUnique({ where: { id: ratePlanId } });
    if (!ratePlan || ratePlan.roomTypeId !== roomTypeId) throw new Error('Plan tarifario inválido');
  }

  const nights = nightsBetween(checkIn, checkOut);
  if (nights < 1) throw new Error('El rango de fechas debe ser de al menos 1 noche');
  if (ratePlan && nights < ratePlan.minNights) {
    throw new Error(`El plan ${ratePlan.name} exige mínimo ${ratePlan.minNights} noches`);
  }

  const nightlyRate = ratePlan ? ratePlan.price : roomType.baseRate;
  const subtotal = money(nightlyRate * nights);
  const taxes = money(subtotal * property.taxRate);
  const total = subtotal + taxes;
  const depositPct = ratePlan ? ratePlan.depositPct : 0.5;
  const depositRequired = money(total * depositPct);

  return {
    propertyId, roomTypeId, ratePlanId: ratePlan?.id || null,
    roomTypeName: roomType.name, ratePlanName: ratePlan?.name || 'Tarifa estándar',
    checkIn, checkOut, nights, nightlyRate, subtotal, taxes, total,
    depositPct, depositRequired, currency: property.currency,
  };
}
