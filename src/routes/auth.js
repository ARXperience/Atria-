import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { signToken, authRequired } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';

export const authRouter = Router();

authRouter.post('/login', async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ companyId: user.companyId, user, action: 'auth.login', ip: req.ip });
  const properties = await prisma.property.findMany({
    where: {
      companyId: user.companyId,
      ...(user.propertyIds === '*' ? {} : { id: { in: user.propertyIds.split(',') } }),
    },
    select: { id: true, name: true, city: true },
  });
  res.json({
    token: signToken(user),
    user: { id: user.id, name: user.name, email: user.email, role: user.role },
    properties,
  });
});

authRouter.get('/me', authRequired, async (req, res) => {
  const properties = await prisma.property.findMany({
    where: {
      companyId: req.user.companyId,
      ...(req.user.propertyIds === '*' ? {} : { id: { in: req.user.propertyIds.split(',') } }),
    },
    select: { id: true, name: true, city: true },
  });
  res.json({ user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role }, properties });
});
