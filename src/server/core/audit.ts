import type { DB } from '../db/client.ts';
import { auditLogs } from '../db/schema/index.ts';

/** Application-level audit events (row changes are captured by DB triggers). */
export async function auditEvent(
  db: DB,
  e: { action: string; actorUserId?: string | null; tableName?: string; recordId?: string; newData?: unknown; oldData?: unknown; ip?: string; requestId?: string },
) {
  await db.insert(auditLogs).values({
    action: e.action,
    actorUserId: e.actorUserId ?? null,
    tableName: e.tableName,
    recordId: e.recordId,
    newData: e.newData ?? null,
    oldData: e.oldData ?? null,
    ip: e.ip,
    requestId: e.requestId,
  });
}
