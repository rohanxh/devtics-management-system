import { eq } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { approvals } from '../db/schema/index.ts';
import type { Actor } from '../rbac/actor.ts';
import { emit } from './events.ts';
import { notify } from './notify.ts';

export type ApprovalRow = typeof approvals.$inferSelect;

export interface ApprovalHandler {
  /** Runs in the same transaction as the decision. */
  onApproved?(tx: DB, approval: ApprovalRow, actor: Actor): Promise<void>;
  onRejected?(tx: DB, approval: ApprovalRow, actor: Actor): Promise<void>;
}

const handlers = new Map<string, ApprovalHandler>();
export function registerApprovalHandler(kind: string, h: ApprovalHandler) {
  handlers.set(kind, h);
}
export const approvalHandler = (kind: string) => handlers.get(kind);

/** Opens an approval request and notifies the approvers. */
export async function requestApproval(tx: DB, a: {
  kind: string; entityType: string; entityId: string; title: string; details?: string;
  requestedBy?: string | null; approverRoleKey?: string; approverUserId?: string; dueDate?: string;
}) {
  const [row] = await tx.insert(approvals).values({
    kind: a.kind, entityType: a.entityType, entityId: a.entityId, title: a.title, details: a.details,
    requestedBy: a.requestedBy ?? null, approverRoleKey: a.approverRoleKey, approverUserId: a.approverUserId, dueDate: a.dueDate,
  }).returning();
  await emit(tx, { type: 'approval.requested', entityType: a.entityType, entityId: a.entityId, actorUserId: a.requestedBy, payload: { approvalId: row.id, kind: a.kind, title: a.title } });
  await notify(tx, {
    userIds: a.approverUserId ? [a.approverUserId] : [], roles: a.approverRoleKey ? [a.approverRoleKey] : [],
    kind: 'approval_request', title: `Approval needed: ${a.title}`, body: a.details,
    link: '/approvals', dedupeKey: `approval:${row.id}`, excludeUserId: a.requestedBy,
  });
  return row;
}

/** True if the actor is an eligible approver for this request. */
export function canDecide(actor: Actor, a: ApprovalRow) {
  if (a.status !== 'pending') return false;
  if (a.approverUserId) return a.approverUserId === actor.userId;
  return !!a.approverRoleKey && actor.roles.includes(a.approverRoleKey);
}

export async function pendingApprovalFor(tx: DB, entityType: string, entityId: string, kind: string) {
  const rows = await tx.select().from(approvals).where(eq(approvals.entityId, entityId));
  return rows.find((r) => r.entityType === entityType && r.kind === kind && r.status === 'pending');
}
