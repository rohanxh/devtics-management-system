import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, isNull, ne, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import {
  bugs, deployments, environments, pipelineStages, projects, pullRequests, qaRunResults, qaRuns, qaTemplateItems,
  techDebt, techReviews, testCases, users,
} from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx } from '../core/context.ts';
import { conflict, forbidden, invalid } from '../core/errors.ts';
import { emit } from '../core/events.ts';
import { nextNumber } from '../core/counters.ts';
import { notify } from '../core/notify.ts';
import { registerApprovalHandler } from '../core/approvals.ts';
import { registerAction } from '../core/events.ts';
import { fill } from '../core/actions.ts';
import { can } from '../rbac/actor.ts';
import { afterWrite, getOne, requireResource } from '../resources/engine.ts';
import type { Row } from '../resources/types.ts';
import { stageId } from './sales.ts';
import { daysAgo, projectPortfolio, registerDashboard, registerDashboardExtra, scopeOr, today, utilization } from './reports.ts';

/** Recomputes pass/fail/blocked counters for a QA run (and moves a planned run to in progress). */
export async function refreshRunCounts(db: DB, runId: string, touched = false) {
  await db.execute(sql`
    update qa_runs r set
      total_count = s.total, pass_count = s.pass, fail_count = s.fail, blocked_count = s.blocked,
      status = case when ${touched} and r.status = 'planned' then 'in_progress'::qa_run_status else r.status end,
      started_at = case when ${touched} and r.started_at is null then now() else r.started_at end
    from (select count(*)::int total,
                 count(*) filter (where status = 'pass')::int pass,
                 count(*) filter (where status = 'fail')::int fail,
                 count(*) filter (where status = 'blocked')::int blocked
          from qa_run_results where run_id = ${runId}) s
    where r.id = ${runId}`);
}

async function setProject(db: DB, actor: any, id: string, patch: Partial<typeof projects.$inferInsert>) {
  const [prev] = await db.select().from(projects).where(eq(projects.id, id));
  const [next] = await db.update(projects).set(patch).where(eq(projects.id, id)).returning();
  await afterWrite(db, requireResource('projects'), actor, next as Row, prev as Row);
  return next;
}

registerApprovalHandler('production_deployment', {
  async onApproved(db, a, actor) {
    const [prev] = await db.select().from(deployments).where(eq(deployments.id, a.entityId));
    const [d] = await db.update(deployments).set({ status: 'approved' }).where(eq(deployments.id, a.entityId)).returning();
    if (d) await afterWrite(db, requireResource('deployments'), actor, d as Row, prev as Row);
  },
  async onRejected(db, a, actor) {
    const [prev] = await db.select().from(deployments).where(eq(deployments.id, a.entityId));
    const [d] = await db.update(deployments).set({ status: 'rejected' }).where(eq(deployments.id, a.entityId)).returning();
    if (d) await afterWrite(db, requireResource('deployments'), actor, d as Row, prev as Row);
  },
});

registerApprovalHandler('tech_review', {
  async onApproved(db, a, actor) {
    const [prev] = await db.select().from(techReviews).where(eq(techReviews.id, a.entityId));
    const [r] = await db.update(techReviews).set({ status: 'approved', decidedAt: new Date(), decision: a.decisionNote }).where(eq(techReviews.id, a.entityId)).returning();
    if (r) await afterWrite(db, requireResource('tech_reviews'), actor, r as Row, prev as Row);
  },
  async onRejected(db, a, actor) {
    const [prev] = await db.select().from(techReviews).where(eq(techReviews.id, a.entityId));
    const [r] = await db.update(techReviews).set({ status: 'rejected', decidedAt: new Date(), decision: a.decisionNote }).where(eq(techReviews.id, a.entityId)).returning();
    if (r) await afterWrite(db, requireResource('tech_reviews'), actor, r as Row, prev as Row);
  },
});

