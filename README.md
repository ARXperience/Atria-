# ATRIA — Hospitality OS 🏨

Ecosistema hotelero integral con IA para Colombia, basado en el **Documento Funcional Atria Hospitality OS v1.1**. No es un PMS tradicional: es un sistema operativo hotelero donde la operación se puede ejecutar desde interfaz visual **y** desde asistentes conversacionales, con permisos por rol, aprobaciones humanas para acciones sensibles y auditoría total.

## 🚀 Inicio rápido

```bash
cp .env.example .env     # ajustar si se desea
npm install
npm run setup            # crea la base de datos (SQLite) y siembra datos demo
npm start                # http://localhost:4000
```

**Usuarios demo** (contraseña `atria2026`):

| Email | Rol |
|---|---|
| owner@atria.co | Dueño (acceso total) |
| gerente@atria.co | Gerente |
| recepcion@atria.co | Recepción |
| ventas@atria.co | Ventas |
| housekeeping@atria.co | Housekeeping |
| contabilidad@atria.co | Contabilidad |
| auditor@atria.co | Auditor (solo lectura) |

**Pruebas end-to-end**: `npm test` (26 pruebas de los flujos críticos de la sección 48 del documento).

## 📱 Vincular WhatsApp (Baileys)

1. Inicia sesión en el panel → **Inbox / WhatsApp**.
2. Clic en **Conectar / Generar QR**.
3. En el teléfono: WhatsApp → Dispositivos vinculados → Vincular dispositivo → escanear el QR.
4. Listo: Atria IA atiende, cotiza, crea reservas tentativas y envía links de pago automáticamente. La sesión se guarda en `storage/wa-sessions/` y se reanuda sola al reiniciar el servidor.

> Baileys usa el protocolo de WhatsApp Web (no requiere API oficial de Meta ni costos por conversación). Para producción de alto volumen se recomienda migrar a WhatsApp Business API; la arquitectura del inbox es agnóstica al canal, por lo que el cambio no afecta al resto del sistema.

## 🤖 Atria IA

El asistente externo funciona **sin ninguna API key** con un motor determinístico de intenciones en español (fechas tipo "del 20 al 23 de diciembre para 2 adultos", selección de opciones, confirmación, escalamiento). Si configuras `ANTHROPIC_API_KEY` en `.env`, Claude refuerza la extracción de entidades y las respuestas naturales de fallback.

Flujo completo implementado (sección 48.1 del documento):
**WhatsApp → intención → disponibilidad real → cotización con impuestos → reserva tentativa (bloqueo 24 h) → link de pago → webhook de pasarela → confirmación → voucher → TRA/SIRE → CRM**.

Guardrails: la IA nunca ofrece reembolsos/descuentos/compensaciones; quejas y solicitudes sensibles escalan a humano (la IA queda en pausa y recepción recibe alerta). Toda acción de IA queda en auditoría con actor `ai`.

## 💳 Pagos

- `PAYMENT_PROVIDER=mock` (por defecto): checkout simulado funcional en `/pay/<token>` — ideal para demo y desarrollo.
- `PAYMENT_PROVIDER=wompi`: soporta webhook real de Wompi con validación de firma de eventos (`/api/public/webhooks/payments/wompi`). Configura las llaves en `.env`.
- Pagos manuales (efectivo/transferencia) y reembolsos **siempre** pasan por el motor de aprobaciones (matriz sección 47).

## 🧩 Módulos implementados (Fase 1 + parte de Fase 2)

