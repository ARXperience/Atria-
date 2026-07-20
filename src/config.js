import 'dotenv/config';

const DEV_JWT_SECRET = 'atria-dev-secret';

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  isProduction: process.env.NODE_ENV === 'production',
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || DEV_JWT_SECRET,
  tentativeHoldHours: Number(process.env.TENTATIVE_HOLD_HOURS || 24),
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`,
  whatsappEnabled: (process.env.WHATSAPP_ENABLED || 'true') !== 'false',
  anthropicApiKey: process.env.ANTHROPIC_API_KEY || '',
  anthropicModel: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5',
  paymentProvider: process.env.PAYMENT_PROVIDER || 'mock',
  wompi: {
    publicKey: process.env.WOMPI_PUBLIC_KEY || '',
    privateKey: process.env.WOMPI_PRIVATE_KEY || '',
    eventsSecret: process.env.WOMPI_EVENTS_SECRET || '',
  },
  mercadopago: {
    accessToken: process.env.MP_ACCESS_TOKEN || '',
  },
  bold: {
    apiKey: process.env.BOLD_API_KEY || '',
    secretKey: process.env.BOLD_SECRET_KEY || '',
  },
  stripe: {
    secretKey: process.env.STRIPE_SECRET_KEY || '',
    webhookSecret: process.env.STRIPE_WEBHOOK_SECRET || '',
  },
  dataico: {
    authToken: process.env.DATAICO_AUTH_TOKEN || '',
    accountId: process.env.DATAICO_ACCOUNT_ID || '',
    invoicePrefix: process.env.DATAICO_INVOICE_PREFIX || 'ATR',
    env: process.env.DATAICO_ENV || 'test', // test | prod
  },
};

// Guardas de arranque para producción: no permitir secretos por defecto.
export function assertProductionConfig(logger) {
  if (!config.isProduction) return;
  const problems = [];
  if (!process.env.JWT_SECRET || config.jwtSecret === DEV_JWT_SECRET || config.jwtSecret.length < 24) {
    problems.push('JWT_SECRET ausente, por defecto o demasiado corto (usa ≥ 24 caracteres aleatorios).');
  }
  if ((process.env.SEED_PASSWORD || 'atria2026') === 'atria2026') {
    problems.push('SEED_PASSWORD no definido: los usuarios sembrados usarían la contraseña de demo.');
  }
  if (problems.length) {
    const msg = `Configuración insegura para producción:\n - ${problems.join('\n - ')}`;
    if (logger) logger.error(msg); else console.error(msg);
    throw new Error('Arranque abortado por configuración insegura (NODE_ENV=production).');
  }
}
