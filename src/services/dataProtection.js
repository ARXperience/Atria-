// Protección de datos / Habeas Data (§26, Ley 1581/2012 + RNBD).
// Registro de consentimientos, solicitudes ARCO del titular, inventario de
// bases de datos (RNBD) y ejercicio real de los derechos de acceso/supresión.
import { prisma } from '../db.js';
import { audit } from '../lib/audit.js';

const PURPOSES = ['marketing', 'tratamiento', 'imagen', 'datos_sensibles', 'transferencia'];
const REQUEST_TYPES = ['acceso', 'rectificacion', 'supresion', 'oposicion', 'revocacion'];

// Suma días hábiles (lun-vie) — la ley concede ~10-15 días hábiles según el derecho.
function addBusinessDays(from, days) {
  const d = new Date(from);
  let added = 0;
  while (added < days) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) added++;
  }
  return d;
}

// Bases de datos por defecto que todo hotel trata (semilla perezosa por sede).
const DEFAULT_TREATMENTS = [
  { name: 'Huéspedes', purpose: 'Gestión de reservas, hospedaje, facturación y fidelización', legalBasis: 'contrato', categories: 'Identificación, contacto, estadía, preferencias', retention: 'Vigencia de la relación + términos legales tributarios (5 años)', security: 'Acceso por rol, cifrado en tránsito, auditoría', responsible: 'Recepción / Gerencia' },
  { name: 'Empleados', purpose: 'Vínculo laboral, nómina, seguridad social y SG-SST', legalBasis: 'obligacion_legal', categories: 'Identificación, contacto, laborales, salud ocupacional', retention: 'Vínculo + 20 años (historia laboral)', security: 'Acceso restringido RRHH, auditoría', responsible: 'Talento humano' },
  { name: 'CRM / Leads', purpose: 'Atención comercial, cotizaciones y mercadeo', legalBasis: 'consentimiento', categories: 'Contacto, intereses, interacciones', retention: 'Hasta revocatoria del titular', security: 'Acceso por rol, auditoría', responsible: 'Comercial' },
];

export async function ensureTreatments(propertyId) {
  const count = await prisma.dataTreatment.count({ where: { propertyId } });
  if (count > 0) return;
  for (const t of DEFAULT_TREATMENTS) {
    await prisma.dataTreatment.upsert({
      where: { propertyId_name: { propertyId, name: t.name } },
      update: {},
      create: { propertyId, ...t },
    });
  }
}

export async function recordConsent({ propertyId, subjectType = 'guest', subjectId = null, subjectName, documentNumber = null, purpose, channel = 'recepcion', policyVersion = null, source = null, granted = true, createdBy = null }) {
  if (!subjectName) throw new Error('subjectName requerido');
  if (!PURPOSES.includes(purpose)) throw new Error(`purpose inválido (${PURPOSES.join(', ')})`);
  const consent = await prisma.dataConsent.create({
    data: { propertyId, subjectType, subjectId, subjectName, documentNumber, purpose, channel, policyVersion, source, granted, grantedAt: new Date(), revokedAt: granted ? null : new Date(), createdBy },
  });
  // Sincroniza el consentimiento de marketing con la ficha del huésped.
  if (purpose === 'marketing' && subjectId && subjectType === 'guest') {
    await prisma.guest.update({ where: { id: subjectId }, data: { marketingConsent: granted } }).catch(() => {});
  }
  return consent;
}

export async function revokeConsent(id, { user } = {}) {
  const c = await prisma.dataConsent.findUnique({ where: { id } });
  if (!c) throw new Error('Consentimiento no encontrado');
  const updated = await prisma.dataConsent.update({ where: { id }, data: { granted: false, revokedAt: new Date() } });
  if (c.purpose === 'marketing' && c.subjectId && c.subjectType === 'guest') {
    await prisma.guest.update({ where: { id: c.subjectId }, data: { marketingConsent: false } }).catch(() => {});
  }
  await audit({ propertyId: c.propertyId, user, action: 'consent.revoked', entity: 'DataConsent', entityId: id, after: { purpose: c.purpose, subject: c.subjectName } });
  return updated;
}

export async function createSubjectRequest({ propertyId, subjectType = 'guest', subjectName, documentNumber = null, email = null, type, channel = 'web', detail = null, createdBy = null }) {
  if (!subjectName) throw new Error('subjectName requerido');
  if (!REQUEST_TYPES.includes(type)) throw new Error(`type inválido (${REQUEST_TYPES.join(', ')})`);
  const dueDate = addBusinessDays(new Date(), 15);
  return prisma.dataSubjectRequest.create({
    data: { propertyId, subjectType, subjectName, documentNumber, email, type, channel, detail, dueDate, createdBy },
  });
}

