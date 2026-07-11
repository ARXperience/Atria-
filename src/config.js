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
};
