// Calidad de datos (§55.4): detecta duplicados, formatos inválidos y registros
// incompletos en huéspedes, empleados y reservas. No modifica datos: reporta.
import { prisma } from '../db.js';

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?\d[\d\s-]{6,}$/; // al menos 7 dígitos

function bump(map, key, sample) {
  if (!map.has(key)) map.set(key, { count: 0, samples: [] });
  const e = map.get(key);
  e.count++;
  if (e.samples.length < 5 && sample) e.samples.push(sample);
}

export async function scanDataQuality(propertyId, companyId) {
  const [guests, employees, reservations] = await Promise.all([
    prisma.guest.findMany({ where: { propertyId }, select: { fullName: true, documentNumber: true, email: true, phone: true } }),
    prisma.employee.findMany({ where: { companyId }, select: { fullName: true, documentNumber: true, email: true, eps: true, afp: true, arl: true } }),
    prisma.reservation.findMany({ where: { propertyId }, select: { code: true, checkIn: true, checkOut: true, total: true, status: true } }),
  ]);
  const issues = new Map();

  // Huéspedes: documentos duplicados, correos/teléfonos inválidos, sin documento.
  const docCounts = new Map();
  for (const g of guests) if (g.documentNumber) docCounts.set(g.documentNumber, (docCounts.get(g.documentNumber) || 0) + 1);
  for (const g of guests) {
    if (!g.documentNumber) bump(issues, 'guest_no_doc', g.fullName);
    else if (docCounts.get(g.documentNumber) > 1) bump(issues, 'guest_dup_doc', `${g.fullName} (${g.documentNumber})`);
    if (g.email && !EMAIL_RE.test(g.email)) bump(issues, 'guest_bad_email', `${g.fullName}: ${g.email}`);
    if (g.phone && !PHONE_RE.test(g.phone)) bump(issues, 'guest_bad_phone', `${g.fullName}: ${g.phone}`);
  }

  // Empleados: afiliaciones incompletas, correos inválidos.
  for (const e of employees) {
    if (!e.eps || !e.afp || !e.arl) bump(issues, 'emp_no_affiliation', `${e.fullName} (${e.documentNumber})`);
    if (e.email && !EMAIL_RE.test(e.email)) bump(issues, 'emp_bad_email', `${e.fullName}: ${e.email}`);
  }

  // Reservas: fechas inconsistentes o total no positivo.
  for (const r of reservations) {
    if (r.checkOut <= r.checkIn) bump(issues, 'res_bad_dates', r.code);
    if (r.total <= 0 && r.status !== 'cancelled') bump(issues, 'res_bad_total', r.code);
  }

  const LABELS = {
    guest_no_doc: 'Huéspedes sin documento',
    guest_dup_doc: 'Huéspedes con documento duplicado',
    guest_bad_email: 'Correos de huésped inválidos',
    guest_bad_phone: 'Teléfonos de huésped mal formados',
    emp_no_affiliation: 'Empleados con afiliaciones incompletas',
    emp_bad_email: 'Correos de empleado inválidos',
    res_bad_dates: 'Reservas con fechas inconsistentes',
    res_bad_total: 'Reservas con total no válido',
  };
  const list = [...issues.entries()].map(([key, v]) => ({ key, label: LABELS[key] || key, count: v.count, samples: v.samples }));
  const totalRecords = guests.length + employees.length + reservations.length;
  const totalIssues = list.reduce((s, i) => s + i.count, 0);
  // Puntaje de salud: 100 si no hay problemas; baja con la proporción de registros afectados.
  const score = totalRecords > 0 ? Math.max(0, Math.round((1 - totalIssues / totalRecords) * 100)) : 100;
  return {
    score, totalRecords, totalIssues,
    scanned: { guests: guests.length, employees: employees.length, reservations: reservations.length },
    issues: list.sort((a, b) => b.count - a.count),
  };
}