export async function qaRoutes(app: FastifyInstance) {
  const kick = () => app.deps.events.kick();

  /** Create a QA run from templates (and/or the project's existing test cases). */
  app.post('/api/qa/runs', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'qa.create')) throw forbidden();
    const body = z.object({
      projectId: z.uuid(), name: z.string().trim().min(2).max(200), templateIds: z.array(z.uuid()).max(20).default([]),
      includeProjectCases: z.boolean().default(true), environmentId: z.uuid().optional().nullable(), assigneeId: z.uuid().optional().nullable(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', z.flattenError(body.error).fieldErrors);
    const d = body.data;
    await getOne(ctx, 'projects', d.projectId);
    const run = await tx(ctx, async (t) => {
      // Materialise template checks as project test cases (once per project).
      if (d.templateIds.length) {
        const items = await t.select().from(qaTemplateItems).where(inArray(qaTemplateItems.templateId, d.templateIds)).orderBy(asc(qaTemplateItems.sortOrder));
        for (const it of items) {
          await t.insert(testCases).values({ projectId: d.projectId, templateItemId: it.id, title: it.title, area: it.area, steps: it.steps, expectedResult: it.expectedResult, priority: it.priority })
            .onConflictDoNothing();
        }
      }
      const cases = await t.select().from(testCases).where(and(eq(testCases.projectId, d.projectId), eq(testCases.isActive, true),
        d.includeProjectCases ? undefined : d.templateIds.length
          ? sql`${testCases.templateItemId} in (select id from qa_template_items where template_id in ${d.templateIds})` : sql`false`))
        .orderBy(asc(testCases.area), asc(testCases.createdAt));
      if (!cases.length) throw invalid('No test cases to run. Pick a template or add test cases to the project.', { templateIds: 'Nothing to test' });
      const [r] = await t.insert(qaRuns).values({
        number: await nextNumber(t, 'qa_run', 'QA-', 4), projectId: d.projectId, name: d.name, environmentId: d.environmentId,
        assigneeId: d.assigneeId ?? ctx.actor.userId, status: 'planned', totalCount: cases.length,
      }).returning();
      await t.insert(qaRunResults).values(cases.map((c, i) => ({ runId: r.id, testCaseId: c.id, sortOrder: i })));
      await afterWrite(t, requireResource('qa_runs'), ctx.actor, r as Row, undefined);
      return r;
    });
    kick();
    return reply.status(201).send(run);
  });

  app.get<{ Params: { id: string } }>('/api/qa/runs/:id/results', async (req) => {
    const ctx = ctxOf(req);
    const run = await getOne(ctx, 'qa_runs', req.params.id);
    const rows = await ctx.db.select({
      id: qaRunResults.id, status: qaRunResults.status, notes: qaRunResults.notes, bugId: qaRunResults.bugId,
      bugNumber: bugs.number, bugStatus: bugs.status, testCaseId: testCases.id, title: testCases.title, area: testCases.area,
      steps: testCases.steps, expectedResult: testCases.expectedResult, priority: testCases.priority, testedByName: users.name,
    }).from(qaRunResults).innerJoin(testCases, eq(testCases.id, qaRunResults.testCaseId))
      .leftJoin(bugs, eq(bugs.id, qaRunResults.bugId)).leftJoin(users, eq(users.id, qaRunResults.testedById))
      .where(eq(qaRunResults.runId, run.id)).orderBy(asc(qaRunResults.sortOrder));
    return { run, rows, canEdit: can(ctx.actor, 'qa.edit') && ['planned', 'in_progress'].includes(run.status), canApprove: can(ctx.actor, 'qa.approve') };
  });

  /** Mark a result as failed and raise a linked bug in one step. */
  app.post<{ Params: { id: string } }>('/api/qa/results/:id/fail', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'qa.edit') || !can(ctx.actor, 'bugs.create')) throw forbidden();
    const result = await getOne(ctx, 'qa_run_results', req.params.id, 'edit');
    const body = z.object({
      title: z.string().trim().min(3).max(300), severity: z.enum(['critical', 'high', 'medium', 'low']).default('medium'),
      actualResult: z.string().max(10000).optional(), stepsToReproduce: z.string().max(20000).optional(), assigneeId: z.uuid().optional().nullable(),
      notes: z.string().max(2000).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', z.flattenError(body.error).fieldErrors);
    const bug = await tx(ctx, async (t) => {
      const [run] = await t.select().from(qaRuns).where(eq(qaRuns.id, result.runId));
      if (!['planned', 'in_progress'].includes(run.status)) throw conflict('This QA run is closed');
      const [tc] = await t.select().from(testCases).where(eq(testCases.id, result.testCaseId));
      const [env] = run.environmentId ? await t.select().from(environments).where(eq(environments.id, run.environmentId)) : [];
      const [b] = await t.insert(bugs).values({
        number: await nextNumber(t, 'bug', 'BUG-', 5), projectId: run.projectId, title: body.data.title, severity: body.data.severity,
        priority: body.data.severity === 'critical' ? 'critical' : body.data.severity === 'high' ? 'high' : 'medium',
        stepsToReproduce: body.data.stepsToReproduce ?? tc.steps, expectedResult: tc.expectedResult, actualResult: body.data.actualResult,
        environment: env?.kind ?? 'staging', foundIn: 'qa', reportedById: ctx.actor.userId, assigneeId: body.data.assigneeId ?? null,
        qaRunId: run.id, testCaseId: tc.id,
      }).returning();
      await afterWrite(t, requireResource('bugs'), ctx.actor, b as Row, undefined);
      await t.update(qaRunResults).set({ status: 'fail', bugId: b.id, notes: body.data.notes, testedById: ctx.actor.userId, testedAt: new Date() }).where(eq(qaRunResults.id, result.id));
      await refreshRunCounts(t, run.id, true);
      return b;
    });
    kick();
    return reply.status(201).send(bug);
  });

  app.post<{ Params: { id: string } }>('/api/qa/runs/:id/complete', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'qa.edit')) throw forbidden();
    const run = await getOne(ctx, 'qa_runs', req.params.id, 'edit');
    if (!['planned', 'in_progress'].includes(run.status)) throw conflict('Run is already closed');
    const [{ pending }] = await ctx.db.select({ pending: sql<number>`count(*)::int` }).from(qaRunResults).where(and(eq(qaRunResults.runId, run.id), eq(qaRunResults.status, 'pending')));
    if (pending > 0) throw invalid(`${pending} test case(s) still pending`, { status: 'Record every result first' });
    await tx(ctx, async (t) => {
      const [u] = await t.update(qaRuns).set({ status: 'completed', completedAt: new Date() }).where(eq(qaRuns.id, run.id)).returning();
      await afterWrite(t, requireResource('qa_runs'), ctx.actor, u as Row, run);
    });
    kick();
    return { ok: true };
  });

  /** QA sign-off: no failed/blocked results and no open critical/high bugs on the project. Enables launch. */
  app.post<{ Params: { id: string } }>('/api/qa/runs/:id/approve', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'qa.approve')) throw forbidden();
    const run = await getOne(ctx, 'qa_runs', req.params.id);
    if (run.status !== 'completed') throw conflict('Complete the run before signing off');
    if (run.failCount > 0 || run.blockedCount > 0) throw conflict('Runs with failed or blocked cases cannot be signed off — retest in a new run');
    const blocking = await ctx.db.select({ number: bugs.number }).from(bugs)
      .where(and(eq(bugs.projectId, run.projectId), inArray(bugs.severity, ['critical', 'high']), notInArray(bugs.status, ['verified', 'closed', 'wont_fix', 'duplicate'])));
    if (blocking.length) throw conflict(`Open critical/high bugs block sign-off: ${blocking.map((b) => b.number).join(', ')}`);
    const body = z.object({ note: z.string().max(5000).optional() }).parse(req.body ?? {});
    await tx(ctx, async (t) => {
      const [u] = await t.update(qaRuns).set({ status: 'approved', decidedAt: new Date(), decidedById: ctx.actor.userId, summary: body.note ?? run.summary }).where(eq(qaRuns.id, run.id)).returning();
      await afterWrite(t, requireResource('qa_runs'), ctx.actor, u as Row, run);
      const p = await setProject(t, ctx.actor, run.projectId, { qaApprovedAt: new Date(), status: 'ready_for_launch', stageId: await stageId(t, 'project', 'client_feedback') });
      await emit(t, { type: 'qa.approved', entityType: 'projects', entityId: run.projectId, actorUserId: ctx.actor.userId, payload: { runId: run.id, title: p.name } });
    });
    kick();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/qa/runs/:id/reject', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'qa.approve')) throw forbidden();
    const run = await getOne(ctx, 'qa_runs', req.params.id);
    if (!['completed', 'in_progress'].includes(run.status)) throw conflict('Only open or completed runs can be rejected');
    const body = z.object({ note: z.string().trim().min(3, 'Explain what must be fixed').max(5000) }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', { note: body.error.issues[0].message });
    await tx(ctx, async (t) => {
      const [u] = await t.update(qaRuns).set({ status: 'rejected', decidedAt: new Date(), decidedById: ctx.actor.userId, summary: body.data.note }).where(eq(qaRuns.id, run.id)).returning();
      await afterWrite(t, requireResource('qa_runs'), ctx.actor, u as Row, run);
      const [p] = await t.select().from(projects).where(eq(projects.id, run.projectId));
      if (p.status === 'in_qa' || p.status === 'ready_for_launch') await setProject(t, ctx.actor, p.id, { status: 'awaiting_development', qaApprovedAt: null });
      await notify(t, {
        userIds: [p.pmId, p.techLeadId], kind: 'status', title: `QA rejected ${run.number} for ${p.code}`, body: body.data.note,
        entityType: 'qa_runs', entityId: run.id, excludeUserId: ctx.actor.userId, dedupeKey: `qa-reject:${run.id}`,
      });
    });
    kick();
    return { ok: true };
  });

  /** Launch: only after QA sign-off. */
  app.post<{ Params: { id: string } }>('/api/projects/:id/launch', async (req) => {
    const ctx = ctxOf(req);
    const p = await getOne(ctx, 'projects', req.params.id, 'edit');
    if (!p.qaApprovedAt) throw conflict('QA sign-off is required before launch');
    if (p.launchedAt) throw conflict('Project already launched');
    await tx(ctx, async (t) => {
      await setProject(t, ctx.actor, p.id, { launchedAt: new Date(), status: 'on_track', stageId: await stageId(t, 'project', 'launch') });
      await emit(t, { type: 'project.launched', entityType: 'projects', entityId: p.id, actorUserId: ctx.actor.userId, payload: { title: p.name } });
    });
    kick();
    return { ok: true };
  });
}

