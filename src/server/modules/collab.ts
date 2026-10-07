import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { activities, auditLogs, comments, files, notifications, users } from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx } from '../core/context.ts';
import { badRequest, forbidden, notFound } from '../core/errors.ts';
import { emit } from '../core/events.ts';
import { notify } from '../core/notify.ts';
import { INLINE_TYPES } from '../core/storage.ts';
import { can } from '../rbac/actor.ts';
import { assertVisible, getOne, isVisible, requireResource } from '../resources/engine.ts';
import { isUuid } from '../resources/validate.ts';

type P = { key: string; id: string };

/** Comments, attachments, activity and per-record audit history. Authorization always flows from the parent record. */
/** Private attachment categories the actor may not see on this record (e.g. employee contracts for a manager). */
async function hiddenCategories(ctx: ReturnType<typeof ctxOf>, key: string, id: string): Promise<Set<string>> {
  const def = requireResource(key);
  if (!def.privateFiles) return new Set();
  const scope = ctx.actor.perms.get(def.privateFiles.permission);
  if (scope === 'all') return new Set();
  if (scope && def.scopes?.own) {
    const own = await ctx.db.select({ id: (def.table as any).id }).from(def.table).where(and(eq((def.table as any).id, id), def.scopes.own(ctx.actor)));
    if (own.length) return new Set();
  }
  return new Set(def.privateFiles.categories);
}

