// Capa opcional de LLM (Atria IA). Si hay ANTHROPIC_API_KEY, se usa Claude
// para extracción de intención/entidades y respuestas naturales; si no,
// el motor determinístico de intents.js opera solo.
import { config } from '../../config.js';
import { logger } from '../../lib/logger.js';

export function llmAvailable() {
  return Boolean(config.anthropicApiKey);
}

export async function llmComplete({ system, messages, maxTokens = 600 }) {
  if (!llmAvailable()) return null;
  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': config.anthropicApiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({ model: config.anthropicModel, max_tokens: maxTokens, system, messages }),
    });
    if (!res.ok) {
      logger.warn({ status: res.status, body: await res.text() }, 'anthropic api error');
      return null;
    }
    const data = await res.json();
    return data.content?.filter(b => b.type === 'text').map(b => b.text).join('\n') || null;
  } catch (err) {
    logger.warn({ err }, 'anthropic api unreachable');
    return null;
  }
}

// Extrae parámetros de reserva desde texto libre usando el LLM (fallback: null)
export async function llmExtractBooking(text) {
  const out = await llmComplete({
    system: 'Eres un extractor de datos para un hotel en Colombia. Responde SOLO un JSON válido, sin markdown, con las claves: intent (uno de: reservar, pregunta, queja, humano, saludo, pago, cancelar, otro), checkIn (YYYY-MM-DD o null), checkOut (YYYY-MM-DD o null), adults (número o null), children (número o null), name (string o null). Fecha de hoy: ' + new Date().toISOString().slice(0, 10),
    messages: [{ role: 'user', content: text }],
    maxTokens: 200,
  });
  if (!out) return null;
  try {
    const json = JSON.parse(out.replace(/^```(json)?|```$/g, '').trim());
    return json && typeof json === 'object' ? json : null;
  } catch {
    return null;
  }
}