registerAction('notify_project_team', {
  description: 'Notify the project manager / tech lead of the project in the event payload (params: who[]: pm|tech_lead, roles?[], title).',
  async run({ db, event, params, rule }) {
    const pid = String(event.payload.projectId ?? (event.entityType === 'projects' ? event.entityId : ''));
    if (!pid) return;
    const [p] = await db.select().from(projects).where(eq(projects.id, pid));
    if (!p) return;
    const who: string[] = params.who ?? ['pm'];
    await notify(db, {
      userIds: [who.includes('pm') ? p.pmId : null, who.includes('tech_lead') ? p.techLeadId : null], roles: params.roles ?? [],
      kind: params.kind ?? 'status', title: fill(params.title ?? '{title}', { ...event.payload, code: p.code, project: p.name }),
      entityType: event.entityType ?? undefined, entityId: event.entityId ?? undefined, excludeUserId: event.actorUserId,
      dedupeKey: `${rule.key}:${event.id}`,
    });
  },
});

// ───────────── Dashboards ─────────────

async function openBugCounts(ctx: Parameters<typeof scopeOr>[0], projectIds?: string[]) {
  const rows = await ctx.db.select({ severity: bugs.severity, n: sql<number>`count(*)::int` }).from(bugs)
    .where(and(scopeOr(ctx, 'bugs'), notInArray(bugs.status, ['verified', 'closed', 'wont_fix', 'duplicate']), projectIds ? (projectIds.length ? inArray(bugs.projectId, projectIds) : sql`false`) : undefined))
    .groupBy(bugs.severity);
  const out = { critical: 0, high: 0, medium: 0, low: 0, total: 0 };
  for (const r of rows) { out[r.severity] = r.n; out.total += r.n; }
  return out;
}