| Módulo Atria | Alcance |
|---|---|
| **Atria Core** | Multiempresa/multi-sede, usuarios, 9 roles con permisos validados en backend, parámetros legales versionados por vigencia, auditoría transversal (humano/IA/sistema), bus de eventos de dominio |
| **Atria PMS** | Habitaciones, mapa por estados, reservas, asignación automática, check-in (valida anticipo + TRA), folios y cargos, check-out (valida saldo), estados de habitación |
| **Atria Booking** | Disponibilidad real anti-sobreventa, cotización con IVA parametrizable, planes tarifarios (flexible/no reembolsable), reserva tentativa con vencimiento y job de expiración/recuperación |
| **Atria Connect** | Inbox omnicanal (WhatsApp + webchat), WhatsApp por Baileys con QR desde el panel, transferencia a humano y devolución a IA, CRM con leads automáticos y scoring |
| **Atria Pay** | Links de pago, webhook idempotente, confirmación automática al cubrir anticipo, pagos manuales y reembolsos con aprobación |
| **Atria IA** | Asistente externo conversacional completo (determinístico + Claude opcional), voucher automático, encuesta post-checkout, seguimiento de abandono |
| **Atria Compliance** | RNT con alerta de vencimiento, TRA automática con control de campos faltantes, detección de extranjeros y checklist SIRE (marcar reportado exige humano) |
| **Atria Ops** | Housekeeping (tarea automática al check-out, ciclo sucia→limpia→inspeccionada), mantenimiento con bloqueo de habitación vía aprobación |
| **Gobierno** | Motor de aprobaciones por tipo/rol con ejecución al aprobar, notificaciones internas por rol, dashboard gerencial (ocupación, ADR, RevPAR, llegadas/salidas) |

**Páginas públicas**: checkout de pago (`/pay/<token>`), portal del huésped (`/guest/<código>`), webchat (`/chat.html?propertyId=...`).

## 🗺️ Roadmap (fases siguientes del documento)

- **Fase 2 restante**: facturación electrónica DIAN (requiere contratar proveedor tecnológico), portal huésped completo (pre check-in con carga de documentos/OCR), caja.
- **Fase 3**: RR. HH., contratos, turnos/recargos, nómina + nómina electrónica DIAN, PILA, prestaciones, SG-SST, compras/inventario. *(El modelo de parámetros legales versionados ya está listo para estos cálculos.)*
- **Fase 4**: channel manager (OTAs), revenue management, marketing automation, reputación, eventos/corporativos.
- **Fase 5**: agentes IA por área con function calling sobre la API interna, RAG documental, BI.

Integraciones que requieren credenciales del hotel: proveedor DIAN, pasarela (Wompi/otra), Meta/Instagram, OTAs, operador PILA.

## 🏗️ Arquitectura

- **Backend**: Node.js 20+ / Express (ESM), servicios de dominio + bus de eventos interno.
- **Base de datos**: Prisma ORM — SQLite por defecto (cero configuración), cambiar a PostgreSQL en producción editando `DATABASE_URL` y el `provider` en `prisma/schema.prisma`.
- **WhatsApp**: `@whiskeysockets/baileys` (multi-sesión por sede).
- **Frontend**: SPA sin build servida por el mismo servidor (`public/`).
- **Seguridad**: JWT, bcrypt, permisos por rol y por sede validados en backend, eliminación lógica, logs de auditoría inmutables por API.

```
src/
  server.js            # arranque, rutas, jobs
  config.js            # variables de entorno
  middleware/auth.js   # JWT + matriz de permisos por rol
  lib/                 # eventos, auditoría, logger, utilidades
  services/            # dominio: availability, quote, reservations, payments,
                       #   approvals, compliance, inbox, whatsapp (Baileys),
                       #   automations, ai/ (assistant + dates + claude)
  routes/              # API REST por módulo
prisma/schema.prisma   # modelo de datos completo
public/                # panel admin + pay + guest + chat
test/smoke.test.js     # 26 pruebas end-to-end
```

> ⚠️ Los valores legales sembrados (SMMLV, UVT, etc.) son **ejemplos**: actualízalos en Configuración → Parámetros legales con las fuentes oficiales vigentes antes de usar en producción. Este software apoya el cumplimiento operativo pero no reemplaza asesoría legal/contable.
