# Atria Hospitality OS — Reglas del sistema de diseño (integración Figma vía MCP)

Este documento es la fuente de verdad para traducir diseños de Figma a código en
este repositorio. Léelo antes de implementar cualquier pantalla o componente.

**Principio rector de UX:** la interfaz debe sentirse como *una experiencia
hospitalaria*, no como "navegar un sistema". Elegante, cálida, con movimiento
suave y con intención. Cada acción responde (hover, foco, transición); nada
aparece de golpe; nada distrae del trabajo.

---

## 0. Stack real (resumen para no asumir de más)

| Aspecto | Realidad de este repo |
|---|---|
| Framework UI | **Ninguno.** SPA en JavaScript vanilla (sin React/Vue). |
| Build / bundler | **Ninguno.** Los archivos de `public/` se sirven tal cual por Express. |
| Estilos | **Un solo CSS global** con custom properties: `public/styles.css`. |
| Componentes | **Funciones JS que devuelven strings de HTML**, renderizadas con `innerHTML`. |
| Ruteo | Hash routing (`location.hash`) en `public/app.js`. |
| Iconos | **Emoji** como glifos (no hay librería de iconos). |
| Assets | Imágenes en el centro documental; se sirven por `/api/public/media/:id`. |
| Tema | **Dark-first, tema único** (decisión deliberada de marca). |

> No introduzcas React, Tailwind, styled-components ni un bundler para
> implementar un diseño de Figma. Traduce a **tokens CSS + funciones-plantilla**.

---

## 1. Tokens de diseño

**Dónde:** `public/styles.css`, bloque `:root`. Son la única capa de tokens.
No hay Style Dictionary ni transformación: se consumen directo como `var(--x)`.

### Formato
```css
:root {
  /* Superficies (navy cálido) */
  --bg: #0c1016;  --bg-elev: #12171f;  --surface: #161d27;
  --surface-2: #1c2530;  --surface-3: #222c39;
  --border: #28313e;  --border-soft: #202834;
  /* Texto */
  --text: #eef1f6;  --text-dim: #aeb7c4;  --muted: #7e8a99;
  /* Acento (oro Atria) */
  --accent: #d8b064;  --accent-hi: #e7c583;  --accent-lo: #b7924a;
  --accent-grad: linear-gradient(135deg,#e2bd76,#c99a4c);
  --accent-soft: rgba(216,176,100,.13);  --accent-ring: rgba(216,176,100,.38);
  /* Semánticos (separados del acento) */
  --green / --red / --yellow / --blue  (+ sus *-soft)
  /* Radios */    --r-sm:8px; --r-md:11px; --r-lg:16px; --r-pill:999px;
  /* Elevación */ --shadow-sm/md/lg; --glow;
  /* Movimiento */ --dur-1:120ms; --dur-2:220ms; --dur-3:380ms;
                   --ease: cubic-bezier(.22,.61,.36,1);
                   --ease-out: cubic-bezier(.16,1,.3,1);
  /* Tipografía */ --font; --step--1:12 → --step-3:26;
}
```

### Reglas al mapear tokens de Figma
1. **Color de Figma → variable existente.** Si el diseño trae un color nuevo,
   primero busca el token semántico equivalente (`--accent`, `--green`…). Solo
   agrega un token nuevo si de verdad no existe, y nómbralo por función
   (`--accent`, no `--gold-500`).
2. El **oro `--accent` es el único color de marca**; gástalo en 1 elemento por
   pantalla (acción principal, valor destacado). Lo demás, superficies neutras.
3. Los **semánticos (verde/ámbar/rojo/azul) no son el acento**: codifican estado
   (bien/advertencia/crítico/info), no decoración.
4. Respeta la escala de radios y de tipografía; no inventes tamaños sueltos.

---

## 2. Componentes

**Dónde:** `public/app.js`. Cada "pantalla" es una función `async viewX()` que
retorna HTML; los helpers producen los átomos reutilizables.

