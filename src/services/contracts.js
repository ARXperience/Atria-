// Contratos laborales (§20): generación, activación (con aprobación), otrosíes
// y texto imprimible. La IA/el sistema preparan borradores; activar, modificar
// o terminar exige aprobación humana (matriz §47).
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { fmtCOP } from '../lib/util.js';

const TYPE_LABEL = {
  indefinido: 'a término indefinido', fijo: 'a término fijo',
  obra: 'por obra o labor', aprendizaje: 'de aprendizaje',
};

export async function createDraftContract({ companyId, employee, data, createdBy }) {
  const contract = await prisma.employmentContract.create({
    data: {
      companyId, propertyId: employee.propertyId, employeeId: employee.id,
      type: data.type || employee.contractType || 'indefinido',
      position: data.position || employee.position,
      salary: data.salary != null ? +data.salary : employee.salary,
      workday: data.workday || 'Tiempo completo',
      functions: data.functions || null,
      startDate: data.startDate ? new Date(data.startDate) : employee.hireDate,
      endDate: data.endDate ? new Date(data.endDate) : null,
      trialEndDate: data.trialEndDate ? new Date(data.trialEndDate) : null,
      status: 'draft', createdBy,
    },
  });
  await audit({ companyId, propertyId: employee.propertyId, action: 'contract.drafted', entity: 'EmploymentContract', entityId: contract.id, after: { employee: employee.fullName, type: contract.type } });
  emitEvent('contract.drafted', { propertyId: employee.propertyId, entityId: contract.id });
  return contract;
}

// Ejecutado al aprobarse: activa el contrato y sincroniza datos del empleado.
export async function activateContract(contractId) {
  const contract = await prisma.employmentContract.findUnique({ where: { id: contractId } });
  if (!contract) throw new Error('Contrato no encontrado');
  // Cerrar contratos activos previos del empleado
  await prisma.employmentContract.updateMany({
    where: { employeeId: contract.employeeId, status: 'active', id: { not: contractId } },
    data: { status: 'ended' },
  });
  const updated = await prisma.employmentContract.update({ where: { id: contractId }, data: { status: 'active' } });
  await prisma.employee.update({
    where: { id: contract.employeeId },
    data: {
      contractType: contract.type, position: contract.position, salary: contract.salary,
      hireDate: contract.startDate, endDate: contract.endDate,
    },
  });
  await audit({ companyId: contract.companyId, propertyId: contract.propertyId, action: 'contract.signed', entity: 'EmploymentContract', entityId: contractId, after: { status: 'active' } });
  emitEvent('contract.signed', { propertyId: contract.propertyId, entityId: contractId });
  return updated;
}

// Ejecutado al aprobarse: registra el otrosí y aplica el cambio.
export async function applyAmendment(payload) {
  const contract = await prisma.employmentContract.findUnique({ where: { id: payload.contractId } });
  if (!contract) throw new Error('Contrato no encontrado');
  const map = { salary: 'salary', position: 'position', workday: 'workday', functions: 'functions', extension: 'endDate' };
  const field = map[payload.changeType];
  const previousValue = field === 'endDate' ? (contract.endDate?.toISOString().slice(0, 10) || 'indefinido') : String(contract[field] ?? '');

  const amendment = await prisma.contractAmendment.create({
    data: {
      contractId: contract.id, changeType: payload.changeType, detail: payload.detail || '',
      previousValue, newValue: String(payload.newValue ?? ''), reason: payload.reason || null,
      effectiveDate: payload.effectiveDate ? new Date(payload.effectiveDate) : new Date(), createdBy: payload.createdBy || null,
    },
  });

  // Aplicar al contrato y al empleado
  const cData = {}, eData = {};
  if (payload.changeType === 'salary') { cData.salary = +payload.newValue; eData.salary = +payload.newValue; }
  else if (payload.changeType === 'position') { cData.position = payload.newValue; eData.position = payload.newValue; }
  else if (payload.changeType === 'workday') { cData.workday = payload.newValue; }
  else if (payload.changeType === 'functions') { cData.functions = payload.newValue; }
  else if (payload.changeType === 'extension') { cData.endDate = new Date(payload.newValue); eData.endDate = new Date(payload.newValue); }
  if (Object.keys(cData).length) await prisma.employmentContract.update({ where: { id: contract.id }, data: cData });
  if (Object.keys(eData).length) await prisma.employee.update({ where: { id: contract.employeeId }, data: eData });

  await audit({ companyId: contract.companyId, propertyId: contract.propertyId, action: 'contract.amended', entity: 'EmploymentContract', entityId: contract.id, before: { [payload.changeType]: previousValue }, after: { [payload.changeType]: payload.newValue } });
  emitEvent('contract.amended', { propertyId: contract.propertyId, entityId: contract.id });
  return amendment;
}

// Texto imprimible del contrato (borrador para firma).
export async function renderContractText(contractId) {
  const contract = await prisma.employmentContract.findUnique({
    where: { id: contractId },
    include: { employee: true, amendments: { orderBy: { createdAt: 'asc' } } },
  });
  if (!contract) throw new Error('Contrato no encontrado');
  const company = await prisma.company.findUnique({ where: { id: contract.companyId } });
  const e = contract.employee;
  const d = x => x ? new Date(x).toLocaleDateString('es-CO', { day: '2-digit', month: 'long', year: 'numeric' }) : '____';

  const lines = [
    `CONTRATO INDIVIDUAL DE TRABAJO ${(TYPE_LABEL[contract.type] || '').toUpperCase()}`,
    '',
    `Entre ${company?.name || 'EL EMPLEADOR'}, identificada con NIT ${company?.nit || '____'} (EL EMPLEADOR), y ${e.fullName}, identificado(a) con ${e.documentType} No. ${e.documentNumber} (EL TRABAJADOR), se celebra el presente contrato de trabajo, regido por las siguientes cláusulas:`,
    '',
    `PRIMERA. Cargo: EL TRABAJADOR se obliga a desempeñar el cargo de ${contract.position}.`,
    `SEGUNDA. Funciones: ${contract.functions || 'Las propias del cargo y las que le sean asignadas por EL EMPLEADOR.'}`,
    `TERCERA. Salario: EL EMPLEADOR pagará como remuneración la suma de ${fmtCOP(contract.salary)} mensuales.`,
    `CUARTA. Jornada: ${contract.workday}, de acuerdo con el horario que establezca EL EMPLEADOR conforme a la ley.`,
    `QUINTA. Duración: Contrato ${TYPE_LABEL[contract.type] || contract.type}. Fecha de inicio: ${d(contract.startDate)}.${contract.endDate ? ` Fecha de terminación: ${d(contract.endDate)}.` : ''}${contract.trialEndDate ? ` Periodo de prueba hasta: ${d(contract.trialEndDate)}.` : ''}`,
    `SEXTA. Lugar de trabajo: instalaciones de EL EMPLEADOR o donde este determine según la operación hotelera.`,
    `SÉPTIMA. Obligaciones y prestaciones sociales conforme al Código Sustantivo del Trabajo y la normatividad vigente.`,
    '',
    ...(contract.amendments.length ? ['OTROSÍES:', ...contract.amendments.map((a, i) => `${i + 1}. (${a.changeType}) ${a.detail} — de "${a.previousValue}" a "${a.newValue}" con efecto ${d(a.effectiveDate)}.`), ''] : []),
    `En constancia se firma a los ${d(new Date())}.`,
    '',
    '____________________________            ____________________________',
    `EL EMPLEADOR                             ${e.fullName}`,
  ];
  return lines.join('\n');
}
