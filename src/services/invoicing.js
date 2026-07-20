// Atria Fiscal (sección 16) — facturación con Dataico como proveedor
// tecnológico DIAN. Sin credenciales opera en modo borrador local (los
// documentos quedan listos para emitir cuando se configure DATAICO_AUTH_TOKEN).
// API Dataico: https://api.dataico.com/direct/dataico_api/v2/invoices
import { prisma } from '../db.js';
import { config } from '../config.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { logger } from '../lib/logger.js';
import { money } from '../lib/util.js';

const DATAICO_API = 'https://api.dataico.com/direct/dataico_api/v2';

export function dataicoConfigured() {
  return Boolean(config.dataico.authToken && config.dataico.accountId);
}

async function nextInvoiceNumber(propertyId) {
  const last = await prisma.invoice.findFirst({
    where: { propertyId, number: { not: null } },
    orderBy: { number: 'desc' },
  });
  return (last?.number || 1000) + 1;
}

// Crea la factura (borrador) desde el folio/reserva
export async function createInvoiceFromReservation(reservationId, { user = null, actor = 'system' } = {}) {
  const r = await prisma.reservation.findUnique({
    where: { id: reservationId },
    include: { guest: true, property: true, folio: { include: { charges: true } } },
  });
  if (!r) throw new Error('Reserva no encontrada');

  const existing = await prisma.invoice.findFirst({ where: { reservationId, status: { not: 'rejected' } } });
  if (existing) return existing;

  const charges = (r.folio?.charges || []).filter(c => !c.voided);
  const items = charges.length
    ? charges.map(c => ({
        description: `${c.concept}${c.description ? ` — ${c.description}` : ''}`,
        qty: 1, price: c.amount, taxRate: c.taxAmount > 0 ? r.property.taxRate : 0,
        taxAmount: c.taxAmount, total: c.amount + c.taxAmount,
      }))
    : [{
        description: `Alojamiento ${r.nights} noche(s) — reserva ${r.code}`,
        qty: 1, price: r.subtotal, taxRate: r.property.taxRate,
        taxAmount: r.taxes, total: r.total,
      }];

  const subtotal = money(items.reduce((s, i) => s + i.price * i.qty, 0));
  const tax = money(items.reduce((s, i) => s + i.taxAmount, 0));

  const invoice = await prisma.invoice.create({
    data: {
      propertyId: r.propertyId, reservationId,
      prefix: config.dataico.invoicePrefix,
      customerName: r.guest.fullName,
      customerDoc: r.guest.documentNumber,
      customerEmail: r.guest.email,
      items: JSON.stringify(items),
      subtotal, tax, total: subtotal + tax,
      status: 'draft',
      createdBy: user?.name || actor,
    },
  });
  await audit({ propertyId: r.propertyId, user, actor, action: 'invoice.created', entity: 'Invoice', entityId: invoice.id, after: { total: invoice.total, reservation: r.code } });
  emitEvent('invoice.created', { propertyId: r.propertyId, reservationId, entityId: invoice.id });
  return invoice;
}

// Emite la factura vía Dataico (o la deja en pending si no hay credenciales)
export async function issueInvoice(invoiceId, { user = null } = {}) {
  const invoice = await prisma.invoice.findUnique({
    where: { id: invoiceId },
    include: { property: { include: { company: true } } },
  });
  if (!invoice) throw new Error('Factura no encontrada');
  if (invoice.status === 'validated') return invoice;
  if (!['draft', 'error', 'pending'].includes(invoice.status)) {
    throw new Error(`La factura está en estado ${invoice.status}`);
  }

  const number = invoice.number || await nextInvoiceNumber(invoice.propertyId);
  const fullNumber = `${invoice.prefix || 'ATR'}-${number}`;

  if (!dataicoConfigured()) {
    // Sin proveedor: numerar y marcar pendiente de transmisión
    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        number, fullNumber, status: 'pending',
        errorMsg: 'Dataico sin configurar (DATAICO_AUTH_TOKEN / DATAICO_ACCOUNT_ID). Documento numerado localmente, pendiente de transmisión a DIAN.',
      },
    });
    await audit({ propertyId: invoice.propertyId, user, action: 'invoice.numbered_local', entity: 'Invoice', entityId: invoiceId, after: { fullNumber } });
    return updated;
  }

  const items = JSON.parse(invoice.items);
  const company = invoice.property.company;
  const payload = {
    actions: { send_dian: true, send_email: Boolean(invoice.customerEmail) },
    invoice: {
      env: config.dataico.env === 'prod' ? 'PRODUCCION' : 'PRUEBAS',
      dataico_account_id: config.dataico.accountId,
      number,
      numbering: { prefix: invoice.prefix || 'ATR' },
      issue_date: new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      payment_date: new Date().toLocaleDateString('es-CO', { day: '2-digit', month: '2-digit', year: 'numeric' }),
      invoice_type_code: 'FACTURA_VENTA',
      payment_means: 'DEBIT_CARD',
      payment_means_type: 'CONTADO',
      customer: {
        party_type: 'PERSONA_NATURAL',
        party_identification_type: 'CC',
        party_identification: invoice.customerDoc || '222222222222',
        first_name: invoice.customerName,
        email: invoice.customerEmail || undefined,
        department: invoice.property.city || 'Bogotá',
        city: invoice.property.city || 'Bogotá',
        address_line: 'N/A',
      },
      items: items.map(i => ({
        sku: 'SRV-HOTEL',
        description: i.description.slice(0, 300),
        quantity: i.qty,
        price: i.price,
        taxes: i.taxRate > 0 ? [{ tax_category: 'IVA', tax_rate: i.taxRate * 100 }] : [],
      })),
    },
  };

  try {
    const res = await fetch(`${DATAICO_API}/invoices`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'auth-token': config.dataico.authToken },
      body: JSON.stringify(payload),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.message || data.error || `Dataico HTTP ${res.status}`);

    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: {
        number, fullNumber,
        status: data.cufe ? 'validated' : 'pending',
        providerRef: data.uuid || data.invoice_id || null,
        cufe: data.cufe || null,
        issuedAt: new Date(),
        errorMsg: null,
      },
    });
    await audit({ propertyId: invoice.propertyId, user, action: 'invoice.issued', entity: 'Invoice', entityId: invoiceId, after: { fullNumber, cufe: data.cufe } });
    emitEvent('invoice.validated', { propertyId: invoice.propertyId, entityId: invoiceId });
    return updated;
  } catch (err) {
    logger.error({ err: err.message, invoiceId }, 'dataico issue failed');
    const updated = await prisma.invoice.update({
      where: { id: invoiceId },
      data: { status: 'error', errorMsg: err.message },
    });
    await audit({ propertyId: invoice.propertyId, user, action: 'invoice.error', entity: 'Invoice', entityId: invoiceId, reason: err.message });
    emitEvent('invoice.rejected', { propertyId: invoice.propertyId, entityId: invoiceId });
    return updated;
  }
}

