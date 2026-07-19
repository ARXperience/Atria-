// Nómina electrónica DIAN (§22). Genera el documento soporte de pago de nómina
// por empleado desde un periodo CERRADO. Sin proveedor configurado opera en
// modo local (numeración y estado "pending", listo para transmitir); con
// proveedor se transmitiría a la DIAN y se guardaría el CUNE.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { money } from '../lib/util.js';

export function nominaProviderConfigured() {
  return Boolean(process.env.NOMINA_DIAN_TOKEN);
}

async function nextNumber(propertyId) {
  const last = await prisma.electronicPayrollDocument.findFirst({
    where: { propertyId, number: { not: null } }, orderBy: { number: 'desc' },
  });
  return (last?.number || 1000) + 1;
}

export async function generateElectronicPayroll(periodId, { user }) {
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });
  if (!period) throw new Error('Periodo no encontrado');
  if (period.status !== 'closed') throw new Error('Cierra la nómina antes de generar el documento soporte de nómina electrónica');

  const items = await prisma.payrollItem.findMany({ where: { periodId }, include: { employee: true } });
  if (!items.length) throw new Error('El periodo no tiene empleados liquidados');

  // Regenerar solo los que aún no se han transmitido
  await prisma.electronicPayrollDocument.deleteMany({ where: { periodId, status: 'generated' } });

  let count = 0;
  for (const it of items) {
    const already = await prisma.electronicPayrollDocument.findFirst({ where: { periodId, employeeId: it.employeeId, status: { in: ['pending', 'validated'] } } });
    if (already) continue;
    let b = {};
    try { b = JSON.parse(it.breakdown); } catch { b = {}; }
    const payload = {
      periodo: `${period.month}/${period.year}`,
      empleado: it.employee.fullName,
      documento: it.employee.documentNumber,
      devengados: (b.earned || []).map(e => ({ concepto: e.concept, valor: money(e.amount) })),
      deducciones: (b.deductions || []).map(d => ({ concepto: d.concept, valor: money(d.amount) })),
      totalDevengado: money(it.earned), totalDeducido: money(it.deductions), neto: money(it.net),
    };
    await prisma.electronicPayrollDocument.create({
      data: {
        companyId: period.companyId, propertyId: period.propertyId, periodId,
        employeeId: it.employeeId, employeeName: it.employee.fullName,
        earned: money(it.earned), deductions: money(it.deductions), net: money(it.net),
        payload: JSON.stringify(payload), status: 'generated', createdBy: user?.name || null,
      },
    });
    count++;
  }
  await audit({ companyId: period.companyId, propertyId: period.propertyId, user, action: 'electronic_payroll.generated', entity: 'PayrollPeriod', entityId: periodId, after: { documents: count } });
  emitEvent('electronic_payroll.generated', { propertyId: period.propertyId, entityId: periodId });
  return count;
}

export async function transmitElectronicPayroll(periodId, { user }) {
  const docs = await prisma.electronicPayrollDocument.findMany({ where: { periodId, status: 'generated' } });
  if (!docs.length) throw new Error('No hay documentos generados para transmitir. Genera primero.');
  const period = await prisma.payrollPeriod.findUnique({ where: { id: periodId } });

  let n = 0;
  for (const doc of docs) {
    const number = doc.number || await nextNumber(doc.propertyId);
    const fullNumber = `NIE-${number}`;
    if (nominaProviderConfigured()) {
      // Punto de integración real con el proveedor DIAN (futuro).
      await prisma.electronicPayrollDocument.update({ where: { id: doc.id }, data: { number, fullNumber, status: 'pending', errorMsg: 'Proveedor configurado: pendiente de implementar el envío real.' } });
    } else {
      await prisma.electronicPayrollDocument.update({
        where: { id: doc.id },
        data: { number, fullNumber, status: 'pending', issuedAt: new Date(), errorMsg: 'Sin proveedor DIAN (NOMINA_DIAN_TOKEN): documento numerado localmente, listo para transmitir.' },
      });
    }
    n++;
  }
  await audit({ companyId: period.companyId, propertyId: period.propertyId, user, action: 'electronic_payroll.transmitted', entity: 'PayrollPeriod', entityId: periodId, after: { documents: n } });
  emitEvent('electronic_payroll.transmitted', { propertyId: period.propertyId, entityId: periodId });
  return n;
}
