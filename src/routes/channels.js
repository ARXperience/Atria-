// Channel manager (§35): canales, mapeos, sincronización y logs.
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { syncChannel, channelsOverview } from '../services/channels.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const channelsRouter = Router();

const KNOWN = [
  { code: 'booking', name: 'Booking.com' }, { code: 'expedia', name: 'Expedia' },
  { code: 'airbnb', name: 'Airbnb' }, { code: 'despegar', name: 'Despegar' },
];
channelsRouter.get('/catalog', requirePermission('channels.view'), (_req, res) => res.json(KNOWN));

channelsRouter.get('/overview', requirePermission('channels.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await channelsOverview(req.query.propertyId));
});

channelsRouter.get('/', requirePermission('channels.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.channel.findMany({ where: { propertyId: req.query.propertyId }, include: { _count: { select: { mappings: true } } }, orderBy: { name: 'asc' } }));
});

channelsRouter.post('/', requirePermission('channels.manage'), async (req, res) => {
  const { propertyId, code, name, commissionPct } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const known = KNOWN.find(k => k.code === code);
  if (!known) return badRequest(res, 'Canal desconocido');
  try {
    const ch = await prisma.channel.create({ data: { propertyId, code, name: name || known.name, commissionPct: commissionPct != null ? +commissionPct : 0.15 } });
    await audit({ propertyId, user: req.user, action: 'channel.created', entity: 'Channel', entityId: ch.id, after: { code } });
    res.status(201).json(ch);
  } catch (err) {
    if (String(err.message).includes('Unique constraint')) return badRequest(res, 'Ese canal ya está configurado');
    badRequest(res, err.message);
  }
});

channelsRouter.patch('/:id', requirePermission('channels.manage'), async (req, res) => {
  const ch = await prisma.channel.findUnique({ where: { id: req.params.id } });
  if (!ch || !propertyScope(req, ch.propertyId)) return res.status(404).json({ error: 'Canal no encontrado' });
  const data = {};
  if (req.body?.enabled !== undefined) data.enabled = !!req.body.enabled;
  if (req.body?.commissionPct !== undefined) data.commissionPct = +req.body.commissionPct;
  const updated = await prisma.channel.update({ where: { id: ch.id }, data });
  await audit({ propertyId: ch.propertyId, user: req.user, action: 'channel.updated', entity: 'Channel', entityId: ch.id, after: data });
  res.json(updated);
});

channelsRouter.post('/:id/sync', requirePermission('channels.manage'), async (req, res) => {
  const ch = await prisma.channel.findUnique({ where: { id: req.params.id } });
  if (!ch || !propertyScope(req, ch.propertyId)) return res.status(404).json({ error: 'Canal no encontrado' });
  try {
    res.json(await syncChannel(ch.id, { user: req.user }));
  } catch (err) { badRequest(res, err.message); }
});

// ---- Mapeos ----
channelsRouter.get('/mappings', requirePermission('channels.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.channelMapping.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { createdAt: 'desc' } }));
});

channelsRouter.post('/mappings', requirePermission('channels.manage'), async (req, res) => {
  const { propertyId, channelId, roomTypeId, externalCode } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!channelId || !roomTypeId || !externalCode) return badRequest(res, 'channelId, roomTypeId y externalCode requeridos');
  const m = await prisma.channelMapping.create({ data: { propertyId, channelId, roomTypeId, externalCode } });
  await audit({ propertyId, user: req.user, action: 'channel.mapping_created', entity: 'ChannelMapping', entityId: m.id, after: { externalCode } });
  res.status(201).json(m);
});

// ---- Logs ----
channelsRouter.get('/logs', requirePermission('channels.view'), async (req, res) => {
  if (!propertyScope(req, req.query.propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await prisma.channelSyncLog.findMany({ where: { propertyId: req.query.propertyId }, orderBy: { createdAt: 'desc' }, take: 100 }));
});