### Arquitectura
- `render()` → resuelve la vista por hash → `renderShell(html, title)` pinta el
  chrome (sidebar + topbar) → inyecta el HTML de la vista en `#content`.
- Los componentes son **funciones puras string→HTML**, no clases ni JSX.

### Átomos / helpers (reutilízalos, no re-inventes)
```js
badge(text, color)        // píldora de estado: 'green'|'red'|'yellow'|'blue'|'gray'
sb(status)                // badge desde un estado de dominio (map en STATUS_BADGE)
cop(n) / dt(d) / day(d)   // formato COP, fecha-hora, fecha
esc(str)                  // ESCAPA SIEMPRE texto dinámico (previene XSS)
modal(html)               // overlay centrado con animación scaleIn
toast(msg, isError)       // notificación efímera (slideInRight)
api(path, {method,body})  // fetch autenticado; get(p) para GET simple
```

### Patrón de una vista (síguelo)
```js
async function viewEjemplo() {
  const data = await get(`/recurso?${pid()}`);       // pid() = propertyId actual
  window._accion = async id => {                       // handlers en window._*
    try { await api(`/recurso/${id}`, { method: 'POST' }); toast('Hecho'); render(); }
    catch (err) { toast(err.message, true); }
  };
  return `
    <div class="card"><h3>Título</h3>
      <table>
        <tr><th>Col</th><th>Estado</th></tr>
        ${data.map(r => `<tr class="clickable" onclick="location.hash='x:${r.id}'">
          <td>${esc(r.nombre)}</td><td>${sb(r.status)}</td></tr>`).join('')}
      </table>
      ${data.length ? '' : '<p class="muted">Estado vacío con guía de qué hacer.</p>'}
    </div>`;
}
```
Regístrala en el objeto `VIEWS` y, si va al menú, en `NAV`.

**No hay Storybook.** La "documentación viva" son las vistas existentes: copia
sus patrones (card → h3 → tabla/form → estado vacío).

---

## 3. Frameworks y librerías

- **UI:** JS vanilla (ES modules del lado servidor; el frontend es un IIFE).
- **Estilos:** CSS puro con custom properties. Sin preprocesador.
- **Backend:** Node 20 + Express + Prisma (SQLite/PostgreSQL). Irrelevante para
  el diseño salvo por los endpoints que la vista consume.
- **Build:** no hay. Editar `public/*` y recargar (Ctrl+F5) es todo el ciclo.

Si un diseño de Figma exige un componente complejo (date range, gráfica), impleméntalo
en vanilla + CSS o Canvas; **no** agregues dependencias de frontend sin acordarlo.

---

## 4. Gestión de assets

- **Imágenes** (fotos de habitaciones, logos de hotel) se suben al **centro
  documental** (`POST /api/documents`, `docType:'image'`, base64) y se sirven
  públicamente por `GET /api/public/media/:id` (solo sirve `docType=image`).
- Referencia en la UI: `<img src="/api/public/media/${doc.id}">`.
- **Optimización:** header `Cache-Control: public, max-age=86400` en media. No hay
  CDN ni resizing; sube imágenes ya optimizadas (≤ ~1–2 MB, máx 15 MB).
- Para **iconografía vectorial** de un diseño Figma, incrusta SVG inline en el
  string HTML (no crees archivos sueltos); mantenlo mínimo.

---

## 5. Sistema de iconos

- Hoy **no hay librería de iconos**: se usan **emoji** como glifos, tanto en el
  menú (`'📊 Dashboard'`, `'🤖 Agente IA'`) como inline.
- **Convención:** un emoji por ítem de navegación, al inicio del label. En
  contenido, úsalos con moderación (el CSS ya es expresivo; no los apiles).
- Si un diseño de Figma trae un set de iconos de línea, la vía correcta es
  **SVG inline** con `currentColor` para heredar el color del contexto:
  ```html
  <svg viewBox="0 0 24 24" width="16" fill="none" stroke="currentColor" stroke-width="2">…</svg>
  ```
  No mezcles emoji y SVG en la misma familia de controles.

