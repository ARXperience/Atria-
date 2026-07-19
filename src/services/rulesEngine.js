// Motor de reglas legales configurable (§39): evalúa vencimientos y
// obligaciones de forma programada y genera alertas/tareas. Las reglas son
// versionables y parametrizables (nada quemado en código).
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { notify } from './notifications.js';
import { logger } from '../lib/logger.js';

// Reglas base sugeridas al crear una sede (se pueden editar/desactivar).
export const DEFAULT_RULES = [
  { key: 'rnt_expiry', name: 'Vencimiento de RNT', severity: 'critical', thresholdDays: 45, audienceRole: 'OWNER' },
  { key: 'doc_expiry', name: 'Documentos por vencer', severity: 'warning', thresholdDays: 30, audienceRole: 'MANAGER' },
  { key: 'tra_incomplete', name: 'TRA incompletas', severity: 'warning', thresholdDays: null, audienceRole: 'FRONTDESK' },
  { key: 'sire_pending', name: 'Reportes SIRE pendientes', severity: 'warning', thresholdDays: null, audienceRole: 'FRONTDESK' },
  { key: 'contract_expiry', name: 'Contratos por vencer', severity: 'warning', thresholdDays: 30, audienceRole: 'HR' },
  { key: 'exam_expiry', name: 'Exámenes médicos por vencer', severity: 'warning', thresholdDays: 30, audienceRole: 'HR' },
  { key: 'low_stock', name: 'Productos con stock bajo', severity: 'warning', thresholdDays: null, audienceRole: 'MANAGER' },
];

export async function ensureDefaultRules(companyId, propertyId = null) {
  for (const r of DEFAULT_RULES) {
    const exists = await prisma.complianceRule.findFirst({ where: { companyId, key: r.key } });
    if (!exists) await prisma.complianceRule.create({ data: { companyId, propertyId, ...r } });
  }
}

// Evaluadores por tipo de regla → devuelven lista de hallazgos.
const evaluators = {
  async rnt_expiry(rule, property) {
    if (!property.rntExpiresAt) {
      return [{ propertyId: property.id, title: 'RNT sin registrar', body: `La sede ${property.name} no tiene RNT o fecha de vencimiento.` }];
    }
    const daysLeft = Math.ceil((property.rntExpiresAt - new Date()) / 86400000);
    if (daysLeft <= (rule.thresholdDays || 45)) {
      return [{ propertyId: property.id, title: `RNT vence en ${daysLeft} día(s)`, body: `${property.name} — renovación entre el 1 de enero y el 31 de marzo.` }];
    }
    return [];
  },
  async doc_expiry(rule, property) {
    const limit = new Date(Date.now() + (rule.thresholdDays || 30) * 86400000);
    const docs = await prisma.document.findMany({ where: { companyId: property.companyId, status: 'active', expiryDate: { not: null, lte: limit } }, take: 50 });
    return docs.map(d => ({ propertyId: property.id, title: `Documento por vencer: ${d.title}`, body: `${d.docType} · vence ${d.expiryDate.toISOString().slice(0, 10)}`, entityId: d.id, entity: 'Document' }));
  },
  async tra_incomplete(_rule, property) {
    const n = await prisma.traRecord.count({ where: { propertyId: property.id, status: 'incomplete' } });
    return n > 0 ? [{ propertyId: property.id, title: `${n} TRA incompleta(s)`, body: 'Completa los datos de registro de alojamiento pendientes.' }] : [];
  },
  async sire_pending(_rule, property) {
    const n = await prisma.sireReport.count({ where: { propertyId: property.id, status: { in: ['pending', 'prepared'] } } });
    return n > 0 ? [{ propertyId: property.id, title: `${n} reporte(s) SIRE pendiente(s)`, body: 'Prepara/reporta los huéspedes extranjeros a Migración Colombia.' }] : [];
  },
  async contract_expiry(rule, property) {
    const limit = new Date(Date.now() + (rule.thresholdDays || 30) * 86400000);
    const emps = await prisma.employee.findMany({ where: { propertyId: property.id, status: 'active', endDate: { not: null, lte: limit } }, take: 50 });
    return emps.map(e => ({ propertyId: property.id, title: `Contrato por vencer: ${e.fullName}`, body: `Fin de contrato ${e.endDate.toISOString().slice(0, 10)} — decidir prórroga o terminación.`, entityId: e.id, entity: 'Employee' }));
  },
  async exam_expiry(rule, property) {
    const limit = new Date(Date.now() + (rule.thresholdDays || 30) * 86400000);
    const exams = await prisma.medicalExam.findMany({ where: { propertyId: property.id, validUntil: { not: null, lte: limit } }, take: 50 });
    return exams.map(x => ({ propertyId: property.id, title: `Examen médico por vencer: ${x.employeeName}`, body: `Examen ${x.type} vence ${x.validUntil.toISOString().slice(0, 10)} — programar renovación (SG-SST).`, entityId: x.id, entity: 'MedicalExam' }));
  },
  async low_stock(_rule, property) {
    const products = await prisma.product.findMany({ where: { propertyId: property.id, active: true }, take: 200 });
    return products.filter(p => p.stock <= p.stockMin).map(p => ({ propertyId: property.id, title: `Stock bajo: ${p.name}`, body: `Quedan ${p.stock} ${p.unit} (mínimo ${p.stockMin}). Considerar reposición.`, entityId: p.id, entity: 'Product' }));
  },
};

// Ejecuta todas las reglas activas de una empresa y notifica hallazgos nuevos.
export async function runComplianceRules(companyId) {
  const rules = await prisma.complianceRule.findMany({ where: { companyId, active: true } });
  const properties = await prisma.property.findMany({ where: { companyId, active: true } });
  const findings = [];
  for (const rule of rules) {
    const evaluator = evaluators[rule.key];
    if (!evaluator) continue;
    for (const property of properties) {
      if (rule.propertyId && rule.propertyId !== property.id) continue;
      let hits = [];
      try { hits = await evaluator(rule, property); } catch (err) { logger.warn({ err: err.message, rule: rule.key }, 'rule eval failed'); }
      for (const h of hits) {
        findings.push({ rule: rule.key, severity: rule.severity, ...h });
        await notify({
          propertyId: h.propertyId, audienceRole: rule.audienceRole, severity: rule.severity,
          title: h.title, body: h.body, entity: h.entity || 'ComplianceRule', entityId: h.entityId || rule.id,
        });
        emitEvent('compliance.alert_created', { propertyId: h.propertyId, rule: rule.key });
      }
    }
    await prisma.complianceRule.update({ where: { id: rule.id }, data: { lastRunAt: new Date() } });
  }
  logger.info({ companyId, findings: findings.length }, 'compliance rules run');
  return findings;
}

export async function runAllComplianceRules() {
  const companies = await prisma.company.findMany({ where: { active: true }, select: { id: true } });
  let total = 0;
  for (const c of companies) total += (await runComplianceRules(c.id)).length;
  return total;
}