registerDashboard({
  key: 'cto', perm: 'reports.technical',
  async build(ctx) {
    const portfolio = await projectPortfolio(ctx);
    const techProjects = portfolio.filter((p) => !['awaiting_client'].includes(p.status));
    const bugCounts = await openBugCounts(ctx);
    const critical = await ctx.db.select({ projectId: bugs.projectId, n: sql<number>`count(*)::int` }).from(bugs)
      .where(and(scopeOr(ctx, 'bugs'), inArray(bugs.severity, ['critical', 'high']), notInArray(bugs.status, ['verified', 'closed', 'wont_fix', 'duplicate'])))
      .groupBy(bugs.projectId);
    const critMap = new Map(critical.map((c) => [c.projectId, c.n]));
    const atRisk = portfolio.filter((p) => ['at_risk', 'delayed'].includes(p.status) || (critMap.get(p.id) ?? 0) > 0)
      .map((p) => ({ ...p, criticalBugs: critMap.get(p.id) ?? 0 }));
    const devs = await ctx.db.select({ id: users.id }).from(users)
      .where(and(eq(users.status, 'active'), sql`${users.id} in (select ur.user_id from user_roles ur join roles r on r.id = ur.role_id where r.key in ('developer', 'designer', 'qa'))`));
    const capacity = await utilization(ctx, daysAgo(13), today(), devs.map((d) => d.id));
    const workload: any = await ctx.db.execute(sql`
      select u.id, u.name, count(t.id)::int as open_tasks, coalesce(sum(t.estimate_hours), 0)::float as open_estimate
      from users u join tasks t on t.assignee_id = u.id and t.status <> 'done'
      where u.id in ${devs.length ? devs.map((d) => d.id) : ['00000000-0000-0000-0000-000000000000']}
      group by u.id, u.name order by open_estimate desc`);
    const qaStatus = await ctx.db.select({ status: qaRuns.status, n: sql<number>`count(*)::int` }).from(qaRuns)
      .where(and(scopeOr(ctx, 'qa_runs'), inArray(qaRuns.status, ['planned', 'in_progress', 'completed']))).groupBy(qaRuns.status);
    const debt = await ctx.db.select({ impact: techDebt.impact, n: sql<number>`count(*)::int` }).from(techDebt)
      .where(and(scopeOr(ctx, 'tech_debt'), inArray(techDebt.status, ['open', 'planned', 'in_progress']))).groupBy(techDebt.impact);
    const envIssues = await ctx.db.select({ id: environments.id, name: environments.name, status: environments.status, kind: environments.kind, projectCode: projects.code })
      .from(environments).innerJoin(projects, eq(projects.id, environments.projectId))
      .where(and(scopeOr(ctx, 'environments'), inArray(environments.status, ['degraded', 'down'])));
    const recentDeploys = await ctx.db.select({
      id: deployments.id, number: deployments.number, version: deployments.version, status: deployments.status, createdAt: deployments.createdAt,
      deployedAt: deployments.deployedAt, projectCode: projects.code, envName: environments.name, envKind: environments.kind,
    }).from(deployments).innerJoin(projects, eq(projects.id, deployments.projectId)).innerJoin(environments, eq(environments.id, deployments.environmentId))
      .where(scopeOr(ctx, 'deployments')).orderBy(desc(deployments.createdAt)).limit(10);
    const reviews = await ctx.db.select({ id: techReviews.id, number: techReviews.number, title: techReviews.title, kind: techReviews.kind, status: techReviews.status })
      .from(techReviews).where(and(scopeOr(ctx, 'tech_reviews'), eq(techReviews.status, 'submitted'))).limit(10);
    const [{ openPrs }] = await ctx.db.select({ openPrs: sql<number>`count(*)::int` }).from(pullRequests).where(and(scopeOr(ctx, 'pull_requests'), inArray(pullRequests.status, ['open', 'changes_requested'])));
    return {
      activeProjects: techProjects.length, portfolio: techProjects, atRisk, bugCounts, capacity,
      workload: workload.rows, qaStatus, debt, envIssues, recentDeploys, reviews, openPullRequests: openPrs,
      pendingProdDeploys: recentDeploys.filter((d) => d.status === 'pending_approval').length,
    };
  },
});

