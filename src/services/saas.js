// Multi-tenant, planes y facturación del software (§55.1).
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';

// Planes por defecto (se siembran perezosamente si aún no existen).
export const DEFAULT_PLANS = [
  { code: 'trial', name: 'Trial', priceMonthly: 0, maxUsers: 5, maxProperties: 1, maxRooms: 20, aiMessagesMonth: 300, modules: '*', sortOrder: 0 },
  { code: 'basic', name: 'Basic', priceMonthly: 149000, maxUsers: 8, maxProperties: 1, maxRooms: 40, aiMessagesMonth: 1000, modules: 'pms,booking,crm,inbox,payments,compliance,housekeeping,maintenance', sortOrder: 1 },
  { code: 'pro', name: 'Pro', priceMonthly: 349000, maxUsers: 25, maxProperties: 3, maxRooms: 150, aiMessagesMonth: 5000, modules: '*', sortOrder: 2 },
  { code: 'enterprise', name: 'Enterprise', priceMonthly: 899000, maxUsers: 200, maxProperties: 50, maxRooms: 2000, aiMessagesMonth: 50000, modules: '*', sortOrder: 3 },
];

export async function ensurePlans() {
  const count = await prisma.plan.count();
  if (count > 0) return;
  for (const p of DEFAULT_PLANS) await prisma.plan.create({ data: p });
}

export async function listPlans() {
  await ensurePlans();
  return prisma.plan.findMany({ where: { active: true }, orderBy: { sortOrder: 'asc' } });
}

export async function getPlanForCompany(companyId) {
  await ensurePlans();
  const company = await prisma.company.findUnique({ where: { id: companyId } });
  const plan = await prisma.plan.findUnique({ where: { code: company?.planCode || 'trial' } })
    || await prisma.plan.findUnique({ where: { code: 'trial' } });
  return { company, plan };
}

// ¿El plan de la empresa habilita un módulo? (para gating de add-ons)
export function planAllowsModule(plan, moduleKey) {
  if (!plan || plan.modules === '*') return true;
  return plan.modules.split(',').map(s => s.trim()).includes(moduleKey);
}

export async function subscriptionOverview(companyId) {
  const { company, plan } = await getPlanForCompany(companyId);
  const [users, properties, rooms] = await Promise.all([
    prisma.user.count({ where: { companyId } }),
    prisma.property.count({ where: { companyId } }),
    prisma.room.count({ where: { property: { companyId } } }),
  ]);
  const usage = [
    { key: 'users', label: 'Usuarios', used: users, limit: plan.maxUsers },
    { key: 'properties', label: 'Sedes', used: properties, limit: plan.maxProperties },
    { key: 'rooms', label: 'Habitaciones', used: rooms, limit: plan.maxRooms },
  ].map(u => ({ ...u, pct: u.limit > 0 ? Math.min(100, Math.round((u.used / u.limit) * 100)) : 0, over: u.used > u.limit }));
  return {
    plan: { code: plan.code, name: plan.name, priceMonthly: plan.priceMonthly, modules: plan.modules },
    status: company.subStatus,
    trialEndsAt: company.trialEndsAt,
    currentPeriodEnd: company.currentPeriodEnd,
    usage,
  };
}

// Comprobación de límite antes de crear un recurso (lanza si se excede).
export async function assertWithinLimit(companyId, resource) {
  const { plan } = await getPlanForCompany(companyId);
  if (resource === 'users') {
    const count = await prisma.user.count({ where: { companyId } });
    if (count >= plan.maxUsers) throw new Error(`Tu plan ${plan.name} permite hasta ${plan.maxUsers} usuarios. Actualiza tu plan para agregar más.`);
  } else if (resource === 'properties') {
    const count = await prisma.property.count({ where: { companyId } });
    if (count >= plan.maxProperties) throw new Error(`Tu plan ${plan.name} permite hasta ${plan.maxProperties} sede(s). Actualiza tu plan para agregar más.`);
  }
}

// ---- Superadministrador SaaS ----
export async function listCompanies() {
  const companies = await prisma.company.findMany({ orderBy: { createdAt: 'asc' } });
  const withCounts = await Promise.all(companies.map(async c => {
    const [users, properties] = await Promise.all([
      prisma.user.count({ where: { companyId: c.id } }),
      prisma.property.count({ where: { companyId: c.id } }),
    ]);
    return { id: c.id, name: c.name, nit: c.nit, planCode: c.planCode, subStatus: c.subStatus, users, properties, createdAt: c.createdAt, currentPeriodEnd: c.currentPeriodEnd };
  }));
  return withCounts;
}

export async function setCompanyPlan(companyId, planCode, { user } = {}) {
  const plan = await prisma.plan.findUnique({ where: { code: planCode } });
  if (!plan) throw new Error('Plan no encontrado');
  const company = await prisma.company.update({
    where: { id: companyId },
    data: { planCode, subStatus: 'active', currentPeriodEnd: new Date(Date.now() + 30 * 86400_000) },
  });
  await audit({ companyId, user, actor: user ? 'human' : 'system', action: 'saas.plan_changed', entity: 'Company', entityId: companyId, after: { planCode } });
  return company;
}

export async function setCompanyStatus(companyId, status, { user } = {}) {
  if (!['trial', 'active', 'suspended', 'cancelled'].includes(status)) throw new Error('Estado inválido');
  const company = await prisma.company.update({ where: { id: companyId }, data: { subStatus: status } });
  await audit({ companyId, user, action: `saas.${status}`, entity: 'Company', entityId: companyId });
  return company;
}

export async function updateBranding(companyId, { commercialName, brandColor, logoUrl } = {}, { user } = {}) {
  const data = {};
  if (commercialName !== undefined) data.commercialName = commercialName || null;
  if (brandColor !== undefined) data.brandColor = brandColor || null;
  if (logoUrl !== undefined) data.logoUrl = logoUrl || null;
  const company = await prisma.company.update({ where: { id: companyId }, data });
  await audit({ companyId, user, action: 'saas.branding_updated', entity: 'Company', entityId: companyId });
  return company;
}
