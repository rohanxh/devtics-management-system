import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, or } from 'drizzle-orm';
import { alias } from 'drizzle-orm/pg-core';
import { z } from 'zod';
import { approvals, pipelineStages, savedViews, users } from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx } from '../core/context.ts';
import { forbidden, notFound } from '../core/errors.ts';
import { emit } from '../core/events.ts';
import { notify } from '../core/notify.ts';
import { approvalHandler, canDecide } from '../core/approvals.ts';
import { can } from '../rbac/actor.ts';
import { allResources, getResource } from '../resources/registry.ts';
import { canAction, list, resourceMeta } from '../resources/engine.ts';
import { isUuid } from '../resources/validate.ts';
import { actorPayload } from '../auth/routes.ts';
import { getSettings } from './settings.ts';

/** Resources included in global search, in display order. */
const SEARCHABLE = ['projects', 'tasks', 'clients', 'companies', 'contacts', 'leads', 'opportunities', 'tickets', 'bugs', 'invoices', 'employees', 'kb_articles', 'assets'];

export async function platformRoutes(app: FastifyInstance) {
  app.get('/api/meta', async (req) => {
    const ctx = ctxOf(req);
    const resources = allResources().filter((d) => canAction(d, ctx.actor, 'view')).map((d) => resourceMeta(d, ctx.actor));
    const stages = await ctx.db.select().from(pipelineStages).orderBy(asc(pipelineStages.pipeline), asc(pipelineStages.sortOrder));
    const pipelines: Record<string, typeof stages> = {};
    for (const s of stages) (pipelines[s.pipeline] ??= []).push(s);
    const s = await getSettings(ctx.db);
    return {
      user: actorPayload(ctx.actor),
      resources: Object.fromEntries(resources.map((r) => [r.key, r])),
      pipelines,
      settings: { companyName: s.companyName, baseCurrency: s.baseCurrency, workdayHours: s.workdayHours },
    };
  });

  app.get<{ Querystring: { q?: string } }>('/api/search', async (req) => {
    const ctx = ctxOf(req);
    const q = req.query.q?.trim() ?? '';
    if (q.length < 2) return [];
    const groups = [];
    for (const key of SEARCHABLE) {
      const def = getResource(key);
      if (!def || !canAction(def, ctx.actor, 'view')) continue;
      const res = await list(ctx, key, { q, pageSize: '5' });
      if (res.rows.length) groups.push({ resource: key, label: def.plural, total: res.total, rows: res.rows.map((r) => ({ id: r.id, title: r._title, number: def.numbering ? r[def.numbering.field] : undefined })) });
    }
    return groups;
  });

  // ── Saved views (per user) ──
  app.get<{ Querystring: { resource?: string } }>('/api/views', async (req) => {
    const ctx = ctxOf(req);
    return ctx.db.select().from(savedViews)
      .where(and(eq(savedViews.userId, ctx.actor.userId), req.query.resource ? eq(savedViews.resource, req.query.resource) : undefined))
      .orderBy(savedViews.name);
  });
  app.post('/api/views', async (req, reply) => {
    const ctx = ctxOf(req);
    const body = z.object({ resource: z.string().max(60), name: z.string().trim().min(1).max(80), query: z.record(z.string(), z.string().max(500)) }).parse(req.body);
    if (!getResource(body.resource)) throw notFound('Resource');
    const [v] = await ctx.db.insert(savedViews).values({ ...body, userId: ctx.actor.userId }).returning();
    return reply.status(201).send(v);
  });
  app.delete<{ Params: { id: string } }>('/api/views/:id', async (req) => {
    const ctx = ctxOf(req);
    if (!isUuid(req.params.id)) throw notFound('View');
    await ctx.db.delete(savedViews).where(and(eq(savedViews.id, req.params.id), eq(savedViews.userId, ctx.actor.userId)));
    return { ok: true };
  });

  // ── Approvals ──
  app.get<{ Querystring: { status?: string; scope?: string } }>('/api/approvals', async (req) => {
    const ctx = ctxOf(req);
    const all = req.query.scope === 'all';
    if (all && !can(ctx.actor, 'approvals.view')) throw forbidden();
    const status = (['pending', 'approved', 'rejected', 'cancelled'] as const).find((s) => s === req.query.status);
    const requester = alias(users, 'requester');
    const decider = alias(users, 'decider');
    const mine = or(
      eq(approvals.approverUserId, ctx.actor.userId),
      ctx.actor.roles.length ? inArray(approvals.approverRoleKey, ctx.actor.roles) : undefined,
      eq(approvals.requestedBy, ctx.actor.userId),
    );
    const rows = await ctx.db.select({
      a: approvals, requestedByName: requester.name, decidedByName: decider.name,
    }).from(approvals)
      .leftJoin(requester, eq(requester.id, approvals.requestedBy))
      .leftJoin(decider, eq(decider.id, approvals.decidedBy))
      .where(and(status ? eq(approvals.status, status) : undefined, all ? undefined : mine))
      .orderBy(desc(approvals.createdAt)).limit(200);
    return rows.map((r) => ({
      ...r.a, requestedByName: r.requestedByName, decidedByName: r.decidedByName,
      canDecide: canDecide(ctx.actor, r.a) && r.a.requestedBy !== ctx.actor.userId,
      link: `/r/${r.a.entityType}/${r.a.entityId}`,
    }));
  });

  app.post<{ Params: { id: string } }>('/api/approvals/:id/decide', async (req) => {
    const ctx = ctxOf(req);
    if (!isUuid(req.params.id)) throw notFound('Approval');
    const body = z.object({ decision: z.enum(['approved', 'rejected']), note: z.string().max(2000).optional() }).parse(req.body);
    const result = await tx(ctx, async (t) => {
      // Lock the row so two approvers cannot decide concurrently.
      const [a] = await t.select().from(approvals).where(eq(approvals.id, req.params.id)).for('update');
      if (!a) throw notFound('Approval');
      if (!canDecide(ctx.actor, a)) throw forbidden('You are not an approver for this request, or it was already decided');
      if (a.requestedBy === ctx.actor.userId) throw forbidden('You cannot approve your own request');
      if (body.decision === 'rejected' && !body.note?.trim()) throw forbidden('A reason is required when rejecting');
      const [updated] = await t.update(approvals).set({
        status: body.decision, decidedBy: ctx.actor.userId, decidedAt: new Date(), decisionNote: body.note,
      }).where(eq(approvals.id, a.id)).returning();
      const h = approvalHandler(a.kind);
      if (body.decision === 'approved') await h?.onApproved?.(t, updated, ctx.actor);
      else await h?.onRejected?.(t, updated, ctx.actor);
      await emit(t, { type: 'approval.decided', entityType: a.entityType, entityId: a.entityId, actorUserId: ctx.actor.userId, payload: { approvalId: a.id, kind: a.kind, decision: body.decision, title: a.title } });
      await notify(t, {
        userIds: [a.requestedBy], kind: 'approval_decided', title: `${body.decision === 'approved' ? 'Approved' : 'Rejected'}: ${a.title}`,
        body: body.note, entityType: a.entityType, entityId: a.entityId, excludeUserId: ctx.actor.userId, dedupeKey: `approval-decided:${a.id}`,
      });
      return updated;
    });
    app.deps.events.kick();
    return result;
  });
}

