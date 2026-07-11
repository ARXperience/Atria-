// Stripe — https://stripe.com/docs/api (sin SDK: API REST directa)
// Checkout Session con client_reference_id = token del link.
// Webhook verificado con la firma Stripe-Signature (HMAC SHA-256).
import crypto from 'node:crypto';
import { config } from '../../config.js';

export const label = 'Stripe';
const API = 'https://api.stripe.com/v1';

export function isConfigured() {
  return Boolean(config.stripe.secretKey);
}

function form(obj, prefix = '') {
  // Serializa objetos anidados al formato x-www-form-urlencoded de Stripe
  const parts = [];
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}[${k}]` : k;
    if (v === null || v === undefined) continue;
    if (typeof v === 'object' && !Array.isArray(v)) parts.push(form(v, key));
    else if (Array.isArray(v)) v.forEach((item, i) => parts.push(typeof item === 'object' ? form(item, `${key}[${i}]`) : `${encodeURIComponent(`${key}[${i}]`)}=${encodeURIComponent(item)}`));
    else parts.push(`${encodeURIComponent(key)}=${encodeURIComponent(v)}`);
  }
  return parts.join('&');
}

export async function createCheckout(link) {
  if (!isConfigured()) throw new Error('Stripe no configurado: define STRIPE_SECRET_KEY en .env');
  const res = await fetch(`${API}/checkout/sessions`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      authorization: `Bearer ${config.stripe.secretKey}`,
    },
    body: form({
      mode: 'payment',
      client_reference_id: link.token,
      success_url: `${config.publicBaseUrl}/pay/${link.token}`,
      cancel_url: `${config.publicBaseUrl}/pay/${link.token}`,
      line_items: [{
        quantity: 1,
        price_data: {
          currency: (link.currency || 'COP').toLowerCase(),
          unit_amount: Math.round(link.amount * 100),
          product_data: { name: link.concept.slice(0, 120) },
        },
      }],
      ...(link.expiresAt ? { expires_at: Math.max(Math.floor(Date.now() / 1000) + 1860, Math.min(Math.floor(new Date(link.expiresAt).getTime() / 1000), Math.floor(Date.now() / 1000) + 86400)) } : {}),
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Stripe ${res.status}: ${data.error?.message || 'error'}`);
  return { externalUrl: data.url, providerRef: data.id };
}

export function verifySignature(rawBody, signatureHeader) {
  if (!config.stripe.webhookSecret) return true; // sin secreto: no se puede verificar (documentado)
  if (!signatureHeader) throw new Error('Falta header Stripe-Signature');
  const parts = Object.fromEntries(signatureHeader.split(',').map(p => p.split('=')));
  const expected = crypto.createHmac('sha256', config.stripe.webhookSecret)
    .update(`${parts.t}.${rawBody}`).digest('hex');
  const provided = Buffer.from(parts.v1 || '', 'utf8');
  const wanted = Buffer.from(expected, 'utf8');
  if (provided.length !== wanted.length || !crypto.timingSafeEqual(provided, wanted)) {
    throw new Error('Firma de webhook Stripe inválida');
  }
  return true;
}

export function parseWebhook(body, headers = {}, _query = {}, rawBody = null) {
  verifySignature(rawBody || JSON.stringify(body), headers['stripe-signature']);
  if (body?.type !== 'checkout.session.completed') return { ignored: true, type: body?.type };
  const session = body.data?.object || {};
  if (session.payment_status && session.payment_status !== 'paid') return { ignored: true };
  return {
    reference: session.client_reference_id,
    approved: true,
    amount: (session.amount_total || 0) / 100,
    providerRef: session.payment_intent || session.id,
    method: 'card',
  };
}
