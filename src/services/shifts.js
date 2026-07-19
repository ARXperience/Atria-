// Turnos y asistencia (§21). Planea cuadrantes y registra marcación; al cerrar
// la asistencia calcula horas, recargo nocturno y horas extra, y crea novedades
// (pendientes de aprobación) que alimentan la nómina.
import { prisma } from '../db.js';
import { getParam } from './payroll.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { parseDay } from '../lib/util.js';

// Horas nocturnas dentro de un intervalo (ventana parametrizable, def. 21:00–06:00).
function nightHoursBetween(start, end, nightStart = 21, nightEnd = 6) {
  let mins = 0;
  for (let t = start.getTime(); t < end.getTime(); t += 60000) {
    const h = new Date(t).getUTCHours();
    if (h >= nightStart || h < nightEnd) mins++;
  }
  return Math.round((mins / 60) * 100) / 100;
}

export async function createShift({ propertyId, employeeId, date, startTime, endTime, area, notes, createdBy }) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp || emp.propertyId !== propertyId) throw new Error('Empleado inválido');
  const shift = await prisma.shiftAssignment.create({
    data: { propertyId, employeeId, date: parseDay(date), startTime, endTime, area, notes, createdBy },
  });
  await audit({ propertyId, action: 'shift.assigned', entity: 'ShiftAssignment', entityId: shift.id, after: { employee: emp.fullName, date, startTime, endTime } });
  emitEvent('shift.assigned', { propertyId, entityId: shift.id });
  return shift;
}

export async function clockIn({ propertyId, employeeId, at = null, source = 'panel' }) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp || emp.propertyId !== propertyId) throw new Error('Empleado inválido');
  const when = at ? new Date(at) : new Date();
  const open = await prisma.attendanceRecord.findFirst({ where: { employeeId, clockOut: null } });
  if (open) throw new Error('El empleado ya tiene una marcación de entrada abierta');
  const rec = await prisma.attendanceRecord.create({
    data: { propertyId, employeeId, date: parseDay(when.toISOString().slice(0, 10)), clockIn: when, source },
  });
  await audit({ propertyId, action: 'attendance.clocked', entity: 'AttendanceRecord', entityId: rec.id, after: { type: 'in', employee: emp.fullName } });
  emitEvent('attendance.clocked', { propertyId, entityId: rec.id });
  return rec;
}

export async function clockOut({ propertyId, employeeId, at = null }) {
  const emp = await prisma.employee.findUnique({ where: { id: employeeId } });
  if (!emp || emp.propertyId !== propertyId) throw new Error('Empleado inválido');
  const rec = await prisma.attendanceRecord.findFirst({ where: { employeeId, clockOut: null }, orderBy: { clockIn: 'desc' } });
  if (!rec) throw new Error('No hay marcación de entrada abierta para este empleado');
  const out = at ? new Date(at) : new Date();
  if (out <= rec.clockIn) throw new Error('La salida debe ser posterior a la entrada');

  const hours = Math.round(((out - rec.clockIn) / 3600000) * 100) / 100;
  const nStart = await getParam(emp.companyId, 'NIGHT_START', out, 21);
  const nEnd = await getParam(emp.companyId, 'NIGHT_END', out, 6);
  const night = nightHoursBetween(rec.clockIn, out, nStart, nEnd);
  const stdDaily = await getParam(emp.companyId, 'STD_DAILY_HOURS', out, 8);
  const overtime = Math.max(0, Math.round((hours - stdDaily) * 100) / 100);

  const updated = await prisma.attendanceRecord.update({
    where: { id: rec.id },
    data: { clockOut: out, hoursWorked: hours, nightHours: night, overtimeHours: overtime },
  });

  // Novedades automáticas (pendientes de aprobación) hacia la nómina
  const created = [];
  if (night > 0) {
    const n = await prisma.payrollNovelty.create({ data: { propertyId, employeeId, type: 'night_surcharge', date: rec.date, hours: night, notes: `Recargo nocturno automático (asistencia ${updated.id})` } });
    created.push(n.id);
  }
  if (overtime > 0) {
    const n = await prisma.payrollNovelty.create({ data: { propertyId, employeeId, type: 'overtime_day', date: rec.date, hours: overtime, notes: `Hora extra automática (asistencia ${updated.id})` } });
    created.push(n.id);
  }
  await audit({ propertyId, action: 'attendance.closed', entity: 'AttendanceRecord', entityId: rec.id, after: { hours, night, overtime, novelties: created.length } });
  if (overtime > 0) emitEvent('overtime.detected', { propertyId, entityId: rec.id, hours: overtime });
  return { attendance: updated, noveltiesCreated: created.length };
}
