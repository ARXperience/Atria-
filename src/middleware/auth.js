// Autenticación JWT + control de roles y permisos validado en backend
// (criterio de aceptación 50.2: permisos por rol también en backend).
import jwt from 'jsonwebtoken';
import { config } from '../config.js';
import { prisma } from '../db.js';

// Jerarquía y permisos por rol (sección 4 del documento funcional)
export const ROLES = ['OWNER', 'MANAGER', 'FRONTDESK', 'SALES', 'HOUSEKEEPING', 'MAINTENANCE', 'ACCOUNTING', 'HR', 'AUDITOR'];

const PERMISSIONS = {
  OWNER: ['*'],
  MANAGER: [
    'dashboard.view', 'reservations.*', 'booking.*', 'rooms.*', 'guests.*', 'crm.*', 'inbox.*',
    'payments.*', 'housekeeping.*', 'maintenance.*', 'compliance.*', 'approvals.*', 'audit.view',
    'settings.view', 'whatsapp.*', 'notifications.*', 'users.view', 'users.manage', 'settings.edit',
    'hr.*', 'payroll.view', 'payroll.manage', 'invoices.*', 'documents.*', 'content.*', 'sgsst.*',
  ],
  FRONTDESK: [
    'dashboard.view', 'reservations.*', 'booking.*', 'rooms.view', 'rooms.status', 'guests.*',
    'inbox.*', 'payments.view', 'payments.link', 'payments.manual_request', 'housekeeping.view',
    'housekeeping.create', 'maintenance.create', 'maintenance.view', 'compliance.tra', 'compliance.sire',
    'compliance.view', 'notifications.*', 'whatsapp.view', 'crm.view', 'crm.create',
    'invoices.view', 'invoices.create', 'documents.view', 'documents.manage',
  ],
  SALES: [
    'dashboard.view', 'crm.*', 'inbox.*', 'booking.*', 'reservations.view', 'reservations.create',
    'payments.link', 'guests.*', 'notifications.*', 'whatsapp.view', 'content.*',
  ],
  HOUSEKEEPING: ['housekeeping.*', 'rooms.view', 'rooms.status', 'maintenance.create', 'notifications.*'],
  MAINTENANCE: ['maintenance.*', 'rooms.view', 'notifications.*'],
  ACCOUNTING: [
    'dashboard.view', 'payments.*', 'reservations.view', 'compliance.view', 'audit.view',
    'approvals.view', 'notifications.*', 'invoices.*', 'payroll.view', 'hr.view', 'documents.view',
  ],
  HR: ['dashboard.view', 'notifications.*', 'audit.view', 'hr.*', 'payroll.*', 'documents.*', 'approvals.view', 'approvals.decide', 'sgsst.*'],
  AUDITOR: ['audit.view', 'dashboard.view', 'reservations.view', 'payments.view', 'compliance.view', 'approvals.view', 'invoices.view', 'payroll.view', 'hr.view', 'documents.view', 'sgsst.view'],
};

export function hasPermission(role, perm) {
  const perms = PERMISSIONS[role] || [];
  if (perms.includes('*')) return true;
  if (perms.includes(perm)) return true;
  const domain = perm.split('.')[0];
  return perms.includes(`${domain}.*`);
}

export function signToken(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, companyId: user.companyId, name: user.name },
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
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ error: 'Sesión inválida o expirada' });
  }
}

export function requirePermission(perm) {
  return (req, res, next) => {
    if (!req.user) return res.status(401).json({ error: 'No autenticado' });
    if (!hasPermission(req.user.role, perm)) {
      return res.status(403).json({ error: `Permiso denegado (${perm}) para rol ${req.user.role}` });
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
