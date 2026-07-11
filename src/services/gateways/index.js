// Registro de pasarelas de pago conectables (Atria Pay, sección 15).
// Cada adaptador implementa la misma interfaz:
//   isConfigured()            → boolean (tiene credenciales)
//   createCheckout(link)      → { externalUrl } URL de pago de la pasarela
//                               (null = usar la página interna /pay/<token>)
//   parseWebhook(body, headers) → { reference, approved, amount?, providerRef, method }
//                               o { ignored: true } si el evento no aplica
// Para agregar una pasarela nueva: crear el archivo, exportarla aquí y listo.
import * as mock from './mock.js';
import * as wompi from './wompi.js';
import * as mercadopago from './mercadopago.js';
import * as bold from './bold.js';
import * as stripe from './stripe.js';

const GATEWAYS = { mock, wompi, mercadopago, bold, stripe };

export function getGateway(name) {
  const gw = GATEWAYS[name];
  if (!gw) throw new Error(`Pasarela desconocida: ${name}. Disponibles: ${Object.keys(GATEWAYS).join(', ')}`);
  return gw;
}

export function gatewayNames() {
  return Object.keys(GATEWAYS);
}

export function gatewaysStatus() {
  return Object.entries(GATEWAYS).map(([name, gw]) => ({
    name,
    configured: gw.isConfigured(),
    label: gw.label,
  }));
}
