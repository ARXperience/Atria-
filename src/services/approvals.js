// Motor de aprobaciones humanas (secciones 47 y 55.6): las acciones sensibles
// crean una solicitud con resumen de impacto; al aprobarse se ejecuta la acción.
import { prisma } from '../db.js';
import { emitEvent } from '../lib/events.js';
import { audit } from '../lib/audit.js';
import { notify } from './notifications.js';

const ROLE_RANK = { FRONTDESK: 1, SALES: 1, HOUSEKEEPING: 1, MAINTENANCE: 1, HR: 2, ACCOUNTING: 2, MANAGER: 3, OWNER: 4 };

export function canApprove(userRole, requiredRole) {
  return (ROLE_RANK[userRole] || 0) >= (ROLE_RANK[requiredRole] || 3);
}

export async function requestApproval({ propertyId, type, summary, payload, requiredRole = 'MANAGER', user = null, actor = 'human' }) {
  const request = await prisma.approvalRequest.create({
    data: {
      propertyId, type, summary,
      payload: JSON.stringify(payload),
      requiredRole,
      requestedBy: user?.id || (actor === 'ai' ? 'ai' : null),
      requestedByName: user?.name || (actor === 'ai' ? 'Atria IA' : null),
    },
  });
  await audit({ propertyId, user, actor, action: 'approval.requested', entity: 'ApprovalRequest', entityId: request.id, after: { type, summary } });
  emitEvent('approval.requested', { propertyId, entityId: request.id, type });
  await notify({ propertyId, audienceRole: requiredRole, severity: 'warning', title: `Aprobación pendiente: ${type}`, body: summary, entity: 'ApprovalRequest', entityId: request.id });
  return request;
}

// Ejecutores por tipo de acción aprobada
const executors = {
  async manual_payment(payload) {
    const { applyApprovedPayment } = await import('./payments.js');
    return applyApprovedPayment({
      reservationId: payload.reservationId, amount: payload.amount,
      method: payload.method, provider: 'manual', providerRef: payload.supportRef || null,
      registeredBy: payload.registeredByName, actor: 'human',
    });
  },
  async refund(payload) {
    const payment = await prisma.payment.create({
      data: {
        propertyId: payload.propertyId, reservationId: payload.reservationId || null,
        amount: payload.amount, method: payload.method || 'transfer',
        provider: 'manual', status: 'approved', kind: 'refund',
        notes: payload.reason || null, registeredBy: payload.registeredByName || null,
      },
    });
    emitEvent('refund.executed', { propertyId: payload.propertyId, reservationId: payload.reservationId, entityId: payment.id });
    return payment;
  },
  async room_block(payload) {
    const room = await prisma.room.update({ where: { id: payload.roomId }, data: { status: 'out_of_service', notes: payload.reason || null } });
    emitEvent('room.status_changed', { propertyId: payload.propertyId, roomId: room.id, status: 'out_of_service' });
    return room;
  },
  async checkin_override(payload) {
    const { checkIn } = await import('./reservations.js');
    return checkIn(payload.reservationId, { roomId: payload.roomId || null, overrideDeposit: true });
  },
  async checkout_with_balance(payload) {
    const { checkOut } = await import('./reservations.js');
    return checkOut(payload.reservationId, { allowBalance: true });
  },
  async payroll_close(payload) {
    const { closePeriod } = await import('./payroll.js');
    return closePeriod(payload.periodId, { user: { name: 'Aprobación de dueño' } });
  },
  async employee_sensitive_change(payload) {
    const data = {};
    if (payload.salary !== undefined) data.salary = payload.salary;
    if (payload.status) data.status = payload.status;
    if (payload.endDate) data.endDate = new Date(payload.endDate);
    return prisma.employee.update({ where: { id: payload.employeeId }, data });
  },
  async document_delete(payload) {
    const { softDeleteDocument } = await import('./documents.js');
    return softDeleteDocument(payload.documentId);
  },
  async contract_activate(payload) {
    const { activateContract } = await import('./contracts.js');
    return activateContract(payload.contractId);
  },
  async contract_amend(payload) {
    const { applyAmendment } = await import('./contracts.js');
    return applyAmendment(payload);
  },
  async purchase_order(payload) {
    const { approvePurchaseOrder } = await import('./inventory.js');
    return approvePurchaseOrder(payload.purchaseOrderId);
  },
};

export async function decideApproval(requestId, { approve, user, note = null }) {
  const request = await prisma.approvalRequest.findUnique({ where: { id: requestId } });
  if (!request) throw new Error('Solicitud no encontrada');
  if (request.status !== 'pending') throw new Error(`La solicitud ya fue ${request.status}`);
  if (!canApprove(user.role, request.requiredRole)) {
    throw new Error(`Su rol ${user.role} no puede aprobar acciones que requieren ${request.requiredRole}`);
  }

  let result = null;
  if (approve) {
    const executor = executors[request.type];
    if (executor) result = await executor(JSON.parse(request.payload));
  }

  const updated = await prisma.approvalRequest.update({
    where: { id: requestId },
    data: {
      status: approve ? 'approved' : 'rejected',
      decidedBy: user.id, decidedByName: user.name, decisionNote: note, decidedAt: new Date(),
    },
  });
  await audit({ propertyId: request.propertyId, user, action: approve ? 'approval.approved' : 'approval.rejected', entity: 'ApprovalRequest', entityId: requestId, reason: note });
  emitEvent('approval.decided', { propertyId: request.propertyId, entityId: requestId, approved: approve });
  return { request: updated, result };
}
