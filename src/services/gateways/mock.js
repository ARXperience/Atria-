// Simulador de pasarela: checkout interno en /pay/<token>. Siempre disponible.
export const label = 'Simulador (pruebas)';

export function isConfigured() {
  return true;
}

export async function createCheckout(_link) {
  return { externalUrl: null }; // usa la página interna /pay/<token>
}

export function parseWebhook(body) {
  if (!body?.reference) throw new Error('Payload mock inválido: falta reference');
  return {
    reference: body.reference,
    approved: body.status ? body.status === 'APPROVED' : true,
    providerRef: body.txId || null,
    method: body.method || 'mock',
  };
}
