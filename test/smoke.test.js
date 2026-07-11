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

    console.log(`\n📊 Resultado: ${passed} OK, ${failed} fallidas`);
    process.exitCode = failed ? 1 : 0;
  } finally {
    proc.kill('SIGTERM');
  }
}

main().catch(err => { console.error(err); process.exit(1); });
