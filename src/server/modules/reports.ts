import type { FastifyInstance } from 'fastify';
import { and, eq, gte, inArray, isNull, lt, lte, ne, notInArray, sql, type SQL } from 'drizzle-orm';
import {
  followUps, leads, opportunities, pipelineStages, projectMembers, projects, projectUpdates, salesTargets, tasks,
  timeEntries, users,
} from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import type { Ctx } from '../core/context.ts';
import { forbidden } from '../core/errors.ts';
import { can } from '../rbac/actor.ts';
import { canAction, scopeCondition } from '../resources/engine.ts';
import { getResource } from '../resources/registry.ts';
import { getSettings } from './settings.ts';

/**
 * Reporting is the single source of truth for business metrics: dashboards and reports call these
 * functions so figures are identical everywhere. Every query is restricted by the caller's record scope.
 */
export const today = () => new Date().toISOString().slice(0, 10);
export const monthStart = () => today().slice(0, 8) + '01';
const n = (v: unknown) => Number(v ?? 0);

/** Scope SQL for a resource, or `false` if the actor cannot view it at all. */
export function scopeOr(ctx: Ctx, key: string): SQL | undefined {
  const def = getResource(key)!;
  if (!canAction(def, ctx.actor, 'view')) return sql`false`;
  return scopeCondition(def, ctx.actor, 'view');
}

export interface DashboardDef { key: string; roles?: string[]; perm?: string; build: (ctx: Ctx, q: Record<string, string | undefined>) => Promise<unknown> }
export const DASHBOARDS = new Map<string, DashboardDef>();
export const registerDashboard = (d: DashboardDef) => DASHBOARDS.set(d.key, d);
/** Other modules can contribute sections to a dashboard without coupling to it. */
const EXTRAS = new Map<string, ((ctx: Ctx) => Promise<Record<string, unknown>>)[]>();
export const registerDashboardExtra = (key: string, fn: (ctx: Ctx) => Promise<Record<string, unknown>>) => EXTRAS.set(key, [...(EXTRAS.get(key) ?? []), fn]);

// ───────────── Delivery metrics ─────────────

export async function projectPortfolio(ctx: Ctx, opts: { managedOnly?: boolean } = {}) {
  const uid = ctx.actor.userId;
  const where = and(
    scopeOr(ctx, 'projects'),
    notInArray(projects.status, ['completed', 'cancelled']),
    opts.managedOnly ? sql`(${projects.pmId} = ${uid} or ${projects.techLeadId} = ${uid})` : undefined,
  );
  const rows = await ctx.db.select({
    id: projects.id, code: projects.code, name: projects.name, status: projects.status, stageId: projects.stageId,
    stageName: pipelineStages.name, stageColor: pipelineStages.color, dueDate: projects.dueDate, pmId: projects.pmId,
    pmName: users.name, budgetHours: projects.budgetHours, clientId: projects.clientId, priority: projects.priority,
    tasksTotal: sql<number>`(select count(*)::int from tasks t where t.project_id = ${projects.id} and t.parent_task_id is null)`,
    tasksDone: sql<number>`(select count(*)::int from tasks t where t.project_id = ${projects.id} and t.parent_task_id is null and t.status = 'done')`,
    tasksOverdue: sql<number>`(select count(*)::int from tasks t where t.project_id = ${projects.id} and t.status <> 'done' and t.due_date < current_date)`,
    minutesLogged: sql<number>`(select coalesce(sum(te.minutes), 0)::int from time_entries te where te.project_id = ${projects.id})`,
    clientName: sql<string>`(select c.name from companies c where c.id = ${projects.clientId})`,
  }).from(projects)
    .innerJoin(pipelineStages, eq(pipelineStages.id, projects.stageId))
    .leftJoin(users, eq(users.id, projects.pmId))
    .where(where).orderBy(sql`${projects.dueDate} asc nulls last`);
  return rows.map((r) => ({
    ...r,
    progressPct: r.tasksTotal ? Math.round((r.tasksDone / r.tasksTotal) * 100) : 0,
    hoursLogged: Math.round((r.minutesLogged / 60) * 10) / 10,
    hoursBudgetPct: r.budgetHours ? Math.round((r.minutesLogged / 60 / Number(r.budgetHours)) * 100) : null,
  }));
}

