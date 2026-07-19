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

    console.log(`\n📊 Resultado: ${passed} OK, ${failed} fallidas`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    proc.kill('SIGTERM');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
