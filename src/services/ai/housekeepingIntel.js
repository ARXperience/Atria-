// Inteligencia de housekeeping (§30): prioriza las tareas de limpieza por
// urgencia real (habitaciones necesarias para llegadas de hoy, tipo y antigüedad)
// y sugiere una asignación balanceada entre el personal disponible.
import { prisma } from '../../db.js';
import { audit } from '../../lib/audit.js';

const TYPE_BASE = { checkout_clean: 40, request: 30, auto_rule: 20, stayover: 18, deep_clean: 10 };
const PRIO = { urgent: 40, high: 25, normal: 10, low: 0 };

function todayRange() {
  const now = new Date();
  const a = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  return { a, b: new Date(a.getTime() + 86400000) };
}

// Personal de housekeeping con acceso a la sede.
async function housekeepingStaff(propertyId) {
  const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { companyId: true } });
  if (!prop) return [];
  const users = await prisma.user.findMany({ where: { companyId: prop.companyId, role: 'HOUSEKEEPING', active: true }, select: { id: true, name: true, propertyIds: true } });
  return users.filter(u => u.propertyIds === '*' || u.propertyIds.split(',').map(s => s.trim()).includes(propertyId));
}

export async function housekeepingPlan(propertyId) {
  const { a, b } = todayRange();
  const [tasks, arrivalsToday, staff] = await Promise.all([
    prisma.housekeepingTask.findMany({ where: { propertyId, status: { in: ['pending', 'in_progress'] } }, include: { room: true } }),
    prisma.reservation.count({ where: { propertyId, status: 'confirmed', checkIn: { gte: a, lt: b } } }),
    housekeepingStaff(propertyId),
  ]);
  const now = Date.now();
  const ranked = tasks.map((t) => {
    const ageHours = (now - new Date(t.createdAt).getTime()) / 3_600_000;
    const ageBoost = Math.min(20, Math.round(ageHours / 2));
    const arrivalBoost = arrivalsToday > 0 && t.type === 'checkout_clean' ? 20 : 0;
    const score = (TYPE_BASE[t.type] ?? 15) + (PRIO[t.priority] ?? 10) + ageBoost + arrivalBoost;
    const reasons = [];
    if (arrivalBoost) reasons.push('habitación necesaria para llegadas de hoy');
    if (t.priority === 'urgent' || t.priority === 'high') reasons.push(`prioridad ${t.priority}`);
    if (t.type === 'checkout_clean') reasons.push('salida por preparar');
    if (ageHours >= 6) reasons.push(`pendiente hace ${Math.round(ageHours)}h`);
    return {
      id: t.id, roomNumber: t.room?.number, type: t.type, priority: t.priority, status: t.status,
      assignedTo: t.assignedTo, score, reason: reasons.join(' · ') || 'rutina',
    };
  }).sort((x, y) => y.score - x.score);

  return {
    arrivalsToday, staff: staff.map(s => ({ id: s.id, name: s.name })),
    tasks: ranked, pending: ranked.filter(t => t.status === 'pending').length,
    unassigned: ranked.filter(t => !t.assignedTo).length,
  };
}

// Asigna las tareas sin responsable balanceando la carga entre el personal
// disponible, en orden de prioridad. Devuelve el reparto.
export async function autoAssignHousekeeping(propertyId, { user = null } = {}) {
  const plan = await housekeepingPlan(propertyId);
  if (!plan.staff.length) throw new Error('No hay personal de housekeeping disponible para asignar');
  const unassigned = plan.tasks.filter(t => !t.assignedTo);
  if (!unassigned.length) return { assigned: 0, byStaff: {} };

  // Carga inicial = tareas ya asignadas a cada persona (pendientes/en curso).
  const load = new Map(plan.staff.map(s => [s.name, 0]));
  for (const t of plan.tasks) if (t.assignedTo && load.has(t.assignedTo)) load.set(t.assignedTo, load.get(t.assignedTo) + 1);

  const byStaff = {};
  for (const t of unassigned) {
    // Persona con menor carga actual.
    const target = [...load.entries()].sort((x, y) => x[1] - y[1])[0][0];
    await prisma.housekeepingTask.update({ where: { id: t.id }, data: { assignedTo: target } });
    load.set(target, load.get(target) + 1);
    (byStaff[target] = byStaff[target] || []).push(t.roomNumber || t.id);
  }
  await audit({ propertyId, user, action: 'housekeeping.auto_assigned', entity: 'HousekeepingTask', after: { assigned: unassigned.length, staff: plan.staff.length } });
  return { assigned: unassigned.length, byStaff };
}
