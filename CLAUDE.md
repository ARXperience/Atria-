# Atria Hospitality OS — Guía para Claude

Ecosistema hotelero integral con IA para Colombia (PMS, motor de reservas, CRM,
WhatsApp IA por Baileys, pagos multi-pasarela, facturación Dataico, nómina,
cumplimiento). Backend Node/Express + Prisma; frontend SPA en JS vanilla.

## Comandos
- `npm run setup` — crea la base (SQLite) y siembra datos demo.
- `npm start` — servidor en http://localhost:4000 (login: `gerente@atria.co` / `atria2026`).
- `npm test` — suite end-to-end (debe quedar SIEMPRE en verde antes de commitear).

## Convenciones
- **Frontend sin build:** edita `public/app.js` (vistas + helpers) y `public/styles.css`
  (sistema visual). No introduzcas React/Tailwind/bundlers.
- **Diseño / Figma:** sigue **`DESIGN.md`** — tokens CSS en `:root`, componentes como
  funciones string→HTML, motion suave, tema dark único. Léelo antes de tocar la UI.
- **Backend:** un router por módulo en `src/routes/`, lógica en `src/services/`,
  permisos por rol en `src/middleware/auth.js`. Toda acción sensible pasa por el
  motor de aprobaciones y queda en auditoría (`actor: human|ai|system`).
- **Parámetros legales/laborales:** nunca quemados en código; van en
  `LegalParameter` versionados por vigencia.
- Escapa todo texto dinámico en el frontend con `esc()`.
- Al terminar un cambio: `npm test` en verde, luego commit + push.