registerDashboard({
  key: 'qa', perm: 'qa.view',
  async build(ctx) {
    const awaiting = await ctx.db.select({ id: projects.id, code: projects.code, name: projects.name, dueDate: projects.dueDate, stageName: pipelineStages.name, stageColor: pipelineStages.color })
      .from(projects).innerJoin(pipelineStages, eq(pipelineStages.id, projects.stageId))
      .where(and(scopeOr(ctx, 'projects'), eq(projects.status, 'in_qa'))).orderBy(projects.dueDate);
    const launchReady = await ctx.db.select({ id: projects.id, code: projects.code, name: projects.name, qaApprovedAt: projects.qaApprovedAt })
      .from(projects).where(and(scopeOr(ctx, 'projects'), eq(projects.status, 'ready_for_launch'), isNull(projects.launchedAt)));
    const runs = await ctx.db.select({
      id: qaRuns.id, number: qaRuns.number, name: qaRuns.name, status: qaRuns.status, totalCount: qaRuns.totalCount, passCount: qaRuns.passCount,
      failCount: qaRuns.failCount, blockedCount: qaRuns.blockedCount, projectCode: projects.code, testerName: users.name,
    }).from(qaRuns).innerJoin(projects, eq(projects.id, qaRuns.projectId)).leftJoin(users, eq(users.id, qaRuns.assigneeId))
      .where(and(scopeOr(ctx, 'qa_runs'), inArray(qaRuns.status, ['planned', 'in_progress', 'completed']))).orderBy(desc(qaRuns.createdAt));
    const retest = await ctx.db.select({ id: bugs.id, number: bugs.number, title: bugs.title, severity: bugs.severity, projectCode: projects.code })
      .from(bugs).innerJoin(projects, eq(projects.id, bugs.projectId))
      .where(and(scopeOr(ctx, 'bugs'), inArray(bugs.status, ['fixed', 'ready_for_retest']))).orderBy(bugs.severity).limit(20);
    const [{ activeCases }] = await ctx.db.select({ activeCases: sql<number>`count(*)::int` }).from(testCases).where(and(scopeOr(ctx, 'test_cases'), eq(testCases.isActive, true)));
    const failed = runs.reduce((a, r) => a + r.failCount, 0);
    return {
      awaiting, launchReady, runs, retest, activeCases, failedTests: failed, bugCounts: await openBugCounts(ctx),
      pendingApprovals: runs.filter((r) => r.status === 'completed').length,
    };
  },
});

