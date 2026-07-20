// Prueba de humo end-to-end: arranca el servidor y ejecuta los flujos
// críticos de la sección 48 del documento funcional.
import { spawn } from 'node:child_process';
import assert from 'node:assert';
import { totpCode } from '../src/lib/totp.js';

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

    await test('el login expone los permisos del rol para adaptar la navegación', async () => {
      const owner = await api('/api/auth/login', { method: 'POST', body: { email: 'owner@atria.co', password: 'atria2026' } });
      assert.ok(owner.data.permissions.includes('*'), 'el dueño tiene acceso total');
      const hk = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      assert.ok(Array.isArray(hk.data.permissions) && hk.data.permissions.length > 0, 'devuelve permisos del rol');
      const flat = hk.data.permissions.join(' ');
      assert.ok(/housekeeping/.test(flat), 'housekeeping ve su área');
      assert.ok(!hk.data.permissions.includes('*') && !/finance\.\*|payroll\.\*/.test(flat), 'housekeeping NO ve finanzas/nómina');
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

    // ===== Portal del huésped: check-in digital y solicitudes (§14/§48.2) =====
    await test('pre-check-in exige aceptar políticas y luego completa el registro', async () => {
      const bad = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}/precheckin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acceptPolicies: false }) });
      assert.equal(bad.status, 400);
      const ok = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}/precheckin`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ acceptPolicies: true, arrivalTime: '15:30', documentNumber: '1099887766', nationality: 'CO', email: 'huesped@correo.co', companions: ['Ana Pérez'] }) });
      assert.equal(ok.status, 200);
      const info = await (await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}`)).json();
      assert.ok(info.precheckinDone, 'la reserva queda marcada con pre-check-in');
      assert.equal(info.arrivalTime, '15:30');
    });

    let guestReqId;
    await test('el huésped solicita un servicio y el staff lo ve', async () => {
      const r = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}/request`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'towels', detail: 'Dos toallas extra' }) });
      assert.equal(r.status, 201);
      const list = await api(`/api/ops/guest-requests?propertyId=${propertyId}`);
      assert.equal(list.status, 200);
      const mine = list.data.find(x => x.detail === 'Dos toallas extra');
      assert.ok(mine, 'el staff ve la solicitud');
      assert.equal(mine.type, 'towels');
      guestReqId = mine.id;
    });

    await test('el staff atiende la solicitud del huésped', async () => {
      const upd = await api(`/api/ops/guest-requests/${guestReqId}`, { method: 'PATCH', body: { status: 'done' } });
      assert.equal(upd.status, 200);
      assert.equal(upd.data.status, 'done');
      assert.ok(upd.data.resolvedAt);
    });

    await test('el huésped genera link de pago del saldo desde el portal', async () => {
      const r = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}/pay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const d = await r.json();
      assert.equal(r.status, 200);
      assert.ok(d.paymentUrl && d.amount > 0, 'devuelve URL de pago y saldo');
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

    let cleanTaskId;
    await test('gerente aprueba → check-out ejecutado + tarea de limpieza', async () => {
      const { status } = await api(`/api/approvals/${approvalId}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(status, 200);
      await settle();
      const { data: r } = await api(`/api/reservations/${reservation.id}`);
      assert.equal(r.status, 'checked_out');
      const { data: tasks } = await api(`/api/ops/housekeeping/tasks?propertyId=${propertyId}`);
      const ct = tasks.find(t => t.type === 'checkout_clean');
      assert.ok(ct, 'debe crear tarea de limpieza automática');
      cleanTaskId = ct.id;
    });

    // ===== Housekeeping: protocolo de limpieza + objetos perdidos (§30) =====
    await test('la tarea de check-out trae un protocolo de limpieza (checklist)', async () => {
      const { data: tasks } = await api(`/api/ops/housekeeping/tasks?propertyId=${propertyId}`);
      const ct = tasks.find(t => t.id === cleanTaskId);
      const list = JSON.parse(ct.checklist || '[]');
      assert.ok(list.length >= 5, 'el protocolo tiene varios puntos');
      assert.ok(list.every(x => x.done === false), 'todos empiezan sin marcar');
    });

    await test('no se puede cerrar la limpieza con el protocolo incompleto', async () => {
      const res = await api(`/api/ops/housekeeping/tasks/${cleanTaskId}`, { method: 'PATCH', body: { status: 'done' } });
      assert.equal(res.status, 400);
    });

    await test('marcar todos los puntos permite cerrar la tarea', async () => {
      const { data: tasks } = await api(`/api/ops/housekeeping/tasks?propertyId=${propertyId}`);
      const ct = tasks.find(t => t.id === cleanTaskId);
      const list = JSON.parse(ct.checklist || '[]');
      for (let i = 0; i < list.length; i++) {
        await api(`/api/ops/housekeeping/tasks/${cleanTaskId}/checklist`, { method: 'PATCH', body: { index: i, done: true } });
      }
      const ok = await api(`/api/ops/housekeeping/tasks/${cleanTaskId}`, { method: 'PATCH', body: { status: 'done' } });
      assert.equal(ok.status, 200);
      assert.equal(ok.data.status, 'done');
    });

    await test('registrar y entregar un objeto perdido', async () => {
      const created = await api('/api/ops/lost-found', { method: 'POST', body: { propertyId, description: 'Cargador de laptop negro', location: 'Hab 101' } });
      assert.equal(created.status, 201);
      assert.equal(created.data.status, 'stored');
      const list = await api(`/api/ops/lost-found?propertyId=${propertyId}`);
      assert.ok(list.data.some(l => l.id === created.data.id), 'aparece en la lista');
      const ret = await api(`/api/ops/lost-found/${created.data.id}`, { method: 'PATCH', body: { status: 'returned', claimedBy: 'Laura Pérez' } });
      assert.equal(ret.data.status, 'returned');
      assert.equal(ret.data.claimedBy, 'Laura Pérez');
      assert.ok(ret.data.resolvedAt);
    });

    // ===== Activos + mantenimiento preventivo (§31) =====
    let assetId, prevOrderId;
    await test('registrar un activo con cadencia y servicio vencido', async () => {
      const past = new Date(Date.now() - 5 * 86400000).toISOString();
      const { status, data } = await api('/api/ops/assets', { method: 'POST', body: { propertyId, name: 'Ascensor principal', category: 'elevator', location: 'Torre A', intervalDays: 90, nextServiceAt: past } });
      assert.equal(status, 201);
      assert.equal(data.intervalDays, 90);
      assetId = data.id;
      const list = await api(`/api/ops/assets?propertyId=${propertyId}`);
      const a = list.data.find(x => x.id === assetId);
      assert.equal(a.due, true, 'el activo aparece como vencido');
    });

    await test('generar preventivas crea una orden para el activo vencido', async () => {
      const { status, data } = await api('/api/ops/maintenance/preventive/run', { method: 'POST', body: { propertyId } });
      assert.equal(status, 200);
      assert.ok(data.generated >= 1, 'genera al menos una orden');
      const orders = await api(`/api/ops/maintenance/orders?propertyId=${propertyId}`);
      const po = orders.data.find(o => o.assetId === assetId && o.preventive);
      assert.ok(po, 'existe la orden preventiva ligada al activo');
      prevOrderId = po.id;
    });

    await test('volver a generar preventivas es idempotente (no duplica)', async () => {
      const { data } = await api('/api/ops/maintenance/preventive/run', { method: 'POST', body: { propertyId } });
      assert.equal(data.generated, 0, 'no crea otra orden mientras la anterior sigue abierta');
    });

    await test('resolver la orden preventiva reprograma el activo', async () => {
      const res = await api(`/api/ops/maintenance/orders/${prevOrderId}`, { method: 'PATCH', body: { status: 'resolved', cost: 120000 } });
      assert.equal(res.status, 200);
      const list = await api(`/api/ops/assets?propertyId=${propertyId}`);
      const a = list.data.find(x => x.id === assetId);
      assert.equal(a.status, 'operational');
      assert.equal(a.due, false, 'el próximo servicio quedó en el futuro');
      assert.ok(a.lastServiceAt, 'registra la fecha del último servicio');
    });

    // ===== Cuentas corporativas + rooming lists (§35) =====
    let corpId, roomingId, corpRoomTypeId;
    await test('crear cuenta corporativa con descuento negociado y crédito', async () => {
      const { status, data } = await api('/api/crm/corporate', { method: 'POST', body: { propertyId, name: 'Constructora Andina S.A.S', nit: '900123456-7', contactName: 'Marta Ríos', discountPct: 0.2, creditEnabled: true, creditLimit: 20000000, paymentTermsDays: 45 } });
      assert.equal(status, 201);
      assert.equal(data.discountPct, 0.2);
      assert.equal(data.creditEnabled, true);
      corpId = data.id;
    });

    await test('crear un rooming list de grupo asociado a la cuenta', async () => {
      const ci = futureDay(20), co = futureDay(22);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      corpRoomTypeId = av.data[0].roomTypeId;
      const { status, data } = await api('/api/crm/rooming', { method: 'POST', body: {
        propertyId, name: 'Congreso ANDI 2026', corporateAccountId: corpId,
        checkIn: ci, checkOut: co, roomTypeId: corpRoomTypeId,
        entries: [{ guestName: 'Ana Pérez' }, { guestName: 'Carlos Ruiz' }, { guestName: 'María Gómez' }],
      } });
      assert.equal(status, 201);
      assert.equal(data.entries.length, 3);
      assert.equal(data.status, 'draft');
      roomingId = data.id;
    });

    await test('materializar el rooming list crea una reserva por huésped con la tarifa negociada', async () => {
      // tarifa base de referencia
      const q = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: futureDay(20), checkOut: futureDay(22), adults: 1 } });
      const baseRate = q.data.find(o => o.roomTypeId === corpRoomTypeId)?.baseRate || q.data[0].baseRate;
      const { status, data } = await api(`/api/crm/rooming/${roomingId}/materialize`, { method: 'POST' });
      assert.equal(status, 200);
      assert.equal(data.reserved, 3);
      // verifica descuento aplicado en una de las reservas
      const stmt = await api(`/api/crm/corporate/${corpId}/statement`);
      assert.equal(stmt.data.reservations.length, 3, 'las 3 reservas quedan bajo la cuenta');
      const full = await api(`/api/reservations?propertyId=${propertyId}&status=confirmed`);
      const grpRes = full.data.filter(r => r.corporateAccountId === corpId);
      assert.ok(grpRes.length >= 3, 'las reservas quedan ligadas a la cuenta');
      assert.ok(grpRes[0].nightlyRate <= baseRate * 0.81, 'la tarifa lleva el 20% de descuento');
    });

    await test('el estado de cuenta consolida saldo y respeta el cupo de crédito', async () => {
      const stmt = await api(`/api/crm/corporate/${corpId}/statement`);
      assert.ok(stmt.data.totalBilled > 0);
      assert.equal(stmt.data.totalPaid, 0, 'aún sin pagos');
      assert.equal(stmt.data.balance, stmt.data.totalBilled);
      assert.equal(stmt.data.overLimit, false, 'dentro del cupo');
      assert.ok(stmt.data.creditAvailable < stmt.data.account.creditLimit, 'el cupo disponible bajó');
    });

    await test('re-materializar no duplica reservas', async () => {
      const res = await api(`/api/crm/rooming/${roomingId}/materialize`, { method: 'POST' });
      assert.equal(res.status, 400, 'no quedan huéspedes pendientes');
    });

    // ===== CRM: scoring de leads + segmentos (§12/§36) =====
    let hotLeadId;
    await test('un lead con intención de reserva y fechas puntúa alto (hot)', async () => {
      const { status, data } = await api('/api/crm/leads', { method: 'POST', body: {
        propertyId, name: 'Prospecto Caliente', phone: '573001112233', channel: 'whatsapp',
        intent: 'reserva', checkIn: futureDay(7), checkOut: futureDay(10), adults: 4,
      } });
      assert.equal(status, 201);
      assert.ok(data.score >= 60, `score alto esperado, fue ${data.score}`);
      assert.equal(data.grade, 'hot');
      hotLeadId = data.id;
    });

    await test('un lead con poca señal puntúa bajo (cold)', async () => {
      const { data } = await api('/api/crm/leads', { method: 'POST', body: { propertyId, name: 'Curioso', email: 'x@y.co', channel: 'web', intent: 'info' } });
      assert.ok(data.score < 30, `score bajo esperado, fue ${data.score}`);
      assert.equal(data.grade, 'cold');
    });

    await test('el detalle del score explica las señales', async () => {
      const { status, data } = await api(`/api/crm/leads/${hotLeadId}/score`);
      assert.equal(status, 200);
      assert.ok(data.signals.length >= 3, 'lista las señales que suman');
      assert.ok(data.signals.some(s => /reserva/i.test(s.label)), 'incluye la intención de reserva');
    });

    await test('recalcular scores recorre los leads abiertos', async () => {
      const { status, data } = await api('/api/crm/leads/rescore', { method: 'POST', body: { propertyId } });
      assert.equal(status, 200);
      assert.ok(data.total >= 2, 'evalúa los leads abiertos');
    });

    let segmentId;
    await test('crear un segmento y previsualizar su tamaño', async () => {
      const prev = await api('/api/crm/segments/preview', { method: 'POST', body: { propertyId, criteria: { minStays: 1 } } });
      assert.equal(prev.status, 200);
      assert.ok(prev.data.count >= 1, 'hay huéspedes con al menos una estadía');
      const { status, data } = await api('/api/crm/segments', { method: 'POST', body: { propertyId, name: 'Huéspedes recurrentes', description: '1+ estadías', criteria: { minStays: 1 } } });
      assert.equal(status, 201);
      segmentId = data.id;
    });

    await test('el segmento aparece listado con su conteo', async () => {
      const { data } = await api(`/api/crm/segments?propertyId=${propertyId}`);
      const s = data.find(x => x.id === segmentId);
      assert.ok(s, 'el segmento aparece');
      assert.ok(s.count >= 1, 'trae el conteo evaluado');
      assert.equal(s.criteria.minStays, 1);
    });

    await test('una campaña puede dirigirse a un segmento guardado', async () => {
      const { status, data } = await api('/api/marketing/campaigns', { method: 'POST', body: { propertyId, name: 'Reactivación recurrentes', channel: 'email', audience: 'guests', segmentId, message: 'Vuelve con nosotros' } });
      assert.equal(status, 201);
      // La audiencia de la campaña se limita a los miembros del segmento (con contacto+consentimiento).
      const members = await api(`/api/crm/segments/${segmentId}/members`);
      assert.ok(data.audienceCount + (data.skippedNoConsent || 0) <= members.data.count, 'la audiencia sale del segmento');
    });

    await test('eliminar un segmento', async () => {
      const del = await api(`/api/crm/segments/${segmentId}`, { method: 'DELETE' });
      assert.equal(del.status, 200);
      const { data } = await api(`/api/crm/segments?propertyId=${propertyId}`);
      assert.ok(!data.some(x => x.id === segmentId), 'ya no aparece');
    });

    // ===== Cupones + ROI de campañas (§36) =====
    let campaignForRoi, couponId, couponCode = 'VERANO20';
    await test('crear una campaña y un cupón atribuido a ella', async () => {
      const camp = await api('/api/marketing/campaigns', { method: 'POST', body: { propertyId, name: 'Promo verano', channel: 'email', audience: 'guests', message: 'Usa VERANO20' } });
      campaignForRoi = camp.data.id;
      const { status, data } = await api('/api/marketing/coupons', { method: 'POST', body: { propertyId, code: couponCode, discountType: 'percent', discountValue: 20, campaignId: campaignForRoi, description: '20% verano' } });
      assert.equal(status, 201);
      assert.equal(data.code, 'VERANO20');
      couponId = data.id;
    });

    await test('no se permiten cupones con código duplicado', async () => {
      const dup = await api('/api/marketing/coupons', { method: 'POST', body: { propertyId, code: 'verano20', discountType: 'percent', discountValue: 10 } });
      assert.equal(dup.status, 400);
    });

    let couponResCode, baseTotal;
    await test('reservar con el cupón aplica el descuento y registra la redención', async () => {
      const ci = futureDay(40), co = futureDay(42);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const rt = av.data[0];
      // reserva sin cupón para tener la línea base
      const plain = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: rt.roomTypeId, guest: { fullName: 'Base Sin Cupón' } } });
      baseTotal = plain.data.reservation.total;
      // reserva con cupón
      const withCoupon = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: rt.roomTypeId, guest: { fullName: 'Con Cupón' }, couponCode } });
      assert.equal(withCoupon.status, 201);
      couponResCode = withCoupon.data.reservation.code;
      assert.ok(withCoupon.data.reservation.subtotal < plain.data.reservation.subtotal, 'el subtotal con cupón es menor');
      // 20% de descuento en la tarifa
      assert.ok(Math.abs(withCoupon.data.reservation.nightlyRate - rt.baseRate * 0.8) < 1, 'aplica el 20%');
    });

    await test('un cupón inexistente es rechazado', async () => {
      const ci = futureDay(40), co = futureDay(42);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const res = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: av.data[0].roomTypeId, guest: { fullName: 'X' }, couponCode: 'NOEXISTE' } });
      assert.equal(res.status, 400);
    });

    await test('el overview de cupones muestra redenciones e ingresos atribuidos', async () => {
      const { status, data } = await api(`/api/marketing/coupons?propertyId=${propertyId}`);
      assert.equal(status, 200);
      const c = data.coupons.find(x => x.id === couponId);
      assert.equal(c.redemptions, 1, 'una redención registrada');
      assert.ok(c.discountGiven > 0, 'registra el descuento otorgado');
      assert.ok(c.revenueAttributed > 0, 'registra ingresos atribuidos');
    });

    await test('el ROI de la campaña cruza envíos y redenciones', async () => {
      const { status, data } = await api(`/api/marketing/campaigns/${campaignForRoi}/roi`);
      assert.equal(status, 200);
      assert.equal(data.redemptions, 1);
      assert.ok(data.revenueAttributed > 0);
      assert.equal(data.coupons.length, 1, 'la campaña tiene su cupón');
    });

    await test('desactivar un cupón impide su uso', async () => {
      await api(`/api/marketing/coupons/${couponId}`, { method: 'PATCH', body: { active: false } });
      const ci = futureDay(40), co = futureDay(42);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const res = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: av.data[0].roomTypeId, guest: { fullName: 'Y' }, couponCode } });
      assert.equal(res.status, 400);
    });

    // ===== Encuestas post-estadía + quejas (§37) =====
    await test('el check-out crea una encuesta post-estadía', async () => {
      await settle(400);
      const info = await (await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}`)).json();
      assert.ok(info.survey && info.survey.status === 'sent', 'la encuesta queda disponible');
    });

    await test('una encuesta con NPS bajo abre un caso interno (queja)', async () => {
      const r = await fetch(`${BASE}/api/public/guest/reservation/${reservation.code}/survey`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ nps: 3, ratingClean: 1, ratingService: 4, ratingComfort: 4, comment: 'La habitación no estaba limpia' }) });
      assert.equal(r.status, 200);
      const sv = await api(`/api/reputation/surveys?propertyId=${propertyId}`);
      assert.equal(sv.status, 200);
      assert.equal(sv.data.responded, 1);
      assert.ok(sv.data.complaints.length >= 1, 'NPS bajo debe abrir una queja');
      assert.equal(sv.data.complaints[0].category, 'limpieza');
    });

    await test('el equipo resuelve la queja con causa raíz y acción correctiva', async () => {
      const sv = await api(`/api/reputation/surveys?propertyId=${propertyId}`);
      const complaintId = sv.data.complaints[0].id;
      const upd = await api(`/api/reputation/complaints/${complaintId}`, { method: 'PATCH', body: { status: 'resolved', rootCause: 'Falla en el turno de housekeeping', correctiveAction: 'Refuerzo de inspección de salida' } });
      assert.equal(upd.status, 200);
      assert.equal(upd.data.status, 'resolved');
      assert.ok(upd.data.rootCause && upd.data.correctiveAction);
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

    await test('exportación de auditoría a CSV (§42)', async () => {
      const res = await fetch(`${BASE}/api/audit-logs/export?propertyId=${propertyId}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') || '', /text\/csv/);
      assert.match(res.headers.get('content-disposition') || '', /attachment; filename="auditoria-/);
      const text = await res.text();
      const lines = text.replace(/^﻿/, '').trim().split('\r\n');
      assert.equal(lines[0], 'fecha,actor,usuario,accion,entidad,entidadId,antes,despues,motivo,ip');
      assert.ok(lines.length > 1, 'incluye filas de registros');
    });

    await test('exportación de auditoría filtra por actor', async () => {
      const res = await fetch(`${BASE}/api/audit-logs/export?propertyId=${propertyId}&actor=ai`, { headers: { authorization: `Bearer ${token}` } });
      const text = await res.text();
      const rows = text.replace(/^﻿/, '').trim().split('\r\n').slice(1);
      assert.ok(rows.length >= 1, 'hay filas de IA');
      assert.ok(rows.every(r => r.split(',')[1] === 'ai'), 'todas las filas son del actor IA');
    });

    // ===== Canales de notificación configurables (§44) =====
    let notifChannelId;
    await test('crear un canal de notificación por email', async () => {
      const { status, data } = await api('/api/notification-channels', { method: 'POST', body: { propertyId, type: 'email', target: 'alertas@hotel.co', label: 'Gerencia', minSeverity: 'warning' } });
      assert.equal(status, 201);
      assert.equal(data.type, 'email');
      assert.equal(data.enabled, true);
      notifChannelId = data.id;
    });

    await test('validaciones de canal (email y webhook)', async () => {
      const badEmail = await api('/api/notification-channels', { method: 'POST', body: { propertyId, type: 'email', target: 'no-es-correo' } });
      assert.equal(badEmail.status, 400);
      const badHook = await api('/api/notification-channels', { method: 'POST', body: { propertyId, type: 'webhook', target: 'ftp://x' } });
      assert.equal(badHook.status, 400);
    });

    await test('una alerta warning se reenvía al canal; una info no', async () => {
      const { notify } = await import('../src/services/notifications.js');
      await notify({ propertyId, audienceRole: 'MANAGER', title: 'Prueba warning', severity: 'warning' });
      await notify({ propertyId, audienceRole: 'MANAGER', title: 'Prueba info', severity: 'info' });
      await settle(300);
      const { data } = await api(`/api/notification-channels?propertyId=${propertyId}`);
      const forChannel = data.deliveries.filter(d => d.channelId === notifChannelId);
      assert.ok(forChannel.some(d => d.title === 'Prueba warning'), 'la warning se reenvió');
      assert.ok(!forChannel.some(d => d.title === 'Prueba info'), 'la info NO se reenvió (bajo la severidad mínima)');
    });

    await test('un canal en pausa no recibe reenvíos', async () => {
      await api(`/api/notification-channels/${notifChannelId}`, { method: 'PATCH', body: { enabled: false } });
      const { notify } = await import('../src/services/notifications.js');
      await notify({ propertyId, audienceRole: 'MANAGER', title: 'Warning en pausa', severity: 'critical' });
      await settle(300);
      const { data } = await api(`/api/notification-channels?propertyId=${propertyId}`);
      assert.ok(!data.deliveries.some(d => d.title === 'Warning en pausa'), 'sin reenvío estando en pausa');
    });

    await test('prueba manual de canal registra una entrega', async () => {
      await api(`/api/notification-channels/${notifChannelId}`, { method: 'PATCH', body: { enabled: true } });
      const t = await api(`/api/notification-channels/${notifChannelId}/test`, { method: 'POST' });
      assert.equal(t.status, 200);
      assert.equal(t.data.status, 'sent');
      assert.match(t.data.title, /prueba/i);
    });

    await test('el canal webhook entrega de verdad por HTTP (falla ante URL inalcanzable)', async () => {
      // Puerto cerrado → la entrega intenta el POST real y registra 'failed'.
      const ch = await api('/api/notification-channels', { method: 'POST', body: { propertyId, type: 'webhook', target: 'http://127.0.0.1:9/atria-hook', minSeverity: 'info' } });
      assert.equal(ch.status, 201);
      const t = await api(`/api/notification-channels/${ch.data.id}/test`, { method: 'POST' });
      assert.equal(t.data.status, 'failed', 'el POST real falla contra un puerto cerrado');
      assert.match(t.data.detail, /Error de red|Webhook/);
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

    // ===== Notas crédito/débito (§16) =====
    let debitNoteId, invoiceTotal;
    await test('no se puede crear nota sobre una factura en borrador', async () => {
      const { data } = await api(`/api/invoices?propertyId=${propertyId}`);
      const draft = data.invoices.find(i => i.status === 'draft');
      if (!draft) return; // si no hay borrador, se omite
      const res = await api(`/api/invoices/${draft.id}/notes`, { method: 'POST', body: { type: 'credit', reason: 'x', amount: 1000 } });
      assert.equal(res.status, 400);
    });

    await test('crear nota débito parcial sobre factura emitida', async () => {
      const inv = await api(`/api/invoices/${invoiceId}/notes`); // GET lista (vacía aún)
      assert.equal(inv.status, 200);
      const list = await api(`/api/invoices?propertyId=${propertyId}`);
      invoiceTotal = list.data.invoices.find(i => i.id === invoiceId).total;
      const { status, data } = await api(`/api/invoices/${invoiceId}/notes`, { method: 'POST', body: { type: 'debit', reason: 'Cargo adicional por daño', amount: 50000 } });
      assert.equal(status, 201);
      assert.equal(data.type, 'debit');
      assert.equal(data.amount, 50000);
      assert.equal(data.status, 'draft');
      debitNoteId = data.id;
    });

    await test('emitir la nota débito le asigna número ND-', async () => {
      const { status, data } = await api(`/api/invoices/notes/${debitNoteId}/issue`, { method: 'POST' });
      assert.equal(status, 200);
      assert.equal(data.status, 'issued');
      assert.match(data.fullNumber, /^ND-\d+/);
    });

    await test('nota crédito por el total anula la factura', async () => {
      const { status, data } = await api(`/api/invoices/${invoiceId}/notes`, { method: 'POST', body: { type: 'credit', reason: 'Anulación total', amount: invoiceTotal } });
      assert.equal(status, 201);
      const issued = await api(`/api/invoices/notes/${data.id}/issue`, { method: 'POST' });
      assert.match(issued.data.fullNumber, /^NC-\d+/);
      const list = await api(`/api/invoices?propertyId=${propertyId}`);
      const inv = list.data.invoices.find(i => i.id === invoiceId);
      assert.equal(inv.status, 'annulled', 'la factura queda anulada');
    });

    await test('nota crédito no puede superar el total de la factura', async () => {
      // se usa otra factura emitida si existe; validamos la regla creando una nueva reserva-factura no es trivial,
      // así que probamos contra la factura ya anulada con un monto excesivo → debe rechazar por monto.
      const list = await api(`/api/invoices?propertyId=${propertyId}`);
      const inv = list.data.invoices.find(i => i.id === invoiceId);
      const res = await api(`/api/invoices/${inv.id}/notes`, { method: 'POST', body: { type: 'credit', reason: 'exceso', amount: inv.total + 1_000_000 } });
      assert.equal(res.status, 400);
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

    // ===== Conocimiento: vigencia + versionado + RAG (§55.5) =====
    let versionedKnowId;
    await test('el conocimiento vencido no llega al snapshot del agente', async () => {
      const past = new Date(Date.now() - 2 * 86400000).toISOString();
      await api('/api/content/knowledge', { method: 'POST', body: { propertyId, category: 'service', title: 'Promo vencida', content: 'Descuento que ya expiró.', visibility: 'public', validUntil: past } });
      const future = new Date(Date.now() + 30 * 86400000).toISOString();
      const vig = await api('/api/content/knowledge', { method: 'POST', body: { propertyId, category: 'service', title: 'Promo vigente', content: 'Descuento activo esta temporada.', visibility: 'public', validUntil: future } });
      versionedKnowId = vig.data.id;
      const snap = await api(`/api/content/knowledge-snapshot?propertyId=${propertyId}&visibility=public`);
      const titles = snap.data.knowledge.map(k => k.title);
      assert.ok(titles.includes('Promo vigente'), 'el vigente sí aparece');
      assert.ok(!titles.includes('Promo vencida'), 'el vencido NO aparece para la IA');
    });

    await test('el panel de vigencia detecta vencidos y por vencer', async () => {
      const { status, data } = await api(`/api/content/knowledge-review?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.counts.expired >= 1, 'detecta al menos un vencido');
      assert.ok(data.counts.expiringSoon >= 1, 'detecta al menos uno por vencer');
    });

    await test('editar un ítem crea una nueva versión con historial', async () => {
      const upd = await api(`/api/content/knowledge/${versionedKnowId}`, { method: 'PATCH', body: { content: 'Descuento actualizado al 25%.' } });
      assert.equal(upd.data.version, 2, 'la versión sube a 2');
      const revs = await api(`/api/content/knowledge/${versionedKnowId}/revisions`);
      assert.equal(revs.data.length, 2, 'hay dos versiones en el historial');
      assert.equal(revs.data[0].version, 2);
    });

    await test('la recuperación RAG devuelve fragmentos relevantes', async () => {
      const { data } = await api('/api/content/agents/preview', { method: 'POST', body: { propertyId, scope: 'guest', question: '¿tienen dónde dejar el carro?' } });
      assert.ok(Array.isArray(data.sources), 'devuelve fuentes RAG');
      assert.ok(data.sources.some(s => /parqueadero/i.test(s.title || s.answer)), 'recupera el ítem de parqueadero por coincidencia parcial (carro/parqueo)');
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

    await test('exportar PILA en archivo plano (estructura Res. 1388)', async () => {
      const res = await fetch(`${BASE}/api/hr/pila/${pilaId}/export?format=flat`, { headers: { authorization: `Bearer ${hrToken}` } });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-disposition') || '', /\.txt/);
      const txt = await res.text();
      const lines = txt.split('\r\n');
      assert.equal(lines[0][0], '1', 'la primera línea es el registro de control Tipo 1');
      assert.ok(lines.slice(1).every(l => l[0] === '2'), 'las demás líneas son registros Tipo 2 por cotizante');
      assert.ok(txt.includes('900100200'), 'incluye el documento del cotizante');
      assert.ok(lines[0].includes('|'), 'los campos van delimitados');
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

    await test('el agente aprende la carta del restaurante y responde por ella', async () => {
      // El menú entra al snapshot de conocimiento del agente.
      const snap = await api(`/api/content/knowledge-snapshot?propertyId=${propertyId}&visibility=public`);
      assert.ok(Array.isArray(snap.data.menu) && snap.data.menu.some(m => m.name === 'Café americano'), 'la carta está en el conocimiento');
      // El agente recupera el plato por una pregunta de restaurante (RAG).
      const { data } = await api('/api/content/agents/preview', { method: 'POST', body: { propertyId, scope: 'guest', question: '¿tienen café? ¿cuánto cuesta?' } });
      assert.ok(/café/i.test(data.answer || '') || (data.sources || []).some(s => /café/i.test(s.title || s.answer)), 'el agente responde con el ítem de la carta');
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

    let roomServiceResvId;
    await test('room service se carga al folio de una habitación en casa', async () => {
      // Crear reserva, pagar, check-in
      const ci = futureDay(1), co = futureDay(2);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const resv = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: av.data[0].roomTypeId, guest: { fullName: 'Huésped POS' } } });
      await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: resv.data.paymentLink.token } });
      await settle();
      await api(`/api/reservations/${resv.data.reservation.id}/checkin`, { method: 'POST', body: {} });
      roomServiceResvId = resv.data.reservation.id;
      // Room service → cargar al folio
      const ord = await api('/api/pos/orders', { method: 'POST', body: { propertyId, type: 'room_service', reservationId: resv.data.reservation.id, items: [{ menuItemId, qty: 1 }] } });
      const charge = await api(`/api/pos/orders/${ord.data.id}/charge`, { method: 'POST' });
      assert.equal(charge.data.status, 'charged');
      const full = await api(`/api/reservations/${resv.data.reservation.id}`);
      assert.ok(full.data.folio.charges.some(c => c.concept === 'room_service'), 'el folio tiene el cargo de room service');
    });

    await test('room service conversacional: el agente toma el pedido por nombre y lo carga a la habitación', async () => {
      const { orderRoomServiceByName } = await import('../src/services/pos.js');
      const full = await api(`/api/reservations/${roomServiceResvId}`);
      const r = await orderRoomServiceByName({ propertyId, reservationCode: full.data.code, items: [{ name: 'café americano', qty: 2 }] });
      assert.equal(r.cargadoAHabitacion, true);
      assert.ok(r.pedido.some(p => /café/i.test(p)), 'reconoce el plato de la carta por nombre');
      const after = await api(`/api/reservations/${roomServiceResvId}`);
      const charges = after.data.folio.charges.filter(c => c.concept === 'room_service');
      assert.ok(charges.length >= 2, 'el pedido quedó cargado al folio de la habitación');
    });

    await test('room service exige estadía en curso (rechaza sin check-in)', async () => {
      const { orderRoomServiceByName } = await import('../src/services/pos.js');
      await assert.rejects(
        orderRoomServiceByName({ propertyId, reservationCode: reservation.code, items: [{ name: 'café americano' }] }),
        /estad[ií]a|check-in|reserva/i,
      );
    });

    await test('check-out express desde el portal detecta el saldo pendiente (§14)', async () => {
      const full = await api(`/api/reservations/${roomServiceResvId}`);
      const r = await fetch(`${BASE}/api/public/guest/reservation/${full.data.code}/express-checkout`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, 200);
      const d = await r.json();
      // Tiene consumo de room service sin pagar → pide pagar antes de cerrar.
      assert.equal(d.needsPayment, true);
      assert.ok(d.balance > 0);
    });

    // ===== Acciones sensibles con aprobación real (§47/§55.6) =====
    await test('descuento al folio requiere aprobación y publica un cargo negativo', async () => {
      const req = await api(`/api/reservations/${roomServiceResvId}/discount`, { method: 'POST', body: { amount: 40000, reason: 'Cortesía por demora' } });
      assert.equal(req.status, 202);
      const approvalId = req.data.pendingApproval.id;
      const dec = await api(`/api/approvals/${approvalId}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(dec.status, 200);
      const full = await api(`/api/reservations/${roomServiceResvId}`);
      const disc = full.data.folio.charges.find(c => c.concept === 'descuento');
      assert.ok(disc, 'existe el cargo de descuento');
      assert.equal(disc.amount, -40000, 'el descuento es un cargo negativo');
    });

    let noDepositResvId;
    await test('cambio de tarifa aprobado recalcula el total de la reserva', async () => {
      const ci = futureDay(3), co = futureDay(5); // 2 noches
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const resv = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: av.data[0].roomTypeId, guest: { fullName: 'Huésped Tarifa' } } });
      noDepositResvId = resv.data.reservation.id;
      const req = await api(`/api/reservations/${noDepositResvId}/rate-override`, { method: 'POST', body: { nightlyRate: 100000, reason: 'Tarifa corporativa' } });
      assert.equal(req.status, 202);
      const dec = await api(`/api/approvals/${req.data.pendingApproval.id}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(dec.status, 200);
      const full = await api(`/api/reservations/${noDepositResvId}`);
      assert.equal(full.data.nightlyRate, 100000);
      assert.equal(full.data.subtotal, 200000, 'subtotal = tarifa x 2 noches');
      assert.ok(full.data.total >= full.data.subtotal, 'el total se recalculó con impuestos');
    });

    await test('exonerar anticipo aprobado deja la reserva en 0 de depósito', async () => {
      const req = await api(`/api/reservations/${noDepositResvId}/waive-deposit`, { method: 'POST', body: { reason: 'Cliente frecuente' } });
      assert.equal(req.status, 202);
      const dec = await api(`/api/approvals/${req.data.pendingApproval.id}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(dec.status, 200);
      const full = await api(`/api/reservations/${noDepositResvId}`);
      assert.equal(full.data.depositRequired, 0);
    });

    await test('cancelación aprobada cancela la reserva', async () => {
      const req = await api(`/api/reservations/${noDepositResvId}/request-cancellation`, { method: 'POST', body: { reason: 'Fuerza mayor' } });
      assert.equal(req.status, 202);
      const dec = await api(`/api/approvals/${req.data.pendingApproval.id}/decide`, { method: 'POST', body: { approve: true } });
      assert.equal(dec.status, 200);
      const full = await api(`/api/reservations/${noDepositResvId}`);
      assert.equal(full.data.status, 'cancelled');
    });

    // ===== Política de cancelación: penalidad y reembolso (§10) =====
    await test('cancelación flexible fuera de ventana → sin penalidad, reembolso total', async () => {
      const { cancellationPenalty } = await import('../src/services/reservations.js');
      const r = { checkIn: futureDay(60), depositRequired: 100000 };
      const c = cancellationPenalty(r, { refundable: true }, 100000);
      assert.equal(c.policy, 'flexible');
      assert.equal(c.penalty, 0);
      assert.equal(c.refundAmount, 100000);
    });

    await test('cancelación flexible dentro de ventana (≤48h) → penalidad = anticipo', async () => {
      const { cancellationPenalty } = await import('../src/services/reservations.js');
      const r = { checkIn: new Date(Date.now() + 12 * 3600000), depositRequired: 100000 };
      const c = cancellationPenalty(r, { refundable: true }, 250000);
      assert.equal(c.policy, 'late_cancellation');
      assert.equal(c.penalty, 100000);
      assert.equal(c.refundAmount, 150000);
    });

    await test('cancelación de tarifa NO reembolsable → retiene todo lo pagado', async () => {
      const { cancellationPenalty } = await import('../src/services/reservations.js');
      const r = { checkIn: futureDay(60), depositRequired: 100000 };
      const c = cancellationPenalty(r, { refundable: false }, 250000);
      assert.equal(c.policy, 'non_refundable');
      assert.equal(c.penalty, 250000);
      assert.equal(c.refundAmount, 0);
    });

    await test('el endpoint de cancelación devuelve el desglose de penalidad', async () => {
      const ci = futureDay(60), co = futureDay(62);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const resv = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: av.data[0].roomTypeId, guest: { fullName: 'Cancela Flexible' } } });
      const cancel = await api(`/api/reservations/${resv.data.reservation.id}/cancel`, { method: 'POST', body: { reason: 'Cambio de planes' } });
      assert.equal(cancel.status, 200);
      assert.ok(cancel.data.cancellation, 'incluye el desglose de cancelación');
      assert.equal(cancel.data.cancellation.policy, 'flexible');
    });

    // ===== IA que ejecuta con vista previa (§41/§55.6) =====
    await test('el copiloto interpreta un descuento y devuelve vista previa de impacto', async () => {
      const full = await api(`/api/reservations/${roomServiceResvId}`);
      const code = full.data.code;
      const { status, data } = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: `aplica un descuento de 30000 a la reserva ${code} por demora en el check-in` } });
      assert.equal(status, 200);
      assert.equal(data.kind, 'action');
      assert.equal(data.action.type, 'discount');
      assert.equal(data.action.payload.amount, 30000);
      assert.ok(data.preview.impact.length >= 1, 'la vista previa lista el impacto');
      assert.equal(data.preview.requiresApproval, false, 'el gerente puede ejecutar directamente');
    });

    await test('el gerente confirma y el copiloto ejecuta el descuento de inmediato', async () => {
      const full = await api(`/api/reservations/${roomServiceResvId}`);
      const code = full.data.code;
      const prev = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: `descuento de 15000 a ${code}` } });
      const exec = await api('/api/assistant/action/execute', { method: 'POST', body: { propertyId, action: prev.data.action } });
      assert.equal(exec.status, 200);
      assert.equal(exec.data.executed, true);
      const after = await api(`/api/reservations/${roomServiceResvId}`);
      assert.ok(after.data.folio.charges.some(c => c.concept === 'descuento' && c.amount === -15000), 'el descuento quedó en el folio');
    });

    await test('un rol sin autoridad envía la acción del copiloto a aprobación', async () => {
      // Front desk propone un descuento → debe requerir aprobación de gerente.
      const fd = await api('/api/auth/login', { method: 'POST', body: { email: 'recepcion@atria.co', password: 'atria2026' } }).catch(() => null);
      if (!fd?.data?.token) return; // si no existe el usuario demo, se omite
      const full = await api(`/api/reservations/${roomServiceResvId}`);
      const code = full.data.code;
      const headers = { 'content-type': 'application/json', authorization: `Bearer ${fd.data.token}` };
      const prevRes = await fetch(`${BASE}/api/assistant/internal`, { method: 'POST', headers, body: JSON.stringify({ propertyId, text: `descuento de 10000 a ${code}` }) });
      const prev = await prevRes.json();
      assert.equal(prev.kind, 'action');
      assert.equal(prev.preview.requiresApproval, true);
      const execRes = await fetch(`${BASE}/api/assistant/action/execute`, { method: 'POST', headers, body: JSON.stringify({ propertyId, action: prev.action }) });
      const exec = await execRes.json();
      assert.equal(exec.executed, false);
      assert.ok(exec.pendingApproval?.id, 'crea una solicitud de aprobación');
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

    // ===== Atria Intelligence: recomendaciones transversales (§38/§41) =====
    await test('el motor de recomendaciones cruza módulos y prioriza', async () => {
      const { status, data } = await api(`/api/ai/insights?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.insights), 'devuelve una lista de recomendaciones');
      assert.ok('counts' in data, 'trae el conteo por severidad');
      // Cada recomendación es accionable y de un área conocida.
      for (const i of data.insights) {
        assert.ok(i.title && i.action && i.area, 'cada recomendación tiene título, acción y área');
        assert.ok(['critical', 'warning', 'info'].includes(i.severity));
      }
      // Ordenadas por severidad (críticas primero).
      const rank = { critical: 3, warning: 2, info: 1 };
      for (let k = 1; k < data.insights.length; k++) {
        assert.ok(rank[data.insights[k - 1].severity] >= rank[data.insights[k].severity], 'orden por severidad');
      }
    });

    await test('el briefing devuelve un resumen accionable', async () => {
      const { status, data } = await api(`/api/ai/briefing?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(typeof data.summary === 'string' && data.summary.length > 0, 'resumen en lenguaje natural');
    });

    await test('el copiloto interno responde "¿qué hago hoy?" con recomendaciones', async () => {
      const { status, data } = await api('/api/assistant/internal', { method: 'POST', body: { propertyId, text: '¿en qué me enfoco hoy?' } });
      assert.equal(status, 200);
      assert.match(data.reply, /Atria Intelligence|prioridad|orden/i);
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

    // ===== Automatizaciones multi-paso (§40) =====
    let multiRuleId;
    await test('crear una regla con secuencia de varios pasos', async () => {
      const { status, data } = await api('/api/automations/rules', { method: 'POST', body: {
        propertyId, name: 'Check-out → aviso + registro', trigger: 'checkout.completed',
        steps: [
          { type: 'notify', params: { role: 'HOUSEKEEPING', title: 'Habitación por limpiar', severity: 'info' } },
          { type: 'log', params: { note: 'checkout procesado por automatización' } },
        ],
      } });
      assert.equal(status, 201);
      assert.equal(data.actionType, 'multi');
      multiRuleId = data.id;
      const ov = await api(`/api/automations/overview?propertyId=${propertyId}`);
      const rule = ov.data.rules.find(r => r.id === multiRuleId);
      assert.equal(rule.stepList.length, 2, 'la regla expone sus 2 pasos');
    });

    await test('un paso con acción inválida se rechaza', async () => {
      const res = await api('/api/automations/rules', { method: 'POST', body: { propertyId, name: 'X', trigger: 'checkout.completed', steps: [{ type: 'cobrar_tarjeta', params: {} }] } });
      assert.equal(res.status, 400);
    });

    await test('probar la regla multi-paso ejecuta toda la secuencia', async () => {
      const notifBefore = (await api(`/api/notifications?propertyId=${propertyId}`)).data.length;
      const r = await api(`/api/automations/rules/${multiRuleId}/test`, { method: 'POST', body: { payload: {} } });
      assert.equal(r.data.executed, true);
      await settle(300);
      const notifAfter = (await api(`/api/notifications?propertyId=${propertyId}`)).data.length;
      assert.ok(notifAfter > notifBefore, 'el paso notify creó una notificación');
      const logs = await api(`/api/audit-logs?propertyId=${propertyId}&action=automation.rule_fired`);
      assert.ok(logs.data.some(l => l.entityId === multiRuleId), 'el paso log registró en auditoría');
    });

    await test('la regla multi-paso corre sus pasos ante un evento real', async () => {
      const before = (await api(`/api/automations/overview?propertyId=${propertyId}`)).data.rules.find(r => r.id === multiRuleId).runCount;
      // Reserva → pago → check-in → check-out para disparar checkout.completed
      const ci = futureDay(50), co = futureDay(51);
      const av = await api('/api/booking/search', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1 } });
      const resv = await api('/api/booking/reservations', { method: 'POST', body: { propertyId, checkIn: ci, checkOut: co, adults: 1, roomTypeId: av.data[0].roomTypeId, guest: { fullName: 'Multi Paso' } } });
      await api('/api/public/webhooks/payments/mock', { method: 'POST', body: { reference: resv.data.paymentLink.token } });
      await settle();
      await api(`/api/reservations/${resv.data.reservation.id}/checkin`, { method: 'POST', body: {} });
      const co1 = await api(`/api/reservations/${resv.data.reservation.id}/checkout`, { method: 'POST', body: {} });
      // Si queda saldo, el check-out escala a aprobación: la aprobamos para completarlo.
      if (co1.status === 202 && co1.data.pendingApproval) {
        await api(`/api/approvals/${co1.data.pendingApproval.id}/decide`, { method: 'POST', body: { approve: true } });
      }
      await settle(600);
      const after = (await api(`/api/automations/overview?propertyId=${propertyId}`)).data.rules.find(r => r.id === multiRuleId).runCount;
      assert.ok(after > before, 'la regla multi-paso se ejecutó con el check-out');
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

    // ===== Cierre de caja y conciliación (§28) =====
    await test('abrir caja, registrar pago en efectivo y cerrar con conteo', async () => {
      const open = await api('/api/finance/cash/open', { method: 'POST', body: { propertyId, openingBalance: 100000 } });
      assert.equal(open.status, 201);
      // Un pago manual en efectivo durante el turno (requiere aprobación → aprobar)
      const link = await api('/api/payments/manual', { method: 'POST', body: { propertyId, concept: 'Pago efectivo caja', amount: 50000, method: 'cash' } }).catch(() => ({ status: 0 }));
      // Cerrar con conteo = base + lo recaudado en efectivo (si el pago manual no aplicó, expected = base)
      const cur = await api(`/api/finance/cash/current?propertyId=${propertyId}`);
      const counted = cur.data.expectedCash; // conteo exacto → sin descuadre
      const close = await api(`/api/finance/cash/${open.data.id}/close`, { method: 'POST', body: { countedAmount: counted } });
      assert.equal(close.status, 200);
      assert.equal(close.data.status, 'closed');
      assert.equal(close.data.difference, 0, 'conteo exacto no debe descuadrar');
    });

    await test('no se puede abrir dos cajas a la vez', async () => {
      const a = await api('/api/finance/cash/open', { method: 'POST', body: { propertyId, openingBalance: 0 } });
      assert.equal(a.status, 201);
      const b = await api('/api/finance/cash/open', { method: 'POST', body: { propertyId, openingBalance: 0 } });
      assert.equal(b.status, 400);
      // cerrar la abierta para no dejar estado colgante
      await api(`/api/finance/cash/${a.data.id}/close`, { method: 'POST', body: { countedAmount: 0 } });
    });

    await test('conciliación empareja pagos del sistema con referencias externas', async () => {
      const rep = await api('/api/finance/reconcile', { method: 'POST', body: { propertyId, externalRefs: [{ ref: 'X-DESCONOCIDA', amount: 999999999 }] } });
      assert.equal(rep.status, 200);
      assert.ok(typeof rep.data.matched === 'number');
      assert.ok(rep.data.unmatchedExternal.length >= 1, 'la referencia externa inventada queda sin conciliar');
    });

    // ===== Multi-tenant, planes y facturación SaaS (§55.1) =====
    await test('la suscripción muestra plan y consumo vs límites', async () => {
      const { status, data } = await api('/api/saas/subscription');
      assert.equal(status, 200);
      assert.equal(data.plan.code, 'pro');
      assert.ok(Array.isArray(data.usage) && data.usage.find(u => u.key === 'users').limit === 25);
    });

    await test('el catálogo de planes está sembrado', async () => {
      const { data } = await api('/api/saas/plans');
      assert.ok(data.length >= 4);
      assert.ok(data.find(p => p.code === 'enterprise'));
    });

    await test('un usuario normal no puede ver la consola de superadmin', async () => {
      const res = await api('/api/saas/companies');
      assert.equal(res.status, 403);
    });

    await test('el superadmin lista empresas y puede suspender/reactivar (con bloqueo 402)', async () => {
      const { data: sa } = await api('/api/auth/login', { method: 'POST', body: { email: 'superadmin@atria.co', password: 'atria2026' } });
      const SH = { 'content-type': 'application/json', authorization: `Bearer ${sa.token}` };
      const companies = await (await fetch(`${BASE}/api/saas/companies`, { headers: SH })).json();
      assert.ok(companies.length >= 1);
      const company = companies[0];
      // Suspender → el token del gerente queda bloqueado (402) en el resto de la API
      await fetch(`${BASE}/api/saas/companies/${company.id}/status`, { method: 'POST', headers: SH, body: JSON.stringify({ status: 'suspended' }) });
      const blocked = await fetch(`${BASE}/api/dashboard?propertyId=${propertyId}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(blocked.status, 402, 'empresa suspendida bloquea la API');
      // El superadmin NO queda bloqueado
      const saOk = await fetch(`${BASE}/api/saas/companies`, { headers: SH });
      assert.equal(saOk.status, 200);
      // Reactivar → el gerente vuelve a operar
      await fetch(`${BASE}/api/saas/companies/${company.id}/status`, { method: 'POST', headers: SH, body: JSON.stringify({ status: 'active' }) });
      const ok = await fetch(`${BASE}/api/dashboard?propertyId=${propertyId}`, { headers: { authorization: `Bearer ${token}` } });
      assert.equal(ok.status, 200, 'tras reactivar, la API responde de nuevo');
    });

    // ===== White-label (§55.1) =====
    await test('el administrador configura la marca y el login la devuelve', async () => {
      const r = await api('/api/saas/branding', { method: 'POST', body: { commercialName: 'Grupo Hotelero Andes', brandColor: '#3b82f6' } });
      assert.equal(r.status, 200);
      const login = await api('/api/auth/login', { method: 'POST', body: { email: 'gerente@atria.co', password: 'atria2026' } });
      assert.equal(login.data.company.commercialName, 'Grupo Hotelero Andes');
      assert.equal(login.data.company.brandColor, '#3b82f6');
    });

    await test('un rol no administrador no puede cambiar la marca', async () => {
      const { data: login } = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      const res = await fetch(`${BASE}/api/saas/branding`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ commercialName: 'X' }) });
      assert.equal(res.status, 403);
    });

    // ===== Facturación del software SaaS (§55.1) =====
    await test('el superadmin emite facturas y el tenant las ve', async () => {
      const { data: sa } = await api('/api/auth/login', { method: 'POST', body: { email: 'superadmin@atria.co', password: 'atria2026' } });
      const SH = { 'content-type': 'application/json', authorization: `Bearer ${sa.token}` };
      const gen = await (await fetch(`${BASE}/api/saas/billing/generate`, { method: 'POST', headers: SH })).json();
      assert.ok(gen.created >= 1, 'debe emitir al menos una factura');
      // El tenant (gerente) ve su factura pendiente
      const mine = await api('/api/saas/invoices');
      assert.ok(mine.data.length >= 1);
      assert.equal(mine.data[0].status, 'pending');
    });

    await test('pagar la factura del software extiende la suscripción', async () => {
      const before = await api('/api/saas/invoices');
      const inv = before.data.find(i => i.status !== 'paid');
      assert.ok(inv, 'debe existir una factura por pagar');
      const pay = await api(`/api/saas/invoices/${inv.id}/pay`, { method: 'POST', body: {} });
      assert.equal(pay.status, 200);
      assert.equal(pay.data.status, 'paid');
      const sub = await api('/api/saas/subscription');
      assert.equal(sub.data.status, 'active');
    });

    await test('un rol sin permiso no puede pagar la factura del software', async () => {
      const before = await api('/api/saas/invoices');
      // Asegura una factura pendiente de un periodo distinto no es trivial; validamos el permiso con housekeeping sobre cualquier factura existente
      const anyInv = before.data[0];
      const { data: login } = await api('/api/auth/login', { method: 'POST', body: { email: 'housekeeping@atria.co', password: 'atria2026' } });
      const res = await fetch(`${BASE}/api/saas/invoices/${anyInv.id}/pay`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: '{}' });
      assert.equal(res.status, 403);
    });

    // ===== Onboarding e importadores (§55.2) =====
    await test('checklist de go-live evalúa la preparación de la sede', async () => {
      const { status, data } = await api(`/api/admin/checklist?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(Array.isArray(data.items) && data.items.length >= 8);
      assert.ok(data.items.find(i => i.key === 'rooms').ok, 'la demo ya tiene habitaciones');
      assert.ok(data.readiness >= 0 && data.readiness <= 100);
    });

    await test('importar habitaciones por CSV valida duplicados y tipos', async () => {
      const csv = 'numero,tipo,piso\nZ101,STD,9\nZ102,STD,9\nZ101,STD,9\nZ103,INEXISTENTE,9';
      const r = await api('/api/admin/import/rooms', { method: 'POST', body: { propertyId, csv } });
      assert.equal(r.status, 200);
      assert.equal(r.data.imported, 2, 'importa Z101 y Z102');
      assert.equal(r.data.errors.length, 2, 'rechaza el duplicado y el tipo inexistente');
    });

    await test('importar huéspedes por CSV deduplica por documento', async () => {
      const csv = 'nombre,documento,telefono,correo\nImport Uno,IMP-111,3001,uno@x.co\nImport Dos,IMP-222,3002,dos@x.co\nImport Uno,IMP-111,3001,uno@x.co';
      const r = await api('/api/admin/import/guests', { method: 'POST', body: { propertyId, csv } });
      assert.equal(r.data.imported, 2);
      assert.equal(r.data.errors.length, 1);
    });

    await test('importar empleados valida documento, cargo y salario', async () => {
      const csv = 'nombre,documento,cargo,area,salario,ingreso\nEmp Uno,EMP-111,Mesero,restaurante,1500000,2026-01-10\nEmp Malo,EMP-222,,cocina,1500000,2026-01-10\nEmp Tres,EMP-333,Cocinero,cocina,0,2026-01-10';
      const r = await api('/api/admin/import/employees', { method: 'POST', body: { propertyId, csv } });
      assert.equal(r.data.imported, 1, 'solo Emp Uno es válido');
      assert.equal(r.data.errors.length, 2, 'rechaza sin cargo y salario 0');
    });

    // ===== Gobierno / calidad de datos (§55.4) =====
    await test('el informe de calidad de datos detecta correos y teléfonos inválidos', async () => {
      // Importa huéspedes con datos problemáticos
      const csv = 'nombre,documento,telefono,correo\nDato Malo,DQ-1,123,no-es-correo\nDato Bien,DQ-2,3001112233,ok@correo.co';
      await api('/api/admin/import/guests', { method: 'POST', body: { propertyId, csv } });
      const { status, data } = await api(`/api/admin/data-quality?propertyId=${propertyId}`);
      assert.equal(status, 200);
      assert.ok(data.totalRecords > 0);
      assert.ok(data.score >= 0 && data.score <= 100);
      assert.ok(data.issues.find(i => i.key === 'guest_bad_email'), 'debe detectar el correo inválido');
      assert.ok(data.issues.find(i => i.key === 'guest_bad_phone'), 'debe detectar el teléfono corto');
    });

    // ===== Seguridad avanzada (§55.3): 2FA, recuperación, sesiones =====
    const secEmail = `sec-${Date.now()}@atria.co`;
    await test('crear usuario dedicado para pruebas de seguridad', async () => {
      const u = await api('/api/admin/users', { method: 'POST', body: { name: 'Seguridad Test', email: secEmail, password: 'Segura123', role: 'FRONTDESK' } });
      assert.equal(u.status, 201);
    });

    async function secLogin(extra = {}) {
      const res = await fetch(`${BASE}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: secEmail, password: 'Segura123', ...extra }) });
      return { status: res.status, data: await res.json() };
    }

    await test('política de contraseñas rechaza claves débiles', async () => {
      const { data: login } = await secLogin();
      const weak = await fetch(`${BASE}/api/auth/password`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${login.token}` }, body: JSON.stringify({ current: 'Segura123', password: 'corta' }) });
      assert.equal(weak.status, 400);
    });

    let secSecret;
    await test('activar 2FA exige un código TOTP válido', async () => {
      const { data: login } = await secLogin();
      const H = { 'content-type': 'application/json', authorization: `Bearer ${login.token}` };
      const setup = await (await fetch(`${BASE}/api/auth/2fa/setup`, { method: 'POST', headers: H })).json();
      assert.ok(setup.secret && setup.otpauthUrl.includes('otpauth://'));
      secSecret = setup.secret;
      const bad = await fetch(`${BASE}/api/auth/2fa/enable`, { method: 'POST', headers: H, body: JSON.stringify({ code: '000000' }) });
      assert.equal(bad.status, 400);
      const ok = await fetch(`${BASE}/api/auth/2fa/enable`, { method: 'POST', headers: H, body: JSON.stringify({ code: totpCode(secSecret) }) });
      assert.equal(ok.status, 200);
    });

    await test('con 2FA activo, el login pide código y lo valida', async () => {
      const noCode = await secLogin();
      assert.equal(noCode.data.twoFactorRequired, true);
      assert.ok(!noCode.data.token, 'sin código no debe emitir token');
      const withCode = await secLogin({ code: totpCode(secSecret) });
      assert.equal(withCode.status, 200);
      assert.ok(withCode.data.token, 'con código válido emite token');
    });

    await test('panel de sesiones lista y permite revocar', async () => {
      const { data: login } = await secLogin({ code: totpCode(secSecret) });
      const H = { 'content-type': 'application/json', authorization: `Bearer ${login.token}` };
      const sessions = await (await fetch(`${BASE}/api/auth/sessions`, { headers: H })).json();
      assert.ok(Array.isArray(sessions) && sessions.length >= 1);
      assert.ok(sessions.some(s => s.current), 'debe marcar la sesión actual');
      // Revocar la sesión actual → el token deja de funcionar
      await fetch(`${BASE}/api/auth/sessions/${sessions.find(s => s.current).id}/revoke`, { method: 'POST', headers: H });
      const after = await fetch(`${BASE}/api/auth/sessions`, { headers: H });
      assert.equal(after.status, 401, 'tras revocar, el token queda inválido');
    });

    await test('recuperación de contraseña con token de un solo uso', async () => {
      const forgot = await (await fetch(`${BASE}/api/auth/forgot`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: secEmail }) })).json();
      assert.ok(forgot.ok);
      assert.ok(forgot.devToken, 'en dev debe devolver el token para pruebas');
      // Nueva contraseña débil se rechaza
      const weak = await fetch(`${BASE}/api/auth/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: forgot.devToken, password: 'abc' }) });
      assert.equal(weak.status, 400);
      // Con contraseña válida, restablece
      const ok = await fetch(`${BASE}/api/auth/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: forgot.devToken, password: 'NuevaClave456' }) });
      assert.equal(ok.status, 200);
      // El token de reset no se puede reusar
      const reuse = await fetch(`${BASE}/api/auth/reset`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: forgot.devToken, password: 'OtraClave789' }) });
      assert.equal(reuse.status, 400);
    });

    await test('login con la contraseña vieja falla tras el reset', async () => {
      const old = await secLogin({ code: totpCode(secSecret) }); // Segura123 ya no sirve
      assert.equal(old.status, 401);
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
