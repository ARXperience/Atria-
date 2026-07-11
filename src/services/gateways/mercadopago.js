// Mercado Pago — https://www.mercadopago.com.co/developers
// Checkout Pro: se crea una "preference" y se redirige al init_point.
// El webhook (tipo payment) trae solo el id: se consulta la API para obtener
// estado y external_reference (token del link).
import { config } from '../../config.js';

export const label = 'Mercado Pago';
const API = 'https://api.mercadopago.com';

export function isConfigured() {
  return Boolean(config.mercadopago.accessToken);
}

async function mpFetch(path, opts = {}) {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${config.mercadopago.accessToken}`,
      ...(opts.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`Mercado Pago ${res.status}: ${data.message || JSON.stringify(data).slice(0, 200)}`);
  return data;
}

export async function createCheckout(link) {
  if (!isConfigured()) throw new Error('Mercado Pago no configurado: define MP_ACCESS_TOKEN en .env');
  const pref = await mpFetch('/checkout/preferences', {
    method: 'POST',
    body: JSON.stringify({
      items: [{
        title: link.concept,
        quantity: 1,
        currency_id: link.currency || 'COP',
        unit_price: link.amount,
      }],
      external_reference: link.token,
      back_urls: {
        success: `${config.publicBaseUrl}/pay/${link.token}`,
        failure: `${config.publicBaseUrl}/pay/${link.token}`,
        pending: `${config.publicBaseUrl}/pay/${link.token}`,
      },
      notification_url: `${config.publicBaseUrl}/api/public/webhooks/payments/mercadopago`,
      ...(link.expiresAt ? { expires: true, expiration_date_to: new Date(link.expiresAt).toISOString() } : {}),
    }),
  });
  return { externalUrl: pref.init_point };
}

export async function parseWebhook(body, _headers, query = {}) {
  // MP notifica {type:'payment', data:{id}} (webhook) o ?topic=payment&id= (IPN)
  const paymentId = body?.data?.id || (query.topic === 'payment' ? query.id : null) || (body?.type === 'payment' ? body?.id : null);
  if (!paymentId) return { ignored: true };
  const payment = await mpFetch(`/v1/payments/${paymentId}`);
  return {
    reference: payment.external_reference,
    approved: payment.status === 'approved',
    amount: payment.transaction_amount,
    providerRef: String(payment.id),
    method: payment.payment_method_id || 'mercadopago',
  };
}