/** Logged hours vs capacity per person over a window — basis for utilization everywhere. */
export async function utilization(ctx: Ctx, from: string, to: string, userIds?: string[]) {
  const s = await getSettings(ctx.db);
  const workdays = countWorkdays(from, to);
  const rows = await ctx.db.select({
    userId: users.id, name: users.name,
    minutes: sql<number>`coalesce(sum(${timeEntries.minutes}), 0)::int`,
    billableMinutes: sql<number>`coalesce(sum(${timeEntries.minutes}) filter (where ${timeEntries.billable}), 0)::int`,
  }).from(users)
    .leftJoin(timeEntries, and(eq(timeEntries.userId, users.id), gte(timeEntries.workDate, from), lte(timeEntries.workDate, to)))
    .where(and(eq(users.status, 'active'), userIds ? (userIds.length ? inArray(users.id, userIds) : sql`false`) : undefined))
    .groupBy(users.id, users.name).orderBy(users.name);
  const capacity = workdays * s.workdayHours;
  return rows.map((r) => ({
    ...r, hours: r.minutes / 60, billableHours: r.billableMinutes / 60, capacityHours: capacity,
    utilizationPct: capacity ? Math.round((r.minutes / 60 / capacity) * 100) : 0,
    billablePct: capacity ? Math.round((r.billableMinutes / 60 / capacity) * 100) : 0,
  }));
}

export function countWorkdays(from: string, to: string) {
  let d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  let c = 0;
  while (d <= end) { const w = d.getUTCDay(); if (w !== 0 && w !== 6) c++; d = new Date(d.getTime() + 86400_000); }
  return c;
}

export const daysAgo = (k: number) => new Date(Date.now() - k * 86400_000).toISOString().slice(0, 10);

// ───────────── Sales metrics ─────────────

export async function salesPipeline(ctx: Ctx, ownerOnly?: boolean) {
  const where = and(scopeOr(ctx, 'opportunities'), ownerOnly ? eq(opportunities.ownerId, ctx.actor.userId) : undefined);
  const byStage = await ctx.db.select({
    stageId: pipelineStages.id, key: pipelineStages.key, name: pipelineStages.name, color: pipelineStages.color, sortOrder: pipelineStages.sortOrder,
    count: sql<number>`count(${opportunities.id})::int`,
    value: sql<string>`coalesce(sum(${opportunities.value}), 0)`,
    weighted: sql<string>`coalesce(sum(${opportunities.value} * ${opportunities.probability} / 100.0), 0)`,
  }).from(pipelineStages)
    .leftJoin(opportunities, and(eq(opportunities.stageId, pipelineStages.id), where))
    .where(eq(pipelineStages.pipeline, 'sales'))
    .groupBy(pipelineStages.id).orderBy(pipelineStages.sortOrder);
  return byStage.map((s) => ({ ...s, value: n(s.value), weighted: n(s.weighted) }));
}

