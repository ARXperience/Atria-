// Endurecimiento para producción (§50): cabeceras de seguridad y limitador de
// tasa en memoria (sin dependencias externas). Para despliegues multi-instancia
// conviene un limitador compartido (Redis); este cubre el caso de instancia única.
import { config } from '../config.js';

// Cabeceras de seguridad equivalentes a un helmet mínimo.
export function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-XSS-Protection', '0');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  if (config.isProduction) {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  next();
}

// Limitador de tasa por clave (IP, o IP+identificador). Ventana deslizante simple.
export function rateLimit({ windowMs = 60_000, max = 60, keyFn = req => req.ip, onlyFailures = false, message = 'Demasiadas solicitudes, intenta más tarde.' } = {}) {
  const hits = new Map(); // key -> { count, resetAt }
  // Limpieza periódica para no crecer sin límite.
  const timer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of hits) if (v.resetAt <= now) hits.delete(k);
  }, windowMs);
  if (timer.unref) timer.unref();

  return function limiter(req, res, next) {
    const key = keyFn(req) || 'anon';
    const now = Date.now();
    let entry = hits.get(key);
    if (!entry || entry.resetAt <= now) { entry = { count: 0, resetAt: now + windowMs }; hits.set(key, entry); }
    if (entry.count >= max) {
      res.setHeader('Retry-After', Math.ceil((entry.resetAt - now) / 1000));
      return res.status(429).json({ error: message });
    }
    if (onlyFailures) {
      // Cuenta solo respuestas de error (p.ej. login fallido) para no penalizar el uso legítimo.
      res.on('finish', () => { if (res.statusCode >= 400) entry.count++; });
    } else {
      entry.count++;
    }
    next();
  };
}
