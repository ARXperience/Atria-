// Onboarding e importadores (§55.2): carga masiva desde CSV con validación de
// duplicados y errores antes de crear, y checklist de go-live.
import { prisma } from '../db.js';
import { csvToObjects } from '../lib/csv.js';
import { gatewaysStatus } from './gateways/index.js';

// Toma el primer valor no vacío entre varios alias de encabezado (es/en).
function pick(obj, ...keys) {
  for (const k of keys) { const v = obj[k]; if (v != null && String(v).trim() !== '') return String(v).trim(); }
  return '';
}

function parseRows(input) {
  if (Array.isArray(input)) return input.map(r => Object.fromEntries(Object.entries(r).map(([k, v]) => [k.toLowerCase(), v])));
  return csvToObjects(input);
}

export async function importRooms(propertyId, input) {
  const rows = parseRows(input);
  const types = await prisma.roomType.findMany({ where: { propertyId } });
  const byCode = new Map(types.map(t => [t.code.toLowerCase(), t]));
  const byName = new Map(types.map(t => [t.name.toLowerCase(), t]));
  const existing = new Set((await prisma.room.findMany({ where: { propertyId }, select: { number: true } })).map(r => r.number));
  const seen = new Set();
  let imported = 0; const errors = [];
  for (const [i, r] of rows.entries()) {
    const number = pick(r, 'numero', 'número', 'number', 'habitacion', 'habitación');
    const typeKey = pick(r, 'tipo', 'type', 'roomtype', 'tipocodigo', 'codigo', 'código').toLowerCase();
    const floor = pick(r, 'piso', 'floor');
    if (!number) { errors.push({ row: i + 2, reason: 'número vacío' }); continue; }
    if (existing.has(number) || seen.has(number)) { errors.push({ row: i + 2, number, reason: 'habitación duplicada' }); continue; }
    const rt = byCode.get(typeKey) || byName.get(typeKey);
    if (!rt) { errors.push({ row: i + 2, number, reason: `tipo de habitación no encontrado (${typeKey || 'vacío'})` }); continue; }
    await prisma.room.create({ data: { propertyId, roomTypeId: rt.id, number, floor: floor || number[0] || '1' } });
    seen.add(number); imported++;
  }
  return { imported, errors, total: rows.length };
}

export async function importGuests(propertyId, input) {
  const rows = parseRows(input);
  const existingDocs = new Set((await prisma.guest.findMany({ where: { propertyId }, select: { documentNumber: true } })).map(g => g.documentNumber).filter(Boolean));
  const seen = new Set();
  let imported = 0; const errors = [];
  for (const [i, r] of rows.entries()) {
    const fullName = pick(r, 'nombre', 'name', 'fullname', 'nombrecompleto', 'huesped', 'huésped');
    const documentNumber = pick(r, 'documento', 'documentnumber', 'cedula', 'cédula', 'nit', 'doc');
    if (!fullName) { errors.push({ row: i + 2, reason: 'nombre vacío' }); continue; }
    if (documentNumber && (existingDocs.has(documentNumber) || seen.has(documentNumber))) { errors.push({ row: i + 2, documentNumber, reason: 'huésped duplicado (documento)' }); continue; }
    await prisma.guest.create({
      data: {
        propertyId, fullName,
        documentType: pick(r, 'tipodocumento', 'documenttype', 'tipo') || 'CC',
        documentNumber: documentNumber || null,
        phone: pick(r, 'telefono', 'teléfono', 'phone', 'celular') || null,
        email: pick(r, 'correo', 'email', 'mail') || null,
        nationality: pick(r, 'nacionalidad', 'nationality', 'pais', 'país') || 'CO',
        city: pick(r, 'ciudad', 'city') || null,
      },
    });
    if (documentNumber) seen.add(documentNumber); imported++;
  }
  return { imported, errors, total: rows.length };
}

