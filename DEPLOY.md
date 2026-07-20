# Guía de despliegue a producción — Atria Hospitality OS

Checklist para llevar Atria de la demo local a un entorno productivo seguro.

## 1. Variables de entorno (obligatorias)

Copia `.env.example` a `.env` y define, como mínimo:

| Variable | Por qué |
|---|---|
| `NODE_ENV=production` | Activa las guardas de seguridad (el arranque **aborta** si hay secretos por defecto) y HSTS. |
| `JWT_SECRET` | Cadena aleatoria de **≥ 24 caracteres** (`openssl rand -base64 48`). Nunca la de demo. |
| `SEED_PASSWORD` | Contraseña fuerte para los usuarios sembrados (o crea usuarios reales y no siembres demo). |
| `DATABASE_URL` | PostgreSQL en producción (ver abajo). |
| `PUBLIC_BASE_URL` | URL pública real (HTTPS) para links de pago y portal del huésped. |

> Con `NODE_ENV=production`, si `JWT_SECRET` o `SEED_PASSWORD` faltan o son los de demo, el servidor **no arranca** (ver `assertProductionConfig`).

## 2. Base de datos (PostgreSQL)

SQLite es solo para demo/desarrollo. Para producción:

```bash
# .env
DATABASE_URL="postgresql://usuario:clave@host:5432/atria?schema=public"
```

En `prisma/schema.prisma` cambia el `datasource`:

```prisma
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}
```

Luego:

```bash
npx prisma migrate deploy   # aplica migraciones (usa migrate, no db push, en prod)
```

- Habilita **backups automáticos** y **point-in-time recovery** del proveedor gestionado.
- Restringe el acceso de red a la base solo desde la app.

## 3. Seguridad ya incluida

- **Cabeceras de seguridad** en todas las respuestas (`X-Content-Type-Options`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, y `Strict-Transport-Security` en prod).
- **Rate limiting anti fuerza-bruta** en `/api/auth/login` (10 intentos fallidos por IP / 15 min → 429).
- **Permisos por rol validados en backend** en cada endpoint.
- **Auditoría transversal** de toda acción (actor `human|ai|system`).
- **Aprobaciones humanas** obligatorias para acciones sensibles (pagos manuales, reembolsos, cierre de nómina, supresión de datos, etc.).
- **Secretos de integraciones enmascarados** al leerse desde la API.
- `.env`, `*.db`, `storage/` y sesiones de WhatsApp están en `.gitignore`.

## 4. Recomendado para el despliegue

- **HTTPS obligatorio** (terminación TLS en el proxy/balanceador). La app confía en `X-Forwarded-*` (`trust proxy` activo).
- Poner Atria detrás de un **reverse proxy** (Nginx/Caddy) o plataforma (Railway, Render, Fly.io, ECS).
- **Proceso gestionado** (systemd, PM2 o el orquestador del PaaS) con reinicio automático; el server maneja `SIGTERM` para cierre ordenado.
- Para **múltiples instancias**, el rate limiter en memoria debe migrarse a uno compartido (Redis) — la arquitectura lo permite (un solo punto en `src/middleware/security.js`).
- Rotar `JWT_SECRET` invalida todas las sesiones activas (los tokens expiran a las 12 h de todos modos).
- Configura las **pasarelas de pago** y **Dataico** con credenciales reales vía `.env` (ver README) y registra los **webhooks** con tu `PUBLIC_BASE_URL`.
- **WhatsApp (Baileys)**: la sesión vive en `storage/wa-sessions/`; monta un volumen persistente para no re-escanear el QR en cada despliegue.

## 5. Salud y monitoreo

- Endpoint de salud: `GET /api/health` (verifica la conexión a la base).
- Los logs salen por `stdout` en JSON (pino) — envíalos a tu agregador (Datadog, Loki, CloudWatch).
- El job de cumplimiento y de expiración de reservas corre dentro del proceso; con múltiples instancias, considera aislarlo en un worker único para evitar duplicados.

## 6. Pre-lanzamiento

```bash
npm ci
npm test            # 172 pruebas end-to-end deben quedar en verde
NODE_ENV=production node -e "import('./src/config.js').then(m=>m.assertProductionConfig(console))"  # valida secretos
```
