# ATRIA — Hospitality OS 🏨

Ecosistema hotelero integral con IA para Colombia, basado en el **Documento Funcional Atria Hospitality OS v1.1**. No es un PMS tradicional: es un sistema operativo hotelero donde la operación se puede ejecutar desde interfaz visual **y** desde asistentes conversacionales, con permisos por rol, aprobaciones humanas para acciones sensibles y auditoría total.

## 🚀 Inicio rápido

```bash
cp .env.example .env     # ajustar si se desea
npm install
npm run setup            # crea la base de datos (SQLite) y siembra datos demo
npm start                # http://localhost:4000
```

**Usuarios demo** (dominio ficticio `@atria.co`, contraseña por defecto `atria2026`):

| Email | Rol |
|---|---|
| owner@atria.co | Dueño (acceso total) |
| gerente@atria.co | Gerente |
| recepcion@atria.co | Recepción |
| ventas@atria.co | Ventas |
| housekeeping@atria.co | Housekeeping |
| contabilidad@atria.co | Contabilidad |
| rrhh@atria.co | RR. HH. |
| auditor@atria.co | Auditor (solo lectura) |

> ⚠️ **Seguridad**: estas credenciales son **solo para la demo local** — el dominio
> `@atria.co` es ficticio y la contraseña solo abre la base sembrada. **En producción**
> define `SEED_PASSWORD` con una clave fuerte (ver `.env.example`) o cambia las
> contraseñas tras el primer arranque, y usa correos reales. Nunca reutilices esta
> contraseña en cuentas reales.

**Pruebas end-to-end**: `npm test` (291 pruebas de los flujos críticos de la sección 48 del documento).

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

## 💳 Pagos multi-pasarela

Arquitectura de adaptadores conectables (`src/services/gateways/`): cada pasarela implementa la misma interfaz (`createCheckout` + `parseWebhook` normalizado). Se pueden tener **varias configuradas a la vez** y elegir pasarela por link de pago; `PAYMENT_PROVIDER` define la de por defecto.

| Pasarela | Variables `.env` | Webhook a registrar |
|---|---|---|
| **Simulador** (`mock`) | ninguna | — (checkout interno `/pay/<token>`) |
| **Wompi** | `WOMPI_PUBLIC_KEY`, `WOMPI_EVENTS_SECRET` | `…/api/public/webhooks/payments/wompi` |
| **Mercado Pago** | `MP_ACCESS_TOKEN` | `…/api/public/webhooks/payments/mercadopago` |
| **Bold** | `BOLD_API_KEY`, `BOLD_SECRET_KEY` | `…/api/public/webhooks/payments/bold` |
| **Stripe** | `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET` | `…/api/public/webhooks/payments/stripe` (evento `checkout.session.completed`) |

Todas verifican firma de webhook cuando el secreto está configurado, son idempotentes (un pago no se duplica) y confirman la reserva automáticamente al cubrir el anticipo. Para agregar otra pasarela: crear un archivo en `src/services/gateways/` y registrarlo en `index.js`.

Pagos manuales (efectivo/transferencia) y reembolsos **siempre** pasan por el motor de aprobaciones (matriz sección 47).

## 🧾 Facturación electrónica (Dataico)