// ---- Notas crédito/débito (§16) ----
async function nextNoteNumber(propertyId, type) {
  const last = await prisma.fiscalNote.findFirst({ where: { propertyId, type, fullNumber: { not: null } }, orderBy: { createdAt: 'desc' } });
  const lastNum = last?.fullNumber ? parseInt(String(last.fullNumber).split('-').pop(), 10) : 1000;
  return (Number.isFinite(lastNum) ? lastNum : 1000) + 1;
}

// Crea una nota crédito (anula/ajusta) o débito (cargo adicional) sobre una factura.
export async function createFiscalNote(invoiceId, { type, reason, amount, user = null } = {}) {
  if (!['credit', 'debit'].includes(type)) throw new Error('type debe ser credit o debit');
  if (!reason) throw new Error('La nota requiere un motivo');
  const invoice = await prisma.invoice.findUnique({ where: { id: invoiceId } });
  if (!invoice) throw new Error('Factura no encontrada');
  if (invoice.status === 'draft') throw new Error('La factura debe estar emitida antes de crear una nota');
  const value = money(amount != null ? amount : invoice.total);
  if (!(value > 0)) throw new Error('El valor de la nota debe ser mayor a cero');
  if (type === 'credit' && value > invoice.total) throw new Error('La nota crédito no puede superar el total de la factura');
  const note = await prisma.fiscalNote.create({
    data: { propertyId: invoice.propertyId, invoiceId, type, reason, amount: value, createdBy: user?.name || null },
  });
  // Nota crédito por el total → anula la factura.
  if (type === 'credit' && value === money(invoice.total)) {
    await prisma.invoice.update({ where: { id: invoiceId }, data: { status: 'annulled' } });
  }
  await audit({ propertyId: invoice.propertyId, user, action: `invoice.${type}_note`, entity: 'FiscalNote', entityId: note.id, after: { invoiceId, amount: value } });
  emitEvent('fiscal_note.created', { propertyId: invoice.propertyId, entityId: note.id, type });
  return note;
}

export async function issueFiscalNote(id, { user = null } = {}) {
  const note = await prisma.fiscalNote.findUnique({ where: { id } });
  if (!note) throw new Error('Nota no encontrada');
  if (note.status === 'issued') return note;
  const prefix = note.type === 'credit' ? 'NC' : 'ND';
  const number = await nextNoteNumber(note.propertyId, note.type);
  // Con credenciales se transmitiría a la DIAN; en modo local queda numerada.
  const updated = await prisma.fiscalNote.update({
    where: { id },
    data: { status: 'issued', fullNumber: `${prefix}-${number}`, issuedAt: new Date(), cude: dataicoConfigured() ? null : `LOCAL-${prefix}-${number}` },
  });
  await audit({ propertyId: note.propertyId, user, action: 'fiscal_note.issued', entity: 'FiscalNote', entityId: id, after: { fullNumber: updated.fullNumber } });
  return updated;
}

export async function listFiscalNotes(invoiceId) {
  return prisma.fiscalNote.findMany({ where: { invoiceId }, orderBy: { createdAt: 'desc' } });
}
