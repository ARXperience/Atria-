// IA-4 · Copiloto interno (§41): cualquier usuario autenticado puede consultarlo;
// el asistente restringe internamente los datos según el rol.
import { Router } from 'express';
import { internalAssistantReply } from '../services/ai/internalAssistant.js';
import { propertyScope } from '../middleware/auth.js';
import { badRequest } from '../lib/util.js';

export const assistantRouter = Router();

assistantRouter.post('/internal', async (req, res) => {
  const { propertyId, text } = req.body || {};
  if (!propertyId || !propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!text || !text.trim()) return badRequest(res, 'text requerido');
  try {
    res.json(await internalAssistantReply({ user: req.user, propertyId, text: text.trim() }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
