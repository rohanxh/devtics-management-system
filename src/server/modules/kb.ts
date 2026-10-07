import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import {
  employees, kbAcknowledgements, kbArticleAudiences, kbArticles, kbArticleVersions, kbReadingAssignments, roles, userRoles, users,
} from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import type { Ctx } from '../core/context.ts';
import { tx, withActor } from '../core/context.ts';
import { conflict, forbidden, invalid, notFound } from '../core/errors.ts';
import { emit } from '../core/events.ts';
import { notify } from '../core/notify.ts';
import { can } from '../rbac/actor.ts';
import { afterWrite, requireResource } from '../resources/engine.ts';
import { isUuid } from '../resources/validate.ts';
import type { Row } from '../resources/types.ts';
import { JOBS } from '../jobs.ts';

const today = () => new Date().toISOString().slice(0, 10);
const plus = (k: number) => new Date(Date.now() + k * 86400_000).toISOString().slice(0, 10);
const CATEGORIES = ['sop', 'policy', 'dev_standard', 'qa_standard', 'pm_procedure', 'sales_procedure', 'hr_policy', 'template', 'training', 'architecture', 'other'] as const;
const slugify = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80) || 'article';

const isEditor = (ctx: Ctx) => can(ctx.actor, 'kb.create') || can(ctx.actor, 'kb.edit');

/** Edit rights on one article: kb.edit at "all", or owner with kb.edit@own. */
function canEdit(ctx: Ctx, a: typeof kbArticles.$inferSelect) {
  const s = ctx.actor.perms.get('kb.edit');
  return s === 'all' || (!!s && a.ownerId === ctx.actor.userId);
}

async function loadArticle(ctx: Ctx, idOrSlug: string) {
  const [a] = await ctx.db.select().from(kbArticles).where(isUuid(idOrSlug) ? eq(kbArticles.id, idOrSlug) : eq(kbArticles.slug, idOrSlug));
  // Drafts and archived articles are only visible to editors (not-found otherwise).
  if (!a || (a.status !== 'published' && !(isEditor(ctx) && (canEdit(ctx, a) || a.ownerId === ctx.actor.userId || can(ctx.actor, 'kb.publish'))))) throw notFound('Article');
  return a;
}

/** Users a required-reading article applies to (its audience, or everyone when no audience is set). */
export async function audienceUserIds(db: DB, articleId: string): Promise<string[]> {
  const aud = await db.select().from(kbArticleAudiences).where(eq(kbArticleAudiences.articleId, articleId));
  const active = eq(users.status, 'active');
  if (!aud.length) return (await db.select({ id: users.id }).from(users).where(active)).map((r) => r.id);
  const roleIds = aud.map((a) => a.roleId).filter(Boolean) as string[];
  const deptIds = aud.map((a) => a.departmentId).filter(Boolean) as string[];
  const ids = new Set<string>();
  if (roleIds.length) (await db.selectDistinct({ id: users.id }).from(users).innerJoin(userRoles, eq(userRoles.userId, users.id)).where(and(active, inArray(userRoles.roleId, roleIds)))).forEach((r) => ids.add(r.id));
  if (deptIds.length) (await db.select({ id: employees.userId }).from(employees).innerJoin(users, eq(users.id, employees.userId)).where(and(active, inArray(employees.departmentId, deptIds)))).forEach((r) => r.id && ids.add(r.id));
  return [...ids];
}

/** Creates reading assignments for a published required-reading version and notifies readers. */
async function assignReading(db: DB, article: typeof kbArticles.$inferSelect, versionId: string) {
  const userIds = await audienceUserIds(db, article.id);
  if (!userIds.length) return 0;
  const due = plus(article.acknowledgeWithinDays);
  const rows = await db.insert(kbReadingAssignments).values(userIds.map((userId) => ({ articleId: article.id, versionId, userId, dueDate: due })))
    .onConflictDoNothing().returning({ userId: kbReadingAssignments.userId });
  await notify(db, {
    userIds: rows.map((r) => r.userId), kind: 'approval_request', title: `Required reading: ${article.title} (acknowledge by ${due})`,
    link: `/kb/${article.slug}`, dedupeKey: `kb-read:${versionId}`,
  });
  return rows.length;
}

