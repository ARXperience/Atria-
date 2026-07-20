// Prueba de humo end-to-end: arranca el servidor y ejecuta los flujos
// críticos de la sección 48 del documento funcional.
import { spawn } from 'node:child_process';
import assert from 'node:assert';

const PORT = 4599;
const BASE = `http://localhost:${PORT}`;
let token = null;
let propertyId = null;
let passed = 0, failed = 0;

async function api(path, opts = {}) {
  const res = await fetch(BASE + path, {
    ...opts,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err) {
    failed++;
    console.error(`  ❌ ${name}: ${err.message}`);
  }
}

function futureDay(offset) {
  return new Date(Date.now() + offset * 86400000).toISOString().slice(0, 10);
}

// Los handlers de eventos de dominio (TRA/SIRE/housekeeping) corren async;
// esperar un instante antes de verificar sus efectos.
const settle = (ms = 400) => new Promise(r => setTimeout(r, ms));

async function waitForServer(proc) {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(BASE + '/api/health');
      if (res.ok) return;
    } catch {}
    await new Promise(r => setTimeout(r, 500));
  }
  throw new Error('El servidor no arrancó');
}

async function main() {
  console.log('🚀 Iniciando servidor de pruebas...');
  const proc = spawn('node', ['src/server.js'], {
    env: { ...process.env, PORT: String(PORT), WHATSAPP_ENABLED: 'false', PUBLIC_BASE_URL: BASE },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  try {
    await waitForServer(proc);
    console.log('✔ Servidor arriba\n');

    // ===== Autenticación y permisos =====
    await test('login gerente', async () => {
      const { status, data } = await api('/api/auth/login', { method: 'POST', body: { email: 'gerente@atria.co', password: 'atria2026' } });
      assert.equal(status, 200);
      token = data.token;
      propertyId = data.properties[0].id;
      assert.ok(propertyId);
    });

    await test('login con contraseña errada rechazado', async () => {
      const { status } = await api('/api/auth/login', { method: 'POST', body: { email: 'gerente@atria.co', password: 'mala' } });
      assert.equal(status, 401);
    });

    await test('endpoint protegido sin token → 401', async () => {
      const res = await fetch(`${BASE}/api/reservations?propertyId=${propertyId}`);
      assert.equal(res.status, 401);
    });

    // ===== Flujo 48.1: reserva → pago → confirmación =====
    const checkIn = futureDay(7), checkOut = futureDay(10);
    let reservation, paymentLink;

    await test('buscar disponibilidad', async () => {
      const { status, data } = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn, checkOut, adults: 2 } });
      assert.equal(status, 200);
      assert.ok(data.length >= 3, 'debe haber al menos 3 tipos disponibles');
    });

    await test('cotizar', async () => {
      const { data: avail } = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn, checkOut, adults: 2 } });
      const { status, data } = await api('/api/booking/quote', { method: 'POST', body: { propertyId, checkIn, checkOut, adults: 2, roomTypeId: avail[0].roomTypeId } });
      assert.equal(status, 200);
      assert.equal(data.nights, 3);
      assert.ok(data.taxes > 0 && data.total === data.subtotal + data.taxes);
    });

    await test('crear reserva tentativa con link de pago', async () => {
      const { data: avail } = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn, checkOut, adults: 2 } });
      const { status, data } = await api('/api/booking/reservations', {
        method: 'POST',
        body: {
          propertyId, checkIn, checkOut, adults: 2,
          roomTypeId: avail[0].roomTypeId,
          ratePlanId: avail[0].ratePlans[0]?.ratePlanId,
          guest: { fullName: 'Juan Pérez Test', phone: '573001112233', documentNumber: '123456789', nationality: 'CO' },
        },
      });
      assert.equal(status, 201);
      reservation = data.reservation;
      paymentLink = data.paymentLink;
      assert.equal(reservation.status, 'tentative');
      assert.ok(paymentLink?.token);
    });

    await test('pagar por webhook mock → reserva confirmada', async () => {
      const { status } = await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: paymentLink.token } });
      assert.equal(status, 200);
      const { data } = await api(`/api/reservations/${reservation.id}`);
      assert.equal(data.status, 'confirmed');
    });

    await test('webhook duplicado ignorado (idempotencia)', async () => {
      const { data } = await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: paymentLink.token } });
      assert.ok(data.result?.ignored || data.received);
      const { data: r } = await api(`/api/reservations/${reservation.id}`);
      assert.equal(r.payments.length, 1, 'no debe duplicar pagos');
    });

    await test('TRA creada automáticamente al confirmar', async () => {
      await settle();
      const { data } = await api(`/api/compliance/tra?propertyId=${propertyId}`);
      assert.ok(data.some(t => t.reservationId === reservation.id));
    });

    await test('portal público del huésped', async () => {
      const res = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}`);
      const data = await res.json();
      assert.equal(data.status, 'confirmed');
      assert.ok(data.paid > 0);
    });

    // ===== Flujo 48.2/48.3: check-in, folio, check-out =====
    await test('check-in asigna habitación y abre folio', async () => {
      const { status, data } = await api(`/api/reservations/${reservation.id}/checkin`, { method: 'POST', body: {} });
      assert.equal(status, 200);
      assert.equal(data.status, 'checked_in');
      const { data: full } = await api(`/api/reservations/${reservation.id}`);
      assert.ok(full.room?.number);
      assert.ok(full.folio?.charges?.length >= 1, 'folio debe tener el cargo de alojamiento');
    });

    await test('cargar consumo al folio', async () => {
      const { status } = await api(`/api/reservations/${reservation.id}/charges`, { method: 'POST', body: { concept: 'minibar', description: 'Agua + snack', amount: 25000 } });
      assert.equal(status, 201);
    });

    let approvalId;
    await test('check-out con saldo → requiere aprobación (202)', async () => {
      const { status, data } = await api(`/api/reservations/${reservation.id}/checkout`, { method: 'POST', body: {} });
      assert.equal(status, 202);
      approvalId = data.pendingApproval.id;
      assert.ok(approvalId);
    });

    await test('gerente aprueba → check-out ejecutado + tarea de limpieza', async () => {
      const { status } = await api(`/api/approvals/${approvalId}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(status, 200);
      await settle();
      const { data: r } = await api(`/api/reservations/${reservation.id}`);
      assert.equal(r.status, 'checked_out');
      const { data: tasks } = await api(`/api/ops/housekeeping/tasks?propertyId=${propertyId}`);
      assert.ok(tasks.some(t => t.type === 'checkout_clean'), 'debe crear tarea de limpieza automática');
    });

    // ===== Bot conversacional (mismo motor que WhatsApp, vía webchat) =====
    const sid = 'test-session-1';
    const chat = async text => {
      const { data } = await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text } });
      return (data.replies || []).join('\n');
    };

    await test('bot: saludo', async () => {
      const reply = await chat('Hola');
      assert.match(reply, /Atria/i);
    });

    await test('bot: fechas y personas → opciones de habitación', async () => {
      const ci = futureDay(20), co = futureDay(23);
      const reply = await chat(`Quiero reservar del ${ci} al ${co} para 2 adultos`);
      assert.match(reply, /disponibilidad/i);
      assert.match(reply, /1\./);
    });

    await test('bot: selección → cotización', async () => {
      const reply = await chat('1');
      assert.match(reply, /Total/i);
      assert.match(reply, /anticipo/i);
    });

    await test('bot: confirmación → pide nombre', async () => {
      const reply = await chat('sí, confirmo');
      assert.match(reply, /nombre/i);
    });

    let botLink;
    await test('bot: nombre → crea reserva + link de pago', async () => {
      const reply = await chat('María García López');
      assert.match(reply, /ATR-\d{4}/);
      const m = reply.match(/\/pay\/([\w-]+)/);
      assert.ok(m, 'debe incluir link de pago');
      botLink = m[1];
    });

    await test('bot: pago confirma la reserva creada por IA', async () => {
      await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: botLink } });
      await settle();
      const { data } = await api(`/api/reservations?propertyId=${propertyId}&status=confirmed`);
      assert.ok(data.some(r => r.guest.fullName === 'María García López' && r.createdBy === 'ai'));
    });

    await test('bot: creó lead en CRM', async () => {
      const { data } = await api(`/api/crm/leads?propertyId=${propertyId}`);
      assert.ok(data.length >= 1);
    });

    await test('bot: escalamiento a humano por queja', async () => {
      const reply = await chat('tengo una queja, quiero hablar con un humano');
      assert.match(reply, /persona|equipo/i);
      const { data } = await api(`/api/inbox/conversations?propertyId=${propertyId}`);
      const convo = data.find(c => c.channel === 'webchat');
      assert.equal(convo.aiEnabled, false, 'la IA debe quedar en pausa');
    });

    // ===== Huésped extranjero → SIRE =====
    await test('huésped extranjero genera checklist SIRE', async () => {
      const ci = futureDay(30), co = futureDay(32);
      const { data: avail } = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const { data } = await api('/api/booking/reservations', {
        method: 'POST',
        body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: avail[0].roomTypeId, guest: { fullName: 'John Smith', nationality: 'US', documentType: 'PASSPORT', documentNumber: 'X99887766' }, withPaymentLink: false },
      });
      await api(`/api/reservations/${data.reservation.id}/confirm`, { method: 'POST' });
      await settle();
      const { data: sire } = await api(`/api/compliance/sire?propertyId=${propertyId}`);
      assert.ok(sire.some(s => s.reservationId === data.reservation.id && s.nationality === 'US'));
    });

    // ===== Gobierno =====
    await test('dashboard gerencial responde KPIs', async () => {
      const { status, data } = await api(`/api/dashboard?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.kpis.monthRevenue > 0);
      assert.ok(typeof data.rooms.occupancyPct === 'number');
    });

    await test('auditoría registra acciones de humanos e IA', async () => {
      const { data } = await api(`/api/audit-logs?propertyId=${propertyId}&take=300`);
      assert.ok(data.some(l => l.actor === 'ai'), 'debe haber acciones de IA');
      assert.ok(data.some(l => l.actor === 'human'), 'debe haber acciones humanas');
      assert.ok(data.some(l => l.action === 'reservation.confirmed'));
    });

    await test('rol housekeeping no puede ver pagos (permisos backend)', async () => {
      const { data: login } = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      const res = await fetch(`${BASE}/api/payments?propertyId=${propertyId}`, { headers: { authorization: `Bearer ${login.token}` } });
      assert.equal(res.status, 403);
    });

    // ===== Multi-pasarela =====
    await test('estado de pasarelas: mock configurada, resto sin llaves', async () => {
      const { data } = await api('/api/payments/gateways');
      const names = data.map(g => g.name);
      for (const n of ['mock', 'wompi', 'mercadopago', 'bold', 'stripe']) assert.ok(names.includes(n), `falta ${n}`);
      assert.ok(data.find(g => g.name === 'mock').configured);
      assert.equal(data.find(g => g.name === 'stripe').configured, false);
    });

    await test('crear link con pasarela sin configurar → error claro', async () => {
      const { status, data } = await api('/api/payments/links', {
        method: 'POST',
        body: { propertyId, concept: 'Prueba stripe', amount: 100000, provider: 'stripe' },
      });
      assert.equal(status, 400);
      assert.match(data.error, /stripe/i);
    });

    await test('webhook de pasarela desconocida → 400', async () => {
      const { status } = await api('/api/public/webhooks/payments/noexiste', { method: 'POST', body: {} });
      assert.equal(status, 400);
    });

    // ===== Atria Fiscal (Dataico en modo borrador) =====
    let invoiceId;
    await test('check-out generó borrador de factura automático', async () => {
      const { data } = await api(`/api/invoices?propertyId=${propertyId}`);
      assert.equal(data.dataicoConfigured, false);
      const inv = data.invoices.find(i => i.reservation?.code === reservation.code);
      assert.ok(inv, 'debe existir borrador para la reserva con check-out');
      assert.equal(inv.status, 'draft');
      assert.ok(inv.total > 0);
      invoiceId = inv.id;
    });

    await test('emitir sin Dataico → numeración local en estado pending', async () => {
      const { status, data } = await api(`/api/invoices/${invoiceId}/issue`, { method: 'POST' });
      assert.equal(status, 200);
      assert.equal(data.status, 'pending');
      assert.match(data.fullNumber, /^ATR-\d+/);
    });

    // ===== Atria People: nómina (Fase 3) =====
    let employeeId, periodId;
    await test('crear empleado', async () => {
      const { status, data } = await api('/api/hr/employees', {
        method: 'POST',
        body: {
          propertyId, fullName: 'Pedro Nómina Test', documentNumber: '900100200',
          position: 'Auxiliar de cocina', area: 'restaurante', salary: 1623500,
          hireDate: '2026-01-01', riskClass: 2, eps: 'Sanitas', afp: 'Protección', arl: 'Positiva',
        },
      });
      assert.equal(status, 201);
      employeeId = data.id;
    });

    await test('registrar y aprobar novedad de horas extras', async () => {
      const { status, data } = await api('/api/hr/novelties', {
        method: 'POST',
        body: { propertyId, employeeId, type: 'overtime_day', date: futureDay(-5), hours: 10 },
      });
      assert.equal(status, 201);
      const dec = await api(`/api/hr/novelties/${data.id}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(dec.status, 200);
    });

    await test('abrir y calcular periodo de nómina', async () => {
      const now = new Date();
      const { status, data } = await api('/api/hr/payroll/periods', {
        method: 'POST', body: { propertyId, year: now.getUTCFullYear(), month: now.getUTCMonth() + 1 },
      });
      assert.equal(status, 201);
      periodId = data.id;
      const calc = await api(`/api/hr/payroll/periods/${periodId}/calculate`, { method: 'POST' });
      assert.equal(calc.status, 200);
      assert.ok(calc.data.employees >= 3, 'debe liquidar los empleados demo + el creado');
    });

    await test('liquidación correcta: salud/pensión 4% y auxilio de transporte', async () => {
      const { data: p } = await api(`/api/hr/payroll/periods/${periodId}`);
      const item = p.items.find(i => i.employee.fullName === 'Pedro Nómina Test');
      assert.ok(item, 'debe existir item de Pedro');
      const b = item.breakdown;
      const health = b.deductions.find(d => d.concept === 'Salud empleado');
      assert.ok(Math.abs(health.amount - Math.round(b.IBC * 0.04)) <= 1, 'salud = 4% del IBC');
      assert.ok(b.earned.some(e => e.concept === 'Auxilio de transporte'), 'salario mínimo recibe auxilio de transporte');
      assert.ok(b.earned.some(e => e.concept === 'Hora extra diurna'), 'debe incluir las horas extras aprobadas');
      assert.ok(item.net > 0 && item.net < item.earned);
      assert.ok(item.employerCost > 0, 'debe calcular costo patronal + provisiones');
    });

    await test('cerrar nómina exige aprobación del DUEÑO (gerente no basta)', async () => {
      const { status, data } = await api(`/api/hr/payroll/periods/${periodId}/close`, { method: 'POST' });
      assert.equal(status, 202);
      const approvalId2 = data.pendingApproval.id;
      // El gerente intenta aprobar → rechazado por rango
      const asManager = await api(`/api/approvals/${approvalId2}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(asManager.status, 400);
      // El dueño aprueba → periodo cerrado
      const { data: ownerLogin } = await api('/api/auth/login', { method: 'POST', body: { email: 'owner@atria.co', password: 'atria2026' } });
      const res = await fetch(`${BASE}/api/approvals/${approvalId2}/decide`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ownerLogin.token}` },
        body: JSON.stringify({ approve: true }),
      });
      assert.equal(res.status, 200);
      const { data: period } = await api(`/api/hr/payroll/periods/${periodId}`);
      assert.equal(period.status, 'closed');
    });

    await test('simulador de liquidación de contrato', async () => {
      const { status, data } = await api('/api/hr/liquidations/simulate', {
        method: 'POST', body: { employeeId, cause: 'sin_justa_causa' },
      });
      assert.equal(status, 200);
      assert.ok(data.total > 0);
      assert.ok(data.items.some(i => /Cesantías/.test(i.concept)));
      assert.ok(data.items.some(i => /Indemnización/.test(i.concept)), 'despido sin justa causa incluye indemnización');
    });

    await test('cambio de salario requiere aprobación del dueño', async () => {
      const { status, data } = await api(`/api/hr/employees/${employeeId}`, { method: 'PATCH', body: { salary: 2000000 } });
      assert.equal(status, 202);
      assert.ok(data.pendingApproval.requiredRole === 'OWNER');
    });

    // ===== Ola 1: Centro documental, plantillas, políticas y reglas =====
    let docId, legalDocId;
    const tinyPdf = Buffer.from('%PDF-1.4 test atria').toString('base64');

    await test('cargar documento con vencimiento', async () => {
      const { status, data } = await api('/api/documents', {
        method: 'POST',
        body: {
          propertyId, docType: 'certificate', title: 'Certificado manipulación alimentos',
          fileName: 'cert.pdf', mimeType: 'application/pdf', base64: `data:application/pdf;base64,${tinyPdf}`,
          expiryDate: futureDay(20),
        },
      });
      assert.equal(status, 201);
      docId = data.id;
      assert.equal(data.version, 1);
    });

    await test('descargar documento devuelve el archivo', async () => {
      const res = await fetch(`${BASE}/api/documents/${docId}/download`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      const buf = Buffer.from(await res.arrayBuffer());
      assert.ok(buf.toString().includes('PDF'), 'debe devolver el contenido del PDF');
    });

    await test('versionar documento supersede la versión anterior', async () => {
      const { status, data } = await api('/api/documents', {
        method: 'POST',
        body: {
          propertyId, docType: 'certificate', title: 'Certificado manipulación alimentos (v2)',
          fileName: 'cert2.pdf', mimeType: 'application/pdf', base64: tinyPdf, supersedesId: docId,
          expiryDate: futureDay(25),
        },
      });
      assert.equal(status, 201);
      assert.equal(data.version, 2);
      const list = await api('/api/documents');
      assert.ok(!list.data.some(d => d.id === docId), 'la versión anterior queda superseded (fuera del listado activo)');
    });

    await test('documento por vencer aparece en filtro expiring', async () => {
      const { data } = await api('/api/documents?expiring=true');
      assert.ok(data.some(d => d.title.includes('manipulación')), 'debe listar el certificado próximo a vencer');
    });

    await test('cargar documento legal y borrarlo requiere aprobación', async () => {
      const up = await api('/api/documents', {
        method: 'POST',
        body: { propertyId, docType: 'RUT', title: 'RUT empresa', fileName: 'rut.pdf', mimeType: 'application/pdf', base64: tinyPdf },
      });
      legalDocId = up.data.id;
      const del = await api(`/api/documents/${legalDocId}`, { method: 'DELETE' });
      assert.equal(del.status, 202, 'borrar un documento legal debe pedir aprobación');
      assert.equal(del.data.pendingApproval.requiredRole, 'OWNER');
    });

    await test('crear plantilla de mensaje', async () => {
      const { status } = await api('/api/documents/templates', {
        method: 'POST',
        body: { propertyId, channel: 'whatsapp', name: 'voucher_confirmacion', body: 'Hola {{nombre}}, tu reserva {{codigo}} está confirmada.' },
      });
      assert.equal(status, 201);
      const list = await api(`/api/documents/templates/list?propertyId=${propertyId}`);
      assert.ok(list.data.some(t => t.name === 'voucher_confirmacion'));
    });

    await test('crear política hotelera', async () => {
      const { status } = await api('/api/documents/policies', {
        method: 'POST',
        body: { propertyId, type: 'cancellation', title: 'Cancelación flexible', penalty: '1 noche', publicText: 'Cancela gratis hasta 48h antes.' },
      });
      assert.equal(status, 201);
    });

    await test('motor de reglas de cumplimiento se ejecuta y detecta pendientes', async () => {
      const { status, data } = await api('/api/documents/rules/run', { method: 'POST' });
      assert.equal(status, 200);
      assert.ok(typeof data.findings === 'number', 'debe devolver número de hallazgos');
      const rules = await api('/api/documents/rules/list');
      assert.ok(rules.data.some(r => r.key === 'rnt_expiry'), 'deben existir las reglas por defecto');
    });

    // ===== IA-1: contenido de habitaciones y base de conocimiento =====
    let rtId;
    const tinyPng = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

    await test('listar contenido de habitaciones', async () => {
      const { status, data } = await api(`/api/content/rooms?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.length >= 3);
      rtId = data[0].id;
      assert.ok(Array.isArray(data[0].images));
    });

    await test('editar contenido rico de una habitación', async () => {
      const { status } = await api(`/api/content/rooms/${rtId}`, {
        method: 'PATCH',
        body: { longDescription: 'Habitación amplia con vista a la ciudad y cama king.', bedConfig: '1 cama king', sizeM2: 28, view: 'ciudad', features: 'wifi,aire,minibar' },
      });
      assert.equal(status, 200);
      const { data } = await api(`/api/content/rooms?propertyId=${propertyId}`);
      const rt = data.find(r => r.id === rtId);
      assert.equal(rt.bedConfig, '1 cama king');
      assert.equal(rt.sizeM2, 28);
    });

    await test('subir imagen de habitación y servirla públicamente', async () => {
      const up = await api('/api/documents', {
        method: 'POST',
        body: { propertyId, entityType: 'RoomType', entityId: rtId, docType: 'image', title: 'Foto', fileName: 'room.png', mimeType: 'image/png', base64: tinyPng },
      });
      assert.equal(up.status, 201);
      const { data } = await api(`/api/content/rooms?propertyId=${propertyId}`);
      const rt = data.find(r => r.id === rtId);
      assert.ok(rt.images.length >= 1, 'la habitación debe tener la imagen');
      // Endpoint público sin autenticación
      const res = await fetch(`${BASE}${rt.images[0].url}`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /image/);
    });

    await test('media pública solo sirve imágenes (no otros documentos)', async () => {
      // legalDocId es un RUT (docType != image) subido antes
      const res = await fetch(`${BASE}/api/public/media/${legalDocId}`);
      assert.equal(res.status, 404, 'un documento que no es imagen no debe servirse como media pública');
    });

    await test('crear conocimiento y verlo en el snapshot del agente', async () => {
      await api('/api/content/knowledge', {
        method: 'POST',
        body: { propertyId, category: 'service', title: 'Parqueadero', content: 'Parqueadero cubierto gratis para huéspedes.', visibility: 'public', tags: 'carro,parqueo' },
      });
      await api('/api/content/knowledge', {
        method: 'POST',
        body: { propertyId, category: 'general', title: 'Nota interna', content: 'Solo staff.', visibility: 'internal' },
      });
      const pub = await api(`/api/content/knowledge-snapshot?propertyId=${propertyId}&visibility=public`);
      const titles = pub.data.knowledge.map(k => k.title);
      assert.ok(titles.includes('Parqueadero'), 'el snapshot público incluye el ítem público');
      assert.ok(!titles.includes('Nota interna'), 'el snapshot público NO incluye ítems internos');
      assert.ok(pub.data.rooms.length >= 3 && pub.data.hotel.name, 'el snapshot trae habitaciones y datos del hotel');
    });

    await test('contenido público de habitaciones sin autenticación (para la web)', async () => {
      const res = await fetch(`${BASE}/api/public/hotel/${propertyId}/rooms`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.ok(data.rooms.length >= 3 && data.hotel.name);
    });

    // ===== IA-2 / IA-3: persona del agente, conocimiento y guardrails =====
    await test('agente existe con persona por defecto y es configurable', async () => {
      const { status, data } = await api(`/api/content/agents?propertyId=${propertyId}`);
      assert.equal(status, 200);
      const guest = data.find(a => a.scope === 'guest');
      assert.ok(guest, 'debe existir el agente de huéspedes');
      const upd = await api(`/api/content/agents/${guest.id}`, {
        method: 'PATCH',
        body: { displayName: 'Lucía', greeting: '¡Hola! Soy Lucía, tu anfitriona en Atria. ¿En qué te ayudo?', tone: 'juvenil y cercano' },
      });
      assert.equal(upd.status, 200);
      assert.equal(upd.data.displayName, 'Lucía');
    });

    await test('el agente saluda con la persona configurada del hotel', async () => {
      const sid = 'persona-test';
      const { data } = await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: 'Hola' } });
      assert.match(data.replies.join(' '), /Luc[ií]a/, 'el saludo debe usar el nombre configurado');
    });

    await test('el agente responde con el conocimiento del hotel (FAQ)', async () => {
      const sid = 'know-test';
      const { data } = await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: '¿Tienen parqueadero?' } });
      assert.match(data.replies.join(' '), /parqueadero|cubierto|gratis/i, 'debe responder con el ítem de conocimiento "Parqueadero"');
    });

    await test('el agente responde datos de una habitación desde el contenido', async () => {
      const sid = 'room-test';
      const { data } = await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: '¿Qué incluye la habitación Estándar?' } });
      assert.match(data.replies.join(' '), /king|wifi|ciudad|noche/i, 'debe describir la habitación con su contenido');
    });

    await test('previsualización del agente sin efectos secundarios', async () => {
      const { status, data } = await api('/api/content/agents/preview', { method: 'POST', body: { propertyId, question: '¿Tienen parqueadero?' } });
      assert.equal(status, 200);
      assert.ok(data.tools.includes('crear_reserva') && data.tools.includes('datos_hotel'));
      assert.ok(data.roomsKnown >= 3);
      assert.match(data.answer, /parqueadero|cubierto/i);
      assert.match(data.systemPromptPreview, /Luc[ií]a/, 'el system prompt refleja la persona');
    });

    await test('el flujo de reserva por chat sigue funcionando tras los cambios de IA', async () => {
      const sid = 'flow-after-ai';
      const ci = futureDay(40), co = futureDay(43);
      await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: `Quiero reservar del ${ci} al ${co} para 2 adultos` } });
      const sel = await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: '1' } });
      assert.match(sel.data.replies.join(' '), /[Tt]otal|anticipo/, 'debe cotizar tras elegir opción');
    });

    // ===== IA-4: copiloto interno con acceso restringido por rol =====
    await test('copiloto: estado de habitaciones (gerente)', async () => {
      const { status, data } = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: '¿Cómo están las habitaciones?' } });
      assert.equal(status, 200);
      assert.match(data.reply, /habitaciones|limpias|ocupadas/i);
    });

    await test('copiloto: llegadas y salidas de hoy', async () => {
      const { data } = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: 'llegadas de hoy' } });
      assert.match(data.reply, /Llegadas|Salidas/i);
    });

    await test('copiloto: busca una reserva por código', async () => {
      const { data } = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: `dame la reserva ${reservation.code}` } });
      assert.match(data.reply, new RegExp(reservation.code));
    });

    await test('copiloto: housekeeping ve limpiezas pero NO caja', async () => {
      const { data: hk } = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      const askAs = async (text) => {
        const res = await fetch(`${BASE}/api/assistant/internal`, {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${hk.token}` },
          body: JSON.stringify({ propertyId, text }),
        });
        return (await res.json()).reply;
      };
      const cleaning = await askAs('¿qué limpiezas hay pendientes?');
      assert.match(cleaning, /limpieza|pendiente/i);
      // Pregunta por caja: housekeeping NO tiene payments.view → no revela caja, cae a ayuda
      const cash = await askAs('¿cuánto hay en caja hoy?');
      assert.doesNotMatch(cash, /total de \$|caja del día se han registrado/i);
      assert.match(cash, /copiloto|ayudarte|habitaciones/i);
    });

    // ===== IA-5: memoria por huésped y conversación, escalamiento con resumen =====
    await test('huésped recurrente recibe saludo personalizado', async () => {
      // 'Juan Pérez Test' (tel 573001112233) ya tiene una reserva confirmada antes.
      const sid = 'returning-guest';
      const { data } = await api(`/api/public/webchat/${propertyId}/messages`, {
        method: 'POST', body: { sessionId: sid, text: 'Hola', phone: '573001112233' },
      });
      assert.match(data.replies.join(' '), /de nuevo|otra vez/i, 'debe reconocer al huésped recurrente');
    });

    await test('memoria del huésped se guarda al reservar por chat', async () => {
      const g = await api(`/api/crm/guests?propertyId=${propertyId}&q=María`);
      const maria = g.data.find(x => x.fullName.includes('María'));
      assert.ok(maria, 'María (creada por el bot) debe existir');
      const mem = await api(`/api/crm/guests/${maria.id}/memory`);
      assert.equal(mem.status, 200);
      assert.ok(mem.data.stays >= 1, 'debe registrar al menos una estadía/reserva');
      assert.ok(mem.data.memory.lastTravel, 'la memoria debe recordar su última intención de viaje');
    });

    await test('escalamiento genera resumen para la persona que recibe', async () => {
      const sid = 'summary-test';
      const ci = futureDay(50), co = futureDay(52);
      await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: `Quiero reservar del ${ci} al ${co} para 2 adultos` } });
      await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: '1' } });
      await api(`/api/public/webchat/${propertyId}/messages`, { method: 'POST', body: { sessionId: sid, text: 'quiero un reembolso, esto es un desastre' } });
      await settle();
      const convos = await api(`/api/inbox/conversations?propertyId=${propertyId}`);
      const convo = convos.data.find(c => c.channel === 'webchat' && !c.aiEnabled && c.lastMessage);
      // Buscar la conversación de summary-test por sus mensajes
      const list = await api(`/api/inbox/conversations?propertyId=${propertyId}`);
      let target = null;
      for (const c of list.data) {
        const det = await api(`/api/inbox/conversations/${c.id}/messages`);
        if (det.data.messages.some(m => m.body.includes('reembolso')) && det.data.conversation.summary) { target = det.data.conversation; break; }
      }
      assert.ok(target, 'debe existir una conversación escalada con resumen');
      assert.match(target.summary, /escalamiento|Fechas de interés|opciones|cotiz/i, 'el resumen debe traer contexto útil');
      assert.equal(target.aiEnabled, false, 'la IA queda en pausa tras escalar');
    });

    // ===== Ola 2: Contratos laborales (§20) =====
    let contractId, hrToken;
    await test('login RR.HH.', async () => {
      const { status, data } = await api('/api/auth/login', { method: 'POST', body: { email: 'rrhh@atria.co', password: 'atria2026' } });
      assert.equal(status, 200);
      hrToken = data.token;
    });
    const hr = (path, opts = {}) => fetch(`${BASE}${path}`, { ...opts, headers: { 'content-type': 'application/json', authorization: `Bearer ${hrToken}`, ...(opts.headers || {}) }, body: opts.body ? JSON.stringify(opts.body) : undefined }).then(async r => ({ status: r.status, data: await r.json().catch(() => ({})) }));

    await test('generar borrador de contrato', async () => {
      const { status, data } = await hr('/api/hr/contracts', { method: 'POST', body: { employeeId, type: 'fijo', workday: 'Tiempo completo', endDate: futureDay(365), functions: 'Atención en cocina' } });
      assert.equal(status, 201);
      contractId = data.id;
      assert.equal(data.status, 'draft');
    });

    await test('texto del contrato incluye empleado y salario', async () => {
      const { data } = await hr(`/api/hr/contracts/${contractId}/text`);
      assert.match(data.text, /CONTRATO INDIVIDUAL DE TRABAJO/);
      assert.match(data.text, /Pedro N[oó]mina Test/);
    });

    await test('activar contrato → aprobación de RR.HH. → empleado sincronizado', async () => {
      const act = await hr(`/api/hr/contracts/${contractId}/activate`, { method: 'POST' });
      assert.equal(act.status, 202);
      const approvalId = act.data.pendingApproval.id;
      // Recepción NO puede aprobar (rango insuficiente)
      const { data: fd } = await api('/api/auth/login', { method: 'POST', body: { email: 'recepcion@atria.co', password: 'atria2026' } });
      const deny = await fetch(`${BASE}/api/approvals/${approvalId}/decide`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${fd.token}` }, body: JSON.stringify({ approve: true }) });
      assert.ok(deny.status === 403 || deny.status === 400, 'recepción no debe poder aprobar contratos');
      // RR.HH. aprueba
      const ok = await hr(`/api/approvals/${approvalId}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(ok.status, 200);
      const { data: c } = await hr(`/api/hr/contracts/${contractId}/text`);
      assert.equal(c.contract.status, 'active');
      // El empleado quedó con el tipo de contrato del contrato activado
      const { data: emps } = await hr(`/api/hr/employees?propertyId=${propertyId}`);
      const pedro = emps.find(e => e.id === employeeId);
      assert.equal(pedro.contractType, 'fijo');
    });

    await test('otrosí de salario → aprobación → aplica al contrato y empleado', async () => {
      const am = await hr(`/api/hr/contracts/${contractId}/amendments`, { method: 'POST', body: { changeType: 'salary', newValue: 2100000, detail: 'Aumento salarial' } });
      assert.equal(am.status, 202);
      const ok = await hr(`/api/approvals/${am.data.pendingApproval.id}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(ok.status, 200);
      const { data: emps } = await hr(`/api/hr/employees?propertyId=${propertyId}`);
      assert.equal(emps.find(e => e.id === employeeId).salary, 2100000);
    });

    // ===== Ola 2: Turnos y asistencia (§21) =====
    await test('planear turno (cuadrante)', async () => {
      const { status } = await hr('/api/hr/shifts', { method: 'POST', body: { propertyId, employeeId, date: futureDay(1), startTime: '14:00', endTime: '22:00', area: 'recepción' } });
      assert.equal(status, 201);
      const list = await hr(`/api/hr/shifts?propertyId=${propertyId}&from=${futureDay(0)}`);
      assert.ok(list.data.length >= 1);
    });

    await test('marcación: entrada + salida nocturna genera recargo y hora extra', async () => {
      // Turno de 21:00 a 06:00 (9h): todo nocturno + 1h extra sobre jornada estándar de 8h
      const day0 = futureDay(2);
      const cin = await hr('/api/hr/attendance/clock', { method: 'POST', body: { propertyId, employeeId, type: 'in', at: `${day0}T21:00:00Z` } });
      assert.equal(cin.status, 201);
      const cout = await hr('/api/hr/attendance/clock', { method: 'POST', body: { propertyId, employeeId, type: 'out', at: `${futureDay(3)}T06:00:00Z` } });
      assert.equal(cout.status, 201);
      assert.equal(cout.data.attendance.hoursWorked, 9);
      assert.equal(cout.data.attendance.nightHours, 9, 'las 9 horas son nocturnas');
      assert.equal(cout.data.attendance.overtimeHours, 1, '1 hora extra sobre la jornada de 8h');
      assert.equal(cout.data.noveltiesCreated, 2, 'debe crear novedad de recargo nocturno y de hora extra');
    });

    await test('las novedades automáticas llegan a nómina (pendientes de aprobación)', async () => {
      const { data } = await hr(`/api/hr/novelties?propertyId=${propertyId}&status=pending`);
      const mine = data.filter(n => n.employeeId === employeeId);
      assert.ok(mine.some(n => n.type === 'night_surcharge'), 'debe existir la novedad de recargo nocturno');
      assert.ok(mine.some(n => n.type === 'overtime_day'), 'debe existir la novedad de hora extra');
    });

    await test('no permite doble entrada sin salida', async () => {
      const day0 = futureDay(4);
      await hr('/api/hr/attendance/clock', { method: 'POST', body: { propertyId, employeeId, type: 'in', at: `${day0}T08:00:00Z` } });
      const dup = await hr('/api/hr/attendance/clock', { method: 'POST', body: { propertyId, employeeId, type: 'in', at: `${day0}T09:00:00Z` } });
      assert.equal(dup.status, 400, 'no debe permitir una segunda entrada abierta');
    });

    // ===== Ola 2: PILA / seguridad social (§23) =====
    let pilaId;
    await test('preparar planilla PILA desde el periodo liquidado', async () => {
      const { status, data } = await hr('/api/hr/pila/prepare', { method: 'POST', body: { periodId } });
      assert.equal(status, 201);
      pilaId = data.id;
      assert.ok(data.employeeCount >= 3);
      assert.ok(data.totalIBC > 0 && data.totalContributions > 0, 'debe traer IBC y aportes totales');
      assert.ok(data.rows[0].salud > 0 && data.rows[0].pension > 0, 'cada empleado trae salud y pensión');
    });

    await test('exportar PILA a CSV', async () => {
      const res = await fetch(`${BASE}/api/hr/pila/${pilaId}/export`, { headers: { authorization: `Bearer ${hrToken}` } });
      assert.equal(res.status, 200);
      const csv = await res.text();
      assert.match(csv, /Documento,Empleado/);
      assert.match(csv, /Pedro N[oó]mina Test/);
    });

    await test('registrar pago de PILA', async () => {
      const { status, data } = await hr(`/api/hr/pila/${pilaId}/payment`, { method: 'PATCH', body: { support: 'REF-PILA-123' } });
      assert.equal(status, 200);
      assert.equal(data.status, 'paid');
    });

    // ===== Ola 2: Nómina electrónica DIAN (§22) =====
    await test('generar documento soporte de nómina electrónica (periodo cerrado)', async () => {
      const { status, data } = await hr('/api/hr/electronic-payroll/generate', { method: 'POST', body: { periodId } });
      assert.equal(status, 201);
      assert.ok(data.generated >= 3, 'un documento por empleado liquidado');
      const list = await hr(`/api/hr/electronic-payroll?propertyId=${propertyId}&periodId=${periodId}`);
      assert.equal(list.data.providerConfigured, false);
      const doc = list.data.documents.find(d => d.employeeName.includes('Pedro'));
      assert.ok(doc && doc.net > 0 && doc.status === 'generated', 'documento con neto y estado generado');
    });

    await test('transmitir sin proveedor → numeración local en estado pending', async () => {
      const { status, data } = await hr('/api/hr/electronic-payroll/transmit', { method: 'POST', body: { periodId } });
      assert.equal(status, 200);
      assert.ok(data.transmitted >= 3);
      const list = await hr(`/api/hr/electronic-payroll?propertyId=${propertyId}&periodId=${periodId}`);
      const doc = list.data.documents[0];
      assert.equal(doc.status, 'pending');
      assert.match(doc.fullNumber, /^NIE-\d+/);
    });

    await test('no permite generar nómina electrónica de un periodo no cerrado', async () => {
      const now = new Date();
      const pr = await hr('/api/hr/payroll/periods', { method: 'POST', body: { propertyId, year: now.getUTCFullYear(), month: (now.getUTCMonth() === 0 ? 12 : now.getUTCMonth()) } });
      const gen = await hr('/api/hr/electronic-payroll/generate', { method: 'POST', body: { periodId: pr.data.id } });
      assert.equal(gen.status, 400, 'debe exigir el cierre de la nómina primero');
    });

    // ===== Ola 2: SG-SST (§25) =====
    await test('matriz de riesgos: crear ítem', async () => {
      const { status } = await hr('/api/sgsst/risks', { method: 'POST', body: { propertyId, area: 'Cocina', hazard: 'Superficies calientes', risk: 'Quemaduras', control: 'Guantes térmicos' } });
      assert.equal(status, 201);
    });

    let incId;
    await test('incidente: registrar y cerrar con plan de mejora', async () => {
      const inc = await hr('/api/sgsst/incidents', { method: 'POST', body: { propertyId, date: futureDay(0), type: 'accidente', severity: 'leve', description: 'Corte menor en cocina', employeeName: 'Laura Rodríguez' } });
      assert.equal(inc.status, 201);
      incId = inc.data.id;
      const noPlan = await hr(`/api/sgsst/incidents/${incId}/close`, { method: 'POST', body: {} });
      assert.equal(noPlan.status, 400, 'cerrar exige plan de mejora');
      const closed = await hr(`/api/sgsst/incidents/${incId}/close`, { method: 'POST', body: { actions: 'Capacitación en manejo de cuchillos' } });
      assert.equal(closed.status, 200);
      assert.equal(closed.data.status, 'closed');
    });

    await test('examen médico por vencer dispara alerta del motor de reglas', async () => {
      await hr('/api/sgsst/exams', { method: 'POST', body: { propertyId, employeeId, type: 'periodico', date: futureDay(-300), validUntil: futureDay(15) } });
      const ov = await hr(`/api/sgsst/overview?propertyId=${propertyId}`);
      assert.ok(ov.data.examsExpiring >= 1, 'el panel SG-SST cuenta el examen por vencer');
      // El motor de reglas (§39) debe detectarlo (lo corre el gerente)
      const run = await api('/api/documents/rules/run', { method: 'POST' });
      assert.ok((run.data.detail || []).some(f => f.rule === 'exam_expiry'), 'la regla exam_expiry genera hallazgo');
    });

    await test('EPP y capacitación se registran', async () => {
      assert.equal((await hr('/api/sgsst/ppe', { method: 'POST', body: { propertyId, employeeId, item: 'Guantes térmicos', quantity: 2, date: futureDay(0) } })).status, 201);
      assert.equal((await hr('/api/sgsst/trainings', { method: 'POST', body: { propertyId, title: 'Inducción SG-SST', date: futureDay(0), validUntil: futureDay(365) } })).status, 201);
    });

    await test('auditor puede ver SG-SST pero NO crear', async () => {
      const { data: aud } = await api('/api/auth/login', { method: 'POST', body: { email: 'auditor@atria.co', password: 'atria2026' } });
      const view = await fetch(`${BASE}/api/sgsst/overview?propertyId=${propertyId}`, { headers: { authorization: `Bearer ${aud.token}` } });
      assert.equal(view.status, 200);
      const create = await fetch(`${BASE}/api/sgsst/risks`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${aud.token}` }, body: JSON.stringify({ propertyId, area: 'x', hazard: 'y', risk: 'z' }) });
      assert.equal(create.status, 403, 'auditor no puede crear en SG-SST');
    });

    // ===== Ola 3: Inventario, proveedores y compras (§29) =====
    let supplierId, productId2;
    await test('crear proveedor y producto', async () => {
      const s = await api('/api/inventory/suppliers', { method: 'POST', body: { propertyId, name: 'Distribuidora Andina', nit: '900555111', category: 'alimentos' } });
      assert.equal(s.status, 201); supplierId = s.data.id;
      const p = await api('/api/inventory/products', { method: 'POST', body: { propertyId, sku: 'CAFE-1KG', name: 'Café 1kg', category: 'alimentos', unit: 'kg', cost: 25000, stock: 10, stockMin: 5 } });
      assert.equal(p.status, 201); productId2 = p.data.id;
    });

    await test('SKU duplicado se rechaza', async () => {
      const dup = await api('/api/inventory/products', { method: 'POST', body: { propertyId, sku: 'CAFE-1KG', name: 'Otro' } });
      assert.equal(dup.status, 400);
    });

    await test('salida de inventario descuenta stock y alerta stock bajo', async () => {
      const mv = await api('/api/inventory/movements', { method: 'POST', body: { propertyId, productId: productId2, type: 'out', quantity: 6, reason: 'consumo cocina' } });
      assert.equal(mv.status, 201);
      assert.equal(mv.data.stock, 4, '10 - 6 = 4');
      const ov = await api(`/api/inventory/overview?propertyId=${propertyId}`);
      assert.ok(ov.data.lowStock >= 1, '4 <= mínimo 5 → stock bajo');
    });

    await test('no permite sacar más stock del disponible', async () => {
      const mv = await api('/api/inventory/movements', { method: 'POST', body: { propertyId, productId: productId2, type: 'out', quantity: 999 } });
      assert.equal(mv.status, 400);
    });

    await test('orden de compra → aprobación de gerente → recepción suma stock', async () => {
      const po = await api('/api/inventory/purchase-orders', { method: 'POST', body: { propertyId, supplierId, items: [{ productId: productId2, qty: 20, unitCost: 24000 }] } });
      assert.equal(po.status, 201);
      assert.equal(po.data.total, 480000);
      const ap = await api(`/api/inventory/purchase-orders/${po.data.id}/approve`, { method: 'POST' });
      assert.equal(ap.status, 202);
      // No se puede recibir sin aprobar
      const early = await api(`/api/inventory/purchase-orders/${po.data.id}/receive`, { method: 'POST' });
      assert.equal(early.status, 400);
      // Gerente aprueba y se recibe
      await api(`/api/approvals/${ap.data.pendingApproval.id}/decide`, { method: 'POST', body: { approve: true } });
      const rec = await api(`/api/inventory/purchase-orders/${po.data.id}/receive`, { method: 'POST' });
      assert.equal(rec.status, 200);
      const prods = await api(`/api/inventory/products?propertyId=${propertyId}`);
      assert.equal(prods.data.find(p => p.id === productId2).stock, 24, '4 + 20 recibidos = 24');
    });

    await test('regla low_stock detecta productos bajo mínimo', async () => {
      // Bajar el café por debajo del mínimo de nuevo
      await api('/api/inventory/movements', { method: 'POST', body: { propertyId, productId: productId2, type: 'out', quantity: 20 } });
      const run = await api('/api/documents/rules/run', { method: 'POST' });
      assert.ok((run.data.detail || []).some(f => f.rule === 'low_stock'), 'la regla low_stock genera hallazgo');
    });

    // ===== Ola 3: POS de restaurante (§32) =====
    let menuItemId, posProductId;
    await test('crear ítem de menú con receta (insumo)', async () => {
      const p = await api('/api/inventory/products', { method: 'POST', body: { propertyId, sku: 'GRANO-CAFE', name: 'Grano de café', unit: 'g', cost: 30, stock: 1000, stockMin: 100 } });
      posProductId = p.data.id;
      const mi = await api('/api/pos/menu', { method: 'POST', body: { propertyId, name: 'Café americano', category: 'bebida', price: 6000, recipe: [{ productId: posProductId, qty: 15 }] } });
      assert.equal(mi.status, 201);
      menuItemId = mi.data.id;
    });

    await test('comanda de mesa pagada descuenta el inventario por receta', async () => {
      const ord = await api('/api/pos/orders', { method: 'POST', body: { propertyId, type: 'table', tableLabel: 'Mesa 3', items: [{ menuItemId, qty: 2 }] } });
      assert.equal(ord.status, 201);
      assert.ok(ord.data.total > ord.data.subtotal, 'incluye impuesto');
      const charge = await api(`/api/pos/orders/${ord.data.id}/charge`, { method: 'POST', body: { method: 'efectivo' } });
      assert.equal(charge.status, 200);
      assert.equal(charge.data.status, 'paid');
      // 1000 - (15 * 2) = 970
      const prods = await api(`/api/inventory/products?propertyId=${propertyId}`);
      assert.equal(prods.data.find(p => p.id === posProductId).stock, 970, 'la receta descontó 30 g de café');
    });

    await test('room service se carga al folio de una habitación en casa', async () => {
      // Crear reserva, pagar, check-in
      const ci = futureDay(1), co = futureDay(2);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const resv = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: av.data[0].roomTypeId, guest: { fullName: 'Huésped POS' } } });
      await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: resv.data.paymentLink.token } });
      await settle();
      await api(`/api/reservations/${resv.data.reservation.id}/checkin`, { method: 'POST', body: {} });
      // Room service → cargar al folio
      const ord = await api('/api/pos/orders', { method: 'POST', body: { propertyId, type: 'room_service', reservationId: resv.data.reservation.id, items: [{ menuItemId, qty: 1 }] } });
      const charge = await api(`/api/pos/orders/${ord.data.id}/charge`, { method: 'POST' });
      assert.equal(charge.data.status, 'charged');
      const full = await api(`/api/reservations/${resv.data.reservation.id}`);
      assert.ok(full.data.folio.charges.some(c => c.concept === 'room_service'), 'el folio tiene el cargo de room service');
    });

    await test('no se puede cargar room service a una habitación sin check-in', async () => {
      const ord = await api('/api/pos/orders', { method: 'POST', body: { propertyId, type: 'room_service', reservationId: reservation.id, items: [{ menuItemId, qty: 1 }] } });
      const charge = await api(`/api/pos/orders/${ord.data.id}/charge`, { method: 'POST' });
      assert.equal(charge.status, 400, 'la reserva original ya hizo check-out');
    });

    // ===== Ola 4: Web pública con motor de reservas (§9) =====
    await test('configurar y publicar el sitio web', async () => {
      const { status } = await api('/api/content/site', { method: 'PUT', body: { propertyId, heroTitle: 'Bienvenido a Atria Bogotá', heroSubtitle: 'Reserva directa sin comisiones', promoText: '10% directo', published: true } });
      assert.equal(status, 200);
    });

    await test('sitio público expone hotel, habitaciones y FAQs (sin auth)', async () => {
      const res = await fetch(`${BASE}/api/public/hotel/${propertyId}/site`);
      assert.equal(res.status, 200);
      const data = await res.json();
      assert.equal(data.site.heroTitle, 'Bienvenido a Atria Bogotá');
      assert.ok(data.rooms.length >= 3);
      assert.ok(data.faqs.some(f => /parqueadero/i.test(f.title)), 'incluye las FAQs públicas');
    });

    await test('la página /sitio/:id se sirve', async () => {
      const res = await fetch(`${BASE}/sitio/${propertyId}`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /ATR<b>IA<\/b>|propertyId/);
    });

    let webBook;
    await test('disponibilidad y reserva directa pública → link de pago', async () => {
      const ci = futureDay(60), co = futureDay(62);
      const av = await fetch(`${BASE}/api/public/hotel/${propertyId}/availability`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkIn: ci, checkOut: co, adults: 2 }) });
      const opts = await av.json();
      assert.ok(opts.length >= 1 && opts[0].price > 0);
      const bk = await fetch(`${BASE}/api/public/hotel/${propertyId}/book`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ checkIn: ci, checkOut: co, adults: 2, roomTypeId: opts[0].roomTypeId, ratePlanId: opts[0].ratePlanId, guest: { fullName: 'Reserva Web Directa', phone: '573009998877' } }) });
      webBook = await bk.json();
      assert.equal(bk.status, 201);
      assert.match(webBook.code, /ATR-\d{4}/);
      assert.match(webBook.paymentUrl, /\/pay\/|checkout|http/);
    });

    await test('pago de la reserva web la confirma', async () => {
      const token = webBook.paymentUrl.split('/pay/')[1];
      await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: token } });
      await settle();
      const list = await api(`/api/reservations?propertyId=${propertyId}&status=confirmed`);
      assert.ok(list.data.some(r => r.code === webBook.code && r.channel === 'web'), 'la reserva web quedó confirmada');
    });

    // ===== Ola 4: Revenue management (§34) =====
    await test('forecast devuelve ocupación, ADR y RevPAR por día', async () => {
      const { status, data } = await api(`/api/revenue/forecast?propertyId=${propertyId}&days=10`);
      assert.equal(status, 200);
      assert.equal(data.length, 10);
      assert.ok(typeof data[0].occupancyPct === 'number' && data[0].sellable >= 1);
    });

    await test('recomendación de alza cuando la ocupación es alta', async () => {
      // Llenar una fecha futura dentro del horizonte de forecast (≤ 60 días)
      const ci = futureDay(25), co = futureDay(26);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 2 } });
      let made = 0;
      for (const opt of av.data) {
        for (let k = 0; k < opt.availableRooms && made < 9; k++) {
          const r = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 2, roomTypeId: opt.roomTypeId, guest: { fullName: `Ocup ${made}` }, withPaymentLink: false } });
          if (r.data.reservation) { await api(`/api/reservations/${r.data.reservation.id}/confirm`, { method: 'POST' }); made++; }
        }
      }
      const recs = await api(`/api/revenue/recommendations?propertyId=${propertyId}&days=30`);
      const high = recs.data.filter(r => r.date === ci && r.changePct > 0);
      assert.ok(high.length >= 1, 'con alta ocupación debe recomendar subir la tarifa');
    });

    await test('crear regla de precio y aplicar un cambio de tarifa', async () => {
      const rule = await api('/api/revenue/rules', { method: 'POST', body: { propertyId, name: 'Última hora', daysAheadLte: 3, adjustPct: -0.15 } });
      assert.equal(rule.status, 201);
      const types = await api(`/api/admin/room-types?propertyId=${propertyId}`);
      const plan = types.data[0].ratePlans[0];
      const before = plan.price;
      const ap = await api('/api/revenue/apply', { method: 'POST', body: { propertyId, ratePlanId: plan.id, newPrice: before + 50000 } });
      assert.equal(ap.status, 200);
      assert.equal(ap.data.price, before + 50000);
    });

    // ===== Ola 4: Channel manager (§35) =====
    let channelId, otaRoomTypeId;
    await test('agregar canal, mapear habitación y sincronizar', async () => {
      const ch = await api('/api/channels', { method: 'POST', body: { propertyId, code: 'booking' } });
      assert.equal(ch.status, 201); channelId = ch.data.id;
      await api(`/api/channels/${channelId}`, { method: 'PATCH', body: { enabled: true } });
      const types = await api(`/api/admin/room-types?propertyId=${propertyId}`);
      otaRoomTypeId = types.data[0].id;
      const map = await api('/api/channels/mappings', { method: 'POST', body: { propertyId, channelId, roomTypeId: otaRoomTypeId, externalCode: 'DBL-STD' } });
      assert.equal(map.status, 201);
      const sync = await api(`/api/channels/${channelId}/sync`, { method: 'POST' });
      assert.equal(sync.status, 200);
      assert.equal(sync.data.status, 'connected');
      const logs = await api(`/api/channels/logs?propertyId=${propertyId}`);
      assert.ok(logs.data.some(l => l.action === 'push_availability'));
    });

    await test('webhook de OTA crea una reserva confirmada de canal', async () => {
      const ci = futureDay(80), co = futureDay(82);
      const res = await fetch(`${BASE}/api/public/channels/booking/webhook?propertyId=${propertyId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalCode: 'DBL-STD', checkIn: ci, checkOut: co, adults: 2, guestName: 'John OTA', ref: 'BK-99887', total: 500000 }),
      });
      assert.equal(res.status, 201);
      const data = await res.json();
      assert.match(data.code, /ATR-\d{4}/);
      assert.equal(data.overbooking, false);
      const list = await api(`/api/reservations?propertyId=${propertyId}&status=confirmed`);
      const ota = list.data.find(r => r.code === data.code);
      assert.ok(ota && ota.channel === 'ota', 'la reserva quedó como canal OTA confirmada');
    });

    await test('webhook con código externo sin mapeo se rechaza', async () => {
      const res = await fetch(`${BASE}/api/public/channels/booking/webhook?propertyId=${propertyId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalCode: 'NO-EXISTE', checkIn: futureDay(80), checkOut: futureDay(82), guestName: 'X' }),
      });
      assert.equal(res.status, 400);
    });

    await test('detección de overbooking cuando no hay disponibilidad', async () => {
      // Saturar un tipo para una fecha, luego recibir una reserva OTA de ese tipo
      const ci = futureDay(35), co = futureDay(36);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 2 } });
      const opt = av.data.find(o => o.roomTypeId === otaRoomTypeId);
      for (let k = 0; k < opt.availableRooms; k++) {
        const r = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 2, roomTypeId: otaRoomTypeId, guest: { fullName: `Full ${k}` }, withPaymentLink: false } });
        if (r.data.reservation) await api(`/api/reservations/${r.data.reservation.id}/confirm`, { method: 'POST' });
      }
      const res = await fetch(`${BASE}/api/public/channels/booking/webhook?propertyId=${propertyId}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ externalCode: 'DBL-STD', checkIn: ci, checkOut: co, adults: 2, guestName: 'Overbook OTA', ref: 'BK-OVER' }),
      });
      const data = await res.json();
      assert.equal(res.status, 201);
      assert.equal(data.overbooking, true, 'debe marcar riesgo de overbooking');
    });

    // ===== Ola 6: Finanzas & cartera (§28) =====
    let payableId;
    await test('crear cuenta por pagar', async () => {
      const ap = await api('/api/finance/payables', { method: 'POST', body: { propertyId, supplierName: 'Lavandería Sur', concept: 'Servicio de lavandería julio', category: 'servicios', amount: 320000 } });
      assert.equal(ap.status, 201);
      payableId = ap.data.id;
      assert.equal(ap.data.status, 'open');
    });

    await test('cuenta por pagar sin monto se rechaza', async () => {
      const ap = await api('/api/finance/payables', { method: 'POST', body: { propertyId, supplierName: 'X', concept: 'Y', amount: 0 } });
      assert.equal(ap.status, 400);
    });

    await test('overview financiero refleja la CxP abierta', async () => {
      const { status, data } = await api(`/api/finance/overview?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.payableOpen >= 320000, 'la cuenta por pagar debe sumar a payableOpen');
      assert.ok(typeof data.monthIncome === 'number' && typeof data.monthExpenses === 'number');
      assert.equal(data.monthNet, Number((data.monthIncome - data.monthExpenses).toFixed(2)));
    });

    await test('pagar proveedor cambia estado y baja la CxP abierta', async () => {
      const pay = await api(`/api/finance/payables/${payableId}/pay`, { method: 'POST', body: { support: 'TRX-LAV-01' } });
      assert.equal(pay.status, 200);
      assert.equal(pay.data.status, 'paid');
      const { data } = await api(`/api/finance/overview?propertyId=${propertyId}`);
      assert.ok(data.breakdown.cxpPagadas >= 320000, 'la CxP pagada debe registrarse como egreso');
    });

    await test('cartera por cobrar lista reservas con saldo', async () => {
      const { status, data } = await api(`/api/finance/receivables?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.rows));
      assert.ok(typeof data.total === 'number');
      if (data.rows.length) { assert.ok(data.rows[0].id && data.rows[0].code); assert.ok(data.rows[0].balance > 0); }
    });

    await test('estado de resultados agrega ingresos y egresos por categoría', async () => {
      const { status, data } = await api(`/api/finance/report?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(typeof data.income === 'number');
      assert.ok(data.expenses && typeof data.expenses === 'object');
      assert.ok('servicios' in data.expenses, 'la CxP pagada de servicios debe aparecer en el P&G');
      assert.equal(data.result, Number((data.income - data.totalExpenses).toFixed(2)));
    });

    await test('rol housekeeping no puede ver finanzas (permisos backend)', async () => {
      const { data: login } = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      const res = await fetch(`${BASE}/api/finance/overview?propertyId=${propertyId}`, { headers: { authorization: `Bearer ${login.token}` } });
      assert.equal(res.status, 403);
    });

    // ===== Ola 6: Protección de datos / Habeas Data (§26) =====
    let consentId;
    await test('registrar consentimiento de tratamiento', async () => {
      const c = await api('/api/dataprotection/consents', { method: 'POST', body: { propertyId, subjectName: 'María Gómez', documentNumber: '52123456', purpose: 'marketing', channel: 'recepcion' } });
      assert.equal(c.status, 201);
      consentId = c.data.id;
      assert.equal(c.data.granted, true);
    });

    await test('finalidad de consentimiento inválida se rechaza', async () => {
      const c = await api('/api/dataprotection/consents', { method: 'POST', body: { propertyId, subjectName: 'X', purpose: 'espionaje' } });
      assert.equal(c.status, 400);
    });

    await test('overview de protección de datos cuenta consentimientos y bases RNBD', async () => {
      const { status, data } = await api(`/api/dataprotection/overview?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.consentsActive >= 1);
      assert.ok(data.treatments >= 3, 'las bases por defecto (RNBD) deben sembrarse');
    });

    await test('revocar consentimiento lo marca como revocado', async () => {
      const r = await api(`/api/dataprotection/consents/${consentId}/revoke`, { method: 'POST' });
      assert.equal(r.status, 200);
      assert.equal(r.data.granted, false);
      const ov = await api(`/api/dataprotection/overview?propertyId=${propertyId}`);
      assert.ok(ov.data.consentsRevoked >= 1);
    });

    let requestId;
    await test('crear solicitud del titular fija plazo legal', async () => {
      const r = await api('/api/dataprotection/requests', { method: 'POST', body: { propertyId, subjectName: 'John Smith', documentNumber: 'X99887766', type: 'acceso', channel: 'correo' } });
      assert.equal(r.status, 201);
      requestId = r.data.id;
      assert.ok(r.data.dueDate, 'debe calcular fecha límite (días hábiles)');
      assert.equal(r.data.status, 'received');
    });

    await test('derecho de acceso exporta los datos del titular', async () => {
      const { status, data } = await api(`/api/dataprotection/export?propertyId=${propertyId}&documentNumber=X99887766`);
      assert.equal(status, 200);
      assert.equal(data.found, true, 'debe encontrar al huésped extranjero creado antes');
      assert.ok(Array.isArray(data.huesped) && data.huesped.length >= 1);
    });

    await test('resolver solicitud del titular', async () => {
      const r = await api(`/api/dataprotection/requests/${requestId}/resolve`, { method: 'POST', body: { status: 'resolved', resolution: 'Se envió copia de la información.' } });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'resolved');
      assert.ok(r.data.resolvedAt);
    });

    await test('derecho de supresión anonimiza al titular', async () => {
      const r = await api('/api/dataprotection/erase', { method: 'POST', body: { propertyId, documentNumber: 'X99887766' } });
      assert.equal(r.status, 200);
      assert.ok(r.data.anonymized >= 1);
      const again = await api(`/api/dataprotection/export?propertyId=${propertyId}&documentNumber=X99887766`);
      assert.equal(again.data.found, false, 'tras la supresión el documento ya no debe hallarse');
    });

    await test('recepción puede registrar consentimiento pero NO suprimir', async () => {
      const { data: login } = await api('/api/auth/login', { method: 'POST', body: { email: 'recepcion@atria.co', password: 'atria2026' } });
      const ok = await fetch(`${BASE}/api/dataprotection/consents`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ propertyId, subjectName: 'Huésped Recepción', purpose: 'tratamiento' }) });
      assert.equal(ok.status, 201);
      const denied = await fetch(`${BASE}/api/dataprotection/erase`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ propertyId, documentNumber: '52123456' }) });
      assert.equal(denied.status, 403);
    });

    // ===== Ola 6: FONTUR — contribución parafiscal del turismo (§27) =====
    let fonturId;
    await test('preview FONTUR calcula base × tarifa del trimestre', async () => {
      const { status, data } = await api(`/api/fontur/preview?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(/^\d{4}-T[1-4]$/.test(data.period), 'periodo trimestral');
      assert.ok(data.rate > 0 && data.rate < 0.01, 'tarifa por mil');
      assert.equal(data.amount, Math.round(data.operatingIncome * data.rate));
    });

    await test('generar contribución FONTUR del trimestre', async () => {
      const { status, data } = await api('/api/fontur/generate', { method: 'POST', body: { propertyId } });
      assert.equal(status, 201);
      fonturId = data.id;
      assert.equal(data.status, 'draft');
      assert.ok(data.amount >= 0);
    });

    await test('generar de nuevo es idempotente (mismo periodo)', async () => {
      const first = await api(`/api/fontur/overview?propertyId=${propertyId}`);
      await api('/api/fontur/generate', { method: 'POST', body: { propertyId } });
      const second = await api(`/api/fontur/overview?propertyId=${propertyId}`);
      const drafts = second.data.contributions.filter(c => c.period === first.data.current.period);
      assert.equal(drafts.length, 1, 'no debe duplicar el periodo');
    });

    await test('presentar y pagar la contribución actualiza estado y YTD', async () => {
      const filed = await api(`/api/fontur/${fonturId}/file`, { method: 'POST' });
      assert.equal(filed.data.status, 'filed');
      const paid = await api(`/api/fontur/${fonturId}/pay`, { method: 'POST', body: { support: 'PSE-FONTUR-01' } });
      assert.equal(paid.data.status, 'paid');
      const ov = await api(`/api/fontur/overview?propertyId=${propertyId}`);
      assert.ok(ov.data.paidYtd >= paid.data.amount);
    });

    await test('no se puede recalcular un periodo ya pagado', async () => {
      const { status } = await api('/api/fontur/generate', { method: 'POST', body: { propertyId } });
      assert.equal(status, 400);
    });

    await test('rol housekeeping no puede ver FONTUR (permisos backend)', async () => {
      const { data: login } = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      const res = await fetch(`${BASE}/api/fontur/overview?propertyId=${propertyId}`, { headers: { authorization: `Bearer ${login.token}` } });
      assert.equal(res.status, 403);
    });

    // ===== Ola 6: Consolidación multi-sede (§8) =====
    await test('portafolio consolida las sedes de la empresa', async () => {
      const { status, data } = await api('/api/portfolio/overview');
      assert.equal(status, 200);
      assert.ok(data.count >= 2, 'la demo tiene al menos dos sedes');
      assert.ok(Array.isArray(data.sites) && data.sites.length === data.count);
      const s0 = data.sites[0];
      assert.ok('occupancyPct' in s0 && 'monthRevenue' in s0 && 'receivable' in s0 && 'adr' in s0);
    });

    await test('totales del portafolio suman las sedes', async () => {
      const { data } = await api('/api/portfolio/overview');
      const sumRooms = data.sites.reduce((s, x) => s + x.rooms, 0);
      const sumRevenue = data.sites.reduce((s, x) => s + x.monthRevenue, 0);
      assert.equal(data.totals.rooms, sumRooms);
      assert.equal(data.totals.monthRevenue, sumRevenue);
      assert.ok(data.totals.occupancyPct >= 0 && data.totals.occupancyPct <= 100);
    });

    await test('la sede con reservas del mes reporta ingresos', async () => {
      const { data } = await api('/api/portfolio/overview');
      const bog = data.sites.find(s => s.id === propertyId);
      assert.ok(bog, 'la sede de pruebas debe estar en el portafolio');
      assert.ok(bog.monthRevenue > 0, 'la sede operada durante las pruebas debe tener ingresos');
    });

    // ===== Marketing & campañas (§36) =====
    await test('canal inválido de campaña se rechaza', async () => {
      const c = await api('/api/marketing/campaigns', { method: 'POST', body: { propertyId, name: 'X', channel: 'paloma', message: 'hola' } });
      assert.equal(c.status, 400);
    });

    await test('campaña sin mensaje se rechaza', async () => {
      const c = await api('/api/marketing/campaigns', { method: 'POST', body: { propertyId, name: 'X', channel: 'email' } });
      assert.equal(c.status, 400);
    });

    await test('la audiencia de marketing respeta el consentimiento', async () => {
      // Huésped contactable sin consentimiento de marketing
      const mkIn = futureDay(120), mkOut = futureDay(122);
      const { data: avail } = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: mkIn, checkOut: mkOut, adults: 1 } });
      await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: mkIn, checkOut: mkOut, adults: 1, roomTypeId: avail[0].roomTypeId, ratePlanId: avail[0].ratePlans[0]?.ratePlanId, guest: { fullName: 'Marta Correo', email: 'marta@example.com', phone: '573009998877', documentNumber: '900900900', nationality: 'CO' } } });
      const list = await api(`/api/reservations?propertyId=${propertyId}`);
      const g = list.data.map(r => r.guest).find(x => x && x.email === 'marta@example.com');
      assert.ok(g, 'debe existir el huésped creado');
      assert.equal(g.marketingConsent, false);
      const before = await api(`/api/marketing/audience?propertyId=${propertyId}&channel=email&audience=guests`);
      // Otorga consentimiento de marketing → sincroniza la ficha del huésped
      const cons = await api('/api/dataprotection/consents', { method: 'POST', body: { propertyId, subjectType: 'guest', subjectId: g.id, subjectName: g.fullName, purpose: 'marketing' } });
      assert.equal(cons.status, 201);
      const after = await api(`/api/marketing/audience?propertyId=${propertyId}&channel=email&audience=guests`);
      assert.equal(after.data.eligible, before.data.eligible + 1, 'el huésped con consentimiento entra a la audiencia');
    });

    let campaignId;
    await test('crear campaña calcula la audiencia elegible', async () => {
      const c = await api('/api/marketing/campaigns', { method: 'POST', body: { propertyId, name: 'Promo julio', channel: 'email', audience: 'guests', subject: '¡Vuelve!', message: 'Tenemos una tarifa especial para ti.' } });
      assert.equal(c.status, 201);
      campaignId = c.data.id;
      assert.equal(c.data.status, 'draft');
      assert.ok(c.data.audienceCount >= 1, 'debe incluir al huésped con consentimiento');
    });

    await test('enviar campaña solo alcanza a quienes consintieron', async () => {
      const sent = await api(`/api/marketing/campaigns/${campaignId}/send`, { method: 'POST' });
      assert.equal(sent.status, 200);
      assert.equal(sent.data.status, 'sent');
      assert.equal(sent.data.sentCount, sent.data.audienceCount);
      assert.ok(sent.data.sentAt);
    });

    await test('no se puede reenviar una campaña ya enviada', async () => {
      const again = await api(`/api/marketing/campaigns/${campaignId}/send`, { method: 'POST' });
      assert.equal(again.status, 400);
    });

    await test('overview de marketing reporta opt-in y envíos', async () => {
      const { status, data } = await api(`/api/marketing/overview?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.reachable >= 1);
      assert.ok(data.campaignsSent >= 1 && data.totalSent >= 1);
    });

    // ===== Reputación & reseñas (§37) =====
    await test('registrar reseña con calificación inválida se rechaza', async () => {
      const r = await api('/api/reputation/reviews', { method: 'POST', body: { propertyId, guestName: 'X', source: 'google', rating: 9 } });
      assert.equal(r.status, 400);
    });

    let reviewId;
    await test('registrar reseña de OTA calcula el sentimiento', async () => {
      const r = await api('/api/reputation/reviews', { method: 'POST', body: { propertyId, guestName: 'Pedro Niño', source: 'google', rating: 5, comment: 'Excelente atención.' } });
      assert.equal(r.status, 201);
      reviewId = r.data.id;
      assert.equal(r.data.sentiment, 'positive');
      assert.equal(r.data.status, 'published');
    });

    await test('el huésped deja reseña desde su portal (público)', async () => {
      const res = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ rating: 2, comment: 'El wifi fallaba.' }),
      });
      assert.equal(res.status, 201);
      const dup = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}/review`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rating: 3 }),
      });
      assert.equal(dup.status, 409, 'no permite dos reseñas directas por reserva');
    });

    await test('sugerencia de respuesta de la IA se adapta al sentimiento', async () => {
      const pos = await api(`/api/reputation/reviews/${reviewId}/draft`);
      assert.equal(pos.status, 200);
      assert.ok(pos.data.draft && pos.data.draft.length > 20);
    });

    await test('responder una reseña la marca como respondida', async () => {
      const r = await api(`/api/reputation/reviews/${reviewId}/respond`, { method: 'POST', body: { response: '¡Gracias por tu visita, Pedro!' } });
      assert.equal(r.status, 200);
      assert.equal(r.data.status, 'responded');
      assert.ok(r.data.respondedAt);
    });

    await test('overview de reputación agrega media, distribución y NPS', async () => {
      const { status, data } = await api(`/api/reputation/overview?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.count >= 2);
      assert.ok(data.avg > 0 && data.avg <= 5);
      assert.ok(typeof data.nps === 'number');
      assert.ok(data.responseRate >= 1, 'al menos una respondida');
      assert.ok(data.distribution[5] >= 1 && data.distribution[2] >= 1);
    });

    // ===== Eventos & corporativo (§33) =====
    let venueId, eventId;
    await test('los salones demo están sembrados', async () => {
      const { status, data } = await api(`/api/events/venues?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.length >= 2);
      venueId = data.reduce((a, b) => (b.capacity > a.capacity ? b : a)).id; // el salón más grande
    });

    await test('cotización de evento suma salón + catering + IVA', async () => {
      const q = await api('/api/events/quote', { method: 'POST', body: { venueId, durationType: 'full', attendees: 50, cateringPerPerson: 40000, extras: 100000 } });
      assert.equal(q.status, 200);
      assert.equal(q.data.cateringTotal, 50 * 40000);
      assert.equal(q.data.subtotal, q.data.venueFee + q.data.cateringTotal + q.data.extras);
      assert.equal(q.data.total, q.data.subtotal + q.data.taxes);
      assert.equal(q.data.deposit, Math.round(q.data.total * 0.5));
    });

    await test('crear evento como cotización', async () => {
      const ev = await api('/api/events', { method: 'POST', body: { propertyId, venueId, clientName: 'ACME Corp', clientContact: 'eventos@acme.co', eventType: 'corporativo', date: futureDay(30), attendees: 50, setup: 'escuela', durationType: 'full', cateringPerPerson: 40000 } });
      assert.equal(ev.status, 201);
      eventId = ev.data.id;
      assert.equal(ev.data.status, 'quote');
      assert.ok(ev.data.total > 0 && /^EVT-/.test(ev.data.code));
    });

    await test('excede la capacidad del salón se rechaza', async () => {
      const small = (await api(`/api/events/venues?propertyId=${propertyId}`)).data.find(v => v.capacity < 100) || {};
      const ev = await api('/api/events', { method: 'POST', body: { propertyId, venueId: small.id, clientName: 'X', date: futureDay(31), attendees: 999, durationType: 'full' } });
      assert.equal(ev.status, 400);
    });

    await test('confirmar evento y bloquear doble reserva del salón', async () => {
      const c = await api(`/api/events/${eventId}/confirm`, { method: 'POST' });
      assert.equal(c.status, 200);
      assert.equal(c.data.status, 'confirmed');
      // Otro evento el mismo día en el mismo salón
      const other = await api('/api/events', { method: 'POST', body: { propertyId, venueId, clientName: 'Otro', date: futureDay(30), attendees: 10, durationType: 'full' } });
      const clash = await api(`/api/events/${other.data.id}/confirm`, { method: 'POST' });
      assert.equal(clash.status, 400, 'el salón ya está ocupado esa fecha');
    });

    await test('overview de eventos reporta pipeline y confirmados', async () => {
      const { status, data } = await api(`/api/events/overview?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.venues >= 2);
      assert.ok(data.confirmed >= 1);
      assert.ok(data.pipeline >= 0);
    });

    // ===== Centro de integraciones (§45) =====
    await test('overview de integraciones lista el catálogo con estado en vivo', async () => {
      const { status, data } = await api(`/api/integrations/overview?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.total >= 8);
      const mock = data.items.find(i => i.provider === 'mercadopago');
      assert.ok(mock && mock.managedByEnv, 'las pasarelas se gestionan por entorno');
      const wa = data.items.find(i => i.provider === 'whatsapp');
      assert.ok(wa && wa.live, 'WhatsApp reporta estado en vivo');
    });

    await test('no se puede configurar una integración gestionada por entorno', async () => {
      const r = await api('/api/integrations/stripe/connect', { method: 'POST', body: { propertyId, config: { secretKey: 'sk_test' } } });
      assert.equal(r.status, 400);
    });

    await test('conectar una OTA guarda credenciales y las enmascara', async () => {
      const r = await api('/api/integrations/booking/connect', { method: 'POST', body: { propertyId, config: { hotelId: 'H-123', apiKey: 'secreto-super-largo-1234' } } });
      assert.equal(r.status, 201);
      assert.equal(r.data.status, 'connected');
      assert.ok(String(r.data.config.apiKey).includes('••'), 'el secreto debe venir enmascarado');
      assert.equal(r.data.config.hotelId, 'H-123');
    });

    await test('conectar sin datos requeridos se rechaza', async () => {
      const r = await api('/api/integrations/ga4/connect', { method: 'POST', body: { propertyId, config: {} } });
      assert.equal(r.status, 400);
    });

    await test('probar la integración conectada responde ok', async () => {
      const r = await api('/api/integrations/booking/test', { method: 'POST', body: { propertyId } });
      assert.equal(r.status, 200);
      assert.equal(r.data.ok, true);
    });

    // ===== Automatizador visual (§40) =====
    let ruleId;
    await test('disparador inválido de regla se rechaza', async () => {
      const r = await api('/api/automations/rules', { method: 'POST', body: { propertyId, name: 'X', trigger: 'inexistente', actionType: 'log' } });
      assert.equal(r.status, 400);
    });

    await test('crear regla no-code (reserva confirmada → notificar)', async () => {
      const r = await api('/api/automations/rules', { method: 'POST', body: { propertyId, name: 'Aviso de reserva confirmada', trigger: 'reservation.confirmed', actionType: 'notify', actionParams: { role: 'MANAGER', title: 'Nueva reserva', severity: 'info' } } });
      assert.equal(r.status, 201);
      ruleId = r.data.id;
      assert.equal(r.data.enabled, true);
      assert.equal(r.data.runCount, 0);
    });

    await test('probar la regla la ejecuta', async () => {
      const r = await api(`/api/automations/rules/${ruleId}/test`, { method: 'POST', body: { payload: {} } });
      assert.equal(r.status, 200);
      assert.equal(r.data.executed, true);
    });

    await test('la regla se dispara con un evento real de dominio', async () => {
      const before = (await api(`/api/automations/overview?propertyId=${propertyId}`)).data.rules.find(x => x.id === ruleId).runCount;
      // Nueva reserva + pago → emite reservation.confirmed
      const aIn = futureDay(200), aOut = futureDay(202);
      const { data: avail } = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: aIn, checkOut: aOut, adults: 1 } });
      const bk = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: aIn, checkOut: aOut, adults: 1, roomTypeId: avail[0].roomTypeId, ratePlanId: avail[0].ratePlans[0]?.ratePlanId, guest: { fullName: 'Auto Regla', phone: '573001239876', documentNumber: '700700700', nationality: 'CO' } } });
      await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: bk.data.paymentLink.token } });
      await settle(700);
      const after = (await api(`/api/automations/overview?propertyId=${propertyId}`)).data.rules.find(x => x.id === ruleId).runCount;
      assert.ok(after > before, `la regla debió ejecutarse (${before} → ${after})`);
    });

    await test('pausar la regla evita que se dispare', async () => {
      await api(`/api/automations/rules/${ruleId}`, { method: 'PATCH', body: { enabled: false } });
      const ov = await api(`/api/automations/overview?propertyId=${propertyId}`);
      assert.equal(ov.data.rules.find(x => x.id === ruleId).enabled, false);
    });

    // ===== Integraciones entre módulos (cierre de lazos) =====
    await test('una reseña nueva dispara la regla de automatización', async () => {
      const rule = await api('/api/automations/rules', { method: 'POST', body: { propertyId, name: 'Reseña → auditoría', trigger: 'review.created', actionType: 'log', actionParams: { note: 'reseña registrada' } } });
      assert.equal(rule.status, 201);
      await api('/api/reputation/reviews', { method: 'POST', body: { propertyId, guestName: 'Trigger Test', source: 'google', rating: 1, comment: 'Prueba de disparo.' } });
      await settle(600);
      const ov = await api(`/api/automations/overview?propertyId=${propertyId}`);
      assert.ok(ov.data.rules.find(r => r.id === rule.data.id).runCount >= 1, 'la regla review.created debió ejecutarse');
    });

    await test('confirmar un evento dispara la regla event.confirmed', async () => {
      const rule = await api('/api/automations/rules', { method: 'POST', body: { propertyId, name: 'Evento confirmado → notificar', trigger: 'event.confirmed', actionType: 'notify', actionParams: { role: 'MANAGER', title: 'Evento confirmado' } } });
      const venues = (await api(`/api/events/venues?propertyId=${propertyId}`)).data;
      const big = venues.reduce((a, b) => (b.capacity > a.capacity ? b : a));
      const ev = await api('/api/events', { method: 'POST', body: { propertyId, venueId: big.id, clientName: 'Trigger Eventos', date: futureDay(300), attendees: 20, durationType: 'full' } });
      await api(`/api/events/${ev.data.id}/confirm`, { method: 'POST' });
      await settle(600);
      const ov = await api(`/api/automations/overview?propertyId=${propertyId}`);
      assert.ok(ov.data.rules.find(r => r.id === rule.data.id).runCount >= 1, 'la regla event.confirmed debió ejecutarse');
    });

    await test('el portafolio pondera ADR y RevPAR del grupo', async () => {
      const { data } = await api('/api/portfolio/overview');
      assert.ok('adr' in data.totals && 'revpar' in data.totals);
      const expectedAdr = data.totals.roomNights > 0 ? Math.round(data.totals.roomRevenue / data.totals.roomNights) : 0;
      assert.equal(data.totals.adr, expectedAdr, 'ADR ponderado por noches vendidas');
      assert.ok(data.totals.adr >= 0 && data.totals.revpar >= 0);
    });

    await test('la condición de una regla filtra el disparo (reseña negativa)', async () => {
      const rule = await api('/api/automations/rules', { method: 'POST', body: { propertyId, name: 'Reseña ≤ 2 → alerta', trigger: 'review.created', conditions: [{ field: 'rating', op: 'lt', value: 3 }], actionType: 'notify', actionParams: { role: 'MANAGER', title: 'Reseña negativa' } } });
      assert.equal(rule.status, 201);
      // Reseña positiva (rating 5): NO debe disparar
      await api('/api/reputation/reviews', { method: 'POST', body: { propertyId, guestName: 'Feliz', source: 'google', rating: 5 } });
      await settle(500);
      let rc = (await api(`/api/automations/overview?propertyId=${propertyId}`)).data.rules.find(r => r.id === rule.data.id).runCount;
      assert.equal(rc, 0, 'una reseña 5★ no cumple la condición rating<3');
      // Reseña negativa (rating 2): SÍ debe disparar
      await api('/api/reputation/reviews', { method: 'POST', body: { propertyId, guestName: 'Molesto', source: 'google', rating: 2 } });
      await settle(500);
      rc = (await api(`/api/automations/overview?propertyId=${propertyId}`)).data.rules.find(r => r.id === rule.data.id).runCount;
      assert.equal(rc, 1, 'una reseña 2★ cumple la condición rating<3');
    });

    await test('el dashboard incluye señales cruzadas del ecosistema', async () => {
      const { status, data } = await api(`/api/dashboard?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.ecosystem, 'debe incluir el bloque ecosystem');
      for (const k of ['reputationAvg', 'reviewsPending', 'upcomingEvents', 'dataRequestsOpen', 'payableOpen']) {
        assert.ok(k in data.ecosystem, `falta ${k}`);
      }
      assert.ok(data.ecosystem.reputationAvg > 0, 'debe reflejar las reseñas creadas antes');
      assert.ok(data.ecosystem.upcomingEvents >= 1, 'debe reflejar los eventos futuros creados antes');
    });

    await test('ningún endpoint de integraciones expone el secreto en claro', async () => {
      const secret = 'ULTRA-SECRETO-NO-DEBE-FILTRARSE-9988';
      await api('/api/integrations/expedia/connect', { method: 'POST', body: { propertyId, config: { hotelId: 'H-9', apiKey: secret } } });
      const ov = JSON.stringify((await api(`/api/integrations/overview?propertyId=${propertyId}`)).data);
      assert.ok(!ov.includes(secret), 'el overview no debe contener el secreto en claro');
      const cat = JSON.stringify((await api('/api/integrations/catalog')).data);
      assert.ok(!cat.includes(secret), 'el catálogo no debe contener secretos');
      const masked = (await api('/api/integrations/overview?propertyId=' + propertyId)).data.items.find(i => i.provider === 'expedia');
      assert.ok(String(masked.config.apiKey).includes('••'), 'la clave debe mostrarse enmascarada');
    });

    // ===== IA ampliada: redactor, copiloto financiero, sugerencias =====
    await test('el redactor de campañas adapta el mensaje al canal y objetivo', async () => {
      const email = await api(`/api/marketing/draft?propertyId=${propertyId}&goal=fidelizar clientes&channel=email`);
      assert.equal(email.status, 200);
      assert.ok(email.data.message.length > 40);
      assert.ok(email.data.subject, 'email debe traer asunto');
      const sms = await api(`/api/marketing/draft?propertyId=${propertyId}&goal=fidelizar clientes&channel=sms`);
      assert.equal(sms.data.subject, null, 'sms no lleva asunto');
      assert.ok(sms.data.message.length <= 300, 'sms debe ser corto');
    });

    await test('el copiloto financiero resume el mes con recomendación', async () => {
      const { status, data } = await api(`/api/finance/summary?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.narrative.includes('ingresos') || data.narrative.includes('resultado'));
      assert.ok(data.narrative.includes('💡'), 'debe incluir una recomendación accionable');
      assert.ok(['positive', 'negative'].includes(data.sentiment));
    });

    await test('el copiloto sugiere reglas y no repite las ya creadas', async () => {
      const before = await api(`/api/automations/suggestions?propertyId=${propertyId}`);
      assert.equal(before.status, 200);
      assert.ok(Array.isArray(before.data));
      const sug = before.data.find(s => s.trigger === 'foreign_guest.detected');
      assert.ok(sug, 'debe sugerir el recordatorio SIRE');
      await api('/api/automations/rules', { method: 'POST', body: { propertyId, name: sug.name, trigger: sug.trigger, conditions: sug.conditions, actionType: sug.actionType, actionParams: sug.actionParams } });
      const after = await api(`/api/automations/suggestions?propertyId=${propertyId}`);
      assert.ok(!after.data.some(s => s.trigger === 'foreign_guest.detected' && s.actionType === sug.actionType), 'la sugerencia aplicada ya no debe aparecer');
    });

    // ===== Copiloto interno ampliado (§41) =====
    await test('el copiloto interno responde sobre finanzas y reputación (gerente)', async () => {
      const fin = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: '¿cómo va el resultado financiero y la cartera?' } });
      assert.equal(fin.status, 200);
      assert.ok(/financiero|ingresos|resultado/i.test(fin.data.reply));
      const rep = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: '¿cuál es nuestra reputación y NPS?' } });
      assert.ok(/calificaci|reseña|NPS/i.test(rep.data.reply));
      const ev = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: '¿cuántos eventos próximos hay?' } });
      assert.ok(/evento|pipeline/i.test(ev.data.reply));
    });

    await test('el copiloto NO revela finanzas a housekeeping (permisos por rol)', async () => {
      const { data: login } = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      const res = await fetch(`${BASE}/api/assistant/internal`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ propertyId, text: '¿cómo va el resultado financiero?' }) });
      const data = await res.json();
      assert.equal(res.status, 200);
      assert.ok(!/copiloto financiero|resultado:/i.test(data.reply), 'no debe entregar el resumen financiero a housekeeping');
    });

    // ===== Endurecimiento para producción (§50) =====
    await test('las respuestas incluyen cabeceras de seguridad', async () => {
      const res = await fetch(`${BASE}/api/health`);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'DENY');
      assert.ok(res.headers.get('referrer-policy'));
      assert.ok(!res.headers.get('x-powered-by'), 'no debe exponer x-powered-by');
    });

    // DEBE ir al final: al superar el umbral bloquea la IP por 15 min.
    await test('login se bloquea tras muchos intentos fallidos (anti fuerza-bruta)', async () => {
      let got429 = false;
      for (let i = 0; i < 15; i++) {
        const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'gerente@atria.co', password: 'incorrecta' }) });
        if (res.status === 429) { got429 = true; break; }
      }
      assert.ok(got429, 'tras varios intentos fallidos el login debe responder 429');
    });

    console.log(`\n📊 Resultado: ${passed} OK, ${failed} fallidas`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    proc.kill('SIGTERM');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