---

## 6. Enfoque de estilos

- **Metodología:** CSS global con **clases planas semánticas** (cercano a BEM
  aplanado): `.card`, `.kpi`, `.btn.secondary`, `.badge.green`, `.room-tile.clean`.
  Nada de CSS-in-JS ni módulos.
- **Globales:** reset mínimo + tokens + componentes, todo en `styles.css`.
- **Responsive:** mobile-first pragmático con **un** breakpoint (`@media (max-width:900px)`)
  que colapsa el sidebar a barra superior y las grillas a una columna. Usa unidades
  relativas y `grid`/`flex` con `gap` (no márgenes por elemento).
- **Movimiento (obligatorio para el feel de "experiencia"):**
  - Entradas: `#content`, `.card`, `.kpi`, `.room-tile` usan `fadeUp`; los hijos de
    `.grid`/`.room-grid` tienen **stagger** por `:nth-child`. Los mensajes de chat y
    modales usan `scaleIn`; los toasts `slideInRight`.
  - Interacción: todo control interactivo transiciona en `--dur-1`/`--dur-2` con
    `--ease`. Botones: `translateY(-1px)` en hover, `scale(.98)` en active. KPIs y
    tiles: lift de 3px en hover.
  - **Foco visible siempre** (`box-shadow: 0 0 0 3px var(--accent-ring)`).
  - **Respeta `prefers-reduced-motion: reduce`** (ya hay override que anula
    animaciones). Cualquier animación nueva debe seguir cayendo bajo esa regla.
  - No abuses: máximo una animación de entrada por bloque; nada que parpadee o
    demore la lectura. Si dudas, menos es más.

### Al implementar un componente de Figma
1. Toma medidas/colores del diseño y **conviértelos a tokens** (§1).
2. Reusa una clase existente si el patrón ya existe (card, badge, btn, kpi).
3. Si es nuevo, crea una clase semántica en `styles.css`, estilízala con tokens,
   añade transición y estado de foco/hover, y verifica el breakpoint de 900px.
4. Añade la animación de entrada acorde (fadeUp para bloques, scaleIn para overlays).

---

## 7. Estructura del proyecto

```
public/                 # TODO el frontend (sin build)
  index.html            # shell que carga app.js
  app.js                # SPA: estado, router, vistas (viewX), helpers
  styles.css            # sistema visual completo (tokens + componentes + motion)
  pay.html              # checkout público de pago
  guest.html            # portal del huésped (por código de reserva)
  chat.html             # webchat público (mismo cerebro que WhatsApp)
src/
  server.js             # Express: monta rutas, sirve public/
  routes/               # API REST por módulo (auth, booking, content, hr, …)
  services/             # dominio (reservations, payments, ai/, gateways/, …)
  services/ai/          # agente: assistant, agentProfile, tools, retrieval, claude
  middleware/auth.js    # JWT + matriz de permisos por rol
  lib/                  # eventos, auditoría, utilidades
prisma/schema.prisma    # modelo de datos
DESIGN.md               # (este documento)
```

**Patrón de feature:** cada módulo del documento funcional = una vista en
`app.js` + (si aplica) un router en `src/routes/` + un service en `src/services/`.
La vista consume la API; nunca toca la base directamente.

---

## Checklist antes de dar por hecho un diseño
- [ ] Colores y medidas expresados como `var(--token)`, no valores sueltos.
- [ ] Reusé card/btn/badge/kpi/modal/toast donde aplica.
- [ ] Texto dinámico pasa por `esc()`.
- [ ] Hover, foco visible y transición en todo control interactivo.
- [ ] Animación de entrada acorde y bajo `prefers-reduced-motion`.
- [ ] Se ve bien en ≤ 900px (sidebar colapsado, grillas a una columna).
- [ ] Estado vacío con guía, no una tabla en blanco.
- [ ] El acento oro aparece en un solo foco por pantalla.
