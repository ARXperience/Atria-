/* Atria Hospitality OS — Panel administrativo (SPA sin build) */
(() => {
  const root = document.getElementById('root');
  let state = {
    token: localStorage.getItem('atria_token'),
    user: JSON.parse(localStorage.getItem('atria_user') || 'null'),
    properties: JSON.parse(localStorage.getItem('atria_props') || '[]'),
    propertyId: localStorage.getItem('atria_prop') || null,
    view: location.hash.slice(1) || 'dashboard',
    inbox: { convoId: null, timer: null },
    wa: { timer: null },
  };

  // ---------- utilidades ----------
  const $ = sel => document.querySelector(sel);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const cop = n => new Intl.NumberFormat('es-CO', { style: 'currency', currency: 'COP', maximumFractionDigits: 0 }).format(n || 0);
  const day = d => d ? String(d).slice(0, 10) : '—';
  const dt = d => d ? new Date(d).toLocaleString('es-CO', { dateStyle: 'short', timeStyle: 'short' }) : '—';

  function toast(msg, isError = false) {
    document.querySelectorAll('.toast').forEach(t => t.remove());
    const el = document.createElement('div');
    el.className = 'toast' + (isError ? ' error' : '');
    el.textContent = msg;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 5000);
  }

  const reducedMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  // Bienvenida elegante tras iniciar sesión (una sola vez).
  function showWelcome() {
    if (reducedMotion()) return;
    const name = (state.user?.name || '').split(' ')[0] || '';
    const el = document.createElement('div');
    el.className = 'welcome-overlay';
    el.innerHTML = `<div class="ring"></div><div class="wm">ATR<b>IA</b></div><div class="greet">Bienvenido${name ? ', ' + esc(name) : ''} 👋</div>`;
    document.body.appendChild(el);
    setTimeout(() => el.remove(), 2400);
  }

  // Descarga/visualización de recursos protegidos (envía el token de sesión).
  async function fetchBlob(path) {
    const res = await fetch('/api' + path, { headers: state.token ? { authorization: 'Bearer ' + state.token } : {} });
    if (!res.ok) throw new Error('No se pudo obtener el archivo');
    return res.blob();
  }
  window._dl = async (path, filename) => {
    try {
      const url = URL.createObjectURL(await fetchBlob(path));
      const a = document.createElement('a'); a.href = url; a.download = filename; document.body.appendChild(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 3000);
    } catch (err) { toast(err.message, true); }
  };
  window._openDoc = async (path) => {
    try {
      const url = URL.createObjectURL(await fetchBlob(path));
      window.open(url, '_blank');
      setTimeout(() => URL.revokeObjectURL(url), 60000);
    } catch (err) { toast(err.message, true); }
  };

  // Conteo animado para los KPIs con [data-count].
  function animateCounts(scope) {
    (scope || document).querySelectorAll('[data-count]').forEach(el => {
      const to = +el.dataset.count;
      if (isNaN(to)) return;
      const type = el.dataset.fmt || 'int';
      const fmt = type === 'cop' ? cop : type === 'pct' ? (v => Math.round(v) + '%') : (v => Math.round(v).toLocaleString('es-CO'));
      if (reducedMotion()) { el.textContent = fmt(to); return; }
      const dur = 850, t0 = performance.now();
      const step = now => {
        const p = Math.min(1, (now - t0) / dur);
        const e = 1 - Math.pow(1 - p, 3);
        el.textContent = fmt(to * e);
        if (p < 1) requestAnimationFrame(step);
      };
      requestAnimationFrame(step);
    });
  }

  async function api(path, opts = {}) {
    const res = await fetch('/api' + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        ...(state.token ? { authorization: 'Bearer ' + state.token } : {}),
        ...(opts.headers || {}),
      },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && state.token) { logout(); throw new Error('Sesión expirada'); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok && res.status !== 202) throw new Error(data.error || 'Error ' + res.status);
    return { data, status: res.status };
  }
  const get = p => api(p).then(r => r.data);

  function logout() {
    localStorage.clear();
    state.token = null; state.user = null;
    stopTimers();
    render();
  }

  function stopTimers() {
    if (state.inbox.timer) { clearInterval(state.inbox.timer); state.inbox.timer = null; }
    if (state.wa.timer) { clearInterval(state.wa.timer); state.wa.timer = null; }
  }

  function badge(text, color) { return `<span class="badge ${color}">${esc(text)}</span>`; }
  const STATUS_BADGE = {
    tentative: ['Tentativa', 'yellow'], confirmed: ['Confirmada', 'blue'], checked_in: ['En casa', 'green'],
    checked_out: ['Check-out', 'gray'], cancelled: ['Cancelada', 'red'], expired: ['Vencida', 'red'], no_show: ['No-show', 'red'],
    pending: ['Pendiente', 'yellow'], in_progress: ['En curso', 'blue'], done: ['Hecha', 'green'], inspected: ['Inspeccionada', 'green'],
    open: ['Abierta', 'yellow'], resolved: ['Resuelta', 'green'], closed: ['Cerrada', 'gray'],
    approved: ['Aprobado', 'green'], rejected: ['Rechazado', 'red'], paid: ['Pagado', 'green'], active: ['Activo', 'blue'],
    incomplete: ['Incompleta', 'yellow'], complete: ['Completa', 'green'], reported: ['Reportado', 'green'], prepared: ['Preparado', 'blue'],
    clean: ['Limpia', 'green'], dirty: ['Sucia', 'yellow'], occupied: ['Ocupada', 'blue'], out_of_service: ['Fuera de servicio', 'red'],
    new: ['Nuevo', 'blue'], qualified: ['Calificado', 'yellow'], quoted: ['Cotizado', 'yellow'], won: ['Ganado', 'green'], lost: ['Perdido', 'red'],
  };
  const sb = s => { const [t, c] = STATUS_BADGE[s] || [s, 'gray']; return badge(t, c); };

  // ---------- login ----------
  function renderLogin() {
    root.innerHTML = `
      <div class="login-wrap"><div class="login-card">
        <div class="brand">ATR<b>IA</b></div>
        <div class="brand-sub">HOSPITALITY OS</div>
        <label>Email</label><input id="email" type="email" value="gerente@atria.co">
        <label>Contraseña</label><input id="password" type="password" placeholder="••••••••">
        <button class="btn mt" style="width:100%" id="loginBtn">Ingresar</button>
        <p class="muted mt" style="font-size:12px;text-align:center">Demo: gerente@atria.co / atria2026</p>
      </div></div>`;
    const doLogin = async () => {
      try {
        const { data } = await api('/auth/login', { method: 'POST', body: { email: $('#email').value, password: $('#password').value } });
        state.token = data.token; state.user = data.user; state.properties = data.properties;
        state.propertyId = data.properties[0]?.id || null;
        localStorage.setItem('atria_token', data.token);
        localStorage.setItem('atria_user', JSON.stringify(data.user));
        localStorage.setItem('atria_props', JSON.stringify(data.properties));
        localStorage.setItem('atria_prop', state.propertyId || '');
        state.justLoggedIn = true;
        render();
      } catch (err) { toast(err.message, true); }
    };
    $('#loginBtn').onclick = doLogin;
    // Nota: el handler debe usar llaves; devolver false en onkeydown cancela la tecla
    $('#password').onkeydown = e => { if (e.key === 'Enter') doLogin(); };
  }

  // ---------- shell ----------
  const NAV = [
    ['sep', 'Operación'],
    ['portfolio', '🏢 Portafolio'],
    ['dashboard', '📊 Dashboard'],
    ['rooms', '🛏️ Habitaciones'],
    ['reservations', '📅 Reservas'],
    ['booking', '➕ Nueva reserva'],
    ['housekeeping', '🧹 Housekeeping'],
    ['maintenance', '🔧 Mantenimiento'],
    ['sep', 'Comercial'],
    ['inbox', '💬 Inbox / WhatsApp'],
    ['crm', '👥 CRM'],
    ['marketing', '📣 Marketing'],
    ['reputation', '⭐ Reputación'],
    ['events', '🎉 Eventos & salones'],
    ['payments', '💳 Pagos'],
    ['invoices', '🧾 Facturación'],
    ['sep', 'IA & Contenido'],
    ['copilot', '🧭 Copiloto'],
    ['content', '🖼️ Habitaciones & Conocimiento'],
    ['site', '🌐 Sitio web'],
    ['agent', '🤖 Agente IA'],
    ['sep', 'Personas'],
    ['employees', '👔 Empleados'],
    ['shifts', '📆 Turnos'],
    ['payroll', '💰 Nómina'],
    ['sgsst', '🦺 SG-SST'],
    ['sep', 'Distribución'],
    ['revenue', '📈 Revenue'],
    ['channels', '🌍 Canales (OTAs)'],
    ['sep', 'Abastecimiento'],
    ['inventory', '📦 Inventario'],
    ['pos', '🍽️ Restaurante (POS)'],
    ['sep', 'Finanzas'],
    ['finance', '💵 Finanzas & Cartera'],
    ['sep', 'Gobierno'],
    ['approvals', '✅ Aprobaciones'],
    ['compliance', '⚖️ Cumplimiento'],
    ['dataprotection', '🛡️ Protección de datos'],
    ['fontur', '🏝️ FONTUR parafiscal'],
    ['documents', '📁 Documentos'],
    ['audit', '🔍 Auditoría'],
    ['integrations', '🔌 Integraciones'],
    ['automations', '⚡ Automatizaciones'],
    ['settings', '⚙️ Configuración'],
  ];

  function renderShell(contentHtml, title) {
    root.innerHTML = `
      <div class="app">
        <div class="sidebar">
          <div class="brand">ATR<b>IA</b></div>
          <div class="brand-sub">HOSPITALITY OS</div>
          <nav class="nav">
            ${NAV.map(([id, label]) => id === 'sep'
              ? `<div class="sep">${label}</div>`
              : `<a href="#${id}" class="${state.view === id ? 'active' : ''}">${label}</a>`).join('')}
          </nav>
          <div class="sidebar-footer">
            ${esc(state.user.name)}<br><span style="font-size:11px">${esc(state.user.role)}</span><br>
            <a href="#" id="logoutLink" style="color:var(--red);font-size:12px">Cerrar sesión</a>
          </div>
        </div>
        <div class="main">
          <div class="topbar">
            <h1>${esc(title)}</h1>
            <div class="row fit" style="align-items:center">
              <select id="propSel" class="fit" style="width:auto">
                ${state.properties.map(p => `<option value="${p.id}" ${p.id === state.propertyId ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
              </select>
            </div>
          </div>
          <div id="content">${contentHtml}</div>
        </div>
      </div>`;
    $('#logoutLink').onclick = e => { e.preventDefault(); logout(); };
    $('#propSel').onchange = e => { state.propertyId = e.target.value; localStorage.setItem('atria_prop', state.propertyId); render(); };
  }

  function modal(html) {
    const bg = document.createElement('div');
    bg.className = 'modal-bg';
    bg.innerHTML = `<div class="modal">${html}</div>`;
    bg.onclick = e => { if (e.target === bg) bg.remove(); };
    document.body.appendChild(bg);
    return bg;
  }

  // Genera un reporte imprimible (→ "Guardar como PDF" del navegador) con
  // membrete del hotel. Sin dependencias: abre una ventana con estilos de impresión.
  function printReport({ title, subtitle = '', meta = [], sections = [] }) {
    const prop = (state.properties || []).find(p => p.id === state.propertyId) || {};
    const now = new Date();
    const fecha = now.toLocaleDateString('es-CO', { year: 'numeric', month: 'long', day: 'numeric' });
    const css = `
      *{box-sizing:border-box;margin:0;padding:0}
      body{font:13px/1.5 -apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#1a1a1a;padding:32px}
      .head{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #d8b064;padding-bottom:14px;margin-bottom:22px}
      .brand{font-size:22px;font-weight:800;letter-spacing:1px}.brand b{color:#c79a4b}
      .brand-sub{font-size:11px;letter-spacing:2px;color:#888;text-transform:uppercase}
      .hotel{text-align:right;font-size:12px;color:#444}
      h1{font-size:19px;margin-bottom:2px}.subtitle{color:#666;font-size:13px;margin-bottom:16px}
      .meta{font-size:12px;color:#555;margin-bottom:18px}.meta span{margin-right:18px}
      section{margin-bottom:20px}h2{font-size:14px;color:#c79a4b;border-bottom:1px solid #eee;padding-bottom:5px;margin-bottom:10px}
      table{width:100%;border-collapse:collapse;font-size:12.5px}
      th,td{text-align:left;padding:7px 9px;border-bottom:1px solid #eee}
      th{color:#888;font-weight:600;text-transform:uppercase;font-size:10.5px;letter-spacing:.5px}
      td.r,th.r{text-align:right}
      tr.total td{border-top:2px solid #333;font-weight:700}
      .foot{margin-top:30px;padding-top:12px;border-top:1px solid #eee;font-size:10.5px;color:#999;text-align:center}
      @media print{body{padding:0}@page{margin:16mm}}
    `;
    const html = `<!doctype html><html lang="es"><head><meta charset="utf-8"><title>${esc(title)} — ${esc(prop.name || 'Atria')}</title><style>${css}</style></head><body>
      <div class="head">
        <div><div class="brand">ATR<b>IA</b></div><div class="brand-sub">Hospitality OS</div></div>
        <div class="hotel"><b>${esc(prop.name || 'Atria Hotel')}</b><br>${esc(prop.city || '')}<br>Generado: ${esc(fecha)}</div>
      </div>
      <h1>${esc(title)}</h1>${subtitle ? `<div class="subtitle">${esc(subtitle)}</div>` : ''}
      ${meta.length ? `<div class="meta">${meta.map(m => `<span><b>${esc(m.label)}:</b> ${esc(m.value)}</span>`).join('')}</div>` : ''}
      ${sections.map(s => `<section><h2>${esc(s.title)}</h2>${s.html}</section>`).join('')}
      <div class="foot">Documento generado por Atria Hospitality OS · ${esc(prop.name || '')} · ${esc(fecha)}</div>
    </body></html>`;
    const w = window.open('', '_blank');
    if (!w) { toast('Permite las ventanas emergentes para exportar el PDF', true); return; }
    w.document.write(html); w.document.close();
    w.onload = () => { w.focus(); w.print(); };
  }

  const pid = () => `propertyId=${state.propertyId}`;

  // ---------- vistas ----------
  async function viewPortfolio() {
    const p = await get('/portfolio/overview');
    const t = p.totals;
    window._goSite = id => { state.propertyId = id; localStorage.setItem('atria_prop', id); location.hash = 'dashboard'; };
    setTimeout(animateCounts, 0);
    const heat = pct => pct >= 75 ? 'var(--green)' : pct >= 45 ? 'var(--yellow)' : 'var(--red)';
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Sedes</div><div class="value">${p.count}</div></div>
        <div class="kpi"><div class="label">Ocupación consolidada</div><div class="value" style="color:${heat(t.occupancyPct)}"><span data-count="${t.occupancyPct}" data-fmt="pct">0%</span><small> ${t.occupied}/${t.sellable}</small></div></div>
        <div class="kpi"><div class="label">Ingresos del mes</div><div class="value" style="color:var(--green)"><span data-count="${t.monthRevenue}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Cartera por cobrar</div><div class="value" style="color:${t.receivable ? 'var(--yellow)' : 'inherit'}"><span data-count="${t.receivable}" data-fmt="cop">$0</span></div></div>
      </div>
      <div class="grid cols-4 mt">
        <div class="kpi"><div class="label">ADR del grupo</div><div class="value"><span data-count="${t.adr}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">RevPAR del grupo</div><div class="value"><span data-count="${t.revpar}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Huéspedes en casa</div><div class="value">${t.inHouse}</div></div>
        <div class="kpi"><div class="label">Aprobaciones pendientes</div><div class="value" style="color:${t.pendingApprovals ? 'var(--yellow)' : 'inherit'}">${t.pendingApprovals}</div></div>
      </div>
      <div class="card mt"><h3>Sedes del portafolio</h3>
        <table><tr><th>Sede</th><th>Ciudad</th><th>Ocupación</th><th>En casa</th><th>ADR</th><th>RevPAR</th><th>Ingresos mes</th><th>Cartera</th><th>Aprob.</th><th></th></tr>
        ${p.sites.map(s => `<tr class="clickable" onclick="_goSite('${s.id}')">
          <td><b>${esc(s.name)}</b><div class="muted" style="font-size:12px">${esc(s.rnt || '')}</div></td>
          <td>${esc(s.city || '—')}</td>
          <td><span style="color:${heat(s.occupancyPct)}">${s.occupancyPct}%</span> <span class="muted" style="font-size:12px">${s.occupied}/${s.sellable}</span></td>
          <td>${s.inHouse}</td>
          <td>${cop(s.adr)}</td>
          <td>${cop(s.revpar)}</td>
          <td><b>${cop(s.monthRevenue)}</b></td>
          <td>${s.receivable ? `<span style="color:var(--yellow)">${cop(s.receivable)}</span>` : '—'}</td>
          <td>${s.pendingApprovals ? sb('pending') + ' ' + s.pendingApprovals : '—'}</td>
          <td><span class="muted">Abrir →</span></td></tr>`).join('')}
        <tr style="border-top:2px solid var(--border)"><td><b>Total</b></td><td></td>
          <td><b style="color:${heat(t.occupancyPct)}">${t.occupancyPct}%</b></td>
          <td><b>${t.inHouse}</b></td><td></td><td></td>
          <td><b>${cop(t.monthRevenue)}</b></td>
          <td><b>${t.receivable ? cop(t.receivable) : '—'}</b></td>
          <td><b>${t.pendingApprovals || '—'}</b></td><td></td></tr>
        </table>
        <p class="muted mt" style="font-size:12px">Consolida las sedes a las que tienes acceso. Haz clic en una sede para abrir su tablero.</p>
      </div>`;
  }

  async function viewDashboard() {
    const d = await get(`/dashboard?${pid()}`);
    setTimeout(animateCounts, 0);
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Ocupación</div><div class="value"><span data-count="${d.rooms.occupancyPct}" data-fmt="pct">0%</span><small> ${d.rooms.occupied}/${d.rooms.total - d.rooms.outOfService}</small></div></div>
        <div class="kpi"><div class="label">ADR (mes)</div><div class="value"><span data-count="${d.kpis.adr}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">RevPAR (mes)</div><div class="value"><span data-count="${d.kpis.revpar}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Ingresos del mes</div><div class="value"><span data-count="${d.kpis.monthRevenue}" data-fmt="cop">$0</span></div></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="card"><h3>Llegadas de hoy (${d.today.arrivals.length})</h3>
          ${d.today.arrivals.length ? `<table>${d.today.arrivals.map(a => `<tr class="clickable" onclick="location.hash='res:${a.id}'"><td>${esc(a.code)}</td><td>${esc(a.guest)}</td><td>${a.adults} pax</td></tr>`).join('')}</table>` : '<p class="muted">Sin llegadas programadas.</p>'}
        </div>
        <div class="card"><h3>Salidas de hoy (${d.today.departures.length})</h3>
          ${d.today.departures.length ? `<table>${d.today.departures.map(a => `<tr class="clickable" onclick="location.hash='res:${a.id}'"><td>${esc(a.code)}</td><td>${esc(a.guest)}</td><td>Hab ${esc(a.room || '—')}</td></tr>`).join('')}</table>` : '<p class="muted">Sin salidas programadas.</p>'}
        </div>
      </div>
      <div class="grid cols-4 mt">
        <div class="kpi"><div class="label">Huéspedes en casa</div><div class="value"><span data-count="${d.today.inHouse}">0</span></div></div>
        <div class="kpi"><div class="label">Aprobaciones pendientes</div><div class="value" style="color:${d.alerts.pendingApprovals ? 'var(--yellow)' : 'inherit'}"><span data-count="${d.alerts.pendingApprovals}">0</span></div></div>
        <div class="kpi"><div class="label">Limpiezas pendientes</div><div class="value"><span data-count="${d.alerts.housekeepingPending}">0</span></div></div>
        <div class="kpi"><div class="label">Leads abiertos</div><div class="value"><span data-count="${d.alerts.openLeads}">0</span></div></div>
      </div>
      ${d.ecosystem ? `<h3 class="mt" style="margin-bottom:10px">Ecosistema</h3>
      <div class="grid cols-4">
        <a class="kpi clickable" href="#reputation" style="text-decoration:none"><div class="label">Reputación ★</div><div class="value" style="color:var(--accent)">${d.ecosystem.reputationAvg || '—'}<small>${d.ecosystem.reviewsPending ? ` · ${d.ecosystem.reviewsPending} sin responder` : ''}</small></div></a>
        <a class="kpi clickable" href="#events" style="text-decoration:none"><div class="label">Próximos eventos</div><div class="value"><span data-count="${d.ecosystem.upcomingEvents}">0</span></div></a>
        <a class="kpi clickable" href="#finance" style="text-decoration:none"><div class="label">Cuentas por pagar</div><div class="value" style="color:${d.ecosystem.payableOpen ? 'var(--yellow)' : 'inherit'}"><span data-count="${d.ecosystem.payableOpen}" data-fmt="cop">$0</span></div></a>
        <a class="kpi clickable" href="#dataprotection" style="text-decoration:none"><div class="label">Solicitudes de datos</div><div class="value" style="color:${d.ecosystem.dataRequestsOpen ? 'var(--yellow)' : 'inherit'}"><span data-count="${d.ecosystem.dataRequestsOpen}">0</span></div></a>
      </div>` : ''}`;
  }

  async function viewRooms() {
    const rooms = await get(`/reservations/map/rooms?${pid()}`);
    window._roomAction = async (roomId, status) => {
      try { await api(`/admin/rooms/${roomId}/status`, { method: 'PATCH', body: { status } }); toast('Estado actualizado'); render(); }
      catch (err) { toast(err.message, true); }
    };
    const today = new Date().toISOString().slice(0, 10);
    const attn = r => r.status === 'out_of_service' ? ' attention urgent'
      : r.status === 'dirty' ? ' attention'
      : (r.currentGuest && day(r.currentGuest.checkOut) === today) ? ' attention' : '';
    const LEG = [['clean', 'Limpia'], ['inspected', 'Inspeccionada'], ['dirty', 'Sucia'], ['occupied', 'Ocupada'], ['out_of_service', 'Fuera de servicio']];
    return `
      <div class="legend">${LEG.map(([k, l]) => `<div class="legend-item"><span class="legend-dot ${k}"></span>${l}</div>`).join('')}
        <div class="legend-item" style="margin-left:auto"><span class="legend-dot" style="background:var(--yellow);animation:pulse 1.9s infinite;box-shadow:0 0 0 0 rgba(230,196,107,.5)"></span>Requiere acción</div>
      </div>
      <div class="room-grid">${rooms.map(r => `
      <div class="room-tile ${r.status}${attn(r)}">
        <div class="num">${esc(r.number)}</div>
        <div class="type">${esc(r.roomType)} · ${r.capacity} pax</div>
        ${sb(r.status)}
        ${r.currentGuest ? `<div class="guest mt">${esc(r.currentGuest.name)}<br><span class="muted">sale ${day(r.currentGuest.checkOut)}</span></div>` : ''}
        ${r.status === 'dirty' ? `<div class="mt"><button class="btn small secondary" onclick="_roomAction('${r.id}','clean')">Marcar limpia</button></div>` : ''}
        ${r.status === 'clean' ? `<div class="mt"><button class="btn small secondary" onclick="_roomAction('${r.id}','inspected')">Inspeccionar</button></div>` : ''}
      </div>`).join('')}</div>`;
  }

  async function viewReservations() {
    const list = await get(`/reservations?${pid()}`);
    return `
      <div class="card"><table>
        <tr><th>Código</th><th>Huésped</th><th>Llegada</th><th>Salida</th><th>Hab</th><th>Total</th><th>Canal</th><th>Estado</th></tr>
        ${list.map(r => `<tr class="clickable" onclick="location.hash='res:${r.id}'">
          <td>${esc(r.code)}</td><td>${esc(r.guest.fullName)}</td><td>${day(r.checkIn)}</td><td>${day(r.checkOut)}</td>
          <td>${esc(r.room?.number || '—')}</td><td>${cop(r.total)}</td><td>${esc(r.channel)}</td><td>${sb(r.status)}</td></tr>`).join('')}
      </table>${list.length ? '' : '<p class="muted">No hay reservas aún. Crea una desde "Nueva reserva" o por WhatsApp/webchat.</p>'}</div>`;
  }

  async function viewReservationDetail(id) {
    const r = await get(`/reservations/${id}`);
    window._resAction = async (action, body = {}) => {
      try {
        const { data, status } = await api(`/reservations/${id}/${action}`, { method: 'POST', body });
        if (status === 202) toast('Acción enviada a aprobación de gerente');
        else toast('Acción realizada');
        render();
      } catch (err) { toast(err.message, true); }
    };
    window._addCharge = async () => {
      try {
        await api(`/reservations/${id}/charges`, { method: 'POST', body: { concept: $('#chConcept').value, description: $('#chDesc').value, amount: +$('#chAmount').value } });
        toast('Cargo agregado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._genInvoice = async () => {
      try {
        await api('/invoices/from-reservation', { method: 'POST', body: { reservationId: id } });
        toast('Borrador de factura creado — ver 🧾 Facturación');
        location.hash = 'invoices';
      } catch (err) { toast(err.message, true); }
    };
    window._payLink = async () => {
      try {
        const { data } = await api('/payments/links', { method: 'POST', body: { propertyId: state.propertyId, reservationId: id, concept: `Pago reserva ${r.code}`, amount: +$('#plAmount').value } });
        toast('Link creado: ' + data.url);
        navigator.clipboard?.writeText(data.url).catch(() => {});
        render();
      } catch (err) { toast(err.message, true); }
    };
    const charges = r.folio?.charges?.filter(c => !c.voided) || [];
    return `
      <p><a href="#reservations" class="muted">← Volver a reservas</a></p>
      <div class="grid cols-2">
        <div class="card">
          <h3>Reserva ${esc(r.code)} ${sb(r.status)}</h3>
          <table>
            <tr><td class="muted">Huésped</td><td>${esc(r.guest.fullName)} ${r.guest.phone ? '· 📱 ' + esc(r.guest.phone) : ''}</td></tr>
            <tr><td class="muted">Fechas</td><td>${day(r.checkIn)} → ${day(r.checkOut)} (${r.nights} noches)</td></tr>
            <tr><td class="muted">Tipo / Hab</td><td>${esc(r.roomType?.name || '')} ${r.room ? '· Hab ' + esc(r.room.number) : '(sin asignar)'}</td></tr>
            <tr><td class="muted">Personas</td><td>${r.adults} adultos, ${r.children} niños</td></tr>
            <tr><td class="muted">Total</td><td>${cop(r.total)} (anticipo ${cop(r.depositRequired)})</td></tr>
            <tr><td class="muted">Pagado / Saldo</td><td>${cop(r.balance.paid)} / <b>${cop(r.balance.balance)}</b></td></tr>
            <tr><td class="muted">Canal</td><td>${esc(r.channel)} ${r.createdBy === 'ai' ? badge('creada por Atria IA', 'blue') : ''}</td></tr>
          </table>
          <div class="row mt">
            ${r.status === 'tentative' ? `<button class="btn small fit" onclick="_resAction('confirm')">Confirmar sin pago</button>` : ''}
            ${['tentative', 'confirmed'].includes(r.status) ? `<button class="btn small fit" onclick="_resAction('checkin')">Check-in</button>
              <button class="btn small danger fit" onclick="_resAction('cancel',{reason:prompt('Motivo de cancelación:')||''})">Cancelar</button>` : ''}
            ${r.status === 'checked_in' ? `<button class="btn small fit" onclick="_resAction('checkout')">Check-out</button>` : ''}
            ${r.status === 'checked_out' ? `<button class="btn small secondary fit" onclick="_genInvoice()">🧾 Generar factura</button>` : ''}
          </div>
        </div>
        <div class="card">
          <h3>Pagos</h3>
          ${r.payments.length ? `<table>${r.payments.map(p => `<tr><td>${dt(p.createdAt)}</td><td>${esc(p.method)}</td><td>${p.kind === 'refund' ? '-' : ''}${cop(p.amount)}</td><td>${sb(p.status)}</td></tr>`).join('')}</table>` : '<p class="muted">Sin pagos registrados.</p>'}
          <div class="row mt">
            <div><label>Valor link de pago</label><input id="plAmount" type="number" value="${Math.max(0, r.balance.balance)}"></div>
            <button class="btn small fit" onclick="_payLink()">Crear link de pago</button>
          </div>
          ${r.paymentLinks.filter(l => l.status === 'active').map(l => `<p class="mt" style="font-size:12px">🔗 <a href="/pay/${l.token}" target="_blank" style="color:var(--accent2)">${location.origin}/pay/${l.token}</a> (${cop(l.amount)})</p>`).join('')}
        </div>
      </div>
      <div class="card">
        <h3>Folio del huésped ${r.folio ? sb(r.folio.status) : ''}</h3>
        ${charges.length ? `<table><tr><th>Concepto</th><th>Descripción</th><th>Valor</th><th>Imp.</th><th>Registró</th></tr>
          ${charges.map(c => `<tr><td>${esc(c.concept)}</td><td>${esc(c.description || '')}</td><td>${cop(c.amount)}</td><td>${cop(c.taxAmount)}</td><td>${esc(c.postedBy || '')}</td></tr>`).join('')}</table>` : '<p class="muted">Folio sin cargos (se abre en el check-in).</p>'}
        ${r.status === 'checked_in' ? `<div class="row mt">
          <div><label>Concepto</label><select id="chConcept"><option>restaurante</option><option>minibar</option><option>room_service</option><option>lavanderia</option><option>daño</option><option>otro</option></select></div>
          <div><label>Descripción</label><input id="chDesc"></div>
          <div><label>Valor</label><input id="chAmount" type="number"></div>
          <button class="btn small fit" onclick="_addCharge()">Cargar</button>
        </div>` : ''}
      </div>
      ${(r.traRecords.length || r.sireReports.length) ? `<div class="card"><h3>Cumplimiento</h3>
        ${r.traRecords.map(t => `<p>TRA ${sb(t.status)} ${t.missingFields ? '<span class="muted">faltan: ' + esc(t.missingFields) + '</span>' : ''} — edítala en ⚖️ Cumplimiento</p>`).join('')}
        ${r.sireReports.map(s => `<p class="mt">SIRE (${esc(s.nationality)}) ${sb(s.status)}</p>`).join('')}
      </div>` : ''}`;
  }

  async function viewBooking() {
    const types = await get(`/admin/room-types?${pid()}`);
    window._searchAvail = async () => {
      const body = { propertyId: state.propertyId, checkIn: $('#bCheckIn').value, checkOut: $('#bCheckOut').value, adults: +$('#bAdults').value, children: +$('#bChildren').value };
      try {
        const { data } = await api('/booking/search', { method: 'POST', body });
        window._availData = { body, options: data };
        $('#availResults').innerHTML = data.length ? `<table><tr><th></th><th>Tipo</th><th>Disponibles</th><th>Tarifa</th><th>Plan</th></tr>
          ${data.map((a, i) => a.ratePlans.length ? a.ratePlans.map(p => `<tr>
            <td><input type="radio" name="opt" value="${i}:${p.ratePlanId}"></td>
            <td>${esc(a.roomType)}</td><td>${a.availableRooms}</td><td>${cop(p.price)}/noche</td><td>${esc(p.name)}${p.refundable ? '' : ' (no reemb.)'}</td></tr>`).join('')
            : `<tr><td><input type="radio" name="opt" value="${i}:"></td><td>${esc(a.roomType)}</td><td>${a.availableRooms}</td><td>${cop(a.baseRate)}/noche</td><td>Estándar</td></tr>`).join('')}
        </table><div class="row mt">
          <div><label>Nombre del huésped *</label><input id="gName"></div>
          <div><label>Teléfono</label><input id="gPhone"></div>
          <div><label>Documento</label><input id="gDoc"></div>
          <div><label>Nacionalidad (ISO)</label><input id="gNat" value="CO"></div>
          <button class="btn fit" onclick="_createRes()">Crear reserva + link de pago</button>
        </div>` : '<p class="muted mt">Sin disponibilidad para esos criterios.</p>';
      } catch (err) { toast(err.message, true); }
    };
    window._createRes = async () => {
      const sel = document.querySelector('input[name=opt]:checked');
      if (!sel) return toast('Selecciona una opción de habitación', true);
      const [idx, planId] = sel.value.split(':');
      const opt = window._availData.options[+idx];
      try {
        const { data } = await api('/booking/reservations', {
          method: 'POST',
          body: {
            ...window._availData.body, roomTypeId: opt.roomTypeId, ratePlanId: planId || null,
            guest: { fullName: $('#gName').value, phone: $('#gPhone').value || null, documentNumber: $('#gDoc').value || null, nationality: $('#gNat').value || 'CO' },
          },
        });
        toast(`Reserva ${data.reservation.code} creada`);
        location.hash = 'res:' + data.reservation.id;
      } catch (err) { toast(err.message, true); }
    };
    const today = new Date().toISOString().slice(0, 10);
    const tomorrow = new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    return `
      <div class="card"><h3>Buscar disponibilidad</h3>
        <div class="row">
          <div><label>Llegada</label><input id="bCheckIn" type="date" value="${today}"></div>
          <div><label>Salida</label><input id="bCheckOut" type="date" value="${tomorrow}"></div>
          <div><label>Adultos</label><input id="bAdults" type="number" value="2" min="1"></div>
          <div><label>Niños</label><input id="bChildren" type="number" value="0" min="0"></div>
          <button class="btn fit" onclick="_searchAvail()">Buscar</button>
        </div>
        <div id="availResults" class="mt"></div>
      </div>
      <div class="card"><h3>Inventario actual</h3>
        <table><tr><th>Tipo</th><th>Código</th><th>Capacidad</th><th>Tarifa base</th><th>Habitaciones</th></tr>
        ${types.map(t => `<tr><td>${esc(t.name)}</td><td>${esc(t.code)}</td><td>${t.capacity}</td><td>${cop(t.baseRate)}</td><td>${t._count.rooms}</td></tr>`).join('')}</table>
      </div>`;
  }

  // ---------- Inbox / WhatsApp ----------
  async function viewInbox() {
    const convos = await get(`/inbox/conversations?${pid()}`);
    setTimeout(() => bindInbox(convos), 0);
    return `
      <div class="card" id="waCard"><h3>WhatsApp (Baileys)</h3><div id="waStatus" class="muted">Consultando estado…</div></div>
      <div class="inbox">
        <div class="convo-list" id="convoList">
          ${convos.length ? convos.map(c => `
            <div class="convo-item" data-id="${c.id}">
              <div class="name"><span>${c.channel === 'whatsapp' ? '🟢' : '💬'} ${esc(c.contactName || c.contactPhone || 'Visitante')}</span>
                ${c.aiEnabled ? badge('IA', 'blue') : badge('Humano', 'yellow')}</div>
              <div class="preview">${esc(c.lastMessage || '')}</div>
            </div>`).join('') : '<p class="muted" style="padding:16px">Sin conversaciones aún. Conecta WhatsApp o prueba el webchat en <code>/chat.html</code>.</p>'}
        </div>
        <div class="chat" id="chatPane">
          <div class="chat-body"><p class="muted" style="margin:auto">Selecciona una conversación</p></div>
        </div>
      </div>`;
  }

  async function refreshWaStatus() {
    try {
      const s = await get(`/inbox/whatsapp/status?${pid()}`);
      const el = $('#waStatus');
      if (!el) return;
      if (!s.enabled) { el.innerHTML = 'Módulo deshabilitado por configuración.'; return; }
      if (s.status === 'connected') {
        el.innerHTML = `${badge('Conectado', 'green')} Número: <b>+${esc(s.number || '')}</b>
          <button class="btn small danger" style="margin-left:10px" onclick="_waLogout()">Desvincular</button>`;
      } else if (s.status === 'qr' && s.qr) {
        el.innerHTML = `<div class="qr-box"><p class="mt">Escanea este QR desde WhatsApp → Dispositivos vinculados:</p><img src="${s.qr}" width="260" alt="QR WhatsApp"><p class="muted">El código se renueva automáticamente.</p></div>`;
      } else if (s.status === 'connecting') {
        el.innerHTML = `${badge('Conectando…', 'yellow')} espera unos segundos.`;
      } else {
        el.innerHTML = `${badge('Desconectado', 'red')} ${s.lastError ? '<span class="muted">' + esc(s.lastError) + '</span>' : ''}
          <button class="btn small" style="margin-left:10px" onclick="_waConnect()">Conectar / Generar QR</button>`;
      }
    } catch { /* sesión sin permiso whatsapp */ }
  }

  function bindInbox(convos) {
    window._waConnect = async () => {
      try { await api('/inbox/whatsapp/connect', { method: 'POST', body: { propertyId: state.propertyId } }); toast('Iniciando conexión… el QR aparecerá en segundos'); }
      catch (err) { toast(err.message, true); }
    };
    window._waLogout = async () => {
      if (!confirm('¿Desvincular WhatsApp de esta sede?')) return;
      try { await api('/inbox/whatsapp/logout', { method: 'POST', body: { propertyId: state.propertyId } }); toast('Sesión cerrada'); }
      catch (err) { toast(err.message, true); }
    };
    refreshWaStatus();
    stopTimers();
    state.wa.timer = setInterval(refreshWaStatus, 4000);

    document.querySelectorAll('.convo-item').forEach(el => {
      el.onclick = () => openConvo(el.dataset.id);
    });
    if (state.inbox.convoId && convos.some(c => c.id === state.inbox.convoId)) openConvo(state.inbox.convoId);
  }

  async function openConvo(id) {
    state.inbox.convoId = id;
    document.querySelectorAll('.convo-item').forEach(el => el.classList.toggle('active', el.dataset.id === id));
    const load = async () => {
      const { conversation: c, messages } = await get(`/inbox/conversations/${id}/messages`);
      const pane = $('#chatPane');
      if (!pane || state.inbox.convoId !== id) return;
      pane.innerHTML = `
        <div class="chat-head">
          <div><b>${esc(c.contactName || c.contactPhone || 'Visitante')}</b> <span class="muted">${esc(c.channel)}${c.contactPhone ? ' · +' + esc(c.contactPhone) : ''}</span></div>
          <div>
            ${c.aiEnabled
              ? `<button class="btn small secondary" onclick="_takeover(false)">🙋 Tomar conversación</button>`
              : `${badge('Atiende: ' + (c.assignedTo || 'humano'), 'yellow')} <button class="btn small secondary" onclick="_takeover(true)">🤖 Devolver a la IA</button>`}
          </div>
        </div>
        ${c.summary ? `<div style="padding:10px 16px;background:var(--accent-soft);border-bottom:1px solid var(--border-soft);font-size:12.5px;color:var(--text-dim)"><b style="color:var(--accent-hi)">🧠 Resumen IA:</b> ${esc(c.summary)}</div>` : ''}
        <div class="chat-body" id="chatBody">
          ${messages.map(m => `<div class="msg ${m.direction}">${esc(m.body)}<div class="meta">${m.direction === 'out' ? esc(m.sender === 'ai' ? 'Atria IA' : m.sender) + ' · ' : ''}${dt(m.createdAt)}</div></div>`).join('')}
        </div>
        <div class="chat-input">
          <input id="chatText" placeholder="Escribe un mensaje como humano…">
          <button class="btn fit" id="chatSend">Enviar</button>
        </div>`;
      const body = $('#chatBody');
      body.scrollTop = body.scrollHeight;
      $('#chatSend').onclick = sendMsg;
      $('#chatText').onkeydown = e => { if (e.key === 'Enter') sendMsg(); };
      window._takeover = async release => {
        try {
          await api(`/inbox/conversations/${id}/takeover`, { method: 'POST', body: { release } });
          toast(release ? 'Conversación devuelta a Atria IA' : 'Conversación tomada — la IA queda en pausa');
          load();
        } catch (err) { toast(err.message, true); }
      };
      async function sendMsg() {
        const text = $('#chatText').value.trim();
        if (!text) return;
        $('#chatText').value = '';
        // Burbuja optimista: aparece al instante para que se sienta ágil.
        const cb = $('#chatBody');
        if (cb) { const d = document.createElement('div'); d.className = 'msg out'; d.textContent = text; cb.appendChild(d); cb.scrollTop = cb.scrollHeight; }
        try { await api(`/inbox/conversations/${id}/messages`, { method: 'POST', body: { text } }); load(); }
        catch (err) { toast(err.message, true); }
      }
    };
    await load();
    if (state.inbox.timer) clearInterval(state.inbox.timer);
    state.inbox.timer = setInterval(load, 4000);
  }

  async function viewCrm() {
    const leads = await get(`/crm/leads?${pid()}`);
    window._leadStage = async (id, stage) => {
      try { await api(`/crm/leads/${id}`, { method: 'PATCH', body: { stage } }); toast('Lead actualizado'); render(); }
      catch (err) { toast(err.message, true); }
    };
    return `<div class="card"><table>
      <tr><th>Nombre</th><th>Teléfono</th><th>Canal</th><th>Fechas</th><th>Score</th><th>Etapa</th><th></th></tr>
      ${leads.map(l => `<tr>
        <td>${esc(l.name || '—')}</td><td>${esc(l.phone || '—')}</td><td>${esc(l.channel)}</td>
        <td>${l.checkIn ? day(l.checkIn) + ' → ' + day(l.checkOut) : '—'}</td>
        <td>${l.score}</td><td>${sb(l.stage)}</td>
        <td>${['new', 'qualified', 'quoted'].includes(l.stage) ? `
          <button class="btn small secondary" onclick="_leadStage('${l.id}','won')">Ganado</button>
          <button class="btn small secondary" onclick="_leadStage('${l.id}','lost')">Perdido</button>` : ''}</td>
      </tr>`).join('')}
    </table>${leads.length ? '' : '<p class="muted">Sin leads. Se crean automáticamente desde WhatsApp/webchat.</p>'}</div>`;
  }

  async function viewHousekeeping() {
    const tasks = await get(`/ops/housekeeping/tasks?${pid()}`);
    window._hkStatus = async (id, status) => {
      try { await api(`/ops/housekeeping/tasks/${id}`, { method: 'PATCH', body: { status } }); toast('Tarea actualizada'); render(); }
      catch (err) { toast(err.message, true); }
    };
    return `<div class="card"><table>
      <tr><th>Habitación</th><th>Tipo</th><th>Prioridad</th><th>Estado</th><th>Notas</th><th>Creada</th><th></th></tr>
      ${tasks.map(t => `<tr>
        <td><b>${esc(t.room.number)}</b></td><td>${esc(t.type)}</td><td>${esc(t.priority)}</td><td>${sb(t.status)}</td>
        <td class="muted">${esc(t.notes || '')}</td><td>${dt(t.createdAt)}</td>
        <td>${t.status === 'pending' ? `<button class="btn small secondary" onclick="_hkStatus('${t.id}','in_progress')">Iniciar</button>` : ''}
          ${t.status === 'in_progress' ? `<button class="btn small secondary" onclick="_hkStatus('${t.id}','done')">Terminar</button>` : ''}
          ${t.status === 'done' ? `<button class="btn small secondary" onclick="_hkStatus('${t.id}','inspected')">Inspeccionar</button>` : ''}</td>
      </tr>`).join('')}
    </table>${tasks.length ? '' : '<p class="muted">Sin tareas. Se generan automáticamente en cada check-out.</p>'}</div>`;
  }

  async function viewMaintenance() {
    const orders = await get(`/ops/maintenance/orders?${pid()}`);
    const rooms = await get(`/admin/rooms?${pid()}`);
    window._mtCreate = async () => {
      try {
        const { data } = await api('/ops/maintenance/orders', {
          method: 'POST',
          body: { propertyId: state.propertyId, roomId: $('#mtRoom').value || null, title: $('#mtTitle').value, priority: $('#mtPrio').value, blocksRoom: $('#mtBlocks').checked },
        });
        toast(data.pendingApproval ? 'Orden creada; bloqueo enviado a aprobación' : 'Orden creada');
        render();
      } catch (err) { toast(err.message, true); }
    };
    window._mtStatus = async (id, status) => {
      try { await api(`/ops/maintenance/orders/${id}`, { method: 'PATCH', body: { status } }); toast('Orden actualizada'); render(); }
      catch (err) { toast(err.message, true); }
    };
    return `
      <div class="card"><h3>Nueva orden</h3><div class="row">
        <div><label>Título *</label><input id="mtTitle" placeholder="Aire acondicionado no enfría"></div>
        <div><label>Habitación</label><select id="mtRoom"><option value="">(ninguna)</option>${rooms.map(r => `<option value="${r.id}">${esc(r.number)}</option>`).join('')}</select></div>
        <div><label>Prioridad</label><select id="mtPrio"><option>low</option><option selected>medium</option><option>high</option><option>critical</option></select></div>
        <div class="fit"><label style="display:inline">Bloquear hab.</label> <input type="checkbox" id="mtBlocks" style="width:auto"></div>
        <button class="btn fit" onclick="_mtCreate()">Crear</button>
      </div></div>
      <div class="card"><table>
        <tr><th>Título</th><th>Hab</th><th>Prioridad</th><th>Estado</th><th>Reportó</th><th></th></tr>
        ${orders.map(o => `<tr>
          <td>${esc(o.title)}</td><td>${esc(o.room?.number || '—')}</td><td>${esc(o.priority)}</td><td>${sb(o.status)}</td><td>${esc(o.reportedBy || '')}</td>
          <td>${o.status === 'open' ? `<button class="btn small secondary" onclick="_mtStatus('${o.id}','in_progress')">Iniciar</button>` : ''}
            ${o.status === 'in_progress' ? `<button class="btn small secondary" onclick="_mtStatus('${o.id}','resolved')">Resolver</button>` : ''}</td>
        </tr>`).join('')}
      </table>${orders.length ? '' : '<p class="muted">Sin órdenes de mantenimiento.</p>'}</div>`;
  }

  async function viewPayments() {
    const [payments, links] = await Promise.all([get(`/payments?${pid()}`), get(`/payments/links?${pid()}`)]);
    return `
      <div class="card"><h3>Pagos registrados</h3><table>
        <tr><th>Fecha</th><th>Reserva</th><th>Método</th><th>Proveedor</th><th>Tipo</th><th>Valor</th><th>Estado</th></tr>
        ${payments.map(p => `<tr><td>${dt(p.createdAt)}</td><td>${esc(p.reservation?.code || '—')}</td><td>${esc(p.method)}</td><td>${esc(p.provider || '')}</td><td>${p.kind === 'refund' ? badge('Reembolso', 'red') : 'Pago'}</td><td>${cop(p.amount)}</td><td>${sb(p.status)}</td></tr>`).join('')}
      </table>${payments.length ? '' : '<p class="muted">Sin pagos aún.</p>'}</div>
      <div class="card"><h3>Links de pago</h3><table>
        <tr><th>Concepto</th><th>Valor</th><th>Estado</th><th>Vence</th><th>URL</th></tr>
        ${links.map(l => `<tr><td>${esc(l.concept)}</td><td>${cop(l.amount)}</td><td>${sb(l.status)}</td><td>${dt(l.expiresAt)}</td><td><a href="${l.url}" target="_blank" style="color:var(--accent2)">abrir</a></td></tr>`).join('')}
      </table>${links.length ? '' : '<p class="muted">Sin links generados.</p>'}</div>`;
  }

  async function viewApprovals() {
    const pending = await get(`/approvals?${pid()}&status=pending`);
    const decided = await get(`/approvals?${pid()}&status=approved`);
    window._decide = async (id, approve) => {
      try {
        await api(`/approvals/${id}/decide`, { method: 'POST', body: { approve, note: approve ? null : prompt('Motivo del rechazo:') } });
        toast(approve ? 'Aprobado y ejecutado' : 'Rechazado');
        render();
      } catch (err) { toast(err.message, true); }
    };
    return `
      <div class="card"><h3>Pendientes (${pending.length})</h3>
      ${pending.length ? `<table><tr><th>Tipo</th><th>Resumen</th><th>Solicitó</th><th>Requiere</th><th>Fecha</th><th></th></tr>
        ${pending.map(a => `<tr>
          <td>${badge(a.type, 'yellow')}</td><td>${esc(a.summary)}</td><td>${esc(a.requestedByName || '—')}</td><td>${esc(a.requiredRole)}</td><td>${dt(a.createdAt)}</td>
          <td><button class="btn small" onclick="_decide('${a.id}',true)">Aprobar</button>
              <button class="btn small danger" onclick="_decide('${a.id}',false)">Rechazar</button></td>
        </tr>`).join('')}</table>` : '<p class="muted">No hay solicitudes pendientes. 🎉</p>'}</div>
      <div class="card"><h3>Histórico aprobadas</h3>
      ${decided.length ? `<table>${decided.map(a => `<tr><td>${badge(a.type, 'green')}</td><td>${esc(a.summary)}</td><td class="muted">por ${esc(a.decidedByName || '')} · ${dt(a.decidedAt)}</td></tr>`).join('')}</table>` : '<p class="muted">Sin decisiones aún.</p>'}</div>`;
  }

  async function viewCompliance() {
    const [ov, tra, sire] = await Promise.all([
      get(`/compliance/overview?${pid()}`),
      get(`/compliance/tra?${pid()}`),
      get(`/compliance/sire?${pid()}`),
    ]);
    window._traEdit = tRecord => {
      const t = JSON.parse(decodeURIComponent(tRecord));
      const m = modal(`
        <h2>TRA — ${esc(t.guestName || '')}</h2>
        <label>Nombre completo</label><input id="tName" value="${esc(t.guestName || '')}">
        <div class="row"><div><label>Tipo doc</label><select id="tDocType">${['CC', 'CE', 'PASSPORT', 'TI'].map(x => `<option ${t.documentType === x ? 'selected' : ''}>${x}</option>`).join('')}</select></div>
        <div><label>Número doc</label><input id="tDocNum" value="${esc(t.documentNumber || '')}"></div></div>
        <div class="row"><div><label>Nacionalidad (ISO)</label><input id="tNat" value="${esc(t.nationality || 'CO')}"></div>
        <div><label>Ciudad origen</label><input id="tOrigin" value="${esc(t.originCity || '')}"></div></div>
        <label>Motivo de viaje</label><select id="tReason">${['turismo', 'negocios', 'evento', 'otro'].map(x => `<option ${t.travelReason === x ? 'selected' : ''}>${x}</option>`).join('')}</select>
        <button class="btn mt" id="tSave">Guardar</button>`);
      m.querySelector('#tSave').onclick = async () => {
        try {
          await api(`/compliance/tra/${t.id}`, { method: 'PATCH', body: { guestName: m.querySelector('#tName').value, documentType: m.querySelector('#tDocType').value, documentNumber: m.querySelector('#tDocNum').value, nationality: m.querySelector('#tNat').value, originCity: m.querySelector('#tOrigin').value, travelReason: m.querySelector('#tReason').value } });
          toast('TRA actualizada'); m.remove(); render();
        } catch (err) { toast(err.message, true); }
      };
    };
    window._sireMark = async (id, status) => {
      try { await api(`/compliance/sire/${id}/status`, { method: 'PATCH', body: { status } }); toast('SIRE actualizado'); render(); }
      catch (err) { toast(err.message, true); }
    };
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">RNT</div><div class="value" style="font-size:16px">${esc(ov.rnt.number || 'Sin registrar')}</div>
          <div class="${ov.rnt.alert ? '' : 'muted'}" style="color:${ov.rnt.alert ? 'var(--red)' : ''};font-size:12px">${ov.rnt.daysLeft !== null ? 'vence en ' + ov.rnt.daysLeft + ' días' : ''}</div></div>
        <div class="kpi"><div class="label">TRA incompletas</div><div class="value" style="color:${ov.tra.incomplete ? 'var(--yellow)' : 'inherit'}">${ov.tra.incomplete}</div></div>
        <div class="kpi"><div class="label">SIRE pendientes</div><div class="value" style="color:${ov.sire.pending ? 'var(--yellow)' : 'inherit'}">${ov.sire.pending}</div></div>
      </div>
      <div class="card mt"><h3>Tarjetas de Registro de Alojamiento (TRA)</h3>
        ${tra.length ? `<table><tr><th>Reserva</th><th>Huésped</th><th>Documento</th><th>Nacionalidad</th><th>Estado</th><th></th></tr>
        ${tra.map(t => `<tr><td>${esc(t.reservation.code)}</td><td>${esc(t.guestName)}</td><td>${esc(t.documentType || '')} ${esc(t.documentNumber || '—')}</td><td>${esc(t.nationality || '—')}</td><td>${sb(t.status)}${t.missingFields ? `<div class="muted" style="font-size:11px">faltan: ${esc(t.missingFields)}</div>` : ''}</td>
        <td><button class="btn small secondary" onclick="_traEdit('${encodeURIComponent(JSON.stringify(t))}')">Editar</button></td></tr>`).join('')}</table>` : '<p class="muted">Se crean automáticamente al confirmar reservas.</p>'}</div>
      <div class="card"><h3>Reportes SIRE (extranjeros)</h3>
        ${sire.length ? `<table><tr><th>Reserva</th><th>Huésped</th><th>Nacionalidad</th><th>Estado</th><th></th></tr>
        ${sire.map(s => `<tr><td>${esc(s.reservation.code)}</td><td>${esc(s.guestName)}</td><td>${esc(s.nationality)}</td><td>${sb(s.status)}</td>
        <td>${s.status === 'pending' ? `<button class="btn small secondary" onclick="_sireMark('${s.id}','prepared')">Marcar preparado</button>` : ''}
        ${s.status === 'prepared' ? `<button class="btn small secondary" onclick="_sireMark('${s.id}','reported')">Marcar reportado</button>` : ''}</td></tr>`).join('')}</table>` : '<p class="muted">Sin huéspedes extranjeros detectados.</p>'}</div>`;
  }

  function viewCopilot() {
    const role = state.user.role;
    const suggestions = {
      HOUSEKEEPING: ['¿Qué limpiezas hay pendientes?', 'Estado de las habitaciones'],
      MAINTENANCE: ['Órdenes de mantenimiento abiertas', 'Estado de las habitaciones'],
      FRONTDESK: ['Llegadas y salidas de hoy', 'Estado de las habitaciones', 'Aprobaciones pendientes'],
      ACCOUNTING: ['Caja del día', 'Aprobaciones pendientes'],
      HR: ['Empleados y nómina', 'Estado de las habitaciones'],
    }[role] || ['Estado de las habitaciones', 'Llegadas y salidas de hoy', 'Aprobaciones pendientes'];

    setTimeout(() => {
      const body = $('#copBody');
      const append = (text, dir) => {
        const el = document.createElement('div');
        el.className = 'msg ' + dir;
        el.textContent = text;
        body.appendChild(el); body.scrollTop = body.scrollHeight;
      };
      const typing = on => {
        let t = document.getElementById('copTyping');
        if (on && !t) { t = document.createElement('div'); t.className = 'typing'; t.id = 'copTyping'; t.innerHTML = '<span></span><span></span><span></span>'; body.appendChild(t); body.scrollTop = body.scrollHeight; }
        if (!on && t) t.remove();
      };
      const ask = async text => {
        if (!text.trim()) return;
        append(text, 'out'); typing(true);
        try {
          const { data } = await api('/assistant/internal', { method: 'POST', body: { propertyId: state.propertyId, text } });
          typing(false); append(data.reply, 'in');
        } catch (err) { typing(false); append('No pude procesar eso: ' + err.message, 'in'); }
      };
      window._copAsk = ask;
      $('#copSend').onclick = () => { const v = $('#copText').value; $('#copText').value = ''; ask(v); };
      $('#copText').onkeydown = e => { if (e.key === 'Enter') { const v = $('#copText').value; $('#copText').value = ''; ask(v); } };
      document.querySelectorAll('.cop-chip').forEach(ch => { ch.onclick = () => ask(ch.textContent); });
    }, 0);

    return `
      <div class="card" style="max-width:820px">
        <h3>🧭 Copiloto interno — ${esc(state.user.name)} <span class="badge blue">${esc(role)}</span></h3>
        <p class="muted" style="font-size:12.5px;margin-bottom:12px">Pregúntame en lenguaje natural. Solo veo la información que tu rol puede consultar.</p>
        <div class="chat" style="height:460px;border-color:var(--border)">
          <div class="chat-body" id="copBody">
            <div class="msg in">¡Hola, ${esc(state.user.name.split(' ')[0])}! 👋 Soy tu copiloto. ¿En qué te ayudo?</div>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;padding:10px 12px 0">
            ${suggestions.map(s => `<button class="btn small secondary cop-chip">${esc(s)}</button>`).join('')}
          </div>
          <div class="chat-input">
            <input id="copText" placeholder="Escribe tu pregunta…" autocomplete="off">
            <button class="btn fit" id="copSend">Enviar</button>
          </div>
        </div>
      </div>`;
  }

  async function viewContent() {
    const [rooms, knowledge] = await Promise.all([
      get(`/content/rooms?${pid()}`),
      get(`/content/knowledge?${pid()}`),
    ]);
    window._editRoom = r => {
      const room = rooms.find(x => x.id === r);
      const m = modal(`
        <h2>Contenido — ${esc(room.name)}</h2>
        <label>Descripción corta</label><input id="rDesc" value="${esc(room.description || '')}">
        <label>Descripción larga (la usa el agente y la web)</label><textarea id="rLong" rows="3">${esc(room.longDescription || '')}</textarea>
        <div class="row">
          <div><label>Camas</label><input id="rBed" value="${esc(room.bedConfig || '')}" placeholder="1 king + 1 sofá cama"></div>
          <div><label>Tamaño m²</label><input id="rSize" type="number" value="${room.sizeM2 || ''}"></div>
          <div><label>Vista</label><input id="rView" value="${esc(room.view || '')}" placeholder="ciudad"></div>
        </div>
        <label>Amenidades (separadas por coma)</label><input id="rAmen" value="${esc(room.amenities || '')}">
        <label>Características (wifi, aire, minibar, jacuzzi...)</label><input id="rFeat" value="${esc(room.features || '')}">
        <div style="display:flex;gap:8px;margin-top:14px"><button class="btn" id="rSave">Guardar</button></div>
        <h3 style="margin-top:20px">Imágenes (${room.images.length})</h3>
        <div style="display:flex;gap:8px;flex-wrap:wrap;margin:8px 0">
          ${room.images.map(im => `<img src="${im.url}" style="width:90px;height:70px;object-fit:cover;border-radius:8px;border:1px solid var(--border)">`).join('') || '<span class="muted">Sin imágenes aún.</span>'}
        </div>
        <label>Subir imagen (máx 15 MB)</label><input id="rImg" type="file" accept="image/*">
        <button class="btn small secondary mt" id="rUpload">Subir imagen</button>`);
      m.querySelector('#rSave').onclick = async () => {
        try {
          await api(`/content/rooms/${room.id}`, { method: 'PATCH', body: {
            description: m.querySelector('#rDesc').value, longDescription: m.querySelector('#rLong').value,
            bedConfig: m.querySelector('#rBed').value, sizeM2: m.querySelector('#rSize').value || null,
            view: m.querySelector('#rView').value, amenities: m.querySelector('#rAmen').value, features: m.querySelector('#rFeat').value,
          }});
          toast('Contenido guardado'); m.remove(); render();
        } catch (err) { toast(err.message, true); }
      };
      m.querySelector('#rUpload').onclick = () => {
        const file = m.querySelector('#rImg').files[0];
        if (!file) return toast('Selecciona una imagen', true);
        const reader = new FileReader();
        reader.onload = async () => {
          try {
            await api('/documents', { method: 'POST', body: {
              propertyId: state.propertyId, entityType: 'RoomType', entityId: room.id, docType: 'image',
              title: `Foto ${room.name}`, fileName: file.name, mimeType: file.type, base64: reader.result,
            }});
            toast('Imagen subida'); m.remove(); render();
          } catch (err) { toast(err.message, true); }
        };
        reader.readAsDataURL(file);
      };
    };
    window._addKnow = async () => {
      try {
        await api('/content/knowledge', { method: 'POST', body: {
          propertyId: state.propertyId, category: $('#kCat').value, title: $('#kTitle').value,
          content: $('#kContent').value, visibility: $('#kVis').value, tags: $('#kTags').value,
        }});
        toast('Conocimiento agregado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._delKnow = async id => {
      if (!confirm('¿Desactivar este ítem de conocimiento?')) return;
      try { await api(`/content/knowledge/${id}`, { method: 'DELETE' }); toast('Ítem desactivado'); render(); }
      catch (err) { toast(err.message, true); }
    };
    return `
      <div class="card"><h3>Habitaciones — contenido que alimenta al agente y la web</h3>
        <p class="muted" style="font-size:12.5px;margin-bottom:12px">Mientras más completa esté cada habitación (descripción, camas, fotos, amenidades), mejor responderá Atria IA a los huéspedes.</p>
        <div class="room-grid">
          ${rooms.map(r => `<div class="room-tile" style="border-top-color:var(--accent2)">
            ${r.images[0] ? `<img src="${r.images[0].url}" style="width:100%;height:80px;object-fit:cover;border-radius:6px;margin-bottom:6px">` : ''}
            <div class="num" style="font-size:15px">${esc(r.name)}</div>
            <div class="type">${cop(r.fromPrice)}/noche · ${r.capacity} pax · ${r.images.length} 📷</div>
            <div class="muted" style="font-size:11px;margin:4px 0;height:28px;overflow:hidden">${esc(r.longDescription || r.description || 'Sin descripción')}</div>
            <button class="btn small secondary" onclick="_editRoom('${r.id}')">Editar contenido</button>
          </div>`).join('')}
        </div>
      </div>
      <div class="card"><h3>Base de conocimiento (FAQs, servicios, ubicación)</h3>
        <p class="muted" style="font-size:12.5px">Lo <b>público</b> lo usa el agente de huéspedes; lo <b>interno</b>, los asistentes del equipo.</p>
        <div class="row mt">
          <div><label>Categoría</label><select id="kCat"><option value="faq">FAQ</option><option value="service">Servicio</option><option value="location">Ubicación</option><option value="amenity">Amenidad</option><option value="attraction">Atracción cercana</option><option value="general">General</option></select></div>
          <div><label>Visibilidad</label><select id="kVis"><option value="public">Pública</option><option value="internal">Interna</option></select></div>
          <div><label>Título</label><input id="kTitle" placeholder="¿Tienen parqueadero?"></div>
          <div><label>Etiquetas</label><input id="kTags" placeholder="parqueo, carro"></div>
        </div>
        <label>Contenido / respuesta</label><textarea id="kContent" rows="2" placeholder="Sí, contamos con parqueadero cubierto sin costo para huéspedes."></textarea>
        <button class="btn small mt" onclick="_addKnow()">Agregar</button>
        <table class="mt"><tr><th>Categoría</th><th>Título</th><th>Visibilidad</th><th>Contenido</th><th></th></tr>
        ${knowledge.map(k => `<tr>
          <td>${esc(k.category)}</td><td>${esc(k.title)}</td>
          <td>${k.visibility === 'public' ? badge('pública', 'green') : badge('interna', 'yellow')}${k.active ? '' : ' ' + badge('inactiva', 'gray')}</td>
          <td class="muted" style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(k.content)}</td>
          <td>${k.active ? `<button class="btn small danger" onclick="_delKnow('${k.id}')">Quitar</button>` : ''}</td>
        </tr>`).join('')}</table>
        ${knowledge.length ? '' : '<p class="muted mt">Sin conocimiento aún. Agrega FAQs, servicios y datos del hotel para que el agente responda con precisión.</p>'}
      </div>`;
  }

  async function viewSite() {
    const site = await get(`/content/site?${pid()}`);
    const siteUrl = `${location.origin}/sitio/${state.propertyId}`;
    window._saveSite = async () => {
      try {
        await api('/content/site', { method: 'PUT', body: { propertyId: state.propertyId, heroTitle: $('#stTitle').value, heroSubtitle: $('#stSub').value, promoText: $('#stPromo').value, aboutText: $('#stAbout').value, published: $('#stPub').checked } });
        toast('Sitio actualizado'); render();
      } catch (e) { toast(e.message, true); }
    };
    return `
      <div class="card"><h3>Sitio web público con reserva directa</h3>
        <p class="muted" style="font-size:12.5px;margin-bottom:12px">Tu página muestra las habitaciones e imágenes que cargaste en "Habitaciones & Conocimiento", con motor de reservas y pago. Compártela sin comisiones de OTAs.</p>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
          <span class="badge ${site.published !== false ? 'green' : 'gray'}">${site.published !== false ? 'Publicado' : 'Oculto'}</span>
          <a href="${siteUrl}" target="_blank" style="color:var(--accent2)">${siteUrl}</a>
          <button class="btn small secondary" onclick="navigator.clipboard&&navigator.clipboard.writeText('${siteUrl}').then(()=>toast('Enlace copiado'))">Copiar enlace</button>
        </div>
        <label>Título principal (hero)</label><input id="stTitle" value="${esc(site.heroTitle || '')}" placeholder="Vive una experiencia inolvidable">
        <label>Subtítulo</label><input id="stSub" value="${esc(site.heroSubtitle || '')}" placeholder="Reserva directa sin comisiones">
        <label>Promoción (opcional)</label><input id="stPromo" value="${esc(site.promoText || '')}" placeholder="10% de descuento reservando directo">
        <label>Acerca del hotel</label><textarea id="stAbout" rows="3">${esc(site.aboutText || '')}</textarea>
        <label style="display:inline-flex;align-items:center;gap:8px;margin-top:12px"><input type="checkbox" id="stPub" ${site.published !== false ? 'checked' : ''} style="width:auto"> Sitio publicado</label>
        <div class="mt"><button class="btn" onclick="_saveSite()">Guardar</button>
          <a href="${siteUrl}" target="_blank" class="btn secondary" style="text-decoration:none;margin-left:8px">Ver sitio</a></div>
      </div>`;
  }

  async function viewAgent() {
    const agents = await get(`/content/agents?${pid()}`);
    const guest = agents.find(a => a.scope === 'guest') || agents[0];
    window._saveAgent = async () => {
      try {
        await api(`/content/agents/${guest.id}`, { method: 'PATCH', body: {
          displayName: $('#agName').value, tone: $('#agTone').value, persona: $('#agPersona').value,
          languages: $('#agLangs').value, greeting: $('#agGreeting').value,
          emojis: $('#agEmojis').checked, domainOnly: $('#agDomain').checked, llmEnabled: $('#agLlm').checked,
        }});
        toast('Agente actualizado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._testAgent = async () => {
      const q = $('#agTest').value.trim();
      if (!q) return;
      $('#agAnswer').innerHTML = '<span class="muted">Pensando…</span>';
      try {
        const { data } = await api('/content/agents/preview', { method: 'POST', body: { propertyId: state.propertyId, scope: 'guest', question: q } });
        $('#agAnswer').innerHTML = `<div class="msg in" style="max-width:100%">${esc(data.answer)}</div>`;
      } catch (err) { $('#agAnswer').innerHTML = `<span style="color:var(--red)">${esc(err.message)}</span>`; }
    };
    return `
      <div class="grid cols-2">
        <div class="card"><h3>Personalidad de ${esc(guest.displayName)}</h3>
          <p class="muted" style="font-size:12.5px;margin-bottom:10px">Configura cómo se presenta y habla el agente de este hotel. La "mascota" de cada hotel puede tener su propio nombre y tono.</p>
          <label>Nombre del agente (la mascota)</label><input id="agName" value="${esc(guest.displayName)}">
          <label>Tono</label><input id="agTone" value="${esc(guest.tone)}" placeholder="cálido, cercano y profesional">
          <label>Personalidad / instrucciones</label><textarea id="agPersona" rows="3">${esc(guest.persona || '')}</textarea>
          <label>Saludo inicial (opcional)</label><input id="agGreeting" value="${esc(guest.greeting || '')}" placeholder="¡Hola! Soy Lucía, tu anfitriona en...">
          <label>Idiomas</label><input id="agLangs" value="${esc(guest.languages)}" placeholder="es,en">
          <div class="row mt" style="align-items:center">
            <label class="fit" style="margin:0"><input type="checkbox" id="agEmojis" ${guest.emojis ? 'checked' : ''} style="width:auto"> Usa emojis</label>
            <label class="fit" style="margin:0"><input type="checkbox" id="agDomain" ${guest.domainOnly ? 'checked' : ''} style="width:auto"> Solo habla del hotel</label>
            <label class="fit" style="margin:0"><input type="checkbox" id="agLlm" ${guest.llmEnabled ? 'checked' : ''} style="width:auto"> IA natural (Claude)</label>
          </div>
          <button class="btn mt" onclick="_saveAgent()">Guardar configuración</button>
        </div>
        <div class="card"><h3>Herramientas que controla</h3>
          <p class="muted" style="font-size:12.5px">El agente puede ejecutar estas funciones por conversación (con permisos y aprobaciones):</p>
          <ul style="margin:10px 0 0 18px;font-size:13.5px;line-height:1.9">
            <li>🔍 Consultar disponibilidad</li>
            <li>💵 Cotizar con impuestos y anticipo</li>
            <li>📅 Crear reserva + link de pago</li>
            <li>🛏️ Dar datos de habitaciones (según lo que configures)</li>
            <li>🏨 Dar datos del hotel, servicios y políticas</li>
            <li>🔔 Notificar al equipo interno</li>
          </ul>
          <p class="muted mt" style="font-size:12px">Nunca ofrece reembolsos ni descuentos: eso escala a una persona.</p>
          <hr style="border-color:var(--border);margin:14px 0">
          <h3>Probar al agente</h3>
          <div class="row"><input id="agTest" placeholder="¿Tienen parqueadero? ¿La suite tiene jacuzzi?"><button class="btn fit" onclick="_testAgent()">Preguntar</button></div>
          <div id="agAnswer" class="mt"></div>
          <p class="muted mt" style="font-size:11.5px">Esta prueba usa el conocimiento configurado en "Habitaciones & Conocimiento". Sin API key de IA, el agente responde con ese conocimiento; con API key, además conversa de forma natural.</p>
        </div>
      </div>`;
  }

  async function viewInvoices() {
    const { dataicoConfigured, invoices } = await get(`/invoices?${pid()}`);
    window._issueInv = async id => {
      try {
        const { data } = await api(`/invoices/${id}/issue`, { method: 'POST' });
        toast(data.status === 'validated' ? `Factura ${data.fullNumber} validada (CUFE recibido)` : `Factura ${data.fullNumber || ''} ${data.status === 'pending' ? 'numerada, pendiente de transmisión' : data.status}`);
        render();
      } catch (err) { toast(err.message, true); }
    };
    return `
      <div class="card"><h3>Proveedor tecnológico DIAN</h3>
        ${dataicoConfigured
          ? `${badge('Dataico conectado', 'green')} Las facturas emitidas se transmiten a la DIAN.`
          : `${badge('Dataico sin configurar', 'yellow')} <span class="muted">Las facturas se generan y numeran localmente como borrador. Configura <code>DATAICO_AUTH_TOKEN</code> y <code>DATAICO_ACCOUNT_ID</code> en .env para transmitir a la DIAN.</span>`}
      </div>
      <div class="card"><table>
        <tr><th>Número</th><th>Reserva</th><th>Cliente</th><th>Subtotal</th><th>IVA</th><th>Total</th><th>Estado</th><th>CUFE</th><th></th></tr>
        ${invoices.map(i => `<tr>
          <td>${esc(i.fullNumber || '(borrador)')}</td><td>${esc(i.reservation?.code || '—')}</td><td>${esc(i.customerName)}</td>
          <td>${cop(i.subtotal)}</td><td>${cop(i.tax)}</td><td><b>${cop(i.total)}</b></td>
          <td>${sb(i.status)}${i.errorMsg ? `<div class="muted" style="font-size:10.5px;max-width:200px">${esc(i.errorMsg.slice(0, 90))}</div>` : ''}</td>
          <td class="muted" style="font-size:11px">${esc((i.cufe || '').slice(0, 12))}${i.cufe ? '…' : '—'}</td>
          <td>${['draft', 'error'].includes(i.status) ? `<button class="btn small" onclick="_issueInv('${i.id}')">Emitir</button>` : ''}</td>
        </tr>`).join('')}
      </table>${invoices.length ? '' : '<p class="muted">Sin facturas. Se generan automáticamente como borrador en cada check-out.</p>'}</div>`;
  }

  async function viewEmployees() {
    const employees = await get(`/hr/employees?${pid()}`);
    window._addEmployee = async () => {
      try {
        await api('/hr/employees', {
          method: 'POST',
          body: {
            propertyId: state.propertyId, fullName: $('#eName').value, documentNumber: $('#eDoc').value,
            position: $('#ePos').value, area: $('#eArea').value, salary: +$('#eSalary').value,
            hireDate: $('#eHire').value, riskClass: +$('#eRisk').value, contractType: $('#eContract').value,
            eps: $('#eEps').value, afp: $('#eAfp').value, arl: $('#eArl').value,
          },
        });
        toast('Empleado creado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._contracts = async (empId, empName) => {
      const list = await get(`/hr/contracts?${pid()}&employeeId=${empId}`);
      const m = modal(`
        <h2>Contratos — ${esc(empName)}</h2>
        <div id="ctList">${list.length ? list.map(c => `
          <div class="card" style="margin-bottom:10px">
            <div style="display:flex;justify-content:space-between;align-items:center">
              <div><b>${esc(c.type)}</b> · ${esc(c.position)} · ${cop(c.salary)}
                <div class="muted" style="font-size:12px">desde ${day(c.startDate)}${c.endDate ? ' hasta ' + day(c.endDate) : ''} · ${c._count.amendments} otrosí(es)</div></div>
              <div>${sb(c.status === 'active' ? 'confirmed' : c.status === 'ended' ? 'closed' : 'pending')} ${esc(c.status)}</div>
            </div>
            <div class="row mt">
              <button class="btn small secondary fit" onclick="_ctText('${c.id}')">Ver texto</button>
              ${c.status === 'draft' ? `<button class="btn small fit" onclick="_ctActivate('${c.id}')">Activar (aprueba RR.HH.)</button>` : ''}
              ${c.status === 'active' ? `<button class="btn small secondary fit" onclick="_ctAmend('${c.id}')">Crear otrosí</button>` : ''}
            </div>
          </div>`).join('') : '<p class="muted">Sin contratos aún.</p>'}</div>
        <h3 class="mt">Generar contrato</h3>
        <div class="row">
          <div><label>Tipo</label><select id="ctType"><option value="indefinido">Indefinido</option><option value="fijo">Fijo</option><option value="obra">Obra o labor</option><option value="aprendizaje">Aprendizaje</option></select></div>
          <div><label>Jornada</label><input id="ctWork" value="Tiempo completo"></div>
          <div><label>Fin (si es fijo)</label><input id="ctEnd" type="date"></div>
        </div>
        <label>Funciones</label><input id="ctFunc" placeholder="Las propias del cargo...">
        <button class="btn mt" id="ctGen">Generar borrador</button>`);
      m.querySelector('#ctGen').onclick = async () => {
        try {
          await api('/hr/contracts', { method: 'POST', body: { employeeId: empId, type: m.querySelector('#ctType').value, workday: m.querySelector('#ctWork').value, endDate: m.querySelector('#ctEnd').value || null, functions: m.querySelector('#ctFunc').value } });
          toast('Borrador de contrato creado'); m.remove(); window._contracts(empId, empName);
        } catch (err) { toast(err.message, true); }
      };
      window._ctText = async id => {
        const { data } = await api(`/hr/contracts/${id}/text`);
        modal(`<h2>Contrato</h2><pre style="white-space:pre-wrap;font-family:inherit;font-size:13px;line-height:1.6">${esc(data.text)}</pre>`);
      };
      window._ctActivate = async id => {
        try { await api(`/hr/contracts/${id}/activate`, { method: 'POST' }); toast('Activación enviada a aprobación de RR.HH.'); m.remove(); render(); }
        catch (err) { toast(err.message, true); }
      };
      window._ctAmend = async id => {
        const type = prompt('Tipo de otrosí (salary, position, workday, functions, extension):', 'salary');
        if (!type) return;
        const val = prompt('Nuevo valor:');
        if (!val) return;
        try { await api(`/hr/contracts/${id}/amendments`, { method: 'POST', body: { changeType: type, newValue: val, detail: `Cambio de ${type}` } }); toast('Otrosí enviado a aprobación'); m.remove(); render(); }
        catch (err) { toast(err.message, true); }
      };
    };
    window._simLiq = async id => {
      try {
        const { data } = await api('/hr/liquidations/simulate', { method: 'POST', body: { employeeId: id, cause: 'renuncia' } });
        modal(`<h2>Simulación de liquidación — ${esc(data.employee.name)}</h2>
          <p class="muted" style="font-size:12px">Ingreso: ${day(data.employee.hireDate)} · Salario: ${cop(data.employee.salary)} · Causa: ${esc(data.cause)}</p>
          <table class="mt">${data.items.map(i => `<tr><td>${esc(i.concept)}</td><td class="right">${cop(i.amount)}</td></tr>`).join('')}
          <tr><td><b>Total estimado</b></td><td class="right"><b>${cop(data.total)}</b></td></tr></table>
          <p class="muted mt" style="font-size:11.5px">${esc(data.note)}</p>`);
      } catch (err) { toast(err.message, true); }
    };
    return `
      <div class="card"><h3>Nuevo empleado</h3>
        <div class="row">
          <div><label>Nombre completo *</label><input id="eName"></div>
          <div><label>Documento *</label><input id="eDoc"></div>
          <div><label>Cargo *</label><input id="ePos"></div>
          <div><label>Área</label><input id="eArea" placeholder="recepción"></div>
        </div>
        <div class="row">
          <div><label>Salario mensual *</label><input id="eSalary" type="number" value="1623500"></div>
          <div><label>Fecha ingreso *</label><input id="eHire" type="date"></div>
          <div><label>Contrato</label><select id="eContract"><option>indefinido</option><option>fijo</option><option>obra</option><option>aprendizaje</option></select></div>
          <div><label>Riesgo ARL</label><select id="eRisk"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></div>
        </div>
        <div class="row">
          <div><label>EPS</label><input id="eEps"></div>
          <div><label>AFP</label><input id="eAfp"></div>
          <div><label>ARL</label><input id="eArl"></div>
          <button class="btn fit" onclick="_addEmployee()">Crear</button>
        </div>
      </div>
      <div class="card"><table>
        <tr><th>Nombre</th><th>Documento</th><th>Cargo</th><th>Salario</th><th>Ingreso</th><th>EPS/AFP</th><th>Estado</th><th></th></tr>
        ${employees.map(e => `<tr>
          <td>${esc(e.fullName)}</td><td>${esc(e.documentNumber)}</td><td>${esc(e.position)}</td>
          <td>${cop(e.salary)}</td><td>${day(e.hireDate)}</td>
          <td class="muted" style="font-size:12px">${esc(e.eps || '⚠ sin EPS')} / ${esc(e.afp || '⚠ sin AFP')}</td>
          <td>${e.status === 'active' ? badge('Activo', 'green') : badge('Retirado', 'gray')}</td>
          <td><button class="btn small secondary" onclick="_contracts('${e.id}','${esc(e.fullName).replace(/'/g, '&#39;')}')">Contrato</button>
              <button class="btn small secondary" onclick="_simLiq('${e.id}')">Liquidación</button></td>
        </tr>`).join('')}
      </table>${employees.length ? '' : '<p class="muted">Sin empleados registrados.</p>'}</div>`;
  }

  async function viewFinance() {
    const [ov, ar, payables, pl] = await Promise.all([
      get(`/finance/overview?${pid()}`),
      get(`/finance/receivables?${pid()}`),
      get(`/finance/payables?${pid()}`),
      get(`/finance/report?${pid()}`),
    ]);
    window._apAdd = async () => {
      try { await api('/finance/payables', { method: 'POST', body: { propertyId: state.propertyId, supplierName: $('#apSup').value, concept: $('#apConcept').value, category: $('#apCat').value, amount: +$('#apAmount').value, dueDate: $('#apDue').value || null } }); toast('Cuenta por pagar creada'); render(); }
      catch (e) { toast(e.message, true); }
    };
    window._apPay = async id => { const s = prompt('Soporte/referencia del pago:'); if (s === null) return; try { await api(`/finance/payables/${id}/pay`, { method: 'POST', body: { support: s } }); toast('Pago registrado'); render(); } catch (e) { toast(e.message, true); } };
    window._finPrint = () => {
      const mes = new Date().toLocaleDateString('es-CO', { year: 'numeric', month: 'long' });
      printReport({
        title: 'Estado de resultados y cartera', subtitle: `Periodo: ${mes}`,
        meta: [{ label: 'Ingresos del mes', value: cop(ov.monthIncome) }, { label: 'Egresos', value: cop(ov.monthExpenses) }, { label: 'Resultado', value: cop(ov.monthNet) }],
        sections: [
          { title: 'Estado de resultados (P&G)', html: `<table><tr><td>Ingresos</td><td class="r">${cop(pl.income)}</td></tr>${Object.entries(pl.expenses).map(([k, v]) => `<tr><td>− ${esc(k)}</td><td class="r">${cop(v)}</td></tr>`).join('')}<tr class="total"><td>Resultado</td><td class="r">${cop(pl.result)}</td></tr></table>` },
          { title: `Cartera por cobrar (${ar.rows.length})`, html: ar.rows.length ? `<table><tr><th>Reserva</th><th>Huésped</th><th class="r">Saldo</th></tr>${ar.rows.map(r => `<tr><td>${esc(r.code)}</td><td>${esc(r.guest)}</td><td class="r">${cop(r.balance)}</td></tr>`).join('')}<tr class="total"><td colspan="2">Total cartera</td><td class="r">${cop(ar.total)}</td></tr></table>` : '<p>Sin cartera pendiente.</p>' },
        ],
      });
    };
    setTimeout(animateCounts, 0);
    return `
      <div class="row" style="justify-content:flex-end"><button class="btn ghost small" onclick="_finPrint()">🖨️ Imprimir / PDF</button></div>
      <div class="grid cols-4 mt">
        <div class="kpi"><div class="label">Ingresos del mes</div><div class="value" style="color:var(--green)"><span data-count="${ov.monthIncome}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Egresos del mes</div><div class="value"><span data-count="${ov.monthExpenses}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Resultado</div><div class="value" style="color:${ov.monthNet >= 0 ? 'var(--green)' : 'var(--red)'}"><span data-count="${ov.monthNet}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Cartera por cobrar</div><div class="value" style="color:${ov.receivable ? 'var(--yellow)' : 'inherit'}"><span data-count="${ov.receivable}" data-fmt="cop">$0</span></div></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="card"><h3>Estado de resultados (mes)</h3>
          <table><tr><td>Ingresos</td><td class="right" style="color:var(--green)">${cop(pl.income)}</td></tr>
          ${Object.entries(pl.expenses).map(([k, v]) => `<tr><td class="muted">− ${esc(k)}</td><td class="right muted">${cop(v)}</td></tr>`).join('')}
          <tr><td><b>Resultado</b></td><td class="right"><b style="color:${pl.result >= 0 ? 'var(--green)' : 'var(--red)'}">${cop(pl.result)}</b></td></tr></table>
        </div>
        <div class="card"><h3>Cartera por cobrar (${ar.rows.length})</h3>
          ${ar.rows.length ? `<table><tr><th>Reserva</th><th>Huésped</th><th>Saldo</th></tr>
          ${ar.rows.slice(0, 12).map(r => `<tr class="clickable" onclick="location.hash='res:${r.id}'"><td>${esc(r.code)}</td><td>${esc(r.guest)}</td><td><b>${cop(r.balance)}</b></td></tr>`).join('')}</table>
          <div class="right mt"><b>Total: ${cop(ar.total)}</b></div>` : '<p class="muted">Sin cartera pendiente. 🎉</p>'}
        </div>
      </div>
      <div class="card"><h3>Cuentas por pagar</h3>
        <div class="row">
          <div><label>Proveedor</label><input id="apSup"></div>
          <div><label>Concepto</label><input id="apConcept"></div>
          <div><label>Categoría</label><select id="apCat"><option value="proveedores">Proveedores</option><option value="servicios">Servicios</option><option value="impuestos">Impuestos</option><option value="otros">Otros</option></select></div>
          <div><label>Valor</label><input id="apAmount" type="number"></div>
          <div><label>Vence</label><input id="apDue" type="date"></div>
          <button class="btn fit" onclick="_apAdd()">Registrar</button>
        </div>
        <table class="mt"><tr><th>Proveedor</th><th>Concepto</th><th>Categoría</th><th>Valor</th><th>Vence</th><th>Estado</th><th></th></tr>
        ${payables.map(p => `<tr><td>${esc(p.supplierName)}</td><td>${esc(p.concept)}</td><td>${esc(p.category)}</td><td>${cop(p.amount)}</td><td>${p.dueDate ? day(p.dueDate) : '—'}</td>
          <td>${sb(p.status === 'paid' ? 'confirmed' : 'pending')} ${p.status === 'paid' ? 'pagada' : 'pendiente'}</td>
          <td>${p.status === 'open' ? `<button class="btn small" onclick="_apPay('${p.id}')">Pagar</button>` : ''}</td>
        </tr>`).join('')}</table>
        ${payables.length ? '' : '<p class="muted">Sin cuentas por pagar.</p>'}
      </div>`;
  }

  async function viewDataProtection() {
    const [ov, consents, requests, treatments] = await Promise.all([
      get(`/dataprotection/overview?${pid()}`),
      get(`/dataprotection/consents?${pid()}`),
      get(`/dataprotection/requests?${pid()}`),
      get(`/dataprotection/treatments?${pid()}`),
    ]);
    const purposeLabel = { marketing: 'Marketing', tratamiento: 'Tratamiento', imagen: 'Imagen', datos_sensibles: 'Datos sensibles', transferencia: 'Transferencia' };
    const typeLabel = { acceso: 'Acceso', rectificacion: 'Rectificación', supresion: 'Supresión', oposicion: 'Oposición', revocacion: 'Revocación' };
    const stLabel = { received: 'Recibida', in_progress: 'En trámite', resolved: 'Resuelta', rejected: 'Rechazada' };
    window._dpConsent = async () => {
      try { await api('/dataprotection/consents', { method: 'POST', body: { propertyId: state.propertyId, subjectName: $('#dcName').value, documentNumber: $('#dcDoc').value || null, purpose: $('#dcPurpose').value, channel: $('#dcChannel').value, granted: true } }); toast('Consentimiento registrado'); render(); }
      catch (e) { toast(e.message, true); }
    };
    window._dpRevoke = async id => { if (!confirm('¿Revocar este consentimiento?')) return; try { await api(`/dataprotection/consents/${id}/revoke`, { method: 'POST' }); toast('Consentimiento revocado'); render(); } catch (e) { toast(e.message, true); } };
    window._dpReq = async () => {
      try { await api('/dataprotection/requests', { method: 'POST', body: { propertyId: state.propertyId, subjectName: $('#drName').value, documentNumber: $('#drDoc').value || null, email: $('#drEmail').value || null, type: $('#drType').value, channel: $('#drChannel').value, detail: $('#drDetail').value || null } }); toast('Solicitud registrada'); render(); }
      catch (e) { toast(e.message, true); }
    };
    window._dpResolve = async id => { const r = prompt('Respuesta / resolución al titular:'); if (r === null) return; try { await api(`/dataprotection/requests/${id}/resolve`, { method: 'POST', body: { status: 'resolved', resolution: r } }); toast('Solicitud resuelta'); render(); } catch (e) { toast(e.message, true); } };
    window._dpExport = async () => {
      const doc = prompt('Documento del titular para el derecho de acceso:'); if (!doc) return;
      try {
        const data = await api(`/dataprotection/export?${pid()}&documentNumber=${encodeURIComponent(doc)}`);
        modal(`<h3>Derecho de acceso — ${esc(doc)}</h3>${data.found ? '' : '<p class="muted">Sin datos asociados a este documento.</p>'}<pre style="max-height:60vh;overflow:auto;white-space:pre-wrap;font-size:12px">${esc(JSON.stringify(data, null, 2))}</pre><div class="right"><button class="btn" onclick="this.closest('.modal-bg').remove()">Cerrar</button></div>`);
      } catch (e) { toast(e.message, true); }
    };
    window._dpErase = async () => {
      const doc = prompt('Documento del titular para SUPRIMIR (anonimizar). Esta acción es irreversible:'); if (!doc) return;
      if (!confirm(`Se anonimizarán los datos del titular ${doc}. Los registros exigidos por ley (TRA, SIRE, facturas) se conservan. ¿Continuar?`)) return;
      try { const r = await api('/dataprotection/erase', { method: 'POST', body: { propertyId: state.propertyId, documentNumber: doc } }); toast(`Titular anonimizado (${r.anonymized})`); render(); } catch (e) { toast(e.message, true); }
    };
    setTimeout(animateCounts, 0);
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Consentimientos activos</div><div class="value" style="color:var(--green)"><span data-count="${ov.consentsActive}">0</span></div></div>
        <div class="kpi"><div class="label">Revocados</div><div class="value"><span data-count="${ov.consentsRevoked}">0</span></div></div>
        <div class="kpi"><div class="label">Solicitudes abiertas</div><div class="value" style="color:${ov.requestsOpen ? 'var(--yellow)' : 'inherit'}"><span data-count="${ov.requestsOpen}">0</span></div></div>
        <div class="kpi"><div class="label">Vencidas (fuera de plazo)</div><div class="value" style="color:${ov.requestsOverdue ? 'var(--red)' : 'inherit'}"><span data-count="${ov.requestsOverdue}">0</span></div></div>
      </div>

      <div class="card mt"><h3>Solicitudes del titular · derechos ARCO / habeas data</h3>
        <div class="row">
          <div><label>Titular</label><input id="drName"></div>
          <div><label>Documento</label><input id="drDoc"></div>
          <div><label>Correo</label><input id="drEmail"></div>
          <div><label>Derecho</label><select id="drType"><option value="acceso">Acceso</option><option value="rectificacion">Rectificación</option><option value="supresion">Supresión</option><option value="oposicion">Oposición</option><option value="revocacion">Revocación</option></select></div>
          <div><label>Canal</label><select id="drChannel"><option value="web">Web</option><option value="correo">Correo</option><option value="recepcion">Recepción</option><option value="whatsapp">WhatsApp</option><option value="telefono">Teléfono</option></select></div>
          <button class="btn fit" onclick="_dpReq()">Registrar</button>
        </div>
        <div class="mt"><input id="drDetail" placeholder="Detalle de la solicitud (opcional)" style="width:100%"></div>
        <div class="row mt">
          <button class="btn ghost" onclick="_dpExport()">📤 Ejercer acceso (exportar datos)</button>
          <button class="btn ghost danger" onclick="_dpErase()">🗑️ Ejercer supresión (anonimizar)</button>
        </div>
        <table class="mt"><tr><th>Titular</th><th>Documento</th><th>Derecho</th><th>Canal</th><th>Plazo</th><th>Estado</th><th></th></tr>
        ${requests.map(r => {
          const overdue = r.dueDate && ['received', 'in_progress'].includes(r.status) && new Date(r.dueDate) < new Date();
          return `<tr><td>${esc(r.subjectName)}</td><td>${esc(r.documentNumber || '—')}</td><td>${typeLabel[r.type] || esc(r.type)}</td><td>${esc(r.channel || '—')}</td>
          <td style="color:${overdue ? 'var(--red)' : 'inherit'}">${r.dueDate ? day(r.dueDate) : '—'}${overdue ? ' ⚠️' : ''}</td>
          <td>${sb(r.status === 'resolved' ? 'confirmed' : r.status === 'rejected' ? 'cancelled' : 'pending')} ${stLabel[r.status] || esc(r.status)}</td>
          <td>${['received', 'in_progress'].includes(r.status) ? `<button class="btn small" onclick="_dpResolve('${r.id}')">Resolver</button>` : (r.resolution ? `<span class="muted" title="${esc(r.resolution)}">✔</span>` : '')}</td></tr>`;
        }).join('')}</table>
        ${requests.length ? '' : '<p class="muted">Sin solicitudes registradas.</p>'}
      </div>

      <div class="grid cols-2 mt">
        <div class="card"><h3>Registro de consentimientos</h3>
          <div class="row">
            <div><label>Titular</label><input id="dcName"></div>
            <div><label>Documento</label><input id="dcDoc"></div>
            <div><label>Finalidad</label><select id="dcPurpose"><option value="marketing">Marketing</option><option value="tratamiento">Tratamiento</option><option value="imagen">Imagen</option><option value="datos_sensibles">Datos sensibles</option><option value="transferencia">Transferencia</option></select></div>
            <div><label>Canal</label><select id="dcChannel"><option value="recepcion">Recepción</option><option value="web">Web</option><option value="whatsapp">WhatsApp</option><option value="contrato">Contrato</option><option value="correo">Correo</option></select></div>
            <button class="btn fit" onclick="_dpConsent()">Registrar</button>
          </div>
          <table class="mt"><tr><th>Titular</th><th>Finalidad</th><th>Estado</th><th></th></tr>
          ${consents.slice(0, 15).map(c => `<tr><td>${esc(c.subjectName)}</td><td>${purposeLabel[c.purpose] || esc(c.purpose)}</td>
            <td>${c.granted ? sb('confirmed') + ' otorgado' : sb('cancelled') + ' revocado'}</td>
            <td>${c.granted ? `<button class="btn small ghost" onclick="_dpRevoke('${c.id}')">Revocar</button>` : ''}</td></tr>`).join('')}</table>
          ${consents.length ? '' : '<p class="muted">Sin consentimientos registrados.</p>'}
        </div>
        <div class="card"><h3>Inventario de bases de datos (RNBD)</h3>
          <table><tr><th>Base</th><th>Finalidad</th><th>Base legal</th><th>RNBD</th></tr>
          ${treatments.map(t => `<tr><td><b>${esc(t.name)}</b><div class="muted" style="font-size:12px">${esc(t.retention || '')}</div></td><td>${esc(t.purpose)}</td><td>${esc(t.legalBasis || '—')}</td><td>${t.registeredRnbd ? '✅' : '—'}</td></tr>`).join('')}</table>
          <p class="muted mt" style="font-size:12px">Bases sujetas a registro en el RNBD de la SIC cuando superan los umbrales de ley.</p>
        </div>
      </div>`;
  }

  async function viewFontur() {
    const ov = await get(`/fontur/overview?${pid()}`);
    const stLabel = { draft: 'Borrador', filed: 'Presentada', paid: 'Pagada' };
    const perMil = (ov.current.rate * 1000).toLocaleString('es-CO', { maximumFractionDigits: 2 });
    window._ftGen = async () => { try { await api('/fontur/generate', { method: 'POST', body: { propertyId: state.propertyId } }); toast('Contribución del trimestre generada'); render(); } catch (e) { toast(e.message, true); } };
    window._ftFile = async id => { try { await api(`/fontur/${id}/file`, { method: 'POST' }); toast('Contribución presentada'); render(); } catch (e) { toast(e.message, true); } };
    window._ftPay = async id => { const s = prompt('Soporte/referencia del pago FONTUR:'); if (s === null) return; try { await api(`/fontur/${id}/pay`, { method: 'POST', body: { support: s } }); toast('Pago registrado'); render(); } catch (e) { toast(e.message, true); } };
    window._ftPrint = () => {
      printReport({
        title: 'Contribución parafiscal FONTUR', subtitle: `Trimestre ${ov.current.period} · Ley 2068/2020`,
        meta: [{ label: 'Base operacional', value: cop(ov.current.operatingIncome) }, { label: 'Tarifa', value: `${perMil} por mil` }, { label: 'Contribución', value: cop(ov.current.amount) }],
        sections: [
          { title: 'Liquidación del trimestre', html: `<table><tr><td>Base gravable (ingresos operacionales)</td><td class="r">${cop(ov.current.operatingIncome)}</td></tr><tr><td>Tarifa aplicada</td><td class="r">${perMil} × 1000</td></tr><tr class="total"><td>Contribución a pagar</td><td class="r">${cop(ov.current.amount)}</td></tr></table>` },
          { title: 'Historial de contribuciones', html: ov.contributions.length ? `<table><tr><th>Periodo</th><th class="r">Base</th><th class="r">Contribución</th><th>Estado</th></tr>${ov.contributions.map(c => `<tr><td>${esc(c.period)}</td><td class="r">${cop(c.operatingIncome)}</td><td class="r">${cop(c.amount)}</td><td>${esc(stLabel[c.status] || c.status)}</td></tr>`).join('')}</table>` : '<p>Sin declaraciones registradas.</p>' },
        ],
      });
    };
    setTimeout(animateCounts, 0);
    return `
      <div class="row" style="justify-content:flex-end"><button class="btn ghost small" onclick="_ftPrint()">🖨️ Imprimir / PDF</button></div>
      <div class="grid cols-4 mt">
        <div class="kpi"><div class="label">Base operacional (${esc(ov.current.period)})</div><div class="value"><span data-count="${ov.current.operatingIncome}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Tarifa vigente</div><div class="value">${perMil}<small> ×1000</small></div></div>
        <div class="kpi"><div class="label">Contribución estimada</div><div class="value" style="color:var(--yellow)"><span data-count="${ov.current.amount}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Pagado en el año</div><div class="value" style="color:var(--green)"><span data-count="${ov.paidYtd}" data-fmt="cop">$0</span></div></div>
      </div>

      <div class="card mt">
        <div class="row" style="justify-content:space-between;align-items:center">
          <div><h3 style="margin:0">Trimestre actual · ${esc(ov.current.period)}</h3>
            <p class="muted" style="margin:.3rem 0 0">Base ${cop(ov.current.operatingIncome)} × ${perMil} por mil = <b>${cop(ov.current.amount)}</b></p></div>
          <button class="btn" onclick="_ftGen()">Generar / actualizar declaración</button>
        </div>
      </div>

      <div class="card mt"><h3>Historial de contribuciones</h3>
        ${ov.contributions.length ? `<table><tr><th>Periodo</th><th>Base operacional</th><th>Tarifa</th><th>Contribución</th><th>Estado</th><th></th></tr>
        ${ov.contributions.map(c => `<tr><td><b>${esc(c.period)}</b></td><td>${cop(c.operatingIncome)}</td><td>${(c.rate * 1000).toLocaleString('es-CO', { maximumFractionDigits: 2 })} ×1000</td><td><b>${cop(c.amount)}</b></td>
          <td>${sb(c.status === 'paid' ? 'paid' : c.status === 'filed' ? 'prepared' : 'pending')} ${stLabel[c.status] || esc(c.status)}</td>
          <td>${c.status === 'draft' ? `<button class="btn small ghost" onclick="_ftFile('${c.id}')">Presentar</button>` : ''}
              ${c.status !== 'paid' ? `<button class="btn small" onclick="_ftPay('${c.id}')">Pagar</button>` : ''}</td>
        </tr>`).join('')}</table>` : '<p class="muted">Aún no hay declaraciones. Genera la del trimestre actual.</p>'}
        <p class="muted mt" style="font-size:12px">Contribución parafiscal para la promoción del turismo (Ley 2068/2020). Base: ingresos operacionales del trimestre. La tarifa se administra como parámetro legal versionado.</p>
      </div>`;
  }

  async function viewMarketing() {
    const ov = await get(`/marketing/overview?${pid()}`);
    const chLabel = { email: '✉️ Email', whatsapp: '💬 WhatsApp', sms: '📱 SMS' };
    const stLabel = { draft: 'Borrador', scheduled: 'Programada', sent: 'Enviada', cancelled: 'Cancelada' };
    window._mkPreview = async () => {
      try {
        const a = await api(`/marketing/audience?${pid()}&channel=${$('#mkChannel').value}&audience=${$('#mkAud').value}`);
        $('#mkAudInfo').innerHTML = `Audiencia elegible: <b>${a.eligible}</b>${a.skippedNoConsent ? ` · <span style="color:var(--yellow)">${a.skippedNoConsent} sin consentimiento (omitidos)</span>` : ''}`;
      } catch (e) { toast(e.message, true); }
    };
    window._mkCreate = async send => {
      try {
        const c = await api('/marketing/campaigns', { method: 'POST', body: { propertyId: state.propertyId, name: $('#mkName').value, channel: $('#mkChannel').value, audience: $('#mkAud').value, subject: $('#mkSubject').value || null, message: $('#mkMsg').value } });
        if (send) await api(`/marketing/campaigns/${c.id}/send`, { method: 'POST' });
        toast(send ? 'Campaña enviada' : 'Campaña guardada'); render();
      } catch (e) { toast(e.message, true); }
    };
    window._mkSend = async id => { if (!confirm('¿Enviar esta campaña ahora? Solo llegará a quienes dieron consentimiento.')) return; try { await api(`/marketing/campaigns/${id}/send`, { method: 'POST' }); toast('Campaña enviada'); render(); } catch (e) { toast(e.message, true); } };
    window._mkCancel = async id => { try { await api(`/marketing/campaigns/${id}/cancel`, { method: 'POST' }); toast('Campaña cancelada'); render(); } catch (e) { toast(e.message, true); } };
    setTimeout(animateCounts, 0);
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Contactables (opt-in)</div><div class="value" style="color:var(--green)"><span data-count="${ov.reachable}">0</span></div></div>
        <div class="kpi"><div class="label">Tasa de opt-in</div><div class="value"><span data-count="${ov.optInRate}" data-fmt="pct">0%</span></div></div>
        <div class="kpi"><div class="label">Campañas enviadas</div><div class="value"><span data-count="${ov.campaignsSent}">0</span></div></div>
        <div class="kpi"><div class="label">Mensajes enviados</div><div class="value"><span data-count="${ov.totalSent}">0</span></div></div>
      </div>

      <div class="grid cols-2 mt">
        <div class="card"><h3>Nueva campaña</h3>
          <div><label>Nombre</label><input id="mkName" placeholder="Promo temporada baja"></div>
          <div class="row mt">
            <div><label>Canal</label><select id="mkChannel" onchange="_mkPreview()"><option value="email">Email</option><option value="whatsapp">WhatsApp</option><option value="sms">SMS</option></select></div>
            <div><label>Audiencia</label><select id="mkAud" onchange="_mkPreview()"><option value="guests">Huéspedes</option><option value="leads">Leads</option></select></div>
          </div>
          <div class="mt"><label>Asunto (email)</label><input id="mkSubject" placeholder="Opcional"></div>
          <div class="mt"><label>Mensaje</label><textarea id="mkMsg" rows="4" placeholder="Escribe el contenido de la campaña…"></textarea></div>
          <p class="muted mt" id="mkAudInfo" style="font-size:12.5px">Selecciona canal y audiencia para estimar el alcance.</p>
          <div class="row mt">
            <button class="btn ghost" onclick="_mkCreate(false)">Guardar borrador</button>
            <button class="btn" onclick="_mkCreate(true)">Crear y enviar</button>
          </div>
        </div>
        <div class="card"><h3>Cumplimiento</h3>
          <p class="muted">Las campañas de marketing solo se envían a titulares con <b>consentimiento vigente</b> (Habeas Data, §26). Quienes lo revocaron quedan automáticamente excluidos y se contabilizan como omitidos.</p>
          <div class="mt" style="padding:14px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2)">
            <div class="label">Base de huéspedes contactable</div>
            <div style="font-size:26px;font-weight:700;color:var(--green)">${ov.reachable}</div>
            <div class="muted" style="font-size:12px">${ov.optInRate}% de la base autorizó recibir comunicaciones.</div>
          </div>
        </div>
      </div>

      <div class="card mt"><h3>Campañas</h3>
        ${ov.campaigns.length ? `<table><tr><th>Campaña</th><th>Canal</th><th>Audiencia</th><th>Alcance</th><th>Enviados</th><th>Estado</th><th></th></tr>
        ${ov.campaigns.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${chLabel[c.channel] || esc(c.channel)}</td><td>${c.audience === 'leads' ? 'Leads' : 'Huéspedes'}</td>
          <td>${c.audienceCount}${c.skippedNoConsent ? ` <span class="muted" title="omitidos sin consentimiento">(−${c.skippedNoConsent})</span>` : ''}</td>
          <td>${c.status === 'sent' ? `<b style="color:var(--green)">${c.sentCount}</b>` : '—'}</td>
          <td>${sb(c.status === 'sent' ? 'done' : c.status === 'cancelled' ? 'cancelled' : c.status === 'scheduled' ? 'prepared' : 'pending')} ${stLabel[c.status] || esc(c.status)}</td>
          <td>${['draft', 'scheduled'].includes(c.status) ? `<button class="btn small" onclick="_mkSend('${c.id}')">Enviar</button> <button class="btn small ghost" onclick="_mkCancel('${c.id}')">Cancelar</button>` : ''}</td>
        </tr>`).join('')}</table>` : '<p class="muted">Aún no hay campañas. Crea la primera arriba.</p>'}
      </div>`;
  }

  async function viewReputation() {
    const ov = await get(`/reputation/overview?${pid()}`);
    const srcLabel = { direct: 'Directo', google: 'Google', booking: 'Booking', tripadvisor: 'Tripadvisor', expedia: 'Expedia' };
    const stars = n => '★★★★★'.slice(0, n) + '☆☆☆☆☆'.slice(0, 5 - n);
    const senC = { positive: 'var(--green)', neutral: 'var(--yellow)', negative: 'var(--red)' };
    const maxDist = Math.max(1, ...Object.values(ov.distribution));
    window._rvImport = async () => {
      try { await api('/reputation/reviews', { method: 'POST', body: { propertyId: state.propertyId, guestName: $('#rvName').value, source: $('#rvSource').value, rating: +$('#rvRating').value, comment: $('#rvComment').value || null } }); toast('Reseña registrada'); render(); }
      catch (e) { toast(e.message, true); }
    };
    window._rvRespond = async id => {
      let draft = '';
      try { draft = (await api(`/reputation/reviews/${id}/draft`)).draft; } catch { /* opcional */ }
      const resp = prompt('Respuesta a la reseña (puedes editar la sugerencia de la IA):', draft);
      if (resp === null || !resp.trim()) return;
      try { await api(`/reputation/reviews/${id}/respond`, { method: 'POST', body: { response: resp } }); toast('Respuesta publicada'); render(); }
      catch (e) { toast(e.message, true); }
    };
    setTimeout(animateCounts, 0);
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Calificación media</div><div class="value" style="color:var(--accent)">${ov.avg || '—'}<small> /5 ★</small></div></div>
        <div class="kpi"><div class="label">Reseñas</div><div class="value"><span data-count="${ov.count}">0</span></div></div>
        <div class="kpi"><div class="label">Tasa de respuesta</div><div class="value"><span data-count="${ov.responseRate}" data-fmt="pct">0%</span></div></div>
        <div class="kpi"><div class="label">NPS aprox.</div><div class="value" style="color:${ov.nps >= 0 ? 'var(--green)' : 'var(--red)'}"><span data-count="${ov.nps}">0</span></div></div>
      </div>

      <div class="grid cols-2 mt">
        <div class="card"><h3>Distribución de estrellas</h3>
          ${[5, 4, 3, 2, 1].map(n => `<div class="row" style="align-items:center;gap:10px;margin:6px 0">
            <span style="width:56px;color:var(--accent)">${stars(n)}</span>
            <div style="flex:1;height:10px;background:var(--surface-2);border-radius:6px;overflow:hidden"><div style="height:100%;width:${Math.round((ov.distribution[n] / maxDist) * 100)}%;background:var(--accent-grad)"></div></div>
            <span class="muted" style="width:30px;text-align:right">${ov.distribution[n]}</span>
          </div>`).join('')}
          <div class="mt muted" style="font-size:12px">${ov.pending} sin responder · ${ov.responded} respondidas</div>
        </div>
        <div class="card"><h3>Registrar reseña (OTA / manual)</h3>
          <div class="row">
            <div><label>Huésped</label><input id="rvName"></div>
            <div><label>Fuente</label><select id="rvSource"><option value="google">Google</option><option value="booking">Booking</option><option value="tripadvisor">Tripadvisor</option><option value="expedia">Expedia</option><option value="direct">Directo</option></select></div>
            <div><label>Estrellas</label><select id="rvRating"><option value="5">★★★★★</option><option value="4">★★★★</option><option value="3">★★★</option><option value="2">★★</option><option value="1">★</option></select></div>
          </div>
          <div class="mt"><label>Comentario</label><textarea id="rvComment" rows="3" placeholder="Opcional"></textarea></div>
          <div class="right mt"><button class="btn" onclick="_rvImport()">Registrar reseña</button></div>
        </div>
      </div>

      <div class="card mt"><h3>Reseñas recientes</h3>
        ${ov.recent.length ? ov.recent.map(r => `<div style="padding:12px 0;border-bottom:1px solid var(--border)">
          <div class="row" style="justify-content:space-between;align-items:baseline">
            <div><b style="color:var(--accent)">${stars(r.rating)}</b> <b>${esc(r.guestName)}</b> <span class="badge gray" style="font-size:10.5px">${srcLabel[r.source] || esc(r.source)}</span> <span style="color:${senC[r.sentiment]};font-size:12px">●</span></div>
            <span class="muted" style="font-size:12px">${day(r.createdAt)}</span>
          </div>
          ${r.title ? `<div style="margin-top:4px"><b>${esc(r.title)}</b></div>` : ''}
          ${r.comment ? `<div class="muted" style="margin-top:4px">${esc(r.comment)}</div>` : ''}
          ${r.response ? `<div style="margin-top:8px;padding:10px 12px;background:var(--surface-2);border-radius:var(--r-sm);border-left:3px solid var(--accent)"><div class="muted" style="font-size:11.5px;margin-bottom:3px">Respuesta del hotel · ${esc(r.respondedBy || '')}</div>${esc(r.response)}</div>`
            : `<div class="mt"><button class="btn small ghost" onclick="_rvRespond('${r.id}')">✨ Responder (sugerencia IA)</button></div>`}
        </div>`).join('') : '<p class="muted">Aún no hay reseñas. Los huéspedes pueden dejarlas desde su portal al finalizar la estadía.</p>'}
      </div>`;
  }

  async function viewEvents() {
    const [ov, venues, events] = await Promise.all([
      get(`/events/overview?${pid()}`),
      get(`/events/venues?${pid()}`),
      get(`/events?${pid()}`),
    ]);
    const evLabel = { corporativo: 'Corporativo', social: 'Social', boda: 'Boda', capacitacion: 'Capacitación' };
    const stLabel = { quote: 'Cotización', confirmed: 'Confirmado', in_progress: 'En curso', completed: 'Completado', cancelled: 'Cancelado' };
    const stBadge = { quote: 'pending', confirmed: 'confirmed', in_progress: 'in_progress', completed: 'done', cancelled: 'cancelled' };
    window._evQuote = async () => {
      try {
        const q = await api('/events/quote', { method: 'POST', body: { venueId: $('#evVenue').value, durationType: $('#evDur').value, hours: +$('#evHours').value || 0, attendees: +$('#evAtt').value || 0, cateringPerPerson: +$('#evCater').value || 0, extras: +$('#evExtras').value || 0 } });
        $('#evQuoteBox').innerHTML = `Salón ${cop(q.venueFee)} + Catering ${cop(q.cateringTotal)} + Extras ${cop(q.extras)} → Subtotal ${cop(q.subtotal)} · IVA ${cop(q.taxes)} · <b>Total ${cop(q.total)}</b> (anticipo ${cop(q.deposit)})`;
      } catch (e) { toast(e.message, true); }
    };
    window._evCreate = async () => {
      try {
        await api('/events', { method: 'POST', body: { propertyId: state.propertyId, venueId: $('#evVenue').value, clientName: $('#evClient').value, clientContact: $('#evContact').value || null, eventType: $('#evType').value, date: $('#evDate').value, startTime: $('#evStart').value || '08:00', endTime: $('#evEnd').value || '17:00', attendees: +$('#evAtt').value || 0, setup: $('#evSetup').value, durationType: $('#evDur').value, hours: +$('#evHours').value || 0, cateringPerPerson: +$('#evCater').value || 0, extras: +$('#evExtras').value || 0 } });
        toast('Evento cotizado'); render();
      } catch (e) { toast(e.message, true); }
    };
    window._evConfirm = async id => { try { await api(`/events/${id}/confirm`, { method: 'POST' }); toast('Evento confirmado'); render(); } catch (e) { toast(e.message, true); } };
    window._evStatus = async (id, status) => { try { await api(`/events/${id}/status`, { method: 'POST', body: { status } }); toast('Estado actualizado'); render(); } catch (e) { toast(e.message, true); } };
    window._evVenue = async () => { try { await api('/events/venues', { method: 'POST', body: { propertyId: state.propertyId, name: $('#vnName').value, capacity: +$('#vnCap').value || 0, halfDayRate: +$('#vnHalf').value || 0, fullDayRate: +$('#vnFull').value || 0, hourlyRate: +$('#vnHour').value || 0, amenities: $('#vnAmen').value || null } }); toast('Salón creado'); render(); } catch (e) { toast(e.message, true); } };
    setTimeout(animateCounts, 0);
    const venueOpts = venues.map(v => `<option value="${v.id}">${esc(v.name)} (${v.capacity} pax)</option>`).join('');
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Salones</div><div class="value">${ov.venues}</div></div>
        <div class="kpi"><div class="label">Próximos eventos</div><div class="value"><span data-count="${ov.upcomingCount}">0</span></div></div>
        <div class="kpi"><div class="label">Pipeline (cotizaciones)</div><div class="value" style="color:var(--yellow)"><span data-count="${ov.pipeline}" data-fmt="cop">$0</span></div></div>
        <div class="kpi"><div class="label">Ingresos eventos (mes)</div><div class="value" style="color:var(--green)"><span data-count="${ov.monthRevenue}" data-fmt="cop">$0</span></div></div>
      </div>

      ${venues.length ? `<div class="card mt"><h3>Cotizar evento</h3>
        <div class="row">
          <div><label>Cliente</label><input id="evClient"></div>
          <div><label>Contacto</label><input id="evContact" placeholder="tel / correo"></div>
          <div><label>Salón</label><select id="evVenue" onchange="_evQuote()">${venueOpts}</select></div>
          <div><label>Tipo</label><select id="evType"><option value="corporativo">Corporativo</option><option value="social">Social</option><option value="boda">Boda</option><option value="capacitacion">Capacitación</option></select></div>
          <div><label>Fecha</label><input id="evDate" type="date"></div>
        </div>
        <div class="row mt">
          <div><label>Montaje</label><select id="evSetup"><option value="auditorio">Auditorio</option><option value="escuela">Escuela</option><option value="banquete">Banquete</option><option value="coctel">Cóctel</option><option value="u">Mesa en U</option></select></div>
          <div><label>Duración</label><select id="evDur" onchange="_evQuote()"><option value="full">Día completo</option><option value="half">Medio día</option><option value="hourly">Por horas</option></select></div>
          <div><label>Horas</label><input id="evHours" type="number" value="0" onchange="_evQuote()"></div>
          <div><label>Asistentes</label><input id="evAtt" type="number" value="0" onchange="_evQuote()"></div>
          <div><label>Inicio</label><input id="evStart" type="time" value="08:00"></div>
          <div><label>Fin</label><input id="evEnd" type="time" value="17:00"></div>
        </div>
        <div class="row mt">
          <div><label>Catering / persona</label><input id="evCater" type="number" value="0" onchange="_evQuote()"></div>
          <div><label>Extras</label><input id="evExtras" type="number" value="0" onchange="_evQuote()"></div>
          <button class="btn ghost fit" onclick="_evQuote()">Cotizar</button>
          <button class="btn fit" onclick="_evCreate()">Crear cotización</button>
        </div>
        <p class="muted mt" id="evQuoteBox" style="font-size:13px">Selecciona salón y parámetros para ver la propuesta económica.</p>
      </div>` : '<div class="card mt"><p class="muted">Crea un salón para empezar a cotizar eventos.</p></div>'}

      <div class="card mt"><h3>Eventos</h3>
        ${events.length ? `<table><tr><th>Código</th><th>Cliente</th><th>Salón</th><th>Fecha</th><th>Pax</th><th>Total</th><th>Estado</th><th></th></tr>
        ${events.map(e => `<tr><td><b>${esc(e.code)}</b><div class="muted" style="font-size:11.5px">${evLabel[e.eventType] || esc(e.eventType)}</div></td>
          <td>${esc(e.clientName)}</td><td>${esc(e.venue?.name || '—')}</td><td>${day(e.date)}</td><td>${e.attendees}</td>
          <td><b>${cop(e.total)}</b></td>
          <td>${sb(stBadge[e.status] || 'pending')} ${stLabel[e.status] || esc(e.status)}</td>
          <td>${e.status === 'quote' ? `<button class="btn small" onclick="_evConfirm('${e.id}')">Confirmar</button>` : ''}
              ${e.status === 'confirmed' ? `<button class="btn small ghost" onclick="_evStatus('${e.id}','in_progress')">Iniciar</button>` : ''}
              ${e.status === 'in_progress' ? `<button class="btn small" onclick="_evStatus('${e.id}','completed')">Completar</button>` : ''}
              ${['quote', 'confirmed'].includes(e.status) ? `<button class="btn small ghost" onclick="_evStatus('${e.id}','cancelled')">Cancelar</button>` : ''}</td>
        </tr>`).join('')}</table>` : '<p class="muted">Aún no hay eventos. Crea la primera cotización arriba.</p>'}
      </div>

      <div class="card mt"><h3>Salones (${venues.length})</h3>
        <table><tr><th>Salón</th><th>Capacidad</th><th>Medio día</th><th>Día completo</th><th>Hora</th><th>Amenidades</th></tr>
        ${venues.map(v => `<tr><td><b>${esc(v.name)}</b></td><td>${v.capacity} pax</td><td>${cop(v.halfDayRate)}</td><td>${cop(v.fullDayRate)}</td><td>${cop(v.hourlyRate)}</td><td class="muted" style="font-size:12px">${esc(v.amenities || '—')}</td></tr>`).join('')}</table>
        <div class="row mt">
          <div><label>Nuevo salón</label><input id="vnName" placeholder="Nombre"></div>
          <div><label>Capacidad</label><input id="vnCap" type="number"></div>
          <div><label>Medio día</label><input id="vnHalf" type="number"></div>
          <div><label>Día completo</label><input id="vnFull" type="number"></div>
          <div><label>Hora</label><input id="vnHour" type="number"></div>
          <div><label>Amenidades</label><input id="vnAmen"></div>
          <button class="btn ghost fit" onclick="_evVenue()">Agregar</button>
        </div>
      </div>`;
  }

  async function viewChannels() {
    const [ov, channels, catalog, mappings, logs, types] = await Promise.all([
      get(`/channels/overview?${pid()}`),
      get(`/channels?${pid()}`),
      get('/channels/catalog'),
      get(`/channels/mappings?${pid()}`),
      get(`/channels/logs?${pid()}`),
      get(`/admin/room-types?${pid()}`).catch(() => []),
    ]);
    const configured = channels.map(c => c.code);
    window._chAdd = async code => { try { await api('/channels', { method: 'POST', body: { propertyId: state.propertyId, code } }); toast('Canal agregado'); render(); } catch (e) { toast(e.message, true); } };
    window._chToggle = async (id, enabled) => { try { await api(`/channels/${id}`, { method: 'PATCH', body: { enabled } }); toast(enabled ? 'Canal activado' : 'Canal desactivado'); render(); } catch (e) { toast(e.message, true); } };
    window._chSync = async id => { try { await api(`/channels/${id}/sync`, { method: 'POST' }); toast('Sincronizado'); render(); } catch (e) { toast(e.message, true); } };
    window._chMap = async () => { try { await api('/channels/mappings', { method: 'POST', body: { propertyId: state.propertyId, channelId: $('#mpChan').value, roomTypeId: $('#mpType').value, externalCode: $('#mpCode').value } }); toast('Mapeo creado'); render(); } catch (e) { toast(e.message, true); } };
    const chName = id => (channels.find(c => c.id === id) || {}).name || '';
    const tName = id => (types.find(t => t.id === id) || {}).name || '';
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Canales</div><div class="value">${ov.channels}</div></div>
        <div class="kpi"><div class="label">Conectados</div><div class="value" style="color:var(--green)">${ov.connected}</div></div>
        <div class="kpi"><div class="label">Reservas OTA</div><div class="value">${ov.otaReservations}</div></div>
        <div class="kpi"><div class="label">Overbooking (7d)</div><div class="value" style="color:${ov.recentOverbooking ? 'var(--red)' : 'inherit'}">${ov.recentOverbooking}</div></div>
      </div>
      <div class="card mt"><h3>Canales</h3>
        <div class="row" style="margin-bottom:10px">${catalog.filter(k => !configured.includes(k.code)).map(k => `<button class="btn small secondary fit" onclick="_chAdd('${k.code}')">+ ${esc(k.name)}</button>`).join('') || '<span class="muted">Todos los canales del catálogo están configurados.</span>'}</div>
        <table><tr><th>Canal</th><th>Comisión</th><th>Mapeos</th><th>Estado</th><th>Última sync</th><th></th></tr>
        ${channels.map(c => `<tr><td><b>${esc(c.name)}</b></td><td>${Math.round(c.commissionPct * 100)}%</td><td>${c._count.mappings}</td>
          <td>${c.enabled ? badge(c.status === 'connected' ? 'conectado' : 'activo', 'green') : badge('inactivo', 'gray')}</td>
          <td class="muted" style="font-size:12px">${c.lastSyncAt ? dt(c.lastSyncAt) : '—'}</td>
          <td>${c.enabled ? `<button class="btn small" onclick="_chSync('${c.id}')">Sincronizar</button> <button class="btn small secondary" onclick="_chToggle('${c.id}',false)">Desactivar</button>` : `<button class="btn small secondary" onclick="_chToggle('${c.id}',true)">Activar</button>`}</td>
        </tr>`).join('')}</table>
        ${channels.length ? '' : '<p class="muted">Agrega un canal del catálogo para empezar.</p>'}
      </div>
      <div class="grid cols-2">
        <div class="card"><h3>Mapeo de habitaciones</h3>
          <p class="muted" style="font-size:12.5px">Relaciona cada tipo interno con el código del canal para sincronizar bien.</p>
          <div class="row"><div><label>Canal</label><select id="mpChan">${channels.map(c => `<option value="${c.id}">${esc(c.name)}</option>`).join('')}</select></div><div><label>Tipo interno</label><select id="mpType">${types.map(t => `<option value="${t.id}">${esc(t.name)}</option>`).join('')}</select></div></div>
          <div class="row"><div><label>Código externo (OTA)</label><input id="mpCode" placeholder="DBL-STD"></div><button class="btn fit" onclick="_chMap()">Mapear</button></div>
          <table class="mt"><tr><th>Canal</th><th>Tipo</th><th>Código</th></tr>${mappings.map(m => `<tr><td>${esc(chName(m.channelId))}</td><td>${esc(tName(m.roomTypeId))}</td><td>${esc(m.externalCode)}</td></tr>`).join('')}</table>
          ${mappings.length ? '' : '<p class="muted">Sin mapeos.</p>'}
        </div>
        <div class="card"><h3>Registro de sincronización</h3>
          <table><tr><th>Fecha</th><th>Acción</th><th>Estado</th><th>Detalle</th></tr>
          ${logs.map(l => `<tr><td>${dt(l.createdAt)}</td><td>${esc(l.action)}</td><td>${l.status === 'ok' ? badge('ok', 'green') : l.status === 'warning' ? badge('aviso', 'yellow') : badge('error', 'red')}</td><td class="muted" style="font-size:12px">${esc(l.detail || '')}</td></tr>`).join('')}</table>
          ${logs.length ? '' : '<p class="muted">Sin actividad.</p>'}
        </div>
      </div>`;
  }

  async function viewRevenue() {
    const [fc, recs, rules, types] = await Promise.all([
      get(`/revenue/forecast?${pid()}&days=14`),
      get(`/revenue/recommendations?${pid()}&days=14`),
      get(`/revenue/rules?${pid()}`),
      get(`/admin/room-types?${pid()}`).catch(() => []),
    ]);
    window._applyRate = async (ratePlanId, price) => {
      try { await api('/revenue/apply', { method: 'POST', body: { propertyId: state.propertyId, ratePlanId, newPrice: price } }); toast('Tarifa actualizada'); render(); }
      catch (e) { toast(e.message, true); }
    };
    window._addRule = async () => {
      try {
        await api('/revenue/rules', { method: 'POST', body: { propertyId: state.propertyId, name: $('#ruName').value, occupancyGte: $('#ruOccGte').value || null, occupancyLte: $('#ruOccLte').value || null, daysAheadLte: $('#ruDays').value || null, adjustPct: +$('#ruPct').value / 100 } });
        toast('Regla creada'); render();
      } catch (e) { toast(e.message, true); }
    };
    const maxRev = Math.max(1, ...fc.map(d => d.revpar));
    return `
      <div class="card"><h3>Forecast — próximos 14 días</h3>
        <div style="display:flex;gap:4px;align-items:flex-end;height:120px;margin:10px 0 4px">
          ${fc.map(d => `<div style="flex:1;display:flex;flex-direction:column;justify-content:flex-end;align-items:center;gap:3px" title="${d.date}: ${d.occupancyPct}% · RevPAR ${cop(d.revpar)}">
            <div style="width:70%;background:linear-gradient(180deg,var(--accent),var(--accent-lo));border-radius:3px 3px 0 0;height:${Math.max(3, Math.round(d.revpar / maxRev * 100))}%"></div>
            <div style="font-size:9px;color:var(--muted)">${d.date.slice(8)}</div></div>`).join('')}
        </div>
        <table class="mt"><tr><th>Fecha</th><th>Ocupación</th><th>Vendidas</th><th>ADR</th><th>RevPAR</th></tr>
        ${fc.map(d => `<tr><td>${d.date}</td><td>${d.occupancyPct >= 80 ? badge(d.occupancyPct + '%', 'green') : d.occupancyPct <= 40 ? badge(d.occupancyPct + '%', 'yellow') : d.occupancyPct + '%'}</td><td>${d.roomsSold}/${d.sellable}</td><td>${cop(d.adr)}</td><td>${cop(d.revpar)}</td></tr>`).join('')}</table>
      </div>
      <div class="card"><h3>Recomendaciones de tarifa (${recs.length})</h3>
        ${recs.length ? `<table><tr><th>Fecha</th><th>Habitación</th><th>Ocup.</th><th>Actual</th><th>Sugerida</th><th>Motivo</th><th></th></tr>
        ${recs.slice(0, 25).map(r => `<tr><td>${r.date}</td><td>${esc(r.roomType)}</td><td>${r.occupancyPct}%</td><td>${cop(r.currentPrice)}</td>
          <td>${r.changePct > 0 ? badge('▲ ' + cop(r.suggestedPrice), 'green') : badge('▼ ' + cop(r.suggestedPrice), 'yellow')}</td>
          <td class="muted" style="font-size:12px">${esc(r.reason)}</td>
          <td><button class="btn small" onclick="_applyRate('${r.ratePlanId}',${r.suggestedPrice})">Aplicar</button></td></tr>`).join('')}</table>`
          : '<p class="muted">Sin recomendaciones — la ocupación está en rango normal.</p>'}
      </div>
      <div class="card"><h3>Reglas dinámicas de precio</h3>
        <div class="row">
          <div><label>Nombre</label><input id="ruName" placeholder="Alta demanda"></div>
          <div><label>Ocup. ≥ (0-1)</label><input id="ruOccGte" type="number" step="0.1" placeholder="0.8"></div>
          <div><label>Ocup. ≤ (0-1)</label><input id="ruOccLte" type="number" step="0.1" placeholder=""></div>
          <div><label>Días antes ≤</label><input id="ruDays" type="number" placeholder=""></div>
          <div><label>Ajuste %</label><input id="ruPct" type="number" placeholder="15"></div>
          <button class="btn fit" onclick="_addRule()">Crear</button>
        </div>
        <table class="mt"><tr><th>Regla</th><th>Condición</th><th>Ajuste</th></tr>
        ${rules.map(r => `<tr><td>${esc(r.name)}</td><td class="muted" style="font-size:12px">${r.occupancyGte != null ? 'ocup ≥ ' + r.occupancyGte : ''}${r.occupancyLte != null ? ' ocup ≤ ' + r.occupancyLte : ''}${r.daysAheadLte != null ? ' · ≤' + r.daysAheadLte + 'd' : ''}</td><td>${r.adjustPct > 0 ? badge('+' + Math.round(r.adjustPct * 100) + '%', 'green') : badge(Math.round(r.adjustPct * 100) + '%', 'yellow')}</td></tr>`).join('')}</table>
        ${rules.length ? '' : '<p class="muted">Sin reglas — se usan umbrales por defecto (≥80% sube, ≤40% baja).</p>'}
      </div>`;
  }

  async function viewPos() {
    const [menu, orders, inhouse, products] = await Promise.all([
      get(`/pos/menu?${pid()}`),
      get(`/pos/orders?${pid()}`),
      get(`/reservations?${pid()}&status=checked_in`).catch(() => []),
      get(`/inventory/products?${pid()}`).catch(() => []),
    ]);
    // Carrito en memoria de sesión
    state.pos = state.pos || { cart: [] };
    const cart = state.pos.cart;
    window._menuAdd = async () => {
      try {
        const recipe = $('#miProd').value ? [{ productId: $('#miProd').value, qty: +$('#miQty').value || 1 }] : null;
        await api('/pos/menu', { method: 'POST', body: { propertyId: state.propertyId, name: $('#miName').value, category: $('#miCat').value, price: +$('#miPrice').value, recipe } });
        toast('Ítem de menú creado'); render();
      } catch (e) { toast(e.message, true); }
    };
    window._cartAdd = () => {
      const id = $('#ordItem').value; const mi = menu.find(m => m.id === id);
      if (!mi) return;
      const ex = cart.find(c => c.menuItemId === id);
      if (ex) ex.qty++; else cart.push({ menuItemId: id, name: mi.name, price: mi.price, qty: 1 });
      render();
    };
    window._cartDel = i => { cart.splice(i, 1); render(); };
    window._ordCreate = async () => {
      if (!cart.length) return toast('Agrega ítems a la comanda', true);
      const type = $('#ordType').value;
      const reservationId = type !== 'table' ? ($('#ordRes').value || null) : null;
      if (type !== 'table' && !reservationId) return toast('Selecciona la habitación en casa', true);
      try {
        await api('/pos/orders', { method: 'POST', body: { propertyId: state.propertyId, type, tableLabel: $('#ordTable').value || null, reservationId, items: cart.map(c => ({ menuItemId: c.menuItemId, qty: c.qty })) } });
        state.pos.cart = []; toast('Comanda creada'); render();
      } catch (e) { toast(e.message, true); }
    };
    window._ordCharge = async (id, toRoom) => {
      try { await api(`/pos/orders/${id}/charge`, { method: 'POST', body: { method: 'efectivo' } }); toast(toRoom ? 'Cargado al folio de la habitación' : 'Comanda cobrada'); render(); }
      catch (e) { toast(e.message, true); }
    };
    const cartTotal = cart.reduce((s, c) => s + c.price * c.qty, 0);
    return `
      <div class="grid cols-2">
        <div class="card"><h3>Nueva comanda</h3>
          <div class="row">
            <div><label>Tipo</label><select id="ordType"><option value="table">Mesa</option><option value="room_service">Room service</option><option value="minibar">Minibar</option></select></div>
            <div><label>Mesa (opcional)</label><input id="ordTable" placeholder="Mesa 4"></div>
            <div><label>Habitación en casa</label><select id="ordRes"><option value="">—</option>${inhouse.map(r => `<option value="${r.id}">Hab ${esc(r.room?.number || '?')} · ${esc(r.guest.fullName)}</option>`).join('')}</select></div>
          </div>
          <div class="row"><div><label>Ítem</label><select id="ordItem">${menu.map(m => `<option value="${m.id}">${esc(m.name)} — ${cop(m.price)}</option>`).join('')}</select></div><button class="btn fit" onclick="_cartAdd()">Agregar</button></div>
          <table class="mt"><tr><th>Ítem</th><th>Cant.</th><th>Subtotal</th><th></th></tr>
          ${cart.map((c, i) => `<tr><td>${esc(c.name)}</td><td>${c.qty}</td><td>${cop(c.price * c.qty)}</td><td><button class="btn small danger" onclick="_cartDel(${i})">×</button></td></tr>`).join('')}</table>
          ${cart.length ? `<div class="right mt"><b>Total: ${cop(cartTotal)}</b></div><button class="btn mt" onclick="_ordCreate()">Crear comanda</button>` : '<p class="muted mt">Agrega ítems del menú.</p>'}
        </div>
        <div class="card"><h3>Menú <span class="muted" style="font-size:12px">(la receta descuenta inventario)</span></h3>
          <div class="row"><div><label>Nombre</label><input id="miName"></div><div><label>Categoría</label><select id="miCat"><option value="comida">Comida</option><option value="bebida">Bebida</option><option value="minibar">Minibar</option><option value="postre">Postre</option></select></div><div><label>Precio</label><input id="miPrice" type="number"></div></div>
          <div class="row"><div><label>Insumo (receta)</label><select id="miProd"><option value="">—</option>${products.map(p => `<option value="${p.id}">${esc(p.name)}</option>`).join('')}</select></div><div><label>Cant. insumo</label><input id="miQty" type="number" value="1"></div><button class="btn fit" onclick="_menuAdd()">Crear ítem</button></div>
          <table class="mt"><tr><th>Ítem</th><th>Categoría</th><th>Precio</th><th>Receta</th></tr>${menu.map(m => `<tr><td>${esc(m.name)}</td><td>${esc(m.category)}</td><td>${cop(m.price)}</td><td>${m.recipe ? '✔' : '—'}</td></tr>`).join('')}</table>
          ${menu.length ? '' : '<p class="muted">Sin ítems de menú.</p>'}
        </div>
      </div>
      <div class="card"><h3>Comandas</h3>
        <table><tr><th>Fecha</th><th>Tipo</th><th>Ítems</th><th>Total</th><th>Estado</th><th></th></tr>
        ${orders.map(o => `<tr><td>${dt(o.createdAt)}</td><td>${esc(o.type)}${o.tableLabel ? ' · ' + esc(o.tableLabel) : ''}</td><td>${o.items.length}</td><td>${cop(o.total)}</td>
          <td>${sb(o.status === 'charged' || o.status === 'paid' ? 'confirmed' : 'open')} ${esc(o.status)}</td>
          <td>${o.status === 'open' ? `<button class="btn small" onclick="_ordCharge('${o.id}',${!!o.reservationId})">${o.reservationId ? 'Cargar a habitación' : 'Cobrar'}</button>` : ''}</td>
        </tr>`).join('')}</table>
        ${orders.length ? '' : '<p class="muted">Sin comandas.</p>'}
      </div>`;
  }

  async function viewInventory() {
    const [ov, suppliers, products, movements, pos] = await Promise.all([
      get(`/inventory/overview?${pid()}`),
      get(`/inventory/suppliers?${pid()}`),
      get(`/inventory/products?${pid()}`),
      get(`/inventory/movements?${pid()}`),
      get(`/inventory/purchase-orders?${pid()}`),
    ]);
    const I = (path, body) => api(`/inventory/${path}`, { method: 'POST', body: { propertyId: state.propertyId, ...body } });
    window._invSup = async () => { try { await I('suppliers', { name: $('#supName').value, nit: $('#supNit').value, contact: $('#supContact').value, category: $('#supCat').value }); toast('Proveedor creado'); render(); } catch (e) { toast(e.message, true); } };
    window._invProd = async () => { try { await I('products', { sku: $('#pSku').value, name: $('#pName').value, category: $('#pCat').value, unit: $('#pUnit').value, cost: $('#pCost').value, stock: $('#pStock').value, stockMin: $('#pMin').value }); toast('Producto creado'); render(); } catch (e) { toast(e.message, true); } };
    window._invMove = async () => { try { await I('movements', { productId: $('#mProd').value, type: $('#mType').value, quantity: $('#mQty').value, reason: $('#mReason').value }); toast('Movimiento registrado'); render(); } catch (e) { toast(e.message, true); } };
    window._invPO = async () => {
      const prod = $('#poProd').value, qty = +$('#poQty').value, cost = +$('#poCost').value;
      if (!prod || !(qty > 0)) return toast('Selecciona producto y cantidad', true);
      try { await I('purchase-orders', { supplierId: $('#poSup').value, items: [{ productId: prod, qty, unitCost: cost }] }); toast('Orden de compra creada'); render(); } catch (e) { toast(e.message, true); }
    };
    window._poApprove = async id => { try { const { status } = await api(`/inventory/purchase-orders/${id}/approve`, { method: 'POST' }); toast(status === 202 ? 'Aprobación enviada a gerente' : 'Aprobada'); render(); } catch (e) { toast(e.message, true); } };
    window._poReceive = async id => { try { await api(`/inventory/purchase-orders/${id}/receive`, { method: 'POST' }); toast('Recibida — stock actualizado'); render(); } catch (e) { toast(e.message, true); } };
    const prodOpts = products.map(p => `<option value="${p.id}">${esc(p.name)} (${p.stock} ${esc(p.unit)})</option>`).join('');
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Productos</div><div class="value">${ov.products}</div></div>
        <div class="kpi"><div class="label">Stock bajo</div><div class="value" style="color:${ov.lowStock ? 'var(--yellow)' : 'inherit'}">${ov.lowStock}</div></div>
        <div class="kpi"><div class="label">Órdenes abiertas</div><div class="value">${ov.openPurchaseOrders}</div></div>
        <div class="kpi"><div class="label">Proveedores</div><div class="value">${ov.suppliers}</div></div>
      </div>
      <div class="card mt"><h3>Productos e insumos</h3>
        <div class="row">
          <div><label>SKU</label><input id="pSku"></div><div><label>Nombre</label><input id="pName"></div>
          <div><label>Categoría</label><select id="pCat"><option value="alimentos">Alimentos</option><option value="bebidas">Bebidas</option><option value="minibar">Minibar</option><option value="amenities">Amenities</option><option value="limpieza">Limpieza</option><option value="lenceria">Lencería</option><option value="repuestos">Repuestos</option></select></div>
          <div><label>Unidad</label><input id="pUnit" value="unidad"></div>
        </div>
        <div class="row">
          <div><label>Costo</label><input id="pCost" type="number" value="0"></div><div><label>Stock inicial</label><input id="pStock" type="number" value="0"></div><div><label>Stock mínimo</label><input id="pMin" type="number" value="0"></div>
          <button class="btn fit" onclick="_invProd()">Crear producto</button>
        </div>
        <table class="mt"><tr><th>SKU</th><th>Producto</th><th>Categoría</th><th>Costo</th><th>Stock</th><th>Mínimo</th></tr>
        ${products.map(p => `<tr><td>${esc(p.sku)}</td><td>${esc(p.name)}</td><td>${esc(p.category || '')}</td><td>${cop(p.cost)}</td><td>${p.stock <= p.stockMin ? badge(p.stock + ' ' + p.unit, 'yellow') : p.stock + ' ' + p.unit}</td><td class="muted">${p.stockMin}</td></tr>`).join('')}</table>
        ${products.length ? '' : '<p class="muted">Sin productos.</p>'}
      </div>
      <div class="grid cols-2">
        <div class="card"><h3>Movimiento de inventario</h3>
          <div class="row"><div><label>Producto</label><select id="mProd">${prodOpts}</select></div><div><label>Tipo</label><select id="mType"><option value="in">Entrada</option><option value="out">Salida</option><option value="consumption">Consumo</option><option value="adjustment">Ajuste</option></select></div></div>
          <div class="row"><div><label>Cantidad</label><input id="mQty" type="number"></div><div><label>Motivo</label><input id="mReason" placeholder="merma, uso..."></div><button class="btn fit" onclick="_invMove()">Registrar</button></div>
          <table class="mt"><tr><th>Fecha</th><th>Producto</th><th>Tipo</th><th>Cant.</th></tr>${movements.slice(0, 12).map(m => `<tr><td>${dt(m.createdAt)}</td><td>${esc(m.product.name)}</td><td>${esc(m.type)}</td><td>${m.quantity}</td></tr>`).join('')}</table>
        </div>
        <div class="card"><h3>Proveedores</h3>
          <div class="row"><div><label>Nombre</label><input id="supName"></div><div><label>NIT</label><input id="supNit"></div></div>
          <div class="row"><div><label>Contacto</label><input id="supContact"></div><div><label>Categoría</label><input id="supCat"></div><button class="btn fit" onclick="_invSup()">Crear</button></div>
          <table class="mt"><tr><th>Proveedor</th><th>NIT</th><th>Contacto</th></tr>${suppliers.map(s => `<tr><td>${esc(s.name)}</td><td>${esc(s.nit || '')}</td><td class="muted">${esc(s.contact || '')}</td></tr>`).join('')}</table>
          ${suppliers.length ? '' : '<p class="muted">Sin proveedores.</p>'}
        </div>
      </div>
      <div class="card"><h3>Órdenes de compra</h3>
        <div class="row">
          <div><label>Proveedor</label><select id="poSup">${suppliers.map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('')}</select></div>
          <div><label>Producto</label><select id="poProd">${prodOpts}</select></div>
          <div><label>Cantidad</label><input id="poQty" type="number"></div>
          <div><label>Costo unit.</label><input id="poCost" type="number"></div>
          <button class="btn fit" onclick="_invPO()">Crear orden</button>
        </div>
        <table class="mt"><tr><th>Proveedor</th><th>Ítems</th><th>Total</th><th>Estado</th><th></th></tr>
        ${pos.map(p => `<tr><td>${esc(p.supplierName)}</td><td>${p.items.length}</td><td>${cop(p.total)}</td>
          <td>${sb(p.status === 'received' ? 'confirmed' : p.status === 'approved' ? 'active' : p.status === 'cancelled' ? 'closed' : 'pending')} ${esc(p.status)}</td>
          <td>${p.status === 'draft' ? `<button class="btn small" onclick="_poApprove('${p.id}')">Aprobar</button>` : ''}
              ${p.status === 'approved' ? `<button class="btn small secondary" onclick="_poReceive('${p.id}')">Recibir</button>` : ''}</td>
        </tr>`).join('')}</table>
        ${pos.length ? '' : '<p class="muted">Sin órdenes de compra.</p>'}
      </div>`;
  }

  async function viewSgsst() {
    const [ov, risks, incidents, exams, ppe, trainings, employees] = await Promise.all([
      get(`/sgsst/overview?${pid()}`),
      get(`/sgsst/risks?${pid()}`),
      get(`/sgsst/incidents?${pid()}`),
      get(`/sgsst/exams?${pid()}`),
      get(`/sgsst/ppe?${pid()}`),
      get(`/sgsst/trainings?${pid()}`),
      get(`/hr/employees?${pid()}&status=active`).catch(() => []),
    ]);
    const empOpts = employees.map(e => `<option value="${e.id}">${esc(e.fullName)}</option>`).join('');
    const P = (path, body) => api(`/sgsst/${path}`, { method: 'POST', body: { propertyId: state.propertyId, ...body } });
    window._sgRisk = async () => { try { await P('risks', { area: $('#rkArea').value, hazard: $('#rkHaz').value, risk: $('#rkRisk').value, control: $('#rkCtrl').value }); toast('Riesgo agregado'); render(); } catch (e) { toast(e.message, true); } };
    window._sgInc = async () => { try { await P('incidents', { date: $('#inDate').value, type: $('#inType').value, severity: $('#inSev').value, description: $('#inDesc').value, employeeName: $('#inEmp').value }); toast('Incidente registrado'); render(); } catch (e) { toast(e.message, true); } };
    window._sgIncClose = async id => { const actions = prompt('Plan de mejora / acciones correctivas:'); if (!actions) return; try { await api(`/sgsst/incidents/${id}/close`, { method: 'POST', body: { actions } }); toast('Incidente cerrado'); render(); } catch (e) { toast(e.message, true); } };
    window._sgExam = async () => { try { await P('exams', { employeeId: $('#exEmp').value, type: $('#exType').value, date: $('#exDate').value, validUntil: $('#exValid').value || null, restrictions: $('#exRes').value }); toast('Examen registrado'); render(); } catch (e) { toast(e.message, true); } };
    window._sgPpe = async () => { try { await P('ppe', { employeeId: $('#ppEmp').value, item: $('#ppItem').value, quantity: +$('#ppQty').value || 1, date: $('#ppDate').value }); toast('EPP registrado'); render(); } catch (e) { toast(e.message, true); } };
    window._sgTrain = async () => { try { await P('trainings', { title: $('#trTitle').value, date: $('#trDate').value, validUntil: $('#trValid').value || null }); toast('Capacitación registrada'); render(); } catch (e) { toast(e.message, true); } };
    const today = new Date().toISOString().slice(0, 10);
    const examBadge = x => { if (!x.validUntil) return '—'; const days = Math.ceil((new Date(x.validUntil) - Date.now()) / 86400000); return days < 0 ? badge('vencido', 'red') : days < 30 ? badge(`${days}d`, 'yellow') : day(x.validUntil); };
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Riesgos en matriz</div><div class="value">${ov.risks}</div></div>
        <div class="kpi"><div class="label">Incidentes abiertos</div><div class="value" style="color:${ov.openIncidents ? 'var(--yellow)' : 'inherit'}">${ov.openIncidents}</div></div>
        <div class="kpi"><div class="label">Exámenes por vencer</div><div class="value" style="color:${ov.examsExpiring ? 'var(--yellow)' : 'inherit'}">${ov.examsExpiring}</div></div>
        <div class="kpi"><div class="label">Capacitaciones</div><div class="value">${ov.trainings}</div></div>
      </div>
      <div class="grid cols-2 mt">
        <div class="card"><h3>Matriz de riesgos</h3>
          <div class="row"><div><label>Área</label><input id="rkArea"></div><div><label>Peligro</label><input id="rkHaz"></div></div>
          <div class="row"><div><label>Riesgo</label><input id="rkRisk"></div><div><label>Control</label><input id="rkCtrl"></div><button class="btn fit" onclick="_sgRisk()">Agregar</button></div>
          <table class="mt"><tr><th>Área</th><th>Peligro</th><th>Riesgo</th><th>Control</th></tr>${risks.map(r => `<tr><td>${esc(r.area)}</td><td>${esc(r.hazard)}</td><td>${esc(r.risk)}</td><td class="muted">${esc(r.control || '')}</td></tr>`).join('')}</table>
          ${risks.length ? '' : '<p class="muted">Sin riesgos registrados.</p>'}
        </div>
        <div class="card"><h3>Incidentes y accidentes</h3>
          <div class="row"><div><label>Fecha</label><input id="inDate" type="date" value="${today}"></div><div><label>Tipo</label><select id="inType"><option value="accidente">Accidente</option><option value="incidente">Incidente</option><option value="casi_accidente">Casi accidente</option><option value="enfermedad">Enfermedad</option></select></div><div><label>Severidad</label><select id="inSev"><option>leve</option><option>grave</option><option>mortal</option></select></div></div>
          <div class="row"><div><label>Empleado</label><input id="inEmp"></div><div><label>Descripción</label><input id="inDesc"></div><button class="btn fit" onclick="_sgInc()">Registrar</button></div>
          <table class="mt"><tr><th>Fecha</th><th>Tipo</th><th>Severidad</th><th>Estado</th><th></th></tr>${incidents.map(i => `<tr><td>${day(i.date)}</td><td>${esc(i.type)}</td><td>${i.severity === 'leve' ? badge('leve', 'blue') : badge(i.severity, 'red')}</td><td>${sb(i.status === 'closed' ? 'closed' : 'open')}</td><td>${i.status === 'open' ? `<button class="btn small secondary" onclick="_sgIncClose('${i.id}')">Cerrar</button>` : ''}</td></tr>`).join('')}</table>
          ${incidents.length ? '' : '<p class="muted">Sin incidentes.</p>'}
        </div>
      </div>
      <div class="card"><h3>Exámenes médicos</h3>
        <div class="row"><div><label>Empleado</label><select id="exEmp">${empOpts}</select></div><div><label>Tipo</label><select id="exType"><option value="ingreso">Ingreso</option><option value="periodico">Periódico</option><option value="egreso">Egreso</option></select></div><div><label>Fecha</label><input id="exDate" type="date" value="${today}"></div><div><label>Vence</label><input id="exValid" type="date"></div></div>
        <div class="row"><div><label>Restricciones</label><input id="exRes"></div><button class="btn fit" onclick="_sgExam()">Registrar examen</button></div>
        <table class="mt"><tr><th>Empleado</th><th>Tipo</th><th>Fecha</th><th>Vence</th><th>Restricciones</th></tr>${exams.map(x => `<tr><td>${esc(x.employeeName)}</td><td>${esc(x.type)}</td><td>${day(x.date)}</td><td>${examBadge(x)}</td><td class="muted">${esc(x.restrictions || '—')}</td></tr>`).join('')}</table>
        ${exams.length ? '' : '<p class="muted">Sin exámenes registrados.</p>'}
      </div>
      <div class="grid cols-2">
        <div class="card"><h3>Entrega de EPP</h3>
          <div class="row"><div><label>Empleado</label><select id="ppEmp">${empOpts}</select></div><div><label>Elemento</label><input id="ppItem" placeholder="Guantes"></div><div><label>Cant.</label><input id="ppQty" type="number" value="1"></div><div><label>Fecha</label><input id="ppDate" type="date" value="${today}"></div></div>
          <button class="btn small mt" onclick="_sgPpe()">Registrar entrega</button>
          <table class="mt"><tr><th>Empleado</th><th>Elemento</th><th>Cant.</th><th>Fecha</th></tr>${ppe.map(p => `<tr><td>${esc(p.employeeName)}</td><td>${esc(p.item)}</td><td>${p.quantity}</td><td>${day(p.date)}</td></tr>`).join('')}</table>
          ${ppe.length ? '' : '<p class="muted">Sin entregas.</p>'}
        </div>
        <div class="card"><h3>Capacitaciones</h3>
          <div class="row"><div><label>Título</label><input id="trTitle"></div><div><label>Fecha</label><input id="trDate" type="date" value="${today}"></div><div><label>Vigencia</label><input id="trValid" type="date"></div></div>
          <button class="btn small mt" onclick="_sgTrain()">Registrar capacitación</button>
          <table class="mt"><tr><th>Título</th><th>Fecha</th><th>Vigencia</th></tr>${trainings.map(t => `<tr><td>${esc(t.title)}</td><td>${day(t.date)}</td><td>${t.validUntil ? day(t.validUntil) : '—'}</td></tr>`).join('')}</table>
          ${trainings.length ? '' : '<p class="muted">Sin capacitaciones.</p>'}
        </div>
      </div>`;
  }

  async function viewShifts() {
    const today = new Date().toISOString().slice(0, 10);
    const [employees, shifts, attendance] = await Promise.all([
      get(`/hr/employees?${pid()}&status=active`),
      get(`/hr/shifts?${pid()}&from=${today}`),
      get(`/hr/attendance?${pid()}&date=${today}`),
    ]);
    window._addShift = async () => {
      try {
        await api('/hr/shifts', { method: 'POST', body: { propertyId: state.propertyId, employeeId: $('#shEmp').value, date: $('#shDate').value, startTime: $('#shStart').value, endTime: $('#shEnd').value, area: $('#shArea').value } });
        toast('Turno asignado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._clock = async type => {
      try {
        const { data } = await api('/hr/attendance/clock', { method: 'POST', body: { propertyId: state.propertyId, employeeId: $('#atEmp').value, type } });
        toast(type === 'in' ? 'Entrada registrada' : `Salida registrada${data.noveltiesCreated ? ` · ${data.noveltiesCreated} novedad(es) generada(s)` : ''}`);
        render();
      } catch (err) { toast(err.message, true); }
    };
    const empOpts = employees.map(e => `<option value="${e.id}">${esc(e.fullName)}</option>`).join('');
    return `
      <div class="grid cols-2">
        <div class="card"><h3>Planear turno (cuadrante)</h3>
          <div class="row">
            <div><label>Empleado</label><select id="shEmp">${empOpts}</select></div>
            <div><label>Fecha</label><input id="shDate" type="date" value="${today}"></div>
          </div>
          <div class="row">
            <div><label>Entrada</label><input id="shStart" value="14:00"></div>
            <div><label>Salida</label><input id="shEnd" value="22:00"></div>
            <div><label>Área</label><input id="shArea" placeholder="recepción"></div>
          </div>
          <button class="btn mt" onclick="_addShift()">Asignar turno</button>
        </div>
        <div class="card"><h3>Marcación de asistencia</h3>
          <p class="muted" style="font-size:12.5px">La salida calcula horas, recargo nocturno y horas extra, y crea las novedades de nómina automáticamente.</p>
          <label>Empleado</label><select id="atEmp">${empOpts}</select>
          <div class="row mt">
            <button class="btn fit" onclick="_clock('in')">▶️ Entrada</button>
            <button class="btn secondary fit" onclick="_clock('out')">⏹️ Salida</button>
          </div>
        </div>
      </div>
      <div class="card"><h3>Asistencia de hoy</h3>
        ${attendance.length ? `<table><tr><th>Empleado</th><th>Entrada</th><th>Salida</th><th>Horas</th><th>Nocturnas</th><th>Extras</th></tr>
          ${attendance.map(a => `<tr><td>${esc(a.employee.fullName)}</td><td>${dt(a.clockIn)}</td><td>${a.clockOut ? dt(a.clockOut) : badge('abierta', 'yellow')}</td>
          <td>${a.hoursWorked ?? '—'}</td><td>${a.nightHours ? badge(a.nightHours + ' h', 'blue') : '—'}</td><td>${a.overtimeHours ? badge(a.overtimeHours + ' h', 'yellow') : '—'}</td></tr>`).join('')}</table>`
          : '<p class="muted">Sin marcaciones hoy.</p>'}
      </div>
      <div class="card"><h3>Turnos programados</h3>
        ${shifts.length ? `<table><tr><th>Fecha</th><th>Empleado</th><th>Horario</th><th>Área</th></tr>
          ${shifts.map(s => `<tr><td>${day(s.date)}</td><td>${esc(s.employee.fullName)}</td><td>${esc(s.startTime)} – ${esc(s.endTime)}</td><td>${esc(s.area || '—')}</td></tr>`).join('')}</table>`
          : '<p class="muted">Sin turnos programados.</p>'}
      </div>`;
  }

  async function viewPayroll() {
    const [periods, employees, novelties, types, pilas, nie] = await Promise.all([
      get(`/hr/payroll/periods?${pid()}`),
      get(`/hr/employees?${pid()}&status=active`),
      get(`/hr/novelties?${pid()}`),
      get('/hr/novelty-types'),
      get(`/hr/pila?${pid()}`).catch(() => []),
      get(`/hr/electronic-payroll?${pid()}`).catch(() => ({ documents: [], providerConfigured: false })),
    ]);
    window._nieGen = async () => {
      const sel = $('#niePeriod').value;
      if (!sel) return toast('Selecciona un periodo cerrado', true);
      try { const { data } = await api('/hr/electronic-payroll/generate', { method: 'POST', body: { periodId: sel } }); toast(`${data.generated} documento(s) generado(s)`); render(); }
      catch (err) { toast(err.message, true); }
    };
    window._nieTx = async periodId => {
      try { const { data } = await api('/hr/electronic-payroll/transmit', { method: 'POST', body: { periodId } }); toast(data.providerConfigured ? `${data.transmitted} transmitido(s)` : `${data.transmitted} numerado(s) localmente (sin proveedor DIAN)`); render(); }
      catch (err) { toast(err.message, true); }
    };
    window._preparePila = async () => {
      const sel = $('#pilaPeriod').value;
      if (!sel) return toast('Selecciona un periodo', true);
      try { await api('/hr/pila/prepare', { method: 'POST', body: { periodId: sel } }); toast('Planilla PILA preparada'); render(); }
      catch (err) { toast(err.message, true); }
    };
    window._pilaPay = async id => {
      const support = prompt('Referencia/soporte del pago PILA:');
      if (support === null) return;
      try { await api(`/hr/pila/${id}/payment`, { method: 'PATCH', body: { support } }); toast('Pago PILA registrado'); render(); }
      catch (err) { toast(err.message, true); }
    };
    window._pilaView = pilas.length ? (id => {
      const p = pilas.find(x => x.id === id);
      modal(`<h2>PILA ${p.month}/${p.year} ${sb(p.status === 'paid' ? 'confirmed' : 'pending')}</h2>
        <p class="muted" style="font-size:12.5px">${p.employeeCount} empleados · IBC total ${cop(p.totalIBC)} · Aportes ${cop(p.totalContributions)}</p>
        ${p.inconsistencies.length ? `<p style="color:var(--yellow);font-size:12.5px">⚠ Afiliaciones faltantes: ${p.inconsistencies.map(i => esc(i.employee) + ' (' + i.missing.join(', ') + ')').join('; ')}</p>` : ''}
        <table class="mt"><tr><th>Empleado</th><th>IBC</th><th>Salud</th><th>Pensión</th><th>ARL</th><th>CCF</th><th>Total</th></tr>
        ${p.rows.map(r => `<tr><td>${esc(r.employee)}</td><td>${cop(r.ibc)}</td><td>${cop(r.salud)}</td><td>${cop(r.pension)}</td><td>${cop(r.arlAmt)}</td><td>${cop(r.ccf)}</td><td><b>${cop(r.total)}</b></td></tr>`).join('')}</table>
        <button class="btn small secondary mt" onclick="_dl('/hr/pila/${p.id}/export','PILA-${p.month}-${p.year}.csv')">Descargar CSV</button>`);
    }) : null;
    const now = new Date();
    window._createPeriod = async () => {
      try {
        await api('/hr/payroll/periods', { method: 'POST', body: { propertyId: state.propertyId, year: +$('#pYear').value, month: +$('#pMonth').value } });
        toast('Periodo creado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._calcPeriod = async id => {
      try {
        const { data } = await api(`/hr/payroll/periods/${id}/calculate`, { method: 'POST' });
        toast(`Nómina calculada (${data.employees} empleados)` + (data.warnings.length ? ` — ${data.warnings.length} advertencia(s)` : ''));
        if (data.warnings.length) setTimeout(() => toast('⚠ ' + data.warnings[0], true), 1200);
        render();
      } catch (err) { toast(err.message, true); }
    };
    window._closePeriod = async id => {
      try {
        await api(`/hr/payroll/periods/${id}/close`, { method: 'POST' });
        toast('Cierre enviado a aprobación del dueño'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._viewPeriod = async id => {
      const p = await get(`/hr/payroll/periods/${id}`);
      modal(`<h2>Nómina ${p.month}/${p.year} ${sb(p.status)}</h2>
        <table class="mt"><tr><th>Empleado</th><th>Días</th><th>Devengado</th><th>Deducciones</th><th>Neto</th><th>Costo patronal</th></tr>
        ${p.items.map(i => `<tr class="clickable" onclick='window._slipShow(${JSON.stringify(JSON.stringify({ name: i.employee.fullName, b: i.breakdown }))})'>
          <td>${esc(i.employee.fullName)}<div class="muted" style="font-size:11px">${esc(i.employee.position)}</div></td>
          <td>${i.daysWorked}</td><td>${cop(i.earned)}</td><td>${cop(i.deductions)}</td><td><b>${cop(i.net)}</b></td><td class="muted">${cop(i.employerCost)}</td></tr>`).join('')}
        <tr><td><b>Totales</b></td><td></td><td><b>${cop(p.totalEarned)}</b></td><td><b>${cop(p.totalDeductions)}</b></td><td><b>${cop(p.totalNet)}</b></td><td><b>${cop(p.totalEmployerCost)}</b></td></tr></table>
        <p class="muted mt" style="font-size:11.5px">Clic en un empleado para ver el desprendible detallado.</p>`);
    };
    window._slipShow = json => {
      const { name, b } = JSON.parse(json);
      const rows = list => list.map(x => `<tr><td>${esc(x.concept)}${x.detail ? ` <span class="muted" style="font-size:11px">(${esc(x.detail)})</span>` : ''}</td><td class="right">${cop(x.amount)}</td></tr>`).join('');
      modal(`<h2>Desprendible — ${esc(name)}</h2>
        <h3 class="mt">Devengados</h3><table>${rows(b.earned)}</table>
        <h3 class="mt">Deducciones (IBC ${cop(b.IBC)})</h3><table>${rows(b.deductions)}</table>
        <h3 class="mt">Costos patronales</h3><table>${rows(b.employer)}</table>
        <h3 class="mt">Provisiones prestacionales</h3><table>${rows(b.provisions)}</table>`);
    };
    window._addNovelty = async () => {
      try {
        await api('/hr/novelties', {
          method: 'POST',
          body: {
            propertyId: state.propertyId, employeeId: $('#nEmp').value, type: $('#nType').value,
            date: $('#nDate').value, hours: $('#nHours').value || null, days: $('#nDays').value || null,
            amount: $('#nAmount').value || null, notes: $('#nNotes').value,
          },
        });
        toast('Novedad registrada (pendiente de aprobación)'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._decideNov = async (id, approve) => {
      try { await api(`/hr/novelties/${id}/decide`, { method: 'POST', body: { approve } }); toast(approve ? 'Novedad aprobada' : 'Novedad rechazada'); render(); }
      catch (err) { toast(err.message, true); }
    };
    const typeLabel = t => (types.find(x => x.type === t) || { label: t }).label;
    return `
      <div class="card"><h3>Periodos de nómina</h3>
        <div class="row">
          <div><label>Año</label><input id="pYear" type="number" value="${now.getFullYear()}"></div>
          <div><label>Mes</label><input id="pMonth" type="number" min="1" max="12" value="${now.getMonth() + 1}"></div>
          <button class="btn fit" onclick="_createPeriod()">Abrir periodo</button>
        </div>
        <table class="mt"><tr><th>Periodo</th><th>Empleados</th><th>Neto</th><th>Costo patronal</th><th>Estado</th><th></th></tr>
        ${periods.map(p => `<tr>
          <td><b>${p.month}/${p.year}</b></td><td>${p._count.items}</td>
          <td>${p.totalNet != null ? cop(p.totalNet) : '—'}</td><td>${p.totalEmployerCost != null ? cop(p.totalEmployerCost) : '—'}</td>
          <td>${sb(p.status)}</td>
          <td>
            ${p.status !== 'closed' ? `<button class="btn small secondary" onclick="_calcPeriod('${p.id}')">${p.status === 'calculated' ? 'Recalcular' : 'Calcular'}</button>` : ''}
            ${p._count.items ? `<button class="btn small secondary" onclick="_viewPeriod('${p.id}')">Ver detalle</button>` : ''}
            ${p.status === 'calculated' ? `<button class="btn small" onclick="_closePeriod('${p.id}')">Cerrar (aprueba dueño)</button>` : ''}
          </td></tr>`).join('')}
        </table>${periods.length ? '' : '<p class="muted mt">Sin periodos abiertos.</p>'}
      </div>
      <div class="card"><h3>Novedades (horas extras, ausencias, bonos…)</h3>
        <div class="row">
          <div><label>Empleado</label><select id="nEmp">${employees.map(e => `<option value="${e.id}">${esc(e.fullName)}</option>`).join('')}</select></div>
          <div><label>Tipo</label><select id="nType">${types.map(t => `<option value="${t.type}">${esc(t.label)}</option>`).join('')}</select></div>
          <div><label>Fecha</label><input id="nDate" type="date" value="${now.toISOString().slice(0, 10)}"></div>
          <div><label>Horas</label><input id="nHours" type="number" step="0.5"></div>
          <div><label>Días</label><input id="nDays" type="number" step="0.5"></div>
          <div><label>Valor</label><input id="nAmount" type="number"></div>
          <div><label>Notas</label><input id="nNotes"></div>
          <button class="btn fit" onclick="_addNovelty()">Registrar</button>
        </div>
        <table class="mt"><tr><th>Empleado</th><th>Tipo</th><th>Fecha</th><th>Cantidad</th><th>Estado</th><th></th></tr>
        ${novelties.slice(0, 30).map(n => `<tr>
          <td>${esc(n.employee.fullName)}</td><td>${esc(typeLabel(n.type))}</td><td>${day(n.date)}</td>
          <td>${n.hours ? n.hours + ' h' : ''}${n.days ? n.days + ' día(s)' : ''}${n.amount ? cop(n.amount) : ''}</td>
          <td>${sb(n.status)}</td>
          <td>${n.status === 'pending' ? `<button class="btn small" onclick="_decideNov('${n.id}',true)">Aprobar</button>
            <button class="btn small danger" onclick="_decideNov('${n.id}',false)">Rechazar</button>` : ''}</td>
        </tr>`).join('')}</table>
      </div>
      <div class="card"><h3>PILA — seguridad social</h3>
        <p class="muted" style="font-size:12.5px">La planilla se arma desde el IBC y los aportes que la nómina ya calculó. Presentar y pagar es una acción humana.</p>
        <div class="row">
          <div><label>Preparar desde periodo</label><select id="pilaPeriod"><option value="">—</option>${periods.filter(p => p.status !== 'open').map(p => `<option value="${p.id}">${p.month}/${p.year}</option>`).join('')}</select></div>
          <button class="btn fit" onclick="_preparePila()">Preparar planilla</button>
        </div>
        <table class="mt"><tr><th>Periodo</th><th>Empleados</th><th>IBC total</th><th>Aportes</th><th>Estado</th><th></th></tr>
        ${pilas.map(p => `<tr>
          <td><b>${p.month}/${p.year}</b></td><td>${p.employeeCount}</td><td>${cop(p.totalIBC)}</td><td>${cop(p.totalContributions)}</td>
          <td>${sb(p.status === 'paid' ? 'confirmed' : 'pending')} ${p.status === 'paid' ? 'pagada' : 'preparada'}${p.inconsistencies.length ? ' ' + badge('⚠ afiliaciones', 'yellow') : ''}</td>
          <td><button class="btn small secondary" onclick="_pilaView('${p.id}')">Ver</button>
              ${p.status !== 'paid' ? `<button class="btn small" onclick="_pilaPay('${p.id}')">Registrar pago</button>` : ''}</td>
        </tr>`).join('')}</table>
        ${pilas.length ? '' : '<p class="muted">Aún no hay planillas PILA.</p>'}
      </div>
      <div class="card"><h3>Nómina electrónica DIAN
        ${nie.providerConfigured ? badge('Proveedor conectado', 'green') : badge('Sin proveedor — modo local', 'yellow')}</h3>
        <p class="muted" style="font-size:12.5px">Genera el documento soporte de pago por empleado desde un periodo cerrado. Sin proveedor DIAN, se numera localmente y queda listo para transmitir.</p>
        <div class="row">
          <div><label>Generar desde periodo cerrado</label><select id="niePeriod"><option value="">—</option>${periods.filter(p => p.status === 'closed').map(p => `<option value="${p.id}">${p.month}/${p.year}</option>`).join('')}</select></div>
          <button class="btn fit" onclick="_nieGen()">Generar documentos</button>
        </div>
        ${nie.documents.length ? `<table class="mt"><tr><th>Número</th><th>Empleado</th><th>Devengado</th><th>Deducido</th><th>Neto</th><th>Estado</th></tr>
          ${nie.documents.map(d => `<tr><td>${esc(d.fullNumber || '(borrador)')}</td><td>${esc(d.employeeName)}</td><td>${cop(d.earned)}</td><td>${cop(d.deductions)}</td><td><b>${cop(d.net)}</b></td><td>${sb(d.status === 'validated' ? 'confirmed' : d.status === 'error' ? 'open' : d.status === 'pending' ? 'pending' : 'active')} ${esc(d.status)}</td></tr>`).join('')}
          </table>
          ${nie.documents.some(d => d.status === 'generated') ? `<button class="btn small mt" onclick="_nieTx('${nie.documents.find(d => d.status === 'generated').periodId}')">Transmitir generados</button>` : ''}`
          : '<p class="muted mt">Aún no hay documentos de nómina electrónica.</p>'}
      </div>`;
  }

  async function viewDocuments() {
    const [docs, rules] = await Promise.all([
      get('/documents'),
      get('/documents/rules/list').catch(() => []),
    ]);
    window._uploadDoc = () => {
      const file = $('#docFile').files[0];
      if (!file) return toast('Selecciona un archivo', true);
      if (file.size > 15 * 1024 * 1024) return toast('El archivo supera 15 MB', true);
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          await api('/documents', {
            method: 'POST',
            body: {
              propertyId: state.propertyId, docType: $('#docType').value, title: $('#docTitle').value || file.name,
              fileName: file.name, mimeType: file.type, base64: reader.result,
              entityType: $('#docEntity').value || null, expiryDate: $('#docExpiry').value || null,
            },
          });
          toast('Documento cargado'); render();
        } catch (err) { toast(err.message, true); }
      };
      reader.readAsDataURL(file);
    };
    window._delDoc = async (id, legal) => {
      if (!confirm(legal ? 'Eliminar un documento legal requiere aprobación del dueño. ¿Continuar?' : '¿Eliminar este documento?')) return;
      try {
        const { status } = await api(`/documents/${id}`, { method: 'DELETE' });
        toast(status === 202 ? 'Solicitud de eliminación enviada a aprobación' : 'Documento eliminado');
        render();
      } catch (err) { toast(err.message, true); }
    };
    window._runRules = async () => {
      try { const { data } = await api('/documents/rules/run', { method: 'POST' }); toast(`Reglas ejecutadas: ${data.findings} alerta(s) generada(s)`); }
      catch (err) { toast(err.message, true); }
    };
    const LEGAL = ['RUT', 'RNT', 'contract', 'policy', 'certificate'];
    const expiryBadge = d => {
      if (!d.expiryDate) return '';
      const days = Math.ceil((new Date(d.expiryDate) - Date.now()) / 86400000);
      if (days < 0) return badge('vencido', 'red');
      if (days < 45) return badge(`vence en ${days}d`, 'yellow');
      return `<span class="muted" style="font-size:11px">${day(d.expiryDate)}</span>`;
    };
    return `
      <div class="card"><h3>Cargar documento</h3>
        <div class="row">
          <div><label>Título</label><input id="docTitle" placeholder="RUT actualizado"></div>
          <div><label>Tipo</label><select id="docType">
            <option value="RUT">RUT</option><option value="RNT">RNT</option><option value="CC">Cédula</option>
            <option value="PASSPORT">Pasaporte</option><option value="contract">Contrato</option>
            <option value="certificate">Certificado</option><option value="policy">Política</option>
            <option value="invoice">Factura</option><option value="other" selected>Otro</option></select></div>
          <div><label>Asociar a</label><select id="docEntity">
            <option value="">(ninguno)</option><option value="Property">Sede</option><option value="Employee">Empleado</option>
            <option value="Guest">Huésped</option><option value="Supplier">Proveedor</option></select></div>
          <div><label>Vence</label><input id="docExpiry" type="date"></div>
        </div>
        <div class="row mt">
          <div><label>Archivo (PDF/imagen, máx 15 MB)</label><input id="docFile" type="file" accept=".pdf,.jpg,.jpeg,.png,.webp,.doc,.docx"></div>
          <button class="btn fit" onclick="_uploadDoc()">Cargar</button>
        </div>
      </div>
      <div class="card"><table>
        <tr><th>Título</th><th>Tipo</th><th>Ver.</th><th>Vencimiento</th><th>Cargado</th><th></th></tr>
        ${docs.map(d => `<tr>
          <td>${esc(d.title)}<div class="muted" style="font-size:11px">${esc(d.fileName)}</div></td>
          <td>${LEGAL.includes(d.docType) ? badge(d.docType, 'blue') : esc(d.docType)}</td>
          <td>v${d.version}</td><td>${expiryBadge(d)}</td><td class="muted" style="font-size:12px">${dt(d.createdAt)}</td>
          <td><button class="btn small secondary" onclick="_openDoc('/documents/${d.id}/download')">Ver</button>
              <button class="btn small danger" onclick="_delDoc('${d.id}',${LEGAL.includes(d.docType)})">Eliminar</button></td>
        </tr>`).join('')}
      </table>${docs.length ? '' : '<p class="muted">Sin documentos. Carga RUT, RNT, contratos, certificados y pólizas para controlar vencimientos.</p>'}</div>
      <div class="card"><h3>Motor de reglas de cumplimiento <button class="btn small secondary" style="float:right" onclick="_runRules()">Ejecutar ahora</button></h3>
        <table><tr><th>Regla</th><th>Severidad</th><th>Anticipación</th><th>Avisar a</th><th>Estado</th></tr>
        ${rules.map(r => `<tr><td>${esc(r.name)}</td><td>${sb(r.severity === 'critical' ? 'open' : r.severity === 'warning' ? 'pending' : 'active')} ${esc(r.severity)}</td><td>${r.thresholdDays ? r.thresholdDays + ' días' : '—'}</td><td>${esc(r.audienceRole)}</td><td>${r.active ? badge('activa', 'green') : badge('inactiva', 'gray')}</td></tr>`).join('')}
        </table><p class="muted mt" style="font-size:12px">Se ejecutan automáticamente cada 6 horas. Revisan RNT, documentos, TRA, SIRE y contratos por vencer.</p>
      </div>`;
  }

  async function viewAudit() {
    const logs = await get(`/audit-logs?${pid()}`);
    return `<div class="card"><table>
      <tr><th>Fecha</th><th>Actor</th><th>Usuario</th><th>Acción</th><th>Entidad</th><th>Detalle</th></tr>
      ${logs.map(l => `<tr>
        <td>${dt(l.createdAt)}</td>
        <td>${l.actor === 'ai' ? badge('IA', 'blue') : l.actor === 'system' ? badge('Sistema', 'gray') : badge('Humano', 'green')}</td>
        <td>${esc(l.userName || '—')}</td><td><code style="font-size:12px">${esc(l.action)}</code></td>
        <td class="muted">${esc(l.entity || '')}</td>
        <td class="muted" style="font-size:11.5px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(l.after || l.reason || '')}</td>
      </tr>`).join('')}
    </table></div>`;
  }

  async function viewIntegrations() {
    const ov = await get(`/integrations/overview?${pid()}`);
    const catLabel = { payments: '💳 Pagos', invoicing: '🧾 Facturación', channel: '🌐 Canales/OTA', messaging: '💬 Mensajería', analytics: '📈 Analítica', other: '🔗 Otros' };
    const stPill = s => s === 'connected' ? badge('Conectado', 'green') : s === 'error' ? badge('Error', 'red') : badge('Sin conectar', 'gray');
    window._inTest = async provider => {
      try { const r = await api(`/integrations/${provider}/test`, { method: 'POST', body: { propertyId: state.propertyId } }); toast(r.message, !r.ok); render(); }
      catch (e) { toast(e.message, true); }
    };
    window._inToggle = async (id, enabled) => { try { await api(`/integrations/${id}`, { method: 'PATCH', body: { enabled } }); toast(enabled ? 'Habilitada' : 'Deshabilitada'); render(); } catch (e) { toast(e.message, true); } };
    window._inConnect = provider => {
      const it = ov.items.find(i => i.provider === provider);
      const fields = it.fields || [];
      modal(`<h3>Conectar ${esc(it.name)}</h3>
        <p class="muted">Ingresa las credenciales del proveedor. Los secretos se almacenan cifrados y se enmascaran al mostrarse.</p>
        ${fields.map(f => `<div class="mt"><label>${esc(f.label)}${f.secret ? ' 🔒' : ''}</label><input id="incfg_${f.key}" ${f.secret ? 'type="password"' : ''}></div>`).join('') || '<p class="muted">Esta integración no requiere credenciales adicionales.</p>'}
        <div class="right mt"><button class="btn secondary" onclick="this.closest('.modal-bg').remove()">Cancelar</button>
        <button class="btn" onclick="_inSave('${provider}')">Guardar y conectar</button></div>`);
    };
    window._inSave = async provider => {
      const it = ov.items.find(i => i.provider === provider);
      const config = {};
      for (const f of it.fields || []) { const v = document.getElementById(`incfg_${f.key}`)?.value; if (v) config[f.key] = v; }
      try { await api(`/integrations/${provider}/connect`, { method: 'POST', body: { propertyId: state.propertyId, config } }); toast('Integración conectada'); document.querySelector('.modal-bg')?.remove(); render(); }
      catch (e) { toast(e.message, true); }
    };
    setTimeout(animateCounts, 0);
    const cats = [...new Set(ov.items.map(i => i.category))];
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Integraciones</div><div class="value">${ov.total}</div></div>
        <div class="kpi"><div class="label">Conectadas</div><div class="value" style="color:var(--green)"><span data-count="${ov.connected}">0</span></div></div>
        <div class="kpi"><div class="label">Categorías</div><div class="value">${cats.length}</div></div>
        <div class="kpi"><div class="label">Disponibles</div><div class="value">${ov.total - ov.connected}</div></div>
      </div>
      ${cats.map(cat => `<div class="card mt"><h3>${catLabel[cat] || esc(cat)}</h3>
        <div class="grid cols-2">
        ${ov.items.filter(i => i.category === cat).map(i => `
          <div style="padding:14px;border:1px solid var(--border);border-radius:var(--r-md);background:var(--surface-2)">
            <div class="row" style="justify-content:space-between;align-items:center">
              <b>${esc(i.name)}</b> ${stPill(i.status)}
            </div>
            ${Object.keys(i.config).length ? `<div class="muted mt" style="font-size:12px">${Object.entries(i.config).map(([k, v]) => `${esc(k)}: <code>${esc(String(v))}</code>`).join(' · ')}</div>` : ''}
            ${i.managedByEnv ? `<div class="muted mt" style="font-size:12px">⚙️ Gestionada por variables de entorno del servidor.</div>`
              : i.live ? `<div class="muted mt" style="font-size:12px">📡 Estado en vivo desde el servicio.</div>` : ''}
            <div class="row mt" style="gap:8px">
              ${!i.managedByEnv && !i.live ? `<button class="btn small" onclick="_inConnect('${i.provider}')">${i.status === 'connected' ? 'Reconfigurar' : 'Conectar'}</button>` : ''}
              <button class="btn small ghost" onclick="_inTest('${i.provider}')">Probar</button>
              ${i.id ? `<button class="btn small ghost" onclick="_inToggle('${i.id}', ${!i.enabled})">${i.enabled ? 'Deshabilitar' : 'Habilitar'}</button>` : ''}
            </div>
          </div>`).join('')}
        </div></div>`).join('')}
      <p class="muted mt" style="font-size:12px">Las pasarelas y Dataico se configuran con variables de entorno por seguridad; las demás se conectan aquí. Todo cambio queda en auditoría.</p>`;
  }

  async function viewAutomations() {
    const ov = await get(`/automations/overview?${pid()}`);
    const trigLabel = Object.fromEntries(ov.triggers.map(t => [t.event, t.label]));
    const actLabel = Object.fromEntries(ov.actions.map(a => [a.type, a.label]));
    window._auAct = null;
    window._auActChange = () => {
      const type = $('#auAction').value;
      const act = ov.actions.find(a => a.type === type);
      $('#auParams').innerHTML = (act?.params || []).map(p => p.options
        ? `<div><label>${esc(p.label)}</label><select id="aup_${p.key}">${p.options.map(o => `<option value="${o}">${esc(o)}</option>`).join('')}</select></div>`
        : `<div><label>${esc(p.label)}</label><input id="aup_${p.key}"></div>`).join('');
    };
    // Campos disponibles en el payload de cada disparador (para condiciones).
    const TRIGGER_FIELDS = {
      'review.created': ['rating', 'sentiment', 'source'], 'payment.succeeded': ['amount'],
      'reservation.confirmed': ['code'], 'event.confirmed': ['total', 'code'],
      'booking.abandoned': ['code'], 'campaign.sent': ['channel', 'sent'],
    };
    window._auTrigChange = () => {
      const fields = TRIGGER_FIELDS[$('#auTrigger').value] || [];
      $('#auCondFields').innerHTML = fields.map(f => `<option value="${f}">`).join('');
      $('#auCondHint').textContent = fields.length ? `Campos: ${fields.join(', ')}` : 'Este disparador no expone campos para filtrar.';
    };
    window._auCreate = async () => {
      const type = $('#auAction').value;
      const act = ov.actions.find(a => a.type === type);
      const params = {};
      for (const p of act?.params || []) { const v = document.getElementById(`aup_${p.key}`)?.value; if (v) params[p.key] = v; }
      const conditions = [];
      const cField = $('#auCondField').value.trim();
      if (cField) conditions.push({ field: cField, op: $('#auCondOp').value, value: $('#auCondVal').value });
      try { await api('/automations/rules', { method: 'POST', body: { propertyId: state.propertyId, name: $('#auName').value, trigger: $('#auTrigger').value, conditions, actionType: type, actionParams: params } }); toast('Regla creada'); render(); }
      catch (e) { toast(e.message, true); }
    };
    window._auToggle = async (id, enabled) => { try { await api(`/automations/rules/${id}`, { method: 'PATCH', body: { enabled } }); toast(enabled ? 'Regla activada' : 'Regla pausada'); render(); } catch (e) { toast(e.message, true); } };
    window._auTest = async id => { try { const r = await api(`/automations/rules/${id}/test`, { method: 'POST', body: { payload: {} } }); toast(r.executed ? 'Regla ejecutada (prueba) ✅' : 'Las condiciones no coincidieron'); render(); } catch (e) { toast(e.message, true); } };
    window._auDel = async id => { if (!confirm('¿Eliminar esta regla?')) return; try { await api(`/automations/rules/${id}`, { method: 'DELETE' }); toast('Regla eliminada'); render(); } catch (e) { toast(e.message, true); } };
    setTimeout(() => { animateCounts(); if ($('#auAction')) _auActChange(); if ($('#auTrigger')) _auTrigChange(); }, 0);
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Reglas</div><div class="value"><span data-count="${ov.total}">0</span></div></div>
        <div class="kpi"><div class="label">Activas</div><div class="value" style="color:var(--green)"><span data-count="${ov.active}">0</span></div></div>
        <div class="kpi"><div class="label">Ejecuciones</div><div class="value"><span data-count="${ov.totalRuns}">0</span></div></div>
        <div class="kpi"><div class="label">Disparadores</div><div class="value">${ov.triggers.length}</div></div>
      </div>

      <div class="card mt"><h3>Nueva regla</h3>
        <p class="muted">Cuando ocurra un <b>disparador</b>, ejecuta una <b>acción</b>. Solo acciones de bajo riesgo; las sensibles siguen exigiendo aprobación humana.</p>
        <div class="row mt">
          <div><label>Nombre</label><input id="auName" placeholder="Avisar a ventas si reserva abandonada"></div>
          <div><label>Cuando… (disparador)</label><select id="auTrigger" onchange="_auTrigChange()">${ov.triggers.map(t => `<option value="${t.event}">${esc(t.label)}</option>`).join('')}</select></div>
          <div><label>Entonces… (acción)</label><select id="auAction" onchange="_auActChange()">${ov.actions.map(a => `<option value="${a.type}">${esc(a.label)}</option>`).join('')}</select></div>
        </div>
        <div class="row mt" id="auParams"></div>
        <div class="mt" style="padding-top:8px;border-top:1px dashed var(--border)">
          <label>Solo si… (condición opcional)</label>
          <div class="row">
            <div><input id="auCondField" list="auCondFields" placeholder="campo (p.ej. rating)"><datalist id="auCondFields"></datalist></div>
            <div><select id="auCondOp"><option value="eq">=</option><option value="neq">≠</option><option value="gt">&gt;</option><option value="lt">&lt;</option><option value="exists">existe</option></select></div>
            <div><input id="auCondVal" placeholder="valor"></div>
          </div>
          <div class="muted" id="auCondHint" style="font-size:12px;margin-top:4px"></div>
        </div>
        <div class="right mt"><button class="btn" onclick="_auCreate()">Crear regla</button></div>
      </div>

      <div class="card mt"><h3>Reglas configuradas</h3>
        ${ov.rules.length ? `<table><tr><th>Regla</th><th>Cuando</th><th>Entonces</th><th>Ejecuciones</th><th>Estado</th><th></th></tr>
        ${ov.rules.map(r => { const cond = (() => { try { const c = JSON.parse(r.conditions || '[]')[0]; return c ? `<div class="muted" style="font-size:11px">si ${esc(c.field)} ${({ eq: '=', neq: '≠', gt: '>', lt: '<', exists: 'existe' })[c.op] || c.op} ${esc(String(c.value ?? ''))}</div>` : ''; } catch { return ''; } })(); return `<tr><td><b>${esc(r.name)}</b></td><td>${esc(trigLabel[r.trigger] || r.trigger)}${cond}</td><td>${esc(actLabel[r.actionType] || r.actionType)}</td>
          <td>${r.runCount}${r.lastRunAt ? ` <span class="muted" style="font-size:11px">· ${day(r.lastRunAt)}</span>` : ''}</td>
          <td>${r.enabled ? sb('active') + ' activa' : badge('Pausada', 'gray')}</td>
          <td><button class="btn small ghost" onclick="_auTest('${r.id}')">Probar</button>
              <button class="btn small ghost" onclick="_auToggle('${r.id}', ${!r.enabled})">${r.enabled ? 'Pausar' : 'Activar'}</button>
              <button class="btn small ghost danger" onclick="_auDel('${r.id}')">Eliminar</button></td>
        </tr>`; }).join('')}</table>` : '<p class="muted">Aún no hay reglas. Crea la primera arriba.</p>'}
      </div>`;
  }

  async function viewSettings() {
    const [users, params, props, gateways, templates, policies] = await Promise.all([
      get('/admin/users').catch(() => []),
      get('/admin/legal-parameters').catch(() => []),
      get('/admin/properties'),
      get('/payments/gateways').catch(() => []),
      get(`/documents/templates/list?${pid()}`).catch(() => []),
      get(`/documents/policies/list?${pid()}`).catch(() => []),
    ]);
    const prop = props.find(p => p.id === state.propertyId) || props[0];
    window._addUser = async () => {
      try {
        await api('/admin/users', { method: 'POST', body: { name: $('#uName').value, email: $('#uEmail').value, password: $('#uPass').value, role: $('#uRole').value } });
        toast('Usuario creado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._addParam = async () => {
      try {
        await api('/admin/legal-parameters', { method: 'POST', body: { key: $('#lpKey').value, value: +$('#lpValue').value, unit: $('#lpUnit').value, validFrom: $('#lpFrom').value, source: $('#lpSource').value } });
        toast('Parámetro registrado'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._addTemplate = async () => {
      try {
        await api('/documents/templates', { method: 'POST', body: { propertyId: state.propertyId, channel: $('#tplChannel').value, name: $('#tplName').value, subject: $('#tplSubject').value, body: $('#tplBody').value } });
        toast('Plantilla guardada'); render();
      } catch (err) { toast(err.message, true); }
    };
    window._addPolicy = async () => {
      try {
        await api('/documents/policies', { method: 'POST', body: { propertyId: state.propertyId, type: $('#polType').value, title: $('#polTitle').value, conditions: $('#polCond').value, penalty: $('#polPen').value, publicText: $('#polPublic').value } });
        toast('Política creada'); render();
      } catch (err) { toast(err.message, true); }
    };
    const roles = ['MANAGER', 'FRONTDESK', 'SALES', 'HOUSEKEEPING', 'MAINTENANCE', 'ACCOUNTING', 'HR', 'AUDITOR', 'OWNER'];
    return `
      <div class="card"><h3>Sede: ${esc(prop?.name || '')}</h3>
        <p class="muted">RNT: ${esc(prop?.rnt || 'sin registrar')} · ${prop?._count?.rooms ?? '—'} habitaciones · Webchat público: <a style="color:var(--accent2)" href="/chat.html?propertyId=${prop?.id}" target="_blank">/chat.html</a></p>
      </div>
      <div class="card"><h3>Pasarelas de pago</h3>
        <p class="muted" style="font-size:12px;margin-bottom:10px">Configura las llaves en <code>.env</code>. La pasarela por defecto se define con <code>PAYMENT_PROVIDER</code>; también puedes elegir pasarela por link de pago.</p>
        <div class="row">${gateways.map(g => `<div class="fit" style="margin-right:8px">${g.configured ? badge(g.label + ' ✓', 'green') : badge(g.label, 'gray')}</div>`).join('')}</div>
      </div>
      <div class="card"><h3>Usuarios</h3>
        <table><tr><th>Nombre</th><th>Email</th><th>Rol</th><th>Último ingreso</th></tr>
        ${users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.email)}</td><td>${badge(u.role, 'blue')}</td><td>${dt(u.lastLoginAt)}</td></tr>`).join('')}</table>
        ${state.user.role === 'OWNER' || state.user.role === 'MANAGER' ? `<div class="row mt">
          <div><label>Nombre</label><input id="uName"></div>
          <div><label>Email</label><input id="uEmail" type="email"></div>
          <div><label>Contraseña</label><input id="uPass" type="password"></div>
          <div><label>Rol</label><select id="uRole">${roles.map(r => `<option>${r}</option>`).join('')}</select></div>
          <button class="btn fit" onclick="_addUser()">Crear</button>
        </div>` : ''}
      </div>
      <div class="card"><h3>Parámetros legales (versionados por vigencia)</h3>
        <table><tr><th>Clave</th><th>Valor</th><th>Unidad</th><th>Vigente desde</th><th>Fuente</th></tr>
        ${params.map(p => `<tr><td><code>${esc(p.key)}</code></td><td>${p.unit === 'COP' ? cop(p.value) : p.value}</td><td>${esc(p.unit || '')}</td><td>${day(p.validFrom)}</td><td class="muted">${esc(p.source || '')}</td></tr>`).join('')}</table>
        <div class="row mt">
          <div><label>Clave</label><input id="lpKey" placeholder="SMMLV"></div>
          <div><label>Valor</label><input id="lpValue" type="number"></div>
          <div><label>Unidad</label><input id="lpUnit" placeholder="COP"></div>
          <div><label>Vigente desde</label><input id="lpFrom" type="date"></div>
          <div><label>Fuente</label><input id="lpSource"></div>
          <button class="btn fit" onclick="_addParam()">Registrar</button>
        </div>
      </div>
      <div class="card"><h3>Plantillas de mensajes</h3>
        <table><tr><th>Nombre</th><th>Canal</th><th>Contenido</th></tr>
        ${templates.map(t => `<tr><td>${esc(t.name)}</td><td>${badge(t.channel, 'blue')}</td><td class="muted" style="font-size:12px;max-width:340px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(t.body)}</td></tr>`).join('')}</table>
        <div class="row mt">
          <div><label>Nombre</label><input id="tplName" placeholder="voucher_confirmacion"></div>
          <div><label>Canal</label><select id="tplChannel"><option>whatsapp</option><option>email</option><option>voucher</option><option>internal</option></select></div>
          <div><label>Asunto (email)</label><input id="tplSubject"></div>
        </div>
        <label>Cuerpo (usa variables {{nombre}}, {{codigo}}, {{total}})</label><textarea id="tplBody" rows="2"></textarea>
        <button class="btn small mt" onclick="_addTemplate()">Guardar plantilla</button>
      </div>
      <div class="card"><h3>Políticas hoteleras</h3>
        <table><tr><th>Tipo</th><th>Título</th><th>Penalidad</th><th>Texto público</th></tr>
        ${policies.map(p => `<tr><td>${esc(p.type)}</td><td>${esc(p.title)}</td><td class="muted">${esc(p.penalty || '—')}</td><td class="muted" style="font-size:12px;max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(p.publicText || '')}</td></tr>`).join('')}</table>
        <div class="row mt">
          <div><label>Tipo</label><select id="polType"><option value="cancellation">Cancelación</option><option value="checkin">Check-in</option><option value="checkout">Check-out</option><option value="pets">Mascotas</option><option value="children">Niños</option><option value="noshow">No-show</option><option value="late_checkout">Late check-out</option><option value="deposit">Anticipo</option></select></div>
          <div><label>Título</label><input id="polTitle"></div>
          <div><label>Penalidad</label><input id="polPen" placeholder="1 noche"></div>
        </div>
        <div class="row mt">
          <div><label>Condiciones</label><input id="polCond"></div>
          <div><label>Texto público</label><input id="polPublic"></div>
          <button class="btn fit" onclick="_addPolicy()">Crear política</button>
        </div>
      </div>`;
  }

  // ---------- router ----------
  const VIEWS = {
    portfolio: ['Portafolio — consolidado multi-sede', viewPortfolio],
    dashboard: ['Dashboard gerencial', viewDashboard],
    rooms: ['Mapa de habitaciones', viewRooms],
    reservations: ['Reservas', viewReservations],
    booking: ['Nueva reserva', viewBooking],
    inbox: ['Inbox omnicanal', viewInbox],
    crm: ['CRM — Leads', viewCrm],
    marketing: ['Marketing & campañas', viewMarketing],
    reputation: ['Reputación & reseñas', viewReputation],
    events: ['Eventos, salones y montajes', viewEvents],
    housekeeping: ['Housekeeping', viewHousekeeping],
    maintenance: ['Mantenimiento', viewMaintenance],
    payments: ['Pagos y links', viewPayments],
    invoices: ['Facturación electrónica (Dataico)', viewInvoices],
    copilot: ['Copiloto interno', viewCopilot],
    content: ['Habitaciones y base de conocimiento', viewContent],
    site: ['Sitio web público', viewSite],
    agent: ['Agente IA — persona y comportamiento', viewAgent],
    employees: ['Empleados (Atria People)', viewEmployees],
    shifts: ['Turnos y asistencia', viewShifts],
    payroll: ['Nómina colombiana', viewPayroll],
    sgsst: ['SG-SST — Seguridad y Salud en el Trabajo', viewSgsst],
    inventory: ['Inventario, proveedores y compras', viewInventory],
    pos: ['Restaurante — POS y comandas', viewPos],
    revenue: ['Revenue — forecast y tarifas', viewRevenue],
    channels: ['Channel manager — OTAs', viewChannels],
    finance: ['Finanzas, contabilidad y cartera', viewFinance],
    approvals: ['Aprobaciones humanas', viewApprovals],
    compliance: ['Cumplimiento (RNT · TRA · SIRE)', viewCompliance],
    dataprotection: ['Protección de datos — Habeas Data', viewDataProtection],
    fontur: ['FONTUR — contribución parafiscal del turismo', viewFontur],
    documents: ['Centro documental', viewDocuments],
    audit: ['Auditoría y trazabilidad', viewAudit],
    integrations: ['Centro de integraciones', viewIntegrations],
    automations: ['Automatizaciones — reglas no-code', viewAutomations],
    settings: ['Configuración', viewSettings],
  };

  async function render() {
    if (!state.token) return renderLogin();
    if (state.view !== 'inbox') stopTimers();
    let title, fn, arg = null;
    if (state.view.startsWith('res:')) {
      title = 'Detalle de reserva'; fn = viewReservationDetail; arg = state.view.slice(4);
    } else {
      [title, fn] = VIEWS[state.view] || VIEWS.dashboard;
    }
    renderShell('<p class="muted">Cargando…</p>', title);
    if (state.justLoggedIn) { state.justLoggedIn = false; showWelcome(); }
    try {
      $('#content').innerHTML = await fn(arg);
    } catch (err) {
      $('#content').innerHTML = `<div class="card"><p style="color:var(--red)">${esc(err.message)}</p></div>`;
    }
  }

  window.addEventListener('hashchange', () => {
    state.view = location.hash.slice(1) || 'dashboard';
    render();
  });

  render();
})();
