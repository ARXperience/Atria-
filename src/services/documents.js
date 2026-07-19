// Centro documental (§43): almacenamiento, versionado, asociación a entidades,
// alertas de vencimiento y búsqueda. Los archivos se guardan en disco bajo
// storage/uploads/<companyId>/ y los metadatos en la base.
import fs from 'node:fs';
import path from 'node:path';
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { notify } from './notifications.js';
import { logger } from '../lib/logger.js';

const UPLOADS_DIR = path.resolve('storage/uploads');
const LEGAL_TYPES = ['RUT', 'RNT', 'contract', 'policy', 'certificate'];

const EXT = {
  'application/pdf': 'pdf', 'image/jpeg': 'jpg', 'image/png': 'png',
  'image/webp': 'webp', 'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
};

export function isLegalDoc(docType) {
  return LEGAL_TYPES.includes(docType);
}

// Recibe el archivo como dataURL/base64 desde el frontend y lo persiste.
export async function storeDocument({
  companyId, propertyId = null, entityType = null, entityId = null,
  docType = 'other', title, fileName, mimeType = null, base64,
  issueDate = null, expiryDate = null, supersedesId = null, uploadedBy = null,
}) {
  if (!title || !fileName || !base64) throw new Error('title, fileName y archivo son requeridos');
  const raw = String(base64).includes(',') ? String(base64).split(',')[1] : String(base64);
  const buffer = Buffer.from(raw, 'base64');
  if (!buffer.length) throw new Error('El archivo está vacío o mal codificado');
  if (buffer.length > 15 * 1024 * 1024) throw new Error('El archivo supera el límite de 15 MB');

  const version = supersedesId
    ? ((await prisma.document.findUnique({ where: { id: supersedesId } }))?.version || 0) + 1
    : 1;

  const dir = path.join(UPLOADS_DIR, companyId);
  fs.mkdirSync(dir, { recursive: true });
  const ext = EXT[mimeType] || (fileName.includes('.') ? fileName.split('.').pop().toLowerCase() : 'bin');

  const doc = await prisma.document.create({
    data: {
      companyId, propertyId, entityType, entityId, docType, title, fileName,
      mimeType, sizeBytes: buffer.length, version, supersedesId,
      issueDate: issueDate ? new Date(issueDate) : null,
      expiryDate: expiryDate ? new Date(expiryDate) : null,
      uploadedBy, storageKey: '',
    },
  });
  const storageKey = path.join(companyId, `${doc.id}.${ext}`);
  fs.writeFileSync(path.join(UPLOADS_DIR, storageKey), buffer);
  const saved = await prisma.document.update({ where: { id: doc.id }, data: { storageKey } });

  if (supersedesId) {
    await prisma.document.update({ where: { id: supersedesId }, data: { status: 'superseded' } });
    emitEvent('document.versioned', { propertyId, entityId: saved.id });
  }
  await audit({ companyId, propertyId, action: supersedesId ? 'document.versioned' : 'document.uploaded', entity: 'Document', entityId: saved.id, after: { title, docType, version } });
  emitEvent('document.uploaded', { propertyId, entityId: saved.id });
  return saved;
}

export async function readDocumentFile(doc) {
  const full = path.join(UPLOADS_DIR, doc.storageKey);
  if (!fs.existsSync(full)) throw new Error('Archivo no encontrado en almacenamiento');
  return fs.readFileSync(full);
}

// Eliminación lógica; para documentos legales el llamador debe exigir aprobación.
export async function softDeleteDocument(id, { user = null } = {}) {
  const doc = await prisma.document.findUnique({ where: { id } });
  if (!doc) throw new Error('Documento no encontrado');
  const updated = await prisma.document.update({ where: { id }, data: { status: 'deleted' } });
  await audit({ companyId: doc.companyId, propertyId: doc.propertyId, user, action: 'document.deleted', entity: 'Document', entityId: id, before: { status: doc.status } });
  return updated;
}

// Job: alerta documentos próximos a vencer (una sola vez por documento).
export async function checkExpiringDocuments(days = 30) {
  const limit = new Date(Date.now() + days * 86400000);
  const docs = await prisma.document.findMany({
    where: { status: 'active', expiryDate: { not: null, lte: limit }, expiryNotifiedAt: null },
  });
  for (const doc of docs) {
    const overdue = doc.expiryDate < new Date();
    await notify({
      propertyId: doc.propertyId || (await anyProperty(doc.companyId)),
      audienceRole: 'MANAGER', severity: overdue ? 'critical' : 'warning',
      title: `${overdue ? 'Documento vencido' : 'Documento por vencer'}: ${doc.title}`,
      body: `${doc.docType} · vence ${doc.expiryDate.toISOString().slice(0, 10)}`,
      entity: 'Document', entityId: doc.id,
    });
    await prisma.document.update({ where: { id: doc.id }, data: { expiryNotifiedAt: new Date() } });
    emitEvent('document.expiring', { propertyId: doc.propertyId, entityId: doc.id });
  }
  if (docs.length) logger.info({ count: docs.length }, 'document expiry alerts sent');
  return docs.length;
}

async function anyProperty(companyId) {
  const p = await prisma.property.findFirst({ where: { companyId } });
  return p?.id;
}
