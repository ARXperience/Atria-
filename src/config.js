import 'dotenv/config';

export const config = {
  port: Number(process.env.PORT || 4000),
  jwtSecret: process.env.JWT_SECRET || 'atria-dev-secret',
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