export async function importEmployees(companyId, propertyId, input) {
  const rows = parseRows(input);
  const existingDocs = new Set((await prisma.employee.findMany({ where: { companyId }, select: { documentNumber: true } })).map(e => e.documentNumber));
  const seen = new Set();
  let imported = 0; const errors = [];
  for (const [i, r] of rows.entries()) {
    const fullName = pick(r, 'nombre', 'name', 'fullname', 'nombrecompleto');
    const documentNumber = pick(r, 'documento', 'documentnumber', 'cedula', 'cédula', 'doc');
    const position = pick(r, 'cargo', 'position', 'puesto');
    const salary = Number(pick(r, 'salario', 'salary', 'sueldo').replace(/[^\d.]/g, ''));
    if (!fullName || !documentNumber) { errors.push({ row: i + 2, reason: 'nombre y documento requeridos' }); continue; }
    if (!position) { errors.push({ row: i + 2, documentNumber, reason: 'cargo requerido' }); continue; }
    if (!(salary > 0)) { errors.push({ row: i + 2, documentNumber, reason: 'salario inválido' }); continue; }
    if (existingDocs.has(documentNumber) || seen.has(documentNumber)) { errors.push({ row: i + 2, documentNumber, reason: 'empleado duplicado (documento)' }); continue; }
    const hire = pick(r, 'ingreso', 'hiredate', 'fechaingreso', 'fecha');
    await prisma.employee.create({
      data: {
        companyId, propertyId, fullName, documentNumber, position,
        area: pick(r, 'area', 'área') || null,
        salary, riskClass: Math.min(5, Math.max(1, Number(pick(r, 'riesgo', 'riskclass', 'claseriesgo')) || 1)),
        hireDate: hire && !isNaN(Date.parse(hire)) ? new Date(hire) : new Date(),
        eps: pick(r, 'eps') || null, afp: pick(r, 'afp', 'pension', 'pensión') || null,
        arl: pick(r, 'arl') || null, ccf: pick(r, 'ccf', 'caja') || null,
        // Marca pendiente de validación por RR. HH.
        status: 'active',
      },
    });
    seen.add(documentNumber); imported++;
  }
  return { imported, errors, total: rows.length };
}

// Checklist de go-live (§55.2): verifica que la sede esté lista para operar.
export async function goLiveChecklist(propertyId, companyId) {
  const [property, roomTypes, rooms, ratePlans, users, site, policies, smmlv] = await Promise.all([
    prisma.property.findUnique({ where: { id: propertyId } }),
    prisma.roomType.count({ where: { propertyId } }),
    prisma.room.count({ where: { propertyId, active: true } }),
    prisma.ratePlan.count({ where: { propertyId } }),
    prisma.user.count({ where: { companyId } }),
    prisma.siteSettings.findFirst({ where: { propertyId } }).catch(() => null),
    prisma.hotelPolicy.count({ where: { propertyId } }).catch(() => 0),
    prisma.legalParameter.findFirst({ where: { companyId, key: 'SMMLV' } }).catch(() => null),
  ]);
  const gwOk = gatewaysStatus().some(g => g.configured);
  const items = [
    { key: 'rooms', label: 'Habitaciones cargadas', ok: rooms > 0, detail: `${rooms} habitación(es)` },
    { key: 'roomTypes', label: 'Tipos de habitación', ok: roomTypes > 0, detail: `${roomTypes} tipo(s)` },
    { key: 'ratePlans', label: 'Planes tarifarios', ok: ratePlans > 0, detail: `${ratePlans} plan(es)` },
    { key: 'rnt', label: 'RNT registrado', ok: !!property?.rnt, detail: property?.rnt || 'sin registrar' },
    { key: 'users', label: 'Usuarios del equipo', ok: users > 1, detail: `${users} usuario(s)` },
    { key: 'payments', label: 'Pasarela de pago configurada', ok: gwOk, detail: gwOk ? 'al menos una activa' : 'ninguna (solo simulador)' },
    { key: 'site', label: 'Sitio web publicado', ok: !!(site && site.published), detail: site?.published ? 'publicado' : 'sin publicar' },
    { key: 'policies', label: 'Políticas comerciales', ok: policies > 0, detail: `${policies} política(s)` },
    { key: 'legal', label: 'Parámetros legales (SMMLV)', ok: !!smmlv, detail: smmlv ? 'cargados' : 'faltan' },
  ];
  const done = items.filter(i => i.ok).length;
  return { items, done, total: items.length, readiness: Math.round((done / items.length) * 100) };
}