export async function kbRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { q?: string; category?: string; status?: string } }>('/api/kb', async (req) => {
    const ctx = ctxOf(req);
    const q = req.query.q?.trim().slice(0, 100);
    const editor = isEditor(ctx);
    const cat = CATEGORIES.find((c) => c === req.query.category);
    const rows = await ctx.db.select({
      id: kbArticles.id, slug: kbArticles.slug, title: kbArticles.title, category: kbArticles.category, summary: kbArticles.summary, status: kbArticles.status,
      requiredReading: kbArticles.requiredReading, publishedAt: kbArticles.publishedAt, updatedAt: kbArticles.updatedAt, ownerName: users.name,
      version: sql<number>`(select v.version_number from kb_article_versions v where v.id = kb_articles.current_version_id)`,
      acknowledged: sql<boolean>`exists (select 1 from kb_acknowledgements k where k.version_id = kb_articles.current_version_id and k.user_id = ${ctx.actor.userId})`,
      mustRead: sql<boolean>`exists (select 1 from kb_reading_assignments r where r.version_id = kb_articles.current_version_id and r.user_id = ${ctx.actor.userId})`,
    }).from(kbArticles).leftJoin(users, eq(users.id, kbArticles.ownerId))
      .where(and(
        editor && req.query.status !== 'published' ? sql`${kbArticles.status} <> 'archived' or ${kbArticles.ownerId} = ${ctx.actor.userId}` : eq(kbArticles.status, 'published'),
        cat ? eq(kbArticles.category, cat) : undefined,
        q ? or(ilike(kbArticles.title, `%${q.replace(/[\\%_]/g, '\\$&')}%`), ilike(kbArticles.summary, `%${q.replace(/[\\%_]/g, '\\$&')}%`),
          sql`exists (select 1 from kb_article_versions v where v.id = kb_articles.current_version_id and v.body ilike ${'%' + q.replace(/[\\%_]/g, '\\$&') + '%'})`) : undefined,
      )).orderBy(asc(kbArticles.category), asc(kbArticles.title));
    return { rows, canCreate: can(ctx.actor, 'kb.create') };
  });

  app.get('/api/kb/my-reading', async (req) => {
    const ctx = ctxOf(req);
    return ctx.db.select({ articleId: kbArticles.id, slug: kbArticles.slug, title: kbArticles.title, dueDate: kbReadingAssignments.dueDate })
      .from(kbReadingAssignments).innerJoin(kbArticles, eq(kbArticles.id, kbReadingAssignments.articleId))
      .leftJoin(kbAcknowledgements, and(eq(kbAcknowledgements.versionId, kbReadingAssignments.versionId), eq(kbAcknowledgements.userId, kbReadingAssignments.userId)))
      .where(and(eq(kbReadingAssignments.userId, ctx.actor.userId), isNull(kbAcknowledgements.id), eq(kbReadingAssignments.versionId, kbArticles.currentVersionId)))
      .orderBy(asc(kbReadingAssignments.dueDate));
  });

  app.get<{ Params: { id: string }; Querystring: { draft?: string; version?: string } }>('/api/kb/:id', async (req) => {
    const ctx = ctxOf(req);
    const a = await loadArticle(ctx, req.params.id);
    const editable = canEdit(ctx, a);
    const versions = await ctx.db.select({ id: kbArticleVersions.id, versionNumber: kbArticleVersions.versionNumber, changeSummary: kbArticleVersions.changeSummary, publishedAt: kbArticleVersions.publishedAt, createdAt: kbArticleVersions.createdAt, author: users.name })
      .from(kbArticleVersions).leftJoin(users, eq(users.id, kbArticleVersions.createdById)).where(eq(kbArticleVersions.articleId, a.id)).orderBy(desc(kbArticleVersions.versionNumber));
    const latestDraft = versions.find((v) => !v.publishedAt && versions[0].id === v.id);
    let versionId = a.currentVersionId;
    if ((req.query.draft === '1' && editable && latestDraft) || !versionId) versionId = latestDraft?.id ?? versions[0]?.id ?? null;
    if (req.query.version && isUuid(req.query.version) && versions.some((v) => v.id === req.query.version && (v.publishedAt || editable))) versionId = req.query.version;
    const [v] = versionId ? await ctx.db.select().from(kbArticleVersions).where(eq(kbArticleVersions.id, versionId)) : [];
    const [ack] = a.currentVersionId ? await ctx.db.select().from(kbAcknowledgements).where(and(eq(kbAcknowledgements.versionId, a.currentVersionId), eq(kbAcknowledgements.userId, ctx.actor.userId))) : [];
    const audience = await ctx.db.select({ roleId: kbArticleAudiences.roleId, departmentId: kbArticleAudiences.departmentId }).from(kbArticleAudiences).where(eq(kbArticleAudiences.articleId, a.id));
    const [owner] = a.ownerId ? await ctx.db.select({ name: users.name }).from(users).where(eq(users.id, a.ownerId)) : [];
    return {
      article: { ...a, ownerName: owner?.name ?? null }, version: v ?? null, isCurrent: v?.id === a.currentVersionId,
      acknowledgedAt: ack?.acknowledgedAt ?? null, versions: editable ? versions : versions.filter((x) => x.publishedAt), audience,
      hasDraft: !!latestDraft, can: { edit: editable, publish: can(ctx.actor, 'kb.publish'), acknowledge: !!a.currentVersionId && !ack && a.status === 'published' },
    };
  });

  const ArticleBody = z.object({
    title: z.string().trim().min(3).max(200), body: z.string().min(1).max(200000), summary: z.string().max(1000).optional().nullable(),
    category: z.enum(CATEGORIES).optional(), requiredReading: z.boolean().optional(), acknowledgeWithinDays: z.number().int().min(1).max(90).optional(),
    reviewIntervalDays: z.number().int().min(7).max(1095).optional().nullable(),
  });

  app.post('/api/kb', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'kb.create')) throw forbidden();
    const parsed = ArticleBody.safeParse(req.body);
    if (!parsed.success) throw invalid('Validation failed', z.flattenError(parsed.error).fieldErrors);
    const d = parsed.data;
    const a = await tx(ctx, async (t) => {
      let slug = slugify(d.title);
      if ((await t.select({ id: kbArticles.id }).from(kbArticles).where(eq(kbArticles.slug, slug))).length) slug = `${slug}-${Date.now().toString(36)}`;
      const [art] = await t.insert(kbArticles).values({
        slug, title: d.title, summary: d.summary, category: d.category ?? 'sop', ownerId: ctx.actor.userId, requiredReading: d.requiredReading ?? false,
        acknowledgeWithinDays: d.acknowledgeWithinDays ?? 7, reviewIntervalDays: d.reviewIntervalDays ?? null,
      }).returning();
      await t.insert(kbArticleVersions).values({ articleId: art.id, versionNumber: 1, title: d.title, body: d.body, createdById: ctx.actor.userId });
      await afterWrite(t, requireResource('kb_articles'), ctx.actor, art as Row, undefined);
      return art;
    });
    return reply.status(201).send(a);
  });

  /** Save edits as the working draft (a new version if the latest one is already published). */
  app.put<{ Params: { id: string } }>('/api/kb/:id/draft', async (req) => {
    const ctx = ctxOf(req);
    const a = await loadArticle(ctx, req.params.id);
    if (!canEdit(ctx, a)) throw forbidden();
    const parsed = ArticleBody.safeParse(req.body);
    if (!parsed.success) throw invalid('Validation failed', z.flattenError(parsed.error).fieldErrors);
    const d = parsed.data;
    return tx(ctx, async (t) => {
      const [latest] = await t.select().from(kbArticleVersions).where(eq(kbArticleVersions.articleId, a.id)).orderBy(desc(kbArticleVersions.versionNumber)).limit(1);
      let v;
      if (latest && !latest.publishedAt) {
        [v] = await t.update(kbArticleVersions).set({ title: d.title, body: d.body }).where(eq(kbArticleVersions.id, latest.id)).returning();
      } else {
        [v] = await t.insert(kbArticleVersions).values({ articleId: a.id, versionNumber: (latest?.versionNumber ?? 0) + 1, title: d.title, body: d.body, createdById: ctx.actor.userId }).returning();
      }
      const meta: Partial<typeof kbArticles.$inferInsert> = {};
      if (d.summary !== undefined) meta.summary = d.summary;
      if (d.category) meta.category = d.category;
      if (d.requiredReading !== undefined) meta.requiredReading = d.requiredReading;
      if (d.acknowledgeWithinDays) meta.acknowledgeWithinDays = d.acknowledgeWithinDays;
      if (d.reviewIntervalDays !== undefined) meta.reviewIntervalDays = d.reviewIntervalDays;
      if (a.status === 'draft') meta.title = d.title;
      if (Object.keys(meta).length) {
        const [u] = await t.update(kbArticles).set(meta).where(eq(kbArticles.id, a.id)).returning();
        await afterWrite(t, requireResource('kb_articles'), ctx.actor, u as Row, a as Row);
      }
      return v;
    });
  });

  app.put<{ Params: { id: string } }>('/api/kb/:id/audience', async (req) => {
    const ctx = ctxOf(req);
    const a = await loadArticle(ctx, req.params.id);
    if (!canEdit(ctx, a)) throw forbidden();
    const body = z.object({ roleKeys: z.array(z.string()).max(30).default([]), departmentIds: z.array(z.uuid()).max(50).default([]) }).parse(req.body);
    const rs = body.roleKeys.length ? await ctx.db.select().from(roles).where(inArray(roles.key, body.roleKeys)) : [];
    await tx(ctx, async (t) => {
      await t.delete(kbArticleAudiences).where(eq(kbArticleAudiences.articleId, a.id));
      const values = [...rs.map((r) => ({ articleId: a.id, roleId: r.id })), ...body.departmentIds.map((d) => ({ articleId: a.id, departmentId: d }))];
      if (values.length) await t.insert(kbArticleAudiences).values(values);
    });
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/kb/:id/publish', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'kb.publish')) throw forbidden('Publishing requires the knowledge-base publish permission');
    const a = await loadArticle(ctx, req.params.id);
    const body = z.object({ changeSummary: z.string().trim().max(1000).optional() }).parse(req.body ?? {});
    const result = await tx(ctx, async (t) => {
      const [latest] = await t.select().from(kbArticleVersions).where(eq(kbArticleVersions.articleId, a.id)).orderBy(desc(kbArticleVersions.versionNumber)).limit(1);
      if (!latest || latest.publishedAt) throw conflict('There is no draft to publish');
      await t.update(kbArticleVersions).set({ publishedAt: new Date(), publishedById: ctx.actor.userId, changeSummary: body.changeSummary ?? (latest.versionNumber === 1 ? 'Initial version' : null) })
        .where(eq(kbArticleVersions.id, latest.id));
      const [u] = await t.update(kbArticles).set({ status: 'published', currentVersionId: latest.id, title: latest.title, publishedAt: new Date(), lastReviewedOn: today() })
        .where(eq(kbArticles.id, a.id)).returning();
      await afterWrite(t, requireResource('kb_articles'), ctx.actor, u as Row, a as Row);
      await emit(t, { type: 'kb.published', entityType: 'kb_articles', entityId: a.id, actorUserId: ctx.actor.userId, payload: { title: u.title, version: latest.versionNumber, requiredReading: u.requiredReading } });
      const assigned = u.requiredReading ? await assignReading(t, u, latest.id) : 0;
      return { version: latest.versionNumber, assigned };
    });
    app.deps.events.kick();
    return result;
  });

  app.post<{ Params: { id: string } }>('/api/kb/:id/acknowledge', async (req) => {
    const ctx = ctxOf(req);
    const a = await loadArticle(ctx, req.params.id);
    if (a.status !== 'published' || !a.currentVersionId) throw conflict('Only published articles can be acknowledged');
    await tx(ctx, (t) => t.insert(kbAcknowledgements).values({ articleId: a.id, versionId: a.currentVersionId!, userId: ctx.actor.userId }).onConflictDoNothing());
    return { ok: true };
  });

  /** Acknowledgement compliance for the current version. */
  app.get<{ Params: { id: string } }>('/api/kb/:id/compliance', async (req) => {
    const ctx = ctxOf(req);
    const a = await loadArticle(ctx, req.params.id);
    if (!canEdit(ctx, a) && !can(ctx.actor, 'kb.publish') && !can(ctx.actor, 'reports.hr')) throw forbidden();
    if (!a.currentVersionId) return { rows: [], total: 0, acknowledged: 0 };
    const rows = await ctx.db.select({
      userId: users.id, name: users.name, dueDate: kbReadingAssignments.dueDate, acknowledgedAt: kbAcknowledgements.acknowledgedAt,
    }).from(kbReadingAssignments).innerJoin(users, eq(users.id, kbReadingAssignments.userId))
      .leftJoin(kbAcknowledgements, and(eq(kbAcknowledgements.versionId, kbReadingAssignments.versionId), eq(kbAcknowledgements.userId, kbReadingAssignments.userId)))
      .where(eq(kbReadingAssignments.versionId, a.currentVersionId)).orderBy(asc(users.name));
    return { rows, total: rows.length, acknowledged: rows.filter((r) => r.acknowledgedAt).length };
  });
}

