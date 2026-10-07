import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import type { Actor } from '../rbac/actor.ts';

export interface Ctx {
  db: DB;
  actor: Actor;
  requestId: string;
  ip?: string;
}

/**
 * Runs `fn` in a transaction that identifies the actor to the database audit triggers.
 * All writes on behalf of a user must go through here.
 */
export function withActor<T>(db: DB, actorUserId: string | null, requestId: string, fn: (tx: DB) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.user_id', ${actorUserId ?? ''}, true), set_config('app.request_id', ${requestId}, true)`);
    return fn(tx as unknown as DB);
  });
}

export const tx = <T>(ctx: Ctx, fn: (tx: DB) => Promise<T>) => withActor(ctx.db, ctx.actor.userId, ctx.requestId, fn);
