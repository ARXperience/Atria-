// IA-4 · Copiloto interno (§41): cualquier usuario autenticado puede consultarlo;
// el asistente restringe internamente los datos según el rol.
import { Router } from 'express';
import { internalAssistantReply } from '../services/ai/internalAssistant.js';
import { interpretAction, runConfirmedAction } from '../services/ai/copilotActions.js';
import { propertyScope } from '../middleware/auth.js';
import { badRequest } from '../lib/util.js';

export const assistantRouter = Router();

assistantRouter.post('/internal', async (req, res) => {
  const { propertyId, text } = req.body || {};
  if (!propertyId || !propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!text || !text.trim()) return badRequest(res, 'text requerido');
  try {
    // Primero, ¿es una acción sensible? Si lo es, devolvemos la vista previa en
    // vez de una respuesta de consulta (IA que ejecuta con vista previa, §55.6).
    const act = await interpretAction({ user: req.user, propertyId, text: text.trim() });
    if (act?.action) return res.json({ kind: 'action', ...act });
    if (act?.error) return res.json({ kind: 'text', reply: act.error });
    res.json({ kind: 'text', ...(await internalAssistantReply({ user: req.user, propertyId, text: text.trim() })) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Confirmar y ejecutar (o enviar a aprobación) una acción propuesta por el copiloto.
assistantRouter.post('/action/execute', async (req, res) => {
  const { propertyId, action } = req.body || {};
  if (!propertyId || !propertyScope(req, propertyId)) return res.status(403).json({ error: 'Sin acceso a esta sede' });
  if (!action?.type) return badRequest(res, 'action requerida');
  try {
    res.json(await runConfirmedAction({ user: req.user, propertyId, action }));
  } catch (err) {
    badRequest(res, err.message);
  }
});
