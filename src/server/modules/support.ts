import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import { bugs, maintenancePlans, projects, slaPolicies, slaTargets, tasks, tickets } from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx, withActor } from '../core/context.ts';
import { conflict, forbidden, invalid } from '../core/errors.ts';
import { registerAction } from '../core/events.ts';
import { nextNumber } from '../core/counters.ts';
import { notify } from '../core/notify.ts';
import { can } from '../rbac/actor.ts';
import { afterWrite, getOne, requireResource } from '../resources/engine.ts';
import type { Row } from '../resources/types.ts';
import { JOBS } from '../jobs.ts';
import { HEALTH_SIGNALS } from './clients.ts';
import { createWorkflowTask } from './delivery.ts';
import { registerDashboard, scopeOr, today } from './reports.ts';

const OPEN = ['new', 'triaged', 'assigned', 'in_development', 'in_qa', 'waiting_for_client'] as const;

/**
 * SLA due times for a ticket from its plan's policy (or the default policy).
 * ponytail: wall-clock minutes; switch to business-hours calendars if contracts require it.
 */
export async function slaDue(db: DB, priority: string, maintenancePlanId: string | null, from: Date) {
  let policyId: string | null = null;
  if (maintenancePlanId) policyId = (await db.select({ id: maintenancePlans.slaPolicyId }).from(maintenancePlans).where(eq(maintenancePlans.id, maintenancePlanId)))[0]?.id ?? null;
  if (!policyId) policyId = (await db.select({ id: slaPolicies.id }).from(slaPolicies).where(eq(slaPolicies.isDefault, true)))[0]?.id ?? null;
  if (!policyId) return { firstResponseDueAt: null, resolutionDueAt: null };
  const [t] = await db.select().from(slaTargets).where(and(eq(slaTargets.policyId, policyId), eq(slaTargets.priority, priority as any)));
  if (!t) return { firstResponseDueAt: null, resolutionDueAt: null };
  return {
    firstResponseDueAt: new Date(from.getTime() + t.firstResponseMinutes * 60_000),
    resolutionDueAt: new Date(from.getTime() + t.resolutionMinutes * 60_000),
  };
}

/** Hours used on a maintenance plan in a month (time logged against its tickets). */
export async function planUsage(db: DB, planIds: string[], monthStartDate = today().slice(0, 8) + '01') {
  if (!planIds.length) return new Map<string, number>();
  const res: any = await db.execute(sql`
    select t.maintenance_plan_id as plan_id, coalesce(sum(te.minutes), 0)::float / 60 as hours
    from time_entries te join tickets t on t.id = te.ticket_id
    where t.maintenance_plan_id in ${planIds} and te.work_date >= ${monthStartDate}::date
    group by t.maintenance_plan_id`);
  return new Map((res.rows as any[]).map((r) => [r.plan_id, Math.round(r.hours * 100) / 100]));
}

// ───────────── Client health ─────────────

HEALTH_SIGNALS.push(async (db, ids) => {
  const m = new Map<string, { penalty: number; reason: string }[]>();
  const rows = await db.select({
    companyId: tickets.companyId,
    urgent: sql<number>`count(*) filter (where ${tickets.priority} = 'urgent')::int`,
    breached: sql<number>`count(*) filter (where ${tickets.slaBreached})::int`,
    open: sql<number>`count(*)::int`,
  }).from(tickets).where(and(inArray(tickets.companyId, ids), inArray(tickets.status, [...OPEN]))).groupBy(tickets.companyId);
  for (const r of rows) {
    const list = [];
    if (r.urgent) list.push({ penalty: Math.min(15 * r.urgent, 30), reason: `${r.urgent} urgent open ticket(s)` });
    if (r.breached) list.push({ penalty: Math.min(10 * r.breached, 20), reason: `${r.breached} SLA breach(es)` });
    if (r.open >= 5) list.push({ penalty: 10, reason: `${r.open} open support requests` });
    if (list.length) m.set(r.companyId, list);
  }
  return m;
});

// ───────────── Automation: delivery work drives ticket status ─────────────

registerAction('support.sync_from_work', {
  description: 'Keep tickets in step with the linked development work: task in QA/done → ticket “In QA”; bug verified/closed → ticket “Resolved”.',
  async run({ db, event }) {
    const to = String(event.payload.to);
    const isBug = event.entityType === 'bugs';
    const linked = await db.select().from(tickets).where(and(isBug ? eq(tickets.bugId, event.entityId!) : eq(tickets.taskId, event.entityId!), inArray(tickets.status, [...OPEN])));
    for (const tk of linked) {
      let next: typeof tk.status | null = null;
      if (!isBug && (to === 'qa' || to === 'done')) next = 'in_qa';
      if (isBug && to === 'ready_for_retest') next = 'in_qa';
      if (isBug && (to === 'verified' || to === 'closed')) next = 'resolved';
      if (!next || next === tk.status) continue;
      const [u] = await db.update(tickets).set({ status: next, resolvedAt: next === 'resolved' ? new Date() : tk.resolvedAt }).where(eq(tickets.id, tk.id)).returning();
      await afterWrite(db, requireResource('tickets'), null, u as Row, tk as Row);
    }
  },
});

