import { Router } from 'express';
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { prisma } from '../db.js';
import { config } from '../config.js';
import { signToken, authRequired } from '../middleware/auth.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';
import { validatePassword } from '../lib/password.js';
import { generateSecret, verifyTotp, otpauthUrl } from '../lib/totp.js';

export const authRouter = Router();

async function accessibleProperties(user) {
  return prisma.property.findMany({
    where: { companyId: user.companyId, ...(user.propertyIds === '*' ? {} : { id: { in: user.propertyIds.split(',') } }) },
    select: { id: true, name: true, city: true },
  });
}

async function issueSession(user, req) {
  const jti = crypto.randomUUID();
  await prisma.session.create({ data: { userId: user.id, jti, ip: req.ip || null, userAgent: (req.headers['user-agent'] || '').slice(0, 200) || null } });
  return signToken(user, jti);
}

authRouter.post('/login', async (req, res) => {
  const { email, password, code } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'Email y contraseña requeridos' });
  const user = await prisma.user.findUnique({ where: { email: String(email).toLowerCase().trim() } });
  if (!user || !user.active || !(await bcrypt.compare(password, user.passwordHash))) {
    return res.status(401).json({ error: 'Credenciales inválidas' });
  }
  // Segundo factor (§55.3): si está activo, exige un código TOTP válido.
  if (user.twoFactorEnabled) {
    if (!code) return res.status(200).json({ twoFactorRequired: true });
    if (!verifyTotp(user.twoFactorSecret, code)) return res.status(401).json({ error: 'Código de verificación inválido', twoFactorRequired: true });
  }
  await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });
  await audit({ companyId: user.companyId, user, action: 'auth.login', ip: req.ip });
  res.json({
    token: await issueSession(user, req),
    user: { id: user.id, name: user.name, email: user.email, role: user.role, twoFactorEnabled: user.twoFactorEnabled, isSuperAdmin: user.isSuperAdmin },
    properties: await accessibleProperties(user),
  });
});

authRouter.get('/me', authRequired, async (req, res) => {
  res.json({
    user: { id: req.user.id, name: req.user.name, email: req.user.email, role: req.user.role, twoFactorEnabled: req.user.twoFactorEnabled, isSuperAdmin: req.user.isSuperAdmin },
    properties: await accessibleProperties(req.user),
  });
});