/** Engineering signals added to developer performance: bugs introduced and code reviews. */
export async function engineeringStats(ctx: Parameters<typeof scopeOr>[0], userId: string, from: string) {
  const [introduced] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(bugs).where(and(eq(bugs.introducedById, userId), sql`${bugs.createdAt} >= ${from}::date`));
  const [assigned] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(bugs).where(and(eq(bugs.assigneeId, userId), notInArray(bugs.status, ['verified', 'closed', 'wont_fix', 'duplicate'])));
  const reviewsToDo = await ctx.db.select({ id: pullRequests.id, title: pullRequests.title, status: pullRequests.status, url: pullRequests.url })
    .from(pullRequests).where(and(eq(pullRequests.reviewerId, userId), inArray(pullRequests.status, ['open']))).limit(10);
  const [myOpenPrs] = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(pullRequests).where(and(eq(pullRequests.authorId, userId), inArray(pullRequests.status, ['open', 'changes_requested', 'approved'])));
  const myDeploys = await ctx.db.select({ id: deployments.id, number: deployments.number, version: deployments.version, status: deployments.status, envName: environments.name, createdAt: deployments.createdAt })
    .from(deployments).innerJoin(environments, eq(environments.id, deployments.environmentId))
    .where(and(scopeOr(ctx, 'deployments'), sql`(${deployments.requestedById} = ${userId} or ${deployments.deployedById} = ${userId})`))
    .orderBy(desc(deployments.createdAt)).limit(5);
  const myBugs = await ctx.db.select({ id: bugs.id, number: bugs.number, title: bugs.title, severity: bugs.severity, status: bugs.status })
    .from(bugs).where(and(eq(bugs.assigneeId, userId), notInArray(bugs.status, ['verified', 'closed', 'wont_fix', 'duplicate'], ), ne(bugs.status, 'fixed'))).orderBy(bugs.severity).limit(10);
  return { bugsIntroduced: introduced.n, openBugsAssigned: assigned.n, reviewsToDo, myOpenPrs: myOpenPrs.n, myDeploys, myBugs };
}


registerDashboardExtra('developer', async (ctx) => ({ engineering: await engineeringStats(ctx, ctx.actor.userId, daysAgo(90)) }));
