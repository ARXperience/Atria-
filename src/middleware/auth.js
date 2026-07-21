// Autenticación JWT + control de roles y permisos validado en backend
// (criterio de aceptación 50.2: permisos por rol también en backend).
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../db.js';
import { serviceForPermission, parseServiceList } from '../lib/services.js';

// Jerarquía y permisos por rol (sección 4 del documento funcional)
export const ROLES = ['OWNER', 'MANAGER', 'FRONTDESK', 'SALES', 'HOUSEKEEPING', 'MAINTENANCE', 'ACCOUNTING', 'HR', 'AUDITOR'];

const PERMISSIONS = {
  OWNER: ['*'],
  MANAGER: [
    'dashboard.view', 'reservations.*', 'booking.*', 'rooms.*', 'guests.*', 'crm.*', 'inbox.*',
    'payments.*', 'housekeeping.*', 'maintenance.*', 'compliance.*', 'approvals.*', 'audit.view',
    'settings.view', 'whatsapp.*', 'notifications.*', 'users.view', 'users.manage', 'settings.edit',
    'hr.*', 'payroll.view', 'payroll.manage', 'invoices.*', 'documents.*', 'content.*', 'sgsst.*', 'inventory.*', 'pos.*', 'revenue.*', 'channels.*', 'finance.*', 'dataprotection.*', 'fontur.*', 'marketing.*', 'reputation.*', 'events.*', 'integrations.*', 'automations.*',
  ],
  FRONTDESK: [
    'dashboard.view', 'reservations.*', 'booking.*', 'rooms.view', 'rooms.status', 'guests.*',
    'inbox.*', 'payments.view', 'payments.link', 'payments.manual_request', 'housekeeping.view',
    'housekeeping.create', 'maintenance.create', 'maintenance.view', 'compliance.tra', 'compliance.sire',
    'compliance.view', 'notifications.*', 'whatsapp.view', 'crm.view', 'crm.create',
    'invoices.view', 'invoices.create', 'documents.view', 'documents.manage', 'pos.*',
    'dataprotection.view', 'dataprotection.consent', 'reputation.view', 'reputation.respond', 'events.view',
  ],
  SALES: [
    'dashboard.view', 'crm.*', 'inbox.*', 'booking.*', 'reservations.view', 'reservations.create',
    'payments.link', 'guests.*', 'notifications.*', 'whatsapp.view', 'content.*', 'revenue.view', 'channels.view', 'marketing.*', 'reputation.view', 'reputation.respond', 'events.*',
  ],
  HOUSEKEEPING: ['housekeeping.*', 'rooms.view', 'rooms.status', 'maintenance.create', 'notifications.*'],
  MAINTENANCE: ['maintenance.*', 'rooms.view', 'notifications.*'],
  ACCOUNTING: [
    'dashboard.view', 'payments.*', 'reservations.view', 'compliance.view', 'audit.view',
    'approvals.view', 'notifications.*', 'invoices.*', 'payroll.view', 'hr.view', 'documents.view', 'inventory.view', 'finance.*', 'fontur.*',
  ],
  HR: ['dashboard.view', 'notifications.*', 'audit.view', 'hr.*', 'payroll.*', 'documents.*', 'approvals.view', 'approvals.decide', 'sgsst.*', 'dataprotection.view', 'dataprotection.consent'],
  AUDITOR: ['audit.view', 'dashboard.view', 'reservations.view', 'payments.view', 'compliance.view', 'approvals.view', 'invoices.view', 'payroll.view', 'hr.view', 'documents.view', 'sgsst.view', 'finance.view', 'dataprotection.view', 'fontur.view', 'integrations.view'],
};

export function hasPermission(role, perm) {
  const perms = PERMISSIONS[role] || [];
  if (perms.includes('*')) return true;
  if (perms.includes(perm)) return true;
  const domain = perm.split('.')[0];
  return perms.includes(`${domain}.*`);
}