// ───────────── Routes ─────────────

export async function supportRoutes(app: FastifyInstance) {
  /** Escalate a ticket to development: creates a task (or bug) in the client's project and links it. */
  app.post<{ Params: { id: string } }>('/api/support/tickets/:id/escalate', async (req, reply) => {
    const ctx = ctxOf(req);
    const ticket = await getOne(ctx, 'tickets', req.params.id, 'edit');
    const body = z.object({ kind: z.enum(['task', 'bug']), assigneeId: z.uuid().optional().nullable(), severity: z.enum(['critical', 'high', 'medium', 'low']).optional() }).parse(req.body);
    if (ticket.taskId || ticket.bugId) throw conflict('This ticket is already linked to development work');
    if (!ticket.projectId) throw invalid('Link the ticket to a project first', { projectId: 'Required to escalate' });
    if (body.kind === 'task' ? !can(ctx.actor, 'tasks.create') : !can(ctx.actor, 'bugs.create')) throw forbidden();
    const result = await tx(ctx, async (t) => {
      let patch: Partial<typeof tickets.$inferInsert>;
      let created: any;
      if (body.kind === 'task') {
        created = await createWorkflowTask(t, {
          projectId: ticket.projectId, title: `[${ticket.number}] ${ticket.title}`, assigneeId: body.assigneeId ?? null, reporterId: ctx.actor.userId,
          description: ticket.description ?? undefined, priority: ticket.priority === 'urgent' ? 'critical' : ticket.priority,
        });
        await t.update(tasks).set({ type: 'support' }).where(eq(tasks.id, created.id));
        patch = { taskId: created.id };
      } else {
        const [b] = await t.insert(bugs).values({
          number: await nextNumber(t, 'bug', 'BUG-', 5), projectId: ticket.projectId, title: `[${ticket.number}] ${ticket.title}`, description: ticket.description,
          severity: body.severity ?? (ticket.priority === 'urgent' ? 'critical' : ticket.priority === 'high' ? 'high' : 'medium'),
          priority: ticket.priority === 'urgent' ? 'critical' : ticket.priority, foundIn: 'client', environment: 'production',
          reportedById: ctx.actor.userId, assigneeId: body.assigneeId ?? null, ticketId: ticket.id,
        }).returning();
        await afterWrite(t, requireResource('bugs'), ctx.actor, b as Row, undefined);
        created = b;
        patch = { bugId: b.id };
      }
      const [u] = await t.update(tickets).set({ ...patch, status: 'in_development', firstRespondedAt: ticket.firstRespondedAt ?? new Date() }).where(eq(tickets.id, ticket.id)).returning();
      await afterWrite(t, requireResource('tickets'), ctx.actor, u as Row, ticket);
      return created;
    });
    app.deps.events.kick();
    return reply.status(201).send(result);
  });

  app.get('/api/support/plans/usage', async (req) => {
    const ctx = ctxOf(req);
    const plans = await ctx.db.select().from(maintenancePlans).where(and(scopeOr(ctx, 'maintenance_plans'), eq(maintenancePlans.status, 'active')));
    const usage = await planUsage(ctx.db, plans.map((p) => p.id));
    return plans.map((p) => ({ id: p.id, name: p.name, monthlyHours: Number(p.monthlyHours), used: usage.get(p.id) ?? 0, remaining: Math.round((Number(p.monthlyHours) - (usage.get(p.id) ?? 0)) * 100) / 100 }));
  });
}

// ───────────── Jobs ─────────────

