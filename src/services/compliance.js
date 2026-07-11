// Atria Compliance (secciones 17 y 18): TRA por reserva, detección de
// extranjeros para SIRE y verificación de completitud.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';

const TRA_REQUIRED = ['guestName', 'documentType', 'documentNumber', 'nationality', 'originCity'];

export function traMissingFields(record) {
  return TRA_REQUIRED.filter(f => !record[f] || String(record[f]).trim() === '');
}

export async function ensureTraForReservation(reservationId) {
  const reservation = await prisma.reservation.findUnique({ where: { id: reservationId }, include: { guest: true } });
  if (!reservation) throw new Error('Reserva no encontrada');

  let tra = await prisma.traRecord.findFirst({ where: { reservationId, isMainGuest: true } });
  if (!tra) {
    const data = {
      propertyId: reservation.propertyId,
      reservationId,
      guestName: reservation.guest.fullName,
      documentType: reservation.guest.documentType,
      documentNumber: reservation.guest.documentNumber,
      nationality: reservation.guest.nationality,
      isMainGuest: true,
    };
    const missing = traMissingFields(data);
    tra = await prisma.traRecord.create({
      data: { ...data, status: missing.length ? 'incomplete' : 'complete', missingFields: missing.join(',') || null },
    });
    emitEvent('tra.created', { propertyId: reservation.propertyId, reservationId, entityId: tra.id });
    if (missing.length) emitEvent('tra.missing_fields_detected', { propertyId: reservation.propertyId, reservationId, missing });
  }

  // Detección de extranjero → checklist SIRE (sección 18)
  const nat = (reservation.guest.nationality || 'CO').toUpperCase();
  const isForeign = nat && nat !== 'CO' && nat !== 'COLOMBIA' && nat !== 'COLOMBIANA';
  if (isForeign) {
    const existing = await prisma.sireReport.findFirst({ where: { reservationId } });
    if (!existing) {
      const report = await prisma.sireReport.create({
        data: {
          propertyId: reservation.propertyId, reservationId,
          guestName: reservation.guest.fullName, nationality: nat,
          documentType: reservation.guest.documentType, documentNumber: reservation.guest.documentNumber,
        },
      });
      emitEvent('foreign_guest.detected', { propertyId: reservation.propertyId, reservationId, entityId: report.id });
    }
  }
  return tra;
}

export async function updateTra(traId, data, { user = null } = {}) {
  const before = await prisma.traRecord.findUnique({ where: { id: traId } });
  if (!before) throw new Error('Registro TRA no encontrado');
  const merged = { ...before, ...data };
  const missing = traMissingFields(merged);
  const updated = await prisma.traRecord.update({
    where: { id: traId },
    data: { ...data, status: missing.length ? 'incomplete' : 'complete', missingFields: missing.join(',') || null },
  });
  await audit({ propertyId: before.propertyId, user, action: 'tra.updated', entity: 'TraRecord', entityId: traId, before, after: data });
  if (!missing.length && before.status === 'incomplete') {
    emitEvent('tra.completed', { propertyId: before.propertyId, entityId: traId });
  }
  return updated;
}

// Marcar SIRE reportado exige confirmación humana (sección 18)
export async function markSireStatus(reportId, { status, user, supportNote = null }) {
  const valid = ['pending', 'prepared', 'reported', 'error', 'not_applicable'];
  if (!valid.includes(status)) throw new Error(`Estado SIRE inválido: ${status}`);
  const before = await prisma.sireReport.findUnique({ where: { id: reportId } });
  if (!before) throw new Error('Reporte SIRE no encontrado');
  const updated = await prisma.sireReport.update({
    where: { id: reportId },
    data: {
      status, supportNote,
      reportedBy: status === 'reported' ? user?.name || null : before.reportedBy,
      reportedAt: status === 'reported' ? new Date() : before.reportedAt,
    },
  });
  await audit({ propertyId: before.propertyId, user, action: 'sire_report.status_changed', entity: 'SireReport', entityId: reportId, before: { status: before.status }, after: { status } });
  emitEvent('sire_report.marked_reported', { propertyId: before.propertyId, entityId: reportId, status });
  return updated;
}

// Panel de cumplimiento: pendientes RNT/TRA/SIRE (sección 39)
export async function complianceOverview(propertyId) {
  const property = await prisma.property.findUnique({ where: { id: propertyId } });
  const [traIncomplete, sirePending] = await Promise.all([
    prisma.traRecord.count({ where: { propertyId, status: 'incomplete' } }),
    prisma.sireReport.count({ where: { propertyId, status: { in: ['pending', 'prepared'] } } }),
  ]);
  const rntDaysLeft = property?.rntExpiresAt
    ? Math.ceil((property.rntExpiresAt - new Date()) / 86400000)
    : null;
  return {
    rnt: {
      number: property?.rnt || null,
      expiresAt: property?.rntExpiresAt || null,
      daysLeft: rntDaysLeft,
      alert: property?.rnt ? (rntDaysLeft !== null && rntDaysLeft < 45) : true,
    },
    tra: { incomplete: traIncomplete },
    sire: { pending: sirePending },
  };
}
