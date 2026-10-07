import { and, eq, gt, isNull, ne } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { sessions } from '../db/schema/index.ts';
import { randomToken, sha256 } from './password.ts';

export const SESSION_COOKIE = 'dms_session';

export interface SessionLimits { idleHours: number; maxDays: number }

export async function createSession(db: DB, userId: string, limits: SessionLimits, meta: { ip?: string; userAgent?: string }) {
  const token = randomToken();
  const expiresAt = new Date(Date.now() + limits.maxDays * 86400_000);
  const [s] = await db.insert(sessions).values({
    tokenHash: sha256(token), userId, expiresAt, ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300),
  }).returning();
  return { token, session: s };
}

/** Validates a session token, enforcing absolute and idle expiry, and touches last-seen. */
export async function resolveSession(db: DB, token: string | undefined, limits: SessionLimits) {
  if (!token || token.length > 100) return null;
  const now = new Date();
  const [s] = await db.select().from(sessions)
    .where(and(eq(sessions.tokenHash, sha256(token)), isNull(sessions.revokedAt), gt(sessions.expiresAt, now)));
  if (!s) return null;
  if (now.getTime() - s.lastSeenAt.getTime() > limits.idleHours * 3600_000) {
    await db.update(sessions).set({ revokedAt: now }).where(eq(sessions.id, s.id));
    return null;
  }
  // Throttle writes: only touch once a minute.
  if (now.getTime() - s.lastSeenAt.getTime() > 60_000) {
    await db.update(sessions).set({ lastSeenAt: now }).where(eq(sessions.id, s.id));
  }
  return s;
}

export async function revokeSession(db: DB, sessionId: string) {
  await db.update(sessions).set({ revokedAt: new Date() }).where(eq(sessions.id, sessionId));
}

export async function revokeAllSessions(db: DB, userId: string, exceptSessionId?: string) {
  await db.update(sessions).set({ revokedAt: new Date() })
    .where(and(eq(sessions.userId, userId), isNull(sessions.revokedAt), exceptSessionId ? ne(sessions.id, exceptSessionId) : undefined));
}