export async function collabRoutes(app: FastifyInstance) {
  const { storage } = app.deps;

  // ── Comments ──
  app.get<{ Params: P }>('/api/r/:key/:id/comments', async (req) => {
    const ctx = ctxOf(req);
    await assertVisible(ctx.db, ctx.actor, req.params.key, req.params.id);
    return ctx.db.select({
      id: comments.id, body: comments.body, createdAt: comments.createdAt, editedAt: comments.editedAt,
      authorId: comments.authorId, authorName: users.name,
    }).from(comments).innerJoin(users, eq(users.id, comments.authorId))
      .where(and(eq(comments.entityType, req.params.key), eq(comments.entityId, req.params.id), isNull(comments.deletedAt)))
      .orderBy(comments.createdAt);
  });

  app.post<{ Params: P }>('/api/r/:key/:id/comments', async (req, reply) => {
    const ctx = ctxOf(req);
    const def = requireResource(req.params.key);
    const body = z.object({ body: z.string().trim().min(1).max(10000), mentions: z.array(z.uuid()).max(20).optional() }).parse(req.body);
    const record = await getOne(ctx, req.params.key, req.params.id);
    const title = String(record[def.titleField] ?? def.label);
    const comment = await tx(ctx, async (t) => {
      const [c] = await t.insert(comments).values({ entityType: def.key, entityId: record.id, authorId: ctx.actor.userId, body: body.body }).returning();
      await emit(t, { type: 'comment.created', entityType: def.key, entityId: record.id, actorUserId: ctx.actor.userId, payload: { commentId: c.id, title } });
      if (body.mentions?.length) {
        await notify(t, {
          userIds: body.mentions, kind: 'mention', title: `${ctx.actor.name} mentioned you on ${def.label.toLowerCase()} "${title}"`,
          body: body.body.slice(0, 280), entityType: def.key, entityId: record.id, excludeUserId: ctx.actor.userId,
          dedupeKey: `mention:${c.id}`,
        });
      }
      return c;
    });
    app.deps.events.kick();
    return reply.status(201).send({ ...comment, authorName: ctx.actor.name });
  });

  app.delete<{ Params: { id: string } }>('/api/comments/:id', async (req) => {
    const ctx = ctxOf(req);
    if (!isUuid(req.params.id)) throw notFound('Comment');
    const [c] = await ctx.db.select().from(comments).where(and(eq(comments.id, req.params.id), isNull(comments.deletedAt)));
    if (!c || !(await isVisible(ctx.db, ctx.actor, c.entityType, c.entityId))) throw notFound('Comment');
    if (c.authorId !== ctx.actor.userId) throw forbidden('Only the author can delete a comment');
    await tx(ctx, (t) => t.update(comments).set({ deletedAt: new Date() }).where(eq(comments.id, c.id)));
    return { ok: true };
  });

  // ── Activity & audit history ──
  app.get<{ Params: P }>('/api/r/:key/:id/activity', async (req) => {
    const ctx = ctxOf(req);
    await assertVisible(ctx.db, ctx.actor, req.params.key, req.params.id);
    const items = await ctx.db.select({
      id: activities.id, verb: activities.verb, summary: activities.summary, createdAt: activities.createdAt, actorName: users.name,
    }).from(activities).leftJoin(users, eq(users.id, activities.actorUserId))
      .where(and(eq(activities.entityType, req.params.key), eq(activities.entityId, req.params.id)))
      .orderBy(desc(activities.createdAt)).limit(100);
    return items;
  });

  app.get<{ Params: P }>('/api/r/:key/:id/audit', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'audit.view')) throw forbidden();
    const def = requireResource(req.params.key);
    await assertVisible(ctx.db, ctx.actor, def.key, req.params.id);
    const tableName = (def.table as any)[Symbol.for('drizzle:Name')] as string;
    return ctx.db.select({
      id: auditLogs.id, occurredAt: auditLogs.occurredAt, action: auditLogs.action, changedFields: auditLogs.changedFields,
      oldData: auditLogs.oldData, newData: auditLogs.newData, actorName: users.name, requestId: auditLogs.requestId,
    }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(and(eq(auditLogs.tableName, tableName), eq(auditLogs.recordId, req.params.id)))
      .orderBy(desc(auditLogs.id)).limit(200);
  });

  // ── Files ──
  app.get<{ Params: P }>('/api/r/:key/:id/files', async (req) => {
    const ctx = ctxOf(req);
    await assertVisible(ctx.db, ctx.actor, req.params.key, req.params.id);
    const hidden = await hiddenCategories(ctx, req.params.key, req.params.id);
    const rows = await ctx.db.select({
      id: files.id, originalName: files.originalName, mimeType: files.mimeType, sizeBytes: files.sizeBytes,
      category: files.category, expiresOn: files.expiresOn, createdAt: files.createdAt, uploadedByName: users.name, uploadedBy: files.uploadedBy,
    }).from(files).innerJoin(users, eq(users.id, files.uploadedBy))
      .where(and(eq(files.entityType, req.params.key), eq(files.entityId, req.params.id), isNull(files.deletedAt)))
      .orderBy(desc(files.createdAt));
    return rows.filter((f) => !f.category || !hidden.has(f.category));
  });

  app.post<{ Params: P; Querystring: { category?: string; expiresOn?: string } }>('/api/r/:key/:id/files', async (req, reply) => {
    const ctx = ctxOf(req);
    const def = requireResource(req.params.key);
    if (!def.collab?.files) throw badRequest('Attachments are not enabled for this record type');
    // Uploading changes the record, so it requires edit access to it.
    const record = await getOne(ctx, def.key, req.params.id, 'edit');
    const part = await req.file();
    if (!part) throw badRequest('No file uploaded');
    const category = req.query.category?.slice(0, 60) || null;
    const expiresOn = req.query.expiresOn && /^\d{4}-\d{2}-\d{2}$/.test(req.query.expiresOn) ? req.query.expiresOn : null;
    const stored = await storage.save(part.file, part.filename);
    try {
      const [f] = await tx(ctx, async (t) => {
        const rows = await t.insert(files).values({
          storageKey: stored.key, originalName: part.filename.slice(0, 255), mimeType: stored.mime, sizeBytes: stored.size,
          sha256: stored.sha256, entityType: def.key, entityId: record.id, category, expiresOn, uploadedBy: ctx.actor.userId,
        }).returning();
        await emit(t, { type: 'file.uploaded', entityType: def.key, entityId: record.id, actorUserId: ctx.actor.userId, payload: { fileId: rows[0].id, name: part.filename } });
        return rows;
      });
      return reply.status(201).send(f);
    } catch (e) {
      await storage.remove(stored.key);
      throw e;
    }
  });

  async function loadFile(req: any) {
    const ctx = ctxOf(req);
    if (!isUuid(req.params.id)) throw notFound('File');
    const [f] = await ctx.db.select().from(files).where(and(eq(files.id, req.params.id), isNull(files.deletedAt)));
    // Not-found (rather than 403) avoids confirming that a file exists.
    if (!f || !(await isVisible(ctx.db, ctx.actor, f.entityType, f.entityId))) throw notFound('File');
    if (f.category && (await hiddenCategories(ctx, f.entityType, f.entityId)).has(f.category)) throw notFound('File');
    return { ctx, f };
  }

  app.get<{ Params: { id: string } }>('/api/files/:id', async (req, reply) => {
    const { f } = await loadFile(req);
    const inline = INLINE_TYPES.has(f.mimeType);
    reply.header('content-type', f.mimeType);
    reply.header('content-disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(f.originalName)}`);
    reply.header('content-security-policy', "sandbox; default-src 'none'; img-src 'self'; media-src 'self'");
    reply.header('cache-control', 'private, no-store');
    return reply.send(storage.open(f.storageKey));
  });

  app.delete<{ Params: { id: string } }>('/api/files/:id', async (req) => {
    const { ctx, f } = await loadFile(req);
    let allowed = f.uploadedBy === ctx.actor.userId;
    if (!allowed) {
      try { await getOne(ctx, f.entityType, f.entityId, 'edit'); allowed = true; } catch { /* not allowed */ }
    }
    if (!allowed) throw forbidden();
    await tx(ctx, (t) => t.update(files).set({ deletedAt: new Date() }).where(eq(files.id, f.id)));
    return { ok: true };
  });

  // ── Notifications ──
  app.get<{ Querystring: { unread?: string } }>('/api/notifications', async (req) => {
    const ctx = ctxOf(req);
    const rows = await ctx.db.select().from(notifications)
      .where(and(eq(notifications.userId, ctx.actor.userId), req.query.unread === '1' ? isNull(notifications.readAt) : undefined))
      .orderBy(desc(notifications.createdAt)).limit(50);
    const [{ unread }] = await ctx.db.select({ unread: sql<number>`count(*)::int` }).from(notifications)
      .where(and(eq(notifications.userId, ctx.actor.userId), isNull(notifications.readAt)));
    return { rows, unread };
  });

  app.post<{ Params: { id: string } }>('/api/notifications/:id/read', async (req) => {
    const ctx = ctxOf(req);
    if (!isUuid(req.params.id)) throw notFound('Notification');
    await ctx.db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.id, req.params.id), eq(notifications.userId, ctx.actor.userId)));
    return { ok: true };
  });

  app.post('/api/notifications/read-all', async (req) => {
    const ctx = ctxOf(req);
    await ctx.db.update(notifications).set({ readAt: new Date() })
      .where(and(eq(notifications.userId, ctx.actor.userId), isNull(notifications.readAt)));
    return { ok: true };
  });
}
