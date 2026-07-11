// Disponibilidad real: cruza habitaciones activas contra reservas vigentes
// y bloqueos por mantenimiento (secciones 10 y 11 del documento funcional).
import { prisma } from '../db.js';

const BLOCKING_STATUSES = ['tentative', 'confirmed', 'checked_in'];

export async function findAvailability({ propertyId, checkIn, checkOut, adults = 2, children = 0 }) {
  const pax = adults + children;

  const roomTypes = await prisma.roomType.findMany({
    where: { propertyId, active: true, capacity: { gte: pax } },
    include: {
      rooms: { where: { active: true, status: { not: 'out_of_service' } } },
      ratePlans: { where: { active: true } },
    },
  });

  // Reservas que se cruzan con el rango pedido
  const overlapping = await prisma.reservation.findMany({
    where: {
      propertyId,
      status: { in: BLOCKING_STATUSES },
      checkIn: { lt: checkOut },
      checkOut: { gt: checkIn },
    },
    select: { roomId: true, roomTypeId: true, holdExpiresAt: true, status: true },
  });

  const now = new Date();
  const active = overlapping.filter(r => !(r.status === 'tentative' && r.holdExpiresAt && r.holdExpiresAt < now));

  const results = [];
  for (const rt of roomTypes) {
    const busyRoomIds = new Set(active.filter(r => r.roomId).map(r => r.roomId));
    // Reservas sin habitación asignada consumen inventario del tipo
    const unassigned = active.filter(r => !r.roomId && r.roomTypeId === rt.id).length;
    const freeRooms = rt.rooms.filter(r => !busyRoomIds.has(r.id));
    const availableCount = Math.max(0, freeRooms.length - unassigned);
    if (availableCount > 0) {
      results.push({
        roomTypeId: rt.id,
        roomType: rt.name,
        code: rt.code,
        capacity: rt.capacity,
        description: rt.description,
        availableRooms: availableCount,
        freeRoomIds: freeRooms.map(r => r.id),
        ratePlans: rt.ratePlans.map(p => ({
          ratePlanId: p.id, name: p.name, code: p.code, price: p.price,
          refundable: p.refundable, minNights: p.minNights, depositPct: p.depositPct,
        })),
        baseRate: rt.baseRate,
      });
    }
  }
  return results;
}
