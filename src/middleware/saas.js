// Guardias multi-tenant / SaaS (§55.1).
import { prisma } from '../db.js';

export function requireSuperAdmin(req, res, next) {
  if (!req.user?.isSuperAdmin) return res.status(403).json({ error: 'Solo el superadministrador SaaS puede realizar esta acción.' });
  next();
}

// Bloquea el acceso de empresas suspendidas/canceladas (402). El superadmin
// y las rutas de autenticación/suscripción quedan exentos.
export async function subscriptionGuard(req, res, next) {
  if (req.user?.isSuperAdmin) return next();
  try {
    const company = await prisma.company.findUnique({ where: { id: req.user.companyId }, select: { subStatus: true } });
    if (company && ['suspended', 'cancelled'].includes(company.subStatus)) {
      return res.status(402).json({ error: 'Suscripción suspendida. Contacta a administración para reactivar el servicio.', subStatus: company.subStatus });
    }
  } catch { /* no bloquear por fallo transitorio de lectura */ }
  next();
}
