// Wompi (Bancolombia) — https://docs.wompi.co
// Cobro con Web Checkout: se construye la URL con la llave pública y la
// referencia (token del link). El webhook de eventos valida firma SHA-256.
import crypto from 'node:crypto';
import { config } from '../../config.js';

export const label = 'Wompi';

export function isConfigured() {
  return Boolean(config.wompi.publicKey);
}

export async function createCheckout(link) {
  if (!isConfigured()) throw new Error('Wompi no configurado: define WOMPI_PUBLIC_KEY en .env');
  const params = new URLSearchParams({
    'public-key': config.wompi.publicKey,
    currency: link.currency || 'COP',
    'amount-in-cents': String(Math.round(link.amount * 100)),
    reference: link.token,
    'redirect-url': `${config.publicBaseUrl}/pay/${link.token}`,
  });
  return { externalUrl: `https://checkout.wompi.co/p/?${params}` };
}

export function parseWebhook(body) {
  const tx = body?.data?.transaction;
  if (!tx) throw new Error('Payload Wompi inválido');
  if (config.wompi.eventsSecret) {
    const props = body.signature?.properties || [];
    const values = props.map(p => p.split('.').reduce((o, k) => o?.[k], body.data)).join('');
    const expected = crypto.createHash('sha256').update(values + body.timestamp + config.wompi.eventsSecret).digest('hex');
    if (expected !== body.signature?.checksum) throw new Error('Firma de webhook Wompi inválida');
  }
  return {
    reference: tx.reference,
    approved: tx.status === 'APPROVED',
    amount: tx.amount_in_cents / 100,
    providerRef: String(tx.id),
    method: (tx.payment_method_type || 'card').toLowerCase(),
  };
}
