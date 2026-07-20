// Atria Hospitality OS — servidor principal (API + panel admin + páginas públicas)
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config, assertProductionConfig } from './config.js';
import { logger } from './lib/logger.js';
import { securityHeaders, rateLimit } from './middleware/security.js';
import { prisma } from './db.js';
import { authRequired } from './middleware/auth.js';
import { authRouter } from './routes/auth.js';
import { adminRouter } from './routes/admin.js';
import { bookingRouter } from './routes/booking.js';
import { reservationsRouter } from './routes/reservations.js';
import { paymentsRouter } from './routes/payments.js';
import { inboxRouter } from './routes/inbox.js';
import { crmRouter } from './routes/crm.js';
import { opsRouter } from './routes/ops.js';
import { complianceRouter } from './routes/compliance.js';
import { hrRouter } from './routes/hr.js';
import { invoicesRouter } from './routes/invoices.js';
import { documentsRouter } from './routes/documents.js';
import { contentRouter } from './routes/content.js';
import { assistantRouter } from './routes/assistant.js';
import { sgsstRouter } from './routes/sgsst.js';
import { inventoryRouter } from './routes/inventory.js';
import { posRouter } from './routes/pos.js';
import { revenueRouter } from './routes/revenue.js';
import { channelsRouter } from './routes/channels.js';
import { financeRouter } from './routes/finance.js';
import { dataProtectionRouter } from './routes/dataProtection.js';
import { fonturRouter } from './routes/fontur.js';
import { portfolioRouter } from './routes/portfolio.js';
import { marketingRouter } from './routes/marketing.js';
import { reputationRouter } from './routes/reputation.js';
import { eventsRouter } from './routes/events.js';
import { integrationsRouter } from './routes/integrations.js';
import { automationsRouter } from './routes/automations.js';
import { miscRouter } from './routes/misc.js';
import { publicRouter } from './routes/public.js';
import { registerAutomations } from './services/automations.js';
import { registerRuleEngine } from './services/automationRules.js';
import { expireStaleTentatives } from './services/reservations.js';
import { resumeSavedSessions } from './services/whatsapp.js';
import { checkExpiringDocuments } from './services/documents.js';
import { runAllComplianceRules } from './services/rulesEngine.js';

// Aborta el arranque si la configuración de producción es insegura (secretos por defecto).
assertProductionConfig(logger);

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');
app.use(securityHeaders);
// rawBody se conserva para verificar firmas de webhooks (Stripe/Bold).
// Límite alto para permitir carga de documentos en base64 (§43).
app.use(express.json({ limit: '20mb', verify: (req, _res, buf) => { req.rawBody = buf.toString('utf8'); } }));

// Anti fuerza-bruta: limita intentos de acceso FALLIDOS por IP (no penaliza logins válidos).
const loginLimiter = rateLimit({ windowMs: 15 * 60_000, max: 10, onlyFailures: true, message: 'Demasiados intentos de acceso fallidos. Espera unos minutos e intenta de nuevo.' });

// Salud
app.get('/api/health', async (_req, res) => {
  try {
    await prisma.$queryRaw`SELECT 1`;
    res.json({ ok: true, service: 'atria', time: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// Rutas públicas (webhooks, pagos, webchat, portal huésped)
app.use('/api/public', publicRouter);

// Rutas autenticadas
app.use('/api/auth/login', loginLimiter);
app.use('/api/auth', authRouter);
app.use('/api/admin', authRequired, adminRouter);
app.use('/api/booking', authRequired, bookingRouter);
app.use('/api/reservations', authRequired, reservationsRouter);
app.use('/api/payments', authRequired, paymentsRouter);
app.use('/api/inbox', authRequired, inboxRouter);
app.use('/api/crm', authRequired, crmRouter);
app.use('/api/ops', authRequired, opsRouter);
app.use('/api/compliance', authRequired, complianceRouter);
app.use('/api/hr', authRequired, hrRouter);
app.use('/api/invoices', authRequired, invoicesRouter);
app.use('/api/documents', authRequired, documentsRouter);
app.use('/api/content', authRequired, contentRouter);
app.use('/api/assistant', authRequired, assistantRouter);
app.use('/api/sgsst', authRequired, sgsstRouter);
app.use('/api/inventory', authRequired, inventoryRouter);
app.use('/api/pos', authRequired, posRouter);
app.use('/api/revenue', authRequired, revenueRouter);
app.use('/api/channels', authRequired, channelsRouter);
app.use('/api/finance', authRequired, financeRouter);
app.use('/api/dataprotection', authRequired, dataProtectionRouter);
app.use('/api/fontur', authRequired, fonturRouter);
app.use('/api/portfolio', authRequired, portfolioRouter);
app.use('/api/marketing', authRequired, marketingRouter);
app.use('/api/reputation', authRequired, reputationRouter);
app.use('/api/events', authRequired, eventsRouter);
app.use('/api/integrations', authRequired, integrationsRouter);
app.use('/api/automations', authRequired, automationsRouter);
app.use('/api', authRequired, miscRouter);

// Frontend estático: panel admin + página de pago + portal huésped
const publicDir = path.join(__dirname, '..', 'public');
app.use(express.static(publicDir));
app.get('/pay/:token', (_req, res) => res.sendFile(path.join(publicDir, 'pay.html')));
app.get('/guest/:code', (_req, res) => res.sendFile(path.join(publicDir, 'guest.html')));
app.get('/sitio/:propertyId', (_req, res) => res.sendFile(path.join(publicDir, 'hotel.html')));
app.get('/', (_req, res) => res.sendFile(path.join(publicDir, 'index.html')));

// Manejo de errores
app.use((err, _req, res, _next) => {
  logger.error({ err }, 'unhandled error');
  res.status(500).json({ error: 'Error interno del servidor' });
});

// Automatizaciones por eventos + jobs programados
registerAutomations();
registerRuleEngine();
setInterval(() => {
  expireStaleTentatives().catch(err => logger.error({ err }, 'expire job failed'));
}, 60_000);
// Cumplimiento diario (§48): vencimiento de documentos + motor de reglas.
// Se ejecuta al arrancar y cada 6 horas (las alertas son idempotentes).
async function complianceSweep() {
  await checkExpiringDocuments().catch(err => logger.error({ err }, 'document expiry job failed'));
  await runAllComplianceRules().catch(err => logger.error({ err }, 'compliance rules job failed'));
}
setInterval(complianceSweep, 6 * 3600_000);
setTimeout(complianceSweep, 8000);

const server = app.listen(config.port, () => {
  logger.info(`Atria Hospitality OS escuchando en http://localhost:${config.port}`);
  // Reanudar sesiones de WhatsApp guardadas (no bloquea el arranque)
  resumeSavedSessions().catch(err => logger.error({ err }, 'whatsapp resume failed'));
});

process.on('SIGTERM', () => server.close(() => process.exit(0)));

export default app;
