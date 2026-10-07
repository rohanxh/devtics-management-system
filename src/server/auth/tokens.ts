import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import { apiTokens } from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx } from '../core/context.ts';
import { auditEvent } from '../core/audit.ts';
import { forbidden, invalid, notFound } from '../core/errors.ts';
import { isUuid } from '../resources/validate.ts';
import { randomToken, sha256 } from './password.ts';

/** Returns the owning user id for a valid, unexpired, unrevoked token (and records usage, throttled). */
export async function resolveApiToken(db: DB, token: string): Promise<string | undefined> {
  const now = new Date();
  const [t] = await db.select().from(apiTokens)
    .where(and(eq(apiTokens.tokenHash, sha256(token)), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, now)));
  if (!t) return undefined;
  if (!t.lastUsedAt || now.getTime() - t.lastUsedAt.getTime() > 60_000) {
    await db.update(apiTokens).set({ lastUsedAt: now }).where(eq(apiTokens.id, t.id));
  }
  return t.userId;
}

/**
 * Personal API tokens: act with exactly the owner's permissions. Created and revoked only from a
 * signed-in browser session (a token cannot mint tokens). The secret is shown once.
 */
export async function tokenRoutes(app: FastifyInstance) {
  app.get('/api/auth/tokens', async (req) => {
    const ctx = ctxOf(req);
    return ctx.db.select({ id: apiTokens.id, name: apiTokens.name, prefix: apiTokens.prefix, expiresAt: apiTokens.expiresAt, lastUsedAt: apiTokens.lastUsedAt, revokedAt: apiTokens.revokedAt, createdAt: apiTokens.createdAt })
      .from(apiTokens).where(eq(apiTokens.userId, ctx.actor.userId)).orderBy(desc(apiTokens.createdAt));
  });

  app.post('/api/auth/tokens', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!req.session) throw forbidden('Create tokens from a signed-in session');
    const body = z.object({ name: z.string().trim().min(2).max(80), expiresInDays: z.number().int().min(1).max(365).default(90) }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', z.flattenError(body.error).fieldErrors);
    const active = await ctx.db.select({ id: apiTokens.id }).from(apiTokens).where(and(eq(apiTokens.userId, ctx.actor.userId), isNull(apiTokens.revokedAt), gt(apiTokens.expiresAt, new Date())));
    if (active.length >= 10) throw invalid('Too many active tokens (max 10). Revoke one first.', {});
    const token = `dms_${randomToken()}`;
    const [row] = await tx(ctx, async (t) => {
      const r = await t.insert(apiTokens).values({
        userId: ctx.actor.userId, name: body.data.name, tokenHash: sha256(token), prefix: token.slice(0, 10),
        expiresAt: new Date(Date.now() + body.data.expiresInDays * 86400_000),
      }).returning();
      await auditEvent(t, { action: 'API_TOKEN_CREATED', actorUserId: ctx.actor.userId, tableName: 'api_tokens', recordId: r[0].id, newData: { name: body.data.name, expiresAt: r[0].expiresAt }, ip: ctx.ip, requestId: ctx.requestId });
      return r;
    });
    return reply.status(201).send({ id: row.id, name: row.name, expiresAt: row.expiresAt, token });
  });

  app.delete<{ Params: { id: string } }>('/api/auth/tokens/:id', async (req) => {
    const ctx = ctxOf(req);
    if (!isUuid(req.params.id)) throw notFound('Token');
    const [t] = await ctx.db.select().from(apiTokens).where(and(eq(apiTokens.id, req.params.id), eq(apiTokens.userId, ctx.actor.userId)));
    if (!t) throw notFound('Token');
    await tx(ctx, async (x) => {
      await x.update(apiTokens).set({ revokedAt: new Date() }).where(eq(apiTokens.id, t.id));
      await auditEvent(x, { action: 'API_TOKEN_REVOKED', actorUserId: ctx.actor.userId, tableName: 'api_tokens', recordId: t.id, ip: ctx.ip, requestId: ctx.requestId });
    });
    return { ok: true };
  });
}