export async function salesSummary(ctx: Ctx, from: string, to: string, ownerOnly?: boolean) {
  const own = ownerOnly ? ctx.actor.userId : undefined;
  const oppScope = and(scopeOr(ctx, 'opportunities'), own ? eq(opportunities.ownerId, own) : undefined);
  const leadScope = and(scopeOr(ctx, 'leads'), own ? eq(leads.ownerId, own) : undefined);
  const [won] = await ctx.db.select({ count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${opportunities.value}),0)` })
    .from(opportunities).where(and(oppScope, gte(opportunities.wonAt, new Date(from)), lte(opportunities.wonAt, new Date(to + 'T23:59:59Z'))));
  const [lost] = await ctx.db.select({ count: sql<number>`count(*)::int`, value: sql<string>`coalesce(sum(${opportunities.value}),0)` })
    .from(opportunities).where(and(oppScope, gte(opportunities.lostAt, new Date(from)), lte(opportunities.lostAt, new Date(to + 'T23:59:59Z'))));
  const [newLeads] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(leads)
    .where(and(leadScope, gte(leads.createdAt, new Date(from)), lte(leads.createdAt, new Date(to + 'T23:59:59Z'))));
  const [converted] = await ctx.db.select({ count: sql<number>`count(*)::int` }).from(leads)
    .where(and(leadScope, gte(leads.convertedAt, new Date(from)), lte(leads.convertedAt, new Date(to + 'T23:59:59Z'))));
  const closed = won.count + lost.count;
  return {
    wonCount: won.count, wonValue: n(won.value), lostCount: lost.count, lostValue: n(lost.value),
    newLeads: newLeads.count, convertedLeads: converted.count,
    winRatePct: closed ? Math.round((won.count / closed) * 100) : null,
    leadConversionPct: newLeads.count ? Math.round((converted.count / newLeads.count) * 100) : null,
  };
}

export async function targetProgress(ctx: Ctx, userId?: string) {
  const t0 = today();
  const [target] = await ctx.db.select().from(salesTargets)
    .where(and(lte(salesTargets.periodStart, t0), gte(salesTargets.periodEnd, t0), userId ? eq(salesTargets.userId, userId) : isNull(salesTargets.userId)))
    .limit(1);
  if (!target) return null;
  const [won] = await ctx.db.select({ value: sql<string>`coalesce(sum(${opportunities.value}),0)` }).from(opportunities)
    .where(and(gte(opportunities.wonAt, new Date(target.periodStart)), lte(opportunities.wonAt, new Date(target.periodEnd + 'T23:59:59Z')), userId ? eq(opportunities.ownerId, userId) : undefined));
  return { ...target, achieved: n(won.value), pct: Math.round((n(won.value) / n(target.targetAmount)) * 100) };
}

// ───────────── Dashboards ─────────────

registerDashboard({
  key: 'pm', perm: 'projects.view',
  async build(ctx, q) {
    const managedOnly = q.scope !== 'all';
    const portfolio = await projectPortfolio(ctx, { managedOnly });
    const ids = portfolio.map((p) => p.id);
    const statusCounts: Record<string, number> = {};
    for (const p of portfolio) statusCounts[p.status] = (statusCounts[p.status] ?? 0) + 1;
    const overdueTasks = ids.length ? await ctx.db.select({
      id: tasks.id, number: tasks.number, title: tasks.title, dueDate: tasks.dueDate, status: tasks.status, assigneeName: users.name, projectCode: projects.code,
    }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId)).leftJoin(users, eq(users.id, tasks.assigneeId))
      .where(and(inArray(tasks.projectId, ids), ne(tasks.status, 'done'), lt(tasks.dueDate, today())))
      .orderBy(tasks.dueDate).limit(15) : [];
    const escalations = ids.length ? await ctx.db.select({
      id: projectUpdates.id, title: projectUpdates.title, createdAt: projectUpdates.createdAt, projectCode: projects.code, escalateToRole: projectUpdates.escalateToRole,
    }).from(projectUpdates).innerJoin(projects, eq(projects.id, projectUpdates.projectId))
      .where(and(inArray(projectUpdates.projectId, ids), eq(projectUpdates.kind, 'escalation'), isNull(projectUpdates.resolvedAt)))
      .orderBy(sql`${projectUpdates.createdAt} desc`).limit(10) : [];
    const memberIds = ids.length ? (await ctx.db.selectDistinct({ id: projectMembers.userId }).from(projectMembers).where(inArray(projectMembers.projectId, ids))).map((r) => r.id) : [];
    const team = can(ctx.actor, 'time.view') ? await utilization(ctx, daysAgo(6), today(), memberIds) : [];
    return { portfolio, statusCounts, overdueTasks, escalations, team, managedOnly };
  },
});

registerDashboard({
  key: 'bd', perm: 'opportunities.view',
  async build(ctx, q) {
    const ownerOnly = q.scope !== 'all' && ctx.actor.perms.get('opportunities.view') === 'all' && !ctx.actor.roles.includes('ceo');
    const pipeline = await salesPipeline(ctx, ownerOnly);
    const open = pipeline.filter((s) => !['won', 'lost'].includes(s.key));
    const month = await salesSummary(ctx, monthStart(), today(), ownerOnly);
    const followUpsDue = await ctx.db.select().from(followUps)
      .where(and(eq(followUps.ownerId, ctx.actor.userId), eq(followUps.status, 'open'), lte(followUps.dueDate, daysAgo(-7))))
      .orderBy(followUps.dueDate).limit(15);
    const hot = await ctx.db.select({
      id: opportunities.id, number: opportunities.number, name: opportunities.name, value: opportunities.value, probability: opportunities.probability,
      expectedCloseDate: opportunities.expectedCloseDate, stageName: pipelineStages.name, stageColor: pipelineStages.color,
    }).from(opportunities).innerJoin(pipelineStages, eq(pipelineStages.id, opportunities.stageId))
      .where(and(scopeOr(ctx, 'opportunities'), ownerOnly ? eq(opportunities.ownerId, ctx.actor.userId) : undefined, eq(pipelineStages.isTerminal, false)))
      .orderBy(sql`${opportunities.expectedCloseDate} asc nulls last`).limit(10);
    const newLeads = await ctx.db.select({ id: leads.id, number: leads.number, title: leads.title, source: leads.source, status: leads.status, createdAt: leads.createdAt })
      .from(leads).where(and(scopeOr(ctx, 'leads'), inArray(leads.status, ['new', 'contacted']))).orderBy(sql`${leads.createdAt} desc`).limit(10);
    return {
      ownerOnly, pipeline, month, followUpsDue, hot, newLeads,
      openCount: open.reduce((a, s) => a + s.count, 0),
      pipelineValue: open.reduce((a, s) => a + s.value, 0),
      weightedValue: open.reduce((a, s) => a + s.weighted, 0),
      proposals: pipeline.find((s) => s.key === 'proposal')?.count ?? 0,
      negotiations: pipeline.find((s) => s.key === 'negotiation')?.count ?? 0,
      target: await targetProgress(ctx, ownerOnly ? ctx.actor.userId : undefined),
    };
  },
});

registerDashboard({
  key: 'developer',
  async build(ctx) {
    const uid = ctx.actor.userId;
    const t0 = today();
    const mine = await ctx.db.select({
      id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status, priority: tasks.priority, dueDate: tasks.dueDate,
      projectId: tasks.projectId, projectCode: projects.code, projectName: projects.name, estimateHours: tasks.estimateHours,
    }).from(tasks).leftJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(tasks.assigneeId, uid), ne(tasks.status, 'done'))).orderBy(sql`${tasks.dueDate} asc nulls last`);
    const myProjects = await ctx.db.selectDistinct({ id: projects.id, code: projects.code, name: projects.name, status: projects.status, dueDate: projects.dueDate, role: projectMembers.role })
      .from(projects).innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projectMembers.userId, uid), notInArray(projects.status, ['completed', 'cancelled'])));
    const [week] = await utilization(ctx, daysAgo(6), t0, [uid]);
    const [perf] = await developerPerformance(ctx, daysAgo(90), t0, [uid]);
    return {
      overdue: mine.filter((t) => t.dueDate && t.dueDate < t0), today: mine.filter((t) => t.dueDate === t0),
      upcoming: mine.filter((t) => !t.dueDate || t.dueDate > t0), projects: myProjects, week, performance: perf ?? null,
    };
  },
});

/**
 * Developer performance beyond raw task counts: estimate accuracy, rework, QA rejections and on-time completion.
 * (Bugs introduced and code-review stats are added by the engineering module.)
 */
export async function developerPerformance(ctx: Ctx, from: string, to: string, userIds?: string[]) {
  const rows: any = await ctx.db.execute(sql`
    with done as (
      select t.id, t.assignee_id, t.estimate_hours, t.due_date, t.completed_at, t.is_rework, t.qa_rejections,
             (select coalesce(sum(te.minutes), 0) from time_entries te where te.task_id = t.id) as minutes
      from tasks t
      where t.status = 'done' and t.assignee_id is not null
        and t.completed_at >= ${from}::date and t.completed_at < (${to}::date + 1)
        ${userIds ? (userIds.length ? sql`and t.assignee_id in ${userIds}` : sql`and false`) : sql``}
    )
    select u.id as user_id, u.name,
      count(d.id)::int as completed,
      coalesce(sum(d.estimate_hours), 0)::float as estimated_hours,
      (coalesce(sum(d.minutes), 0) / 60.0)::float as actual_hours,
      count(*) filter (where d.is_rework)::int as rework,
      coalesce(sum(d.qa_rejections), 0)::int as qa_rejections,
      count(*) filter (where d.due_date is not null)::int as with_due,
      count(*) filter (where d.due_date is not null and d.completed_at::date <= d.due_date)::int as on_time
    from done d join users u on u.id = d.assignee_id
    group by u.id, u.name order by u.name`);
  return (rows.rows as any[]).map((r) => ({
    userId: r.user_id, name: r.name, completed: r.completed, estimatedHours: r.estimated_hours, actualHours: Math.round(r.actual_hours * 10) / 10,
    estimateAccuracyPct: r.estimated_hours && r.actual_hours ? Math.round((r.estimated_hours / r.actual_hours) * 100) : null,
    reworkPct: r.completed ? Math.round((r.rework / r.completed) * 100) : 0,
    qaRejections: r.qa_rejections,
    qaRejectionRatePct: r.completed ? Math.round((r.qa_rejections / r.completed) * 100) : 0,
    onTimePct: r.with_due ? Math.round((r.on_time / r.with_due) * 100) : null,
  }));
}

export async function reportRoutes(app: FastifyInstance) {
  app.get<{ Params: { key: string }; Querystring: Record<string, string | undefined> }>('/api/dashboard/:key', async (req) => {
    const ctx = ctxOf(req);
    const d = DASHBOARDS.get(req.params.key);
    if (!d) throw forbidden('Unknown dashboard');
    if (d.perm && !can(ctx.actor, d.perm)) throw forbidden();
    if (d.roles && !d.roles.some((r) => ctx.actor.roles.includes(r))) throw forbidden();
    const out = (await d.build(ctx, req.query)) as Record<string, unknown>;
    for (const fn of EXTRAS.get(d.key) ?? []) Object.assign(out, await fn(ctx));
    return out;
  });
}