// Lista de permisos efectivos del rol (para que el frontend adapte la
// navegación a cada área). '*' = acceso total.
export function permissionsForRole(role) {
  return PERMISSIONS[role] || [];
}

export function signToken(user, jti = null) {
  return jwt.sign(
    { sub: user.id, role: user.role, companyId: user.companyId, name: user.name, ...(jti ? { jti } : {}) },
    config.jwtSecret,
    { expiresIn: '12h' },
  );
}

export async function authRequired(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'No autenticado' });
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    const user = await prisma.user.findUnique({ where: { id: payload.sub } });
    if (!user || !user.active) return res.status(401).json({ error: 'Usuario inactivo' });
    // Revocación de sesión (§55.3): si el token trae jti, la sesión debe existir y estar activa.
    if (payload.jti) {
      const session = await prisma.session.findUnique({ where: { jti: payload.jti } });
      if (!session || session.revokedAt) return res.status(401).json({ error: 'Sesión revocada. Inicia sesión de nuevo.' });
      if (Date.now() - new Date(session.lastSeenAt).getTime() > 60_000) {
        prisma.session.update({ where: { jti: payload.jti }, data: { lastSeenAt: new Date() } }).catch(() => {});
      }
      req.sessionJti = payload.jti;
    }
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

// Caché en memoria de servicios habilitados por sede (TTL corto). Evita un query
// por request; se invalida al actualizar la configuración de una sede.
const propertyServicesCache = new Map(); // propertyId -> { services: string[]|null, at: number }
const PROP_CACHE_TTL = 30_000;

export function invalidatePropertyServices(propertyId) {
  if (propertyId) propertyServicesCache.delete(propertyId);
  else propertyServicesCache.clear();
}

async function propertyEnabledServices(propertyId) {
  const hit = propertyServicesCache.get(propertyId);
  if (hit && Date.now() - hit.at < PROP_CACHE_TTL) return hit.services;
  const prop = await prisma.property.findUnique({ where: { id: propertyId }, select: { enabledServices: true } }).catch(() => null);
  const services = prop ? parseServiceList(prop.enabledServices) : null; // null = todos
  propertyServicesCache.set(propertyId, { services, at: Date.now() });
  return services;
}

// Resuelve el propertyId del request (query/body/params) para el gating por sede.
function propertyIdFromReq(req) {
  return req.query?.propertyId || req.body?.propertyId || req.params?.propertyId || null;
}

// El usuario tiene el servicio habilitado a nivel personal (allowedServices).
// null = todas las áreas que su rol permite.
export function userAllowsService(user, service) {
  if (!service) return true;
  const allowed = parseServiceList(user.allowedServices);
  if (allowed == null) return true;
  return allowed.includes(service);
}

export function requirePermission(perm) {
  return async (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    // El superadmin tiene acceso a todas las funciones (§55.1).
    if (req.user.isSuperAdmin) return next();
    if (!hasPermission(req.user.role, perm)) {
      return res.status(403).json({ error: `Permiso denegado (${perm}) para rol ${req.user.role}` });
    }
    const service = serviceForPermission(perm);
    if (service) {
      // Gating por usuario: áreas asignadas por el superadmin.
      if (!userAllowsService(req.user, service)) {
        return res.status(403).json({ error: `Área no habilitada para tu usuario (${service})` });
      }
      // Gating por sede: el servicio debe estar contratado en la sede en contexto.
      const propertyId = propertyIdFromReq(req);
      if (propertyId && propertyScope(req, propertyId)) {
        const enabled = await propertyEnabledServices(propertyId);
        if (enabled != null && !enabled.includes(service)) {
          return res.status(403).json({ error: `Servicio no habilitado en esta sede (${service})` });
        }
      }
    }
    next();
  };
}

// Verifica acceso del usuario a la sede solicitada (permisos por sede, 55.3)
export function propertyScope(req, propertyId) {
  if (!propertyId) return false;
  if (req.user.propertyIds === '*') return true;
  return req.user.propertyIds.split(',').includes(propertyId);
}