JOBS.push({
  name: 'kb.reminders', everyMinutes: 720,
  run: (db) => withActor(db, null, 'job:kb.reminders', async (t) => {
    const overdue = await t.select({ a: kbReadingAssignments, title: kbArticles.title, slug: kbArticles.slug }).from(kbReadingAssignments)
      .innerJoin(kbArticles, and(eq(kbArticles.id, kbReadingAssignments.articleId), eq(kbArticles.currentVersionId, kbReadingAssignments.versionId)))
      .leftJoin(kbAcknowledgements, and(eq(kbAcknowledgements.versionId, kbReadingAssignments.versionId), eq(kbAcknowledgements.userId, kbReadingAssignments.userId)))
      .where(and(isNull(kbAcknowledgements.id), lt(kbReadingAssignments.dueDate, today())));
    for (const o of overdue) {
      await notify(t, { userIds: [o.a.userId], kind: 'deadline', title: `Overdue required reading: ${o.title}`, link: `/kb/${o.slug}`, dedupeKey: `kb-overdue:${o.a.versionId}` });
    }
    const review = await t.select().from(kbArticles).where(and(eq(kbArticles.status, 'published'), sql`${kbArticles.reviewIntervalDays} is not null`,
      sql`${kbArticles.lastReviewedOn} + ${kbArticles.reviewIntervalDays} <= current_date`));
    for (const a of review) {
      await notify(t, { userIds: [a.ownerId], kind: 'deadline', title: `Review due: ${a.title}`, link: `/kb/${a.slug}`, dedupeKey: `kb-review:${a.id}:${a.lastReviewedOn}` });
    }
  }),
});
