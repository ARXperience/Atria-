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
    ['dashboard', '📊 Dashboard'],
    ['rooms', '🛏️ Habitaciones'],
    ['reservations', '📅 Reservas'],
    ['booking', '➕ Nueva reserva'],
    ['housekeeping', '🧹 Housekeeping'],
    ['maintenance', '🔧 Mantenimiento'],
    ['sep', 'Comercial'],
    ['inbox', '💬 Inbox / WhatsApp'],
    ['crm', '👥 CRM'],
    ['payments', '💳 Pagos'],
    ['invoices', '🧾 Facturación'],
    ['sep', 'Personas'],
    ['employees', '👔 Empleados'],
    ['payroll', '💰 Nómina'],
    ['sep', 'Gobierno'],
    ['approvals', '✅ Aprobaciones'],
    ['compliance', '⚖️ Cumplimiento'],
    ['audit', '🔍 Auditoría'],
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

  const pid = () => `propertyId=${state.propertyId}`;

  // ---------- vistas ----------
  async function viewDashboard() {
    const d = await get(`/dashboard?${pid()}`);
    return `
      <div class="grid cols-4">
        <div class="kpi"><div class="label">Ocupación</div><div class="value">${d.rooms.occupancyPct}%<small> ${d.rooms.occupied}/${d.rooms.total - d.rooms.outOfService}</small></div></div>
        <div class="kpi"><div class="label">ADR (mes)</div><div class="value">${cop(d.kpis.adr)}</div></div>
        <div class="kpi"><div class="label">RevPAR (mes)</div><div class="value">${cop(d.kpis.revpar)}</div></div>
        <div class="kpi"><div class="label">Ingresos del mes</div><div class="value">${cop(d.kpis.monthRevenue)}</div></div>
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
        <div class="kpi"><div class="label">Huéspedes en casa</div><div class="value">${d.today.inHouse}</div></div>
        <div class="kpi"><div class="label">Aprobaciones pendientes</div><div class="value" style="color:${d.alerts.pendingApprovals ? 'var(--yellow)' : 'inherit'}">${d.alerts.pendingApprovals}</div></div>
        <div class="kpi"><div class="label">Limpiezas pendientes</div><div class="value">${d.alerts.housekeepingPending}</div></div>
        <div class="kpi"><div class="label">Leads abiertos</div><div class="value">${d.alerts.openLeads}</div></div>
      </div>`;
  }

  async function viewRooms() {
    const rooms = await get(`/reservations/map/rooms?${pid()}`);
    window._roomAction = async (roomId, status) => {
      try { await api(`/admin/rooms/${roomId}/status`, { method: 'PATCH', body: { status } }); toast('Estado actualizado'); render(); }
      catch (err) { toast(err.message, true); }
    };
    return `<div class="room-grid">${rooms.map(r => `
      <div class="room-tile ${r.status}">
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
          <td><button class="btn small secondary" onclick="_simLiq('${e.id}')">Simular liquidación</button></td>
        </tr>`).join('')}
      </table>${employees.length ? '' : '<p class="muted">Sin empleados registrados.</p>'}</div>`;
  }

  async function viewPayroll() {
    const [periods, employees, novelties, types] = await Promise.all([
      get(`/hr/payroll/periods?${pid()}`),
      get(`/hr/employees?${pid()}&status=active`),
      get(`/hr/novelties?${pid()}`),
      get('/hr/novelty-types'),
    ]);
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

  async function viewSettings() {
    const [users, params, props, gateways] = await Promise.all([
      get('/admin/users').catch(() => []),
      get('/admin/legal-parameters').catch(() => []),
      get('/admin/properties'),
      get('/payments/gateways').catch(() => []),
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
      </div>`;
  }

  // ---------- router ----------
  const VIEWS = {
    dashboard: ['Dashboard gerencial', viewDashboard],
    rooms: ['Mapa de habitaciones', viewRooms],
    reservations: ['Reservas', viewReservations],
    booking: ['Nueva reserva', viewBooking],
    inbox: ['Inbox omnicanal', viewInbox],
    crm: ['CRM — Leads', viewCrm],
    housekeeping: ['Housekeeping', viewHousekeeping],
    maintenance: ['Mantenimiento', viewMaintenance],
    payments: ['Pagos y links', viewPayments],
    invoices: ['Facturación electrónica (Dataico)', viewInvoices],
    employees: ['Empleados (Atria People)', viewEmployees],
    payroll: ['Nómina colombiana', viewPayroll],
    approvals: ['Aprobaciones humanas', viewApprovals],
    compliance: ['Cumplimiento (RNT · TRA · SIRE)', viewCompliance],
    audit: ['Auditoría y trazabilidad', viewAudit],
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
