// IA-1 · Admin de contenido de habitaciones y base de conocimiento (§9, §55.5).
import { Router } from 'express';
import { prisma } from '../db.js';
import { propertyScope, requirePermission } from '../middleware/auth.js';
import { roomsContent, updateRoomTypeContent, listKnowledge, knowledgeSnapshot } from '../services/knowledge.js';
import { getAgentProfile, buildSystemPrompt, AGENT_SCOPES } from '../services/ai/agentProfile.js';
import { searchKnowledge } from '../services/ai/retrieval.js';
import { buildTools } from '../services/ai/tools.js';
import { audit } from '../lib/audit.js';
import { badRequest } from '../lib/util.js';

export const contentRouter = Router();

// ---- Configuración del agente (IA-2: persona por hotel) ----
contentRouter.get('/agents', requirePermission('content.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const guest = await getAgentProfile(propertyId, 'guest');
  const others = await prisma.agentProfile.findMany({ where: { propertyId, scope: { not: 'guest' } } });
  res.json([guest, ...others]);
});

contentRouter.patch('/agents/:id', requirePermission('content.manage'), async (req, res) => {
  const profile = await prisma.agentProfile.findUnique({ where: { id: req.params.id } });
  if (!profile || !propertyScope(req, profile.propertyId)) return res.status(404).json({ error: 'Agente no encontrado' });
  const allowed = ['displayName', 'persona', 'tone', 'languages', 'emojis', 'greeting', 'domainOnly', 'llmEnabled', 'enabledTools', 'knowledgeScope', 'active'];
  const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  const updated = await prisma.agentProfile.update({ where: { id: profile.id }, data });
  await audit({ propertyId: profile.propertyId, user: req.user, action: 'agent.configured', entity: 'AgentProfile', entityId: profile.id, after: data });
  res.json(updated);
});

// Previsualización segura: qué sabría y respondería el agente (sin efectos).
contentRouter.post('/agents/preview', requirePermission('content.view'), async (req, res) => {
  const { propertyId, scope = 'guest', question } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  const profile = await getAgentProfile(propertyId, scope);
  const snapshot = await knowledgeSnapshot(propertyId, { visibility: profile.knowledgeScope });
  const tools = buildTools({ propertyId, profile, conversation: null });
  const answer = question ? searchKnowledge(snapshot, question) : null;
  res.json({
    displayName: profile.displayName,
    tools: Object.keys(tools),
    roomsKnown: snapshot.rooms.length,
    knowledgeItems: snapshot.knowledge.length,
    systemPromptPreview: buildSystemPrompt(profile, snapshot).slice(0, 1200),
    answer: answer ? answer.answer : (question ? 'El agente no encontró esta información en el conocimiento configurado — pediría más datos o escalaría a una persona.' : null),
  });
});

// ---- Contenido de habitaciones ----
contentRouter.get('/rooms', requirePermission('content.view'), async (req, res) => {
  const { propertyId } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await roomsContent(propertyId));
});

contentRouter.patch('/rooms/:roomTypeId', requirePermission('content.manage'), async (req, res) => {
  const rt = await prisma.roomType.findUnique({ where: { id: req.params.roomTypeId } });
  if (!rt || !propertyScope(req, rt.propertyId)) return res.status(404).json({ error: 'Tipo de habitación no encontrado' });
  const updated = await updateRoomTypeContent(rt.id, req.body || {});
  await audit({ propertyId: rt.propertyId, user: req.user, action: 'room_content.updated', entity: 'RoomType', entityId: rt.id, after: req.body });
  res.json(updated);
});

// ---- Base de conocimiento ----
contentRouter.get('/knowledge', requirePermission('content.view'), async (req, res) => {
  const { propertyId, visibility } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await listKnowledge(propertyId, { visibility: visibility || null, activeOnly: false }));
});

contentRouter.post('/knowledge', requirePermission('content.manage'), async (req, res) => {
  const { propertyId, category, title, content, visibility = 'public', tags } = req.body || {};
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!category || !title || !content) return badRequest(res, 'category, title y content son requeridos');
  const item = await prisma.knowledgeItem.create({
    data: { propertyId, category, title, content, visibility, tags, updatedBy: req.user.name },
  });
  await audit({ propertyId, user: req.user, action: 'knowledge.created', entity: 'KnowledgeItem', entityId: item.id, after: { category, title } });
  res.status(201).json(item);
});

contentRouter.patch('/knowledge/:id', requirePermission('content.manage'), async (req, res) => {
  const item = await prisma.knowledgeItem.findUnique({ where: { id: req.params.id } });
  if (!item || !propertyScope(req, item.propertyId)) return res.status(404).json({ error: 'Ítem no encontrado' });
  const allowed = ['category', 'title', 'content', 'visibility', 'tags', 'active'];
  const data = Object.fromEntries(Object.entries(req.body || {}).filter(([k]) => allowed.includes(k)));
  data.updatedBy = req.user.name;
  const updated = await prisma.knowledgeItem.update({ where: { id: item.id }, data });
  await audit({ propertyId: item.propertyId, user: req.user, action: 'knowledge.updated', entity: 'KnowledgeItem', entityId: item.id, after: data });
  res.json(updated);
});

contentRouter.delete('/knowledge/:id', requirePermission('content.manage'), async (req, res) => {
  const item = await prisma.knowledgeItem.findUnique({ where: { id: req.params.id } });
  if (!item || !propertyScope(req, item.propertyId)) return res.status(404).json({ error: 'Ítem no encontrado' });
  await prisma.knowledgeItem.update({ where: { id: item.id }, data: { active: false } });
  res.json({ ok: true });
});

// Vista previa del conocimiento que "ve" el agente (útil para el admin)
contentRouter.get('/knowledge-snapshot', requirePermission('content.view'), async (req, res) => {
  const { propertyId, visibility } = req.query;
  if (!propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  res.json(await knowledgeSnapshot(propertyId, { visibility: visibility || 'public' }));
});