export async function resolveSubjectRequest(id, { status = 'resolved', resolution = null, user } = {}) {
  const r = await prisma.dataSubjectRequest.findUnique({ where: { id } });
  if (!r) throw new Error('Solicitud no encontrada');
  const updated = await prisma.dataSubjectRequest.update({
    where: { id },
    data: { status, resolution, resolvedBy: user?.name || null, resolvedAt: ['resolved', 'rejected'].includes(status) ? new Date() : null },
  });
  await audit({ propertyId: r.propertyId, user, action: `dsr.${status}`, entity: 'DataSubjectRequest', entityId: id, after: { type: r.type, subject: r.subjectName } });
  return updated;
}

// Derecho de acceso: consolida toda la información personal asociada a un
// número de documento a través de las bases de datos de la sede.
export async function exportSubjectData(propertyId, { documentNumber }) {
  if (!documentNumber) throw new Error('documentNumber requerido');
  const [guests, employees, leads, consents, requests] = await Promise.all([
    prisma.guest.findMany({ where: { propertyId, documentNumber }, include: { reservations: { select: { code: true, checkIn: true, checkOut: true, status: true, total: true } } } }),
    prisma.employee.findMany({ where: { propertyId, documentNumber }, select: { fullName: true, email: true, phone: true, position: true, area: true, status: true, hireDate: true } }),
    prisma.lead.findMany({ where: { propertyId }, select: { name: true, phone: true, email: true, channel: true, intent: true, stage: true, guest: { select: { documentNumber: true } } } }),
    prisma.dataConsent.findMany({ where: { propertyId, documentNumber } }),
    prisma.dataSubjectRequest.findMany({ where: { propertyId, documentNumber } }),
  ]);
  const relatedLeads = leads.filter(l => l.guest?.documentNumber === documentNumber).map(({ guest, ...l }) => l);
  return {
    documentNumber,
    generatedAt: new Date().toISOString(),
    huesped: guests.map(({ id, propertyId: _p, memory, ...g }) => g),
    empleado: employees,
    crm: relatedLeads,
    consentimientos: consents.map(c => ({ purpose: c.purpose, granted: c.granted, channel: c.channel, grantedAt: c.grantedAt, revokedAt: c.revokedAt })),
    solicitudes: requests.map(r => ({ type: r.type, status: r.status, createdAt: r.createdAt })),
    found: guests.length > 0 || employees.length > 0 || relatedLeads.length > 0,
  };
}

// Derecho de supresión: anonimiza los datos del huésped conservando los
// registros exigidos por ley (TRA/SIRE/facturas/nómina no se borran).
export async function eraseSubjectData(propertyId, { documentNumber, user }) {
  if (!documentNumber) throw new Error('documentNumber requerido');
  const guests = await prisma.guest.findMany({ where: { propertyId, documentNumber } });
  if (!guests.length) throw new Error('No hay titular con ese documento en huéspedes');
  let anonymized = 0;
  for (const g of guests) {
    await prisma.guest.update({
      where: { id: g.id },
      data: { fullName: '[Titular suprimido]', phone: null, email: null, city: null, notes: null, memory: null, marketingConsent: false, documentNumber: `SUP-${g.id.slice(-6)}` },
    });
    anonymized++;
  }
  await prisma.dataConsent.updateMany({ where: { propertyId, documentNumber }, data: { granted: false, revokedAt: new Date() } });
  await audit({ propertyId, user, action: 'dsr.erased', entity: 'Guest', entityId: documentNumber, after: { anonymized }, reason: 'Ejercicio del derecho de supresión (Ley 1581)' });
  return { anonymized, note: 'Registros legales obligatorios (TRA, SIRE, facturas) se conservan por norma.' };
}

export async function dataProtectionOverview(propertyId) {
  await ensureTreatments(propertyId);
  const now = new Date();
  const [grantedActive, revoked, openReqs, treatments, requests] = await Promise.all([
    prisma.dataConsent.count({ where: { propertyId, granted: true } }),
    prisma.dataConsent.count({ where: { propertyId, granted: false } }),
    prisma.dataSubjectRequest.count({ where: { propertyId, status: { in: ['received', 'in_progress'] } } }),
    prisma.dataTreatment.count({ where: { propertyId } }),
    prisma.dataSubjectRequest.findMany({ where: { propertyId, status: { in: ['received', 'in_progress'] } }, select: { dueDate: true } }),
  ]);
  const overdue = requests.filter(r => r.dueDate && new Date(r.dueDate) < now).length;
  return { consentsActive: grantedActive, consentsRevoked: revoked, requestsOpen: openReqs, requestsOverdue: overdue, treatments };
}