Módulo **Atria Fiscal** integrado con [Dataico](https://www.dataico.com) como proveedor tecnológico DIAN:

- Al hacer check-out se genera **automáticamente un borrador de factura** desde el folio del huésped (cargos + impuestos).
- **Sin credenciales** (estado actual): las facturas se numeran localmente (`ATR-1001…`) y quedan en estado `pending`, listas para transmitir.
- **Con credenciales** (`DATAICO_AUTH_TOKEN` + `DATAICO_ACCOUNT_ID` en `.env`): el botón "Emitir" transmite a la DIAN vía Dataico y guarda el CUFE. `DATAICO_ENV=test|prod` controla el ambiente.
- Rechazos/errores quedan registrados con el mensaje del proveedor para corrección (sección 16 del documento).

## 👔 Nómina colombiana (Fase 3 — Atria People)

- **Empleados**: expediente con cargo, salario, contrato, afiliaciones (EPS/AFP/ARL/CCF/cesantías) y clase de riesgo ARL. Cambios de salario y terminación de contrato exigen aprobación del dueño.
- **Novedades**: horas extras diurnas/nocturnas, recargos nocturnos y dominicales/festivos, ausencias, incapacidades, bonos, comisiones, deducciones y préstamos — con flujo de aprobación previo a nómina (sección 21).
- **Liquidación mensual**: salario proporcional por días, auxilio de transporte (≤ 2 SMMLV), horas extras con tarifas parametrizadas, IBC, salud/pensión 4%, FSP, y costos patronales completos (salud/pensión empleador, ARL por clase, CCF, SENA, ICBF) + provisiones (prima, cesantías, intereses, vacaciones). **Todo sale de la tabla de parámetros legales versionados** — nada quemado en código (criterio 50.9).
- **Desprendible transparente** por empleado con el detalle de cada concepto (revisable por el contador).
- **Cerrar nómina exige aprobación del dueño** (matriz 47) — el gerente no puede autoaprobar (verificado por test).
- **Simulador de liquidación de contrato**: cesantías, intereses, prima proporcional, vacaciones e indemnización por despido sin justa causa.

> Pendiente de fase posterior: transmisión de nómina electrónica DIAN (requiere proveedor tecnológico) y archivo PILA para operador.

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

## 📁 Centro documental, plantillas y reglas (Ola 1)

- **Centro documental** (§43): carga de archivos (PDF/imagen hasta 15 MB), clasificación por tipo, asociación a empresa/sede/empleado/huésped/proveedor, **versionado** (una versión nueva supersede la anterior), descarga y **alertas automáticas de vencimiento**. Eliminar un documento legal (RUT, RNT, contrato, póliza, certificado) **requiere aprobación del dueño**.
- **Plantillas de mensajes** (§7): WhatsApp/email/voucher con variables `{{nombre}}`, `{{codigo}}`, `{{total}}`.
- **Políticas hoteleras** (§7): cancelación, check-in, mascotas, no-show, etc., con texto público.
- **Motor de reglas de cumplimiento** (§39): reglas versionables y parametrizables (anticipación, severidad, destinatario) que se ejecutan **automáticamente cada 6 horas** revisando RNT, documentos, TRA, SIRE y contratos por vencer, y generan alertas. Botón "Ejecutar ahora" en el panel.

## 🤖 Atria IA — Agente con conocimiento, persona y control de funciones (Track IA)

El agente de WhatsApp/webchat ahora es **configurable por hotel** y responde con el **conocimiento real** que el administrador carga:

- **IA-1 · Contenido y conocimiento** (menú *Habitaciones & Conocimiento*): editor de cada habitación (descripción larga, camas, tamaño, vista, amenidades e **imágenes**) + **base de conocimiento** (FAQs, servicios, ubicación) con visibilidad pública/interna. Las imágenes se sirven por URL pública para web y agente.
- **IA-2 · Persona por hotel** (menú *Agente IA*): nombre de la "mascota", tono, idiomas, saludo, uso de emojis, **guardrail de solo-dominio** (no habla de otros temas) y on/off de IA natural. Cada hotel tiene su propio agente.
- **IA-4 · Copiloto interno**: asistente dentro del panel para el equipo (recepción, housekeeping, mantenimiento, contabilidad, RR.HH.), que responde en lenguaje natural sobre habitaciones, llegadas/salidas, aprobaciones, limpiezas, mantenimiento, caja y nómina — **solo con la información que el rol del usuario puede ver**.
- **IA-3 · Control de funciones**: el agente ejecuta herramientas por conversación — consultar disponibilidad, cotizar, **crear reserva + link de pago**, dar datos de habitación/hotel y **notificar al equipo** — con permisos, aprobaciones y auditoría. Nunca ofrece reembolsos/descuentos: escala a una persona.

**Cómo funciona la IA según tengas o no API key:**
- **Sin `ANTHROPIC_API_KEY`**: el agente responde con el conocimiento configurado (busca en FAQs, habitaciones y políticas) y ejecuta el flujo completo de reserva de forma determinística. Ya es útil desde el primer momento.
- **Con `ANTHROPIC_API_KEY`**: además conversa en lenguaje natural y **decide qué herramientas llamar** (function-calling) manteniendo la persona y los guardrails del hotel.

Prueba el agente sin salir del panel: *Agente IA → Probar al agente*.

## 🗺️ Roadmap (fases siguientes del documento)

- **Fase 2 restante**: portal huésped completo (pre check-in con carga de documentos/OCR), caja.
- **Fase 3 restante**: turnos/cuadrantes con marcación, nómina electrónica DIAN (proveedor), archivo PILA, SG-SST, compras/inventario.
- **Fase 4**: channel manager (OTAs), revenue management, marketing automation, reputación, eventos/corporativos.
- **Fase 5**: agentes IA por área con function calling sobre la API interna, RAG documental, BI.

Integraciones que requieren credenciales del hotel: Dataico (facturación), llaves de pasarelas (Wompi/MercadoPago/Bold/Stripe), Meta/Instagram, OTAs, operador PILA.

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
test/smoke.test.js     # 170 pruebas end-to-end
```

> ⚠️ Los valores legales sembrados (SMMLV, UVT, etc.) son **ejemplos**: actualízalos en Configuración → Parámetros legales con las fuentes oficiales vigentes antes de usar en producción. Este software apoya el cumplimiento operativo pero no reemplaza asesoría legal/contable.
