// Bold (Colombia) — https://developers.bold.co
// API de links de pago: POST /online/link/v1 con llave de identidad.
// Webhook firmado con HMAC SHA-256 (llave secreta) en el header x-bold-signature.
import crypto from 'node:crypto';
import { config } from '../../config.js';

export const label = 'Bold';
const API = 'https://integrations.api.bold.co';

export function isConfigured() {
  return Boolean(config.bold.apiKey);
}

export async function createCheckout(link) {
  if (!isConfigured()) throw new Error('Bold no configurado: define BOLD_API_KEY en .env');
  const res = await fetch(`${API}/online/link/v1`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `x-api-key ${config.bold.apiKey}`,
    },
    body: JSON.stringify({
      amount_type: 'CLOSE',
      amount: {
        currency: link.currency || 'COP',
        total_amount: Math.round(link.amount),
        tip_amount: 0,
      },
      description: link.concept.slice(0, 100),
      reference: link.token,
      ...(link.expiresAt ? { expiration_date: new Date(link.expiresAt).getTime() * 1e6 } : {}), // nanosegundos según doc Bold
      callback_url: `${config.publicBaseUrl}/pay/${link.token}`,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.errors?.length) {
    throw new Error(`Bold ${res.status}: ${JSON.stringify(data.errors || data).slice(0, 200)}`);
  }
  return { externalUrl: data.payload?.url, providerRef: data.payload?.payment_link };
}

export function parseWebhook(body, headers = {}, _query = {}, rawBody = null) {
  // Verificación de firma: HMAC SHA-256 del cuerpo con la llave secreta
  if (config.bold.secretKey && headers['x-bold-signature']) {
    const payload = rawBody || JSON.stringify(body);
    const expected = crypto.createHmac('sha256', config.bold.secretKey).update(payload).digest('base64');
    if (expected !== headers['x-bold-signature']) throw new Error('Firma de webhook Bold inválida');
  }
  const type = body?.type;
  if (!type) throw new Error('Payload Bold inválido');
  if (type !== 'SALE_APPROVED') return { ignored: true, type };
  const data = body.data || {};
  return {
    reference: data.metadata?.reference || data.reference,
    approved: true,
    amount: data.amount?.total,
    providerRef: data.payment_id || null,
    method: (data.payment_method || 'bold').toLowerCase(),
  };
}