JOBS.push(
  {
    name: 'support.sla', everyMinutes: 15,
    run: (db) => withActor(db, null, 'job:support.sla', async (t) => {
      const now = new Date();
      const late = await t.select().from(tickets).where(and(inArray(tickets.status, [...OPEN]), eq(tickets.slaBreached, false),
        sql`(${tickets.resolutionDueAt} < ${now} or (${tickets.firstRespondedAt} is null and ${tickets.firstResponseDueAt} < ${now}))`));
      for (const tk of late) {
        const [u] = await t.update(tickets).set({ slaBreached: true, breachedAt: now }).where(eq(tickets.id, tk.id)).returning();
        await afterWrite(t, requireResource('tickets'), null, u as Row, tk as Row);
        const [p] = tk.projectId ? await t.select({ pmId: projects.pmId }).from(projects).where(eq(projects.id, tk.projectId)) : [];
        await notify(t, {
          roles: ['support'], userIds: [tk.assigneeId, p?.pmId], kind: 'escalation',
          title: `SLA breached: ${tk.number} ${tk.title} (${tk.priority})`, entityType: 'tickets', entityId: tk.id, dedupeKey: `sla:${tk.id}`,
        });
      }
    }),
  },
  {
    name: 'support.plan_usage', everyMinutes: 360,
    run: (db) => withActor(db, null, 'job:support.plan_usage', async (t) => {
      const plans = await t.select().from(maintenancePlans).where(eq(maintenancePlans.status, 'active'));
      const usage = await planUsage(t, plans.map((p) => p.id));
      const month = today().slice(0, 7);
      for (const p of plans) {
        const used = usage.get(p.id) ?? 0;
        const pct = Number(p.monthlyHours) ? (used / Number(p.monthlyHours)) * 100 : 0;
        const level = pct >= 100 ? 100 : pct >= 80 ? 80 : 0;
        if (!level) continue;
        await notify(t, {
          roles: ['support', 'finance'], userIds: [p.accountManagerId], kind: 'alert',
          title: `${p.name}: ${used}h of ${p.monthlyHours}h used this month (${Math.round(pct)}%)${level === 100 ? ' — overage billable' : ''}`,
          entityType: 'maintenance_plans', entityId: p.id, dedupeKey: `plan-usage:${p.id}:${month}:${level}`,
        });
      }
    }),
  },
);

// ───────────── Dashboard ─────────────

registerDashboard({
  key: 'support', perm: 'tickets.view',
  async build(ctx) {
    const scope = scopeOr(ctx, 'tickets');
    const [c] = await ctx.db.select({
      open: sql<number>`count(*) filter (where ${tickets.status} in ('new','triaged','assigned','in_development','in_qa','waiting_for_client'))::int`,
      urgent: sql<number>`count(*) filter (where ${tickets.priority} = 'urgent' and ${tickets.status} not in ('resolved','closed'))::int`,
      breached: sql<number>`count(*) filter (where ${tickets.slaBreached} and ${tickets.status} not in ('resolved','closed'))::int`,
      waiting: sql<number>`count(*) filter (where ${tickets.status} = 'waiting_for_client')::int`,
      mine: sql<number>`count(*) filter (where ${tickets.assigneeId} = ${ctx.actor.userId} and ${tickets.status} not in ('resolved','closed'))::int`,
      unassigned: sql<number>`count(*) filter (where ${tickets.assigneeId} is null and ${tickets.status} not in ('resolved','closed'))::int`,
      resolved7: sql<number>`count(*) filter (where ${tickets.resolvedAt} >= now() - interval '7 days')::int`,
    }).from(tickets).where(scope);
    const byStatus = await ctx.db.select({ status: tickets.status, n: sql<number>`count(*)::int` }).from(tickets).where(and(scope, inArray(tickets.status, [...OPEN]))).groupBy(tickets.status);
    const queue = await ctx.db.select({
      id: tickets.id, number: tickets.number, title: tickets.title, priority: tickets.priority, status: tickets.status, slaBreached: tickets.slaBreached,
      resolutionDueAt: tickets.resolutionDueAt, assigneeId: tickets.assigneeId, client: sql<string>`(select c.name from companies c where c.id = tickets.company_id)`,
    }).from(tickets).where(and(scope, inArray(tickets.status, [...OPEN]))).orderBy(sql`${tickets.slaBreached} desc`, asc(tickets.resolutionDueAt)).limit(15);
    const plans = await ctx.db.select().from(maintenancePlans).where(and(scopeOr(ctx, 'maintenance_plans'), eq(maintenancePlans.status, 'active')));
    const usage = await planUsage(ctx.db, plans.map((p) => p.id));
    const [{ avgHours }] = await ctx.db.select({ avgHours: sql<number>`coalesce(avg(extract(epoch from (${tickets.resolvedAt} - ${tickets.createdAt})) / 3600), 0)::float` })
      .from(tickets).where(and(scope, gte(tickets.resolvedAt, new Date(Date.now() - 30 * 86400_000))));
    return {
      counts: c, byStatus, queue, avgResolutionHours: Math.round(avgHours * 10) / 10,
      plans: plans.map((p) => ({ id: p.id, name: p.name, monthlyHours: Number(p.monthlyHours), used: usage.get(p.id) ?? 0 })),
    };
  },
});