authRouter.post('/logout', authRequired, async (req, res) => {
  if (req.sessionJti) await prisma.session.updateMany({ where: { jti: req.sessionJti }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
});

// ---- Recuperación de contraseña (§55.3) ----
authRouter.post('/forgot', async (req, res) => {
  const email = String(req.body?.email || '').toLowerCase().trim();
  const user = email ? await prisma.user.findUnique({ where: { email } }) : null;
  // Respuesta uniforme para no revelar si el correo existe (anti-enumeración).
  const response = { ok: true, message: 'Si el correo existe, enviaremos instrucciones para restablecer la contraseña.' };
  if (user && user.active) {
    const token = crypto.randomBytes(32).toString('hex');
    const tokenHash = crypto.createHash('sha256').update(token).digest('hex');
    await prisma.passwordReset.create({ data: { userId: user.id, tokenHash, expiresAt: new Date(Date.now() + 3600_000) } });
    await audit({ companyId: user.companyId, user, action: 'auth.forgot_password', ip: req.ip });
    // En producción el token se envía por correo. En desarrollo se devuelve para poder probar.
    if (!config.isProduction) response.devToken = token;
  }
  res.json(response);
});

authRouter.post('/reset', async (req, res) => {
  const { token, password } = req.body || {};
  if (!token || !password) return badRequest(res, 'token y password requeridos');
  const pwError = validatePassword(password);
  if (pwError) return badRequest(res, pwError);
  const tokenHash = crypto.createHash('sha256').update(String(token)).digest('hex');
  const reset = await prisma.passwordReset.findUnique({ where: { tokenHash } });
  if (!reset || reset.usedAt || reset.expiresAt < new Date()) return res.status(400).json({ error: 'Token inválido o expirado' });
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.$transaction([
    prisma.user.update({ where: { id: reset.userId }, data: { passwordHash, passwordUpdatedAt: new Date() } }),
    prisma.passwordReset.update({ where: { id: reset.id }, data: { usedAt: new Date() } }),
    // Por seguridad, revoca todas las sesiones activas del usuario.
    prisma.session.updateMany({ where: { userId: reset.userId, revokedAt: null }, data: { revokedAt: new Date() } }),
  ]);
  await audit({ user: { id: reset.userId }, action: 'auth.reset_password', ip: req.ip });
  res.json({ ok: true, message: 'Contraseña actualizada. Inicia sesión con la nueva contraseña.' });
});

authRouter.post('/password', authRequired, async (req, res) => {
  const { current, password } = req.body || {};
  if (!current || !password) return badRequest(res, 'current y password requeridos');
  const pwError = validatePassword(password);
  if (pwError) return badRequest(res, pwError);
  if (!(await bcrypt.compare(current, req.user.passwordHash))) return res.status(401).json({ error: 'La contraseña actual no es correcta' });
  const passwordHash = await bcrypt.hash(password, 10);
  await prisma.user.update({ where: { id: req.user.id }, data: { passwordHash, passwordUpdatedAt: new Date() } });
  await audit({ companyId: req.user.companyId, user: req.user, action: 'auth.change_password' });
  res.json({ ok: true });
});

// ---- 2FA / MFA (§55.3) ----
authRouter.post('/2fa/setup', authRequired, async (req, res) => {
  const secret = generateSecret();
  await prisma.user.update({ where: { id: req.user.id }, data: { twoFactorSecret: secret, twoFactorEnabled: false } });
  res.json({ secret, otpauthUrl: otpauthUrl(secret, { label: req.user.email }) });
});

authRouter.post('/2fa/enable', authRequired, async (req, res) => {
  const { code } = req.body || {};
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorSecret) return badRequest(res, 'Primero genera el secreto con /2fa/setup');
  if (!verifyTotp(user.twoFactorSecret, code)) return res.status(400).json({ error: 'Código inválido. Verifica la hora de tu dispositivo.' });
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: true } });
  await audit({ companyId: user.companyId, user, action: 'auth.2fa_enabled' });
  res.json({ ok: true, twoFactorEnabled: true });
});

authRouter.post('/2fa/disable', authRequired, async (req, res) => {
  const { code, password } = req.body || {};
  const user = await prisma.user.findUnique({ where: { id: req.user.id } });
  if (!user.twoFactorEnabled) return res.json({ ok: true, twoFactorEnabled: false });
  const ok = (code && verifyTotp(user.twoFactorSecret, code)) || (password && await bcrypt.compare(password, user.passwordHash));
  if (!ok) return res.status(400).json({ error: 'Aporta un código válido o tu contraseña para desactivar 2FA' });
  await prisma.user.update({ where: { id: user.id }, data: { twoFactorEnabled: false, twoFactorSecret: null } });
  await audit({ companyId: user.companyId, user, action: 'auth.2fa_disabled' });
  res.json({ ok: true, twoFactorEnabled: false });
});

// ---- Sesiones activas (§55.3) ----
authRouter.get('/sessions', authRequired, async (req, res) => {
  const sessions = await prisma.session.findMany({ where: { userId: req.user.id, revokedAt: null }, orderBy: { lastSeenAt: 'desc' }, take: 50 });
  res.json(sessions.map(s => ({ id: s.id, ip: s.ip, userAgent: s.userAgent, createdAt: s.createdAt, lastSeenAt: s.lastSeenAt, current: s.jti === req.sessionJti })));
});

authRouter.post('/sessions/:id/revoke', authRequired, async (req, res) => {
  const s = await prisma.session.findUnique({ where: { id: req.params.id } });
  if (!s || s.userId !== req.user.id) return res.status(404).json({ error: 'Sesión no encontrada' });
  await prisma.session.update({ where: { id: s.id }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
});

authRouter.post('/sessions/revoke-others', authRequired, async (req, res) => {
  await prisma.session.updateMany({ where: { userId: req.user.id, revokedAt: null, jti: { not: req.sessionJti || '' } }, data: { revokedAt: new Date() } });
  res.json({ ok: true });
});
