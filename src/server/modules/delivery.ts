import type { FastifyInstance } from 'fastify';
import { and, eq, inArray, isNull, lt, ne, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import {
  changeRequests, clientFeedback, companies, contracts, followUps, opportunities, projectMembers, projectOnboardings,
  projects, tasks, users,
} from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx, withActor } from '../core/context.ts';
import { conflict, forbidden, invalid, notFound } from '../core/errors.ts';
import { emit, registerAction } from '../core/events.ts';
import { notify } from '../core/notify.ts';
import { nextNumber } from '../core/counters.ts';
import { registerApprovalHandler, requestApproval } from '../core/approvals.ts';
import { can } from '../rbac/actor.ts';
import { afterWrite, getOne, isVisible, requireResource } from '../resources/engine.ts';
import { isUuid } from '../resources/validate.ts';
import type { Row } from '../resources/types.ts';
import { JOBS } from '../jobs.ts';
import { stageId } from './sales.ts';

const today = () => new Date().toISOString().slice(0, 10);
const plusDays = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

/** Creates a task as part of a workflow (audited as the current transaction actor). */
export async function createWorkflowTask(db: DB, t: {
  projectId: string | null; title: string; assigneeId?: string | null; reporterId?: string | null; dueDate?: string;
  type?: 'onboarding' | 'task' | 'devops'; description?: string; priority?: 'low' | 'medium' | 'high' | 'critical';
}) {
  const [row] = await db.insert(tasks).values({
    number: await nextNumber(db, 'task', 'T-', 5), projectId: t.projectId, title: t.title, assigneeId: t.assigneeId ?? null,
    reporterId: t.reporterId ?? null, dueDate: t.dueDate, type: t.type ?? 'task', description: t.description, priority: t.priority ?? 'medium',
  }).returning();
  await afterWrite(db, requireResource('tasks'), null, row as Row, undefined);
  return row;
}

// ───────────── Won deal → project onboarding ─────────────

registerAction('sales.onboard_won_deal', {
  description: 'When a deal is won: mark the company as a client, create the project, link contracts, start the BD → PM → CTO → Development onboarding and notify the people involved.',
  async run({ db, event }) {
    const [opp] = await db.select().from(opportunities).where(eq(opportunities.id, event.entityId!));
    if (!opp || opp.projectId) return; // already onboarded (idempotent)
    const [company] = await db.select().from(companies).where(eq(companies.id, opp.companyId));
    const companyPatch: Partial<typeof companies.$inferInsert> = { lifecycle: 'client' };
    if (!company.clientCode) companyPatch.clientCode = await nextNumber(db, 'client', 'CL-', 4);
    if (!company.clientSince) companyPatch.clientSince = today();
    if (!company.accountManagerId) companyPatch.accountManagerId = opp.ownerId;
    if (!company.health) companyPatch.health = 'active';
    const [updatedCompany] = await db.update(companies).set(companyPatch).where(eq(companies.id, company.id)).returning();
    await afterWrite(db, requireResource('clients'), null, updatedCompany as Row, company as Row);

    const [project] = await db.insert(projects).values({
      code: await nextNumber(db, 'project', 'PRJ-', 4), name: opp.name, clientId: company.id, opportunityId: opp.id,
      type: opp.projectType ?? 'other', stageId: await stageId(db, 'project', 'scope'), status: 'on_track',
      budgetAmount: opp.value, currency: opp.currency, startDate: today(), createdBy: opp.ownerId, description: opp.description,
    }).returning();
    await afterWrite(db, requireResource('projects'), null, project as Row, undefined);
    await db.update(opportunities).set({ projectId: project.id }).where(eq(opportunities.id, opp.id));
    await db.update(contracts).set({ projectId: project.id }).where(and(eq(contracts.opportunityId, opp.id), isNull(contracts.projectId)));

    const [onb] = await db.insert(projectOnboardings).values({
      opportunityId: opp.id, projectId: project.id, companyId: company.id, status: 'bd_handover', bdOwnerId: opp.ownerId,
    }).returning();
    if (opp.ownerId) {
      await createWorkflowTask(db, {
        projectId: project.id, title: `Complete client handover for ${project.name}`, assigneeId: opp.ownerId, reporterId: opp.ownerId,
        dueDate: plusDays(2), type: 'onboarding', priority: 'high',
        description: 'Summarise scope, commitments, contacts, deadlines and risks in the onboarding handover, then submit it to PM review.',
      });
    }
    await notify(db, {
      userIds: [opp.ownerId], roles: ['pm', 'ceo'], kind: 'status', title: `Deal won: ${opp.name} — project ${project.code} created`,
      body: 'Onboarding started (BD handover → PM review → CTO review → development kickoff).',
      entityType: 'projects', entityId: project.id, dedupeKey: `onboarding:${onb.id}:started`,
    });
    await emit(db, { type: 'project.onboarding_started', entityType: 'projects', entityId: project.id, payload: { onboardingId: onb.id, opportunityId: opp.id, title: project.name } });
  },
});

async function loadOnboarding(ctx: ReturnType<typeof ctxOf>, id: string) {
  if (!isUuid(id)) throw notFound('Onboarding');
  const [o] = await ctx.db.select().from(projectOnboardings).where(eq(projectOnboardings.id, id));
  if (!o || !(await isVisible(ctx.db, ctx.actor, 'project_onboardings', o.id))) throw notFound('Onboarding');
  return o;
}

registerApprovalHandler('technical_feasibility', {
  async onApproved(db, approval, actor) {
    const [o] = await db.select().from(projectOnboardings).where(and(eq(projectOnboardings.projectId, approval.entityId), eq(projectOnboardings.status, 'cto_review')));
    if (!o) return;
    await db.update(projectOnboardings).set({ status: 'development_kickoff', ctoNotes: approval.decisionNote }).where(eq(projectOnboardings.id, o.id));
    const [p] = await db.select().from(projects).where(eq(projects.id, o.projectId));
    // Kick-off checklist: concrete first tasks for the delivery team.
    const kickoff: [string, string | null, 'task' | 'devops'][] = [
      ['Hold internal kickoff meeting', p.pmId, 'task'],
      ['Hold client kickoff and confirm scope & milestones', p.pmId, 'task'],
      ['Set up repository, branching and environments', p.techLeadId ?? p.pmId, 'devops'],
      ['Define milestones and initial task breakdown', p.pmId, 'task'],
    ];
    for (const [title, assignee, type] of kickoff) {
      await createWorkflowTask(db, { projectId: p.id, title, assigneeId: assignee, reporterId: actor.userId, dueDate: plusDays(5), type });
    }
    await notify(db, {
      userIds: [p.pmId, p.techLeadId, o.bdOwnerId], kind: 'status', title: `CTO approved ${p.code} — development kickoff`,
      entityType: 'projects', entityId: p.id, excludeUserId: actor.userId, dedupeKey: `onboarding:${o.id}:kickoff`,
    });
  },
  async onRejected(db, approval) {
    const [o] = await db.select().from(projectOnboardings).where(and(eq(projectOnboardings.projectId, approval.entityId), eq(projectOnboardings.status, 'cto_review')));
    if (!o) return;
    await db.update(projectOnboardings).set({ status: 'pm_review', ctoNotes: approval.decisionNote }).where(eq(projectOnboardings.id, o.id));
    const [p] = await db.select().from(projects).where(eq(projects.id, o.projectId));
    await notify(db, {
      userIds: [p.pmId], kind: 'status', title: `CTO sent ${p.code} back to PM review`, body: approval.decisionNote ?? undefined,
      entityType: 'projects', entityId: p.id, dedupeKey: `onboarding:${o.id}:rejected:${approval.id}`,
    });
  },
});

registerApprovalHandler('change_request', {
  async onApproved(db, approval, actor) {
    const [cr] = await db.update(changeRequests).set({ status: 'approved', decidedAt: new Date() }).where(eq(changeRequests.id, approval.entityId)).returning();
    if (cr) await afterWrite(db, requireResource('change_requests'), actor, cr as Row, { ...cr, status: 'submitted' } as Row);
  },
  async onRejected(db, approval, actor) {
    const [cr] = await db.update(changeRequests).set({ status: 'rejected', decidedAt: new Date() }).where(eq(changeRequests.id, approval.entityId)).returning();
    if (cr) await afterWrite(db, requireResource('change_requests'), actor, cr as Row, { ...cr, status: 'submitted' } as Row);
  },
});

// ───────────── Project lifecycle automation ─────────────

registerAction('projects.enter_qa', {
  description: 'Project entered the QA stage: set status “In QA”, notify QA and create the QA preparation task.',
  async run({ db, event }) {
    const [p] = await db.select().from(projects).where(eq(projects.id, event.entityId!));
    if (!p) return;
    if (p.status !== 'in_qa') {
      const [u] = await db.update(projects).set({ status: 'in_qa' }).where(eq(projects.id, p.id)).returning();
      await afterWrite(db, requireResource('projects'), null, u as Row, p as Row);
    }
    await createWorkflowTask(db, {
      projectId: p.id, title: `QA cycle for ${p.name}`, reporterId: p.pmId, dueDate: plusDays(3), priority: 'high',
      description: 'Prepare and execute the QA run (use the relevant QA templates), log bugs, and request QA sign-off.',
    });
    await notify(db, {
      roles: ['qa'], userIds: [p.pmId], kind: 'status', title: `${p.code} ${p.name} is ready for QA`,
      entityType: 'projects', entityId: p.id, dedupeKey: `project-qa:${p.id}:${event.id}`, excludeUserId: event.actorUserId,
    });
  },
});

registerAction('escalation.notify', {
  description: 'Escalation posted on a project: notify the target role (PM / CTO / CEO) and the project manager.',
  async run({ db, event, rule }) {
    const [p] = await db.select().from(projects).where(eq(projects.id, String(event.payload.projectId)));
    if (!p) return;
    const role = String(event.payload.escalateToRole ?? 'cto');
    await notify(db, {
      roles: [role], userIds: [p.pmId], kind: 'escalation', title: `Escalation on ${p.code}: ${event.payload.title}`,
      entityType: 'project_updates', entityId: event.entityId!, excludeUserId: event.actorUserId, dedupeKey: `${rule.key}:${event.id}`,
    });
  },
});

// ───────────── Routes ─────────────

export async function deliveryRoutes(app: FastifyInstance) {
  const kick = () => app.deps.events.kick();

  app.get<{ Params: { projectId: string } }>('/api/projects/:projectId/onboarding', async (req) => {
    const ctx = ctxOf(req);
    await getOne(ctx, 'projects', req.params.projectId);
    const [o] = await ctx.db.select().from(projectOnboardings).where(eq(projectOnboardings.projectId, req.params.projectId));
    if (!o) return null;
    const isBd = o.bdOwnerId === ctx.actor.userId || can(ctx.actor, 'opportunities.edit');
    return {
      ...o,
      can: {
        handover: o.status === 'bd_handover' && isBd,
        pmReview: o.status === 'pm_review' && can(ctx.actor, 'projects.assign'),
        complete: o.status === 'development_kickoff' && can(ctx.actor, 'projects.edit'),
      },
    };
  });

  app.post<{ Params: { id: string } }>('/api/onboarding/:id/handover', async (req) => {
    const ctx = ctxOf(req);
    const o = await loadOnboarding(ctx, req.params.id);
    if (o.status !== 'bd_handover') throw conflict('Handover has already been submitted');
    if (o.bdOwnerId !== ctx.actor.userId && !can(ctx.actor, 'opportunities.edit')) throw forbidden();
    const body = z.object({ handoverNotes: z.string().trim().min(20, 'Write a meaningful handover (20+ characters)').max(20000) }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', { handoverNotes: body.error.issues[0].message });
    await tx(ctx, async (t) => {
      await t.update(projectOnboardings).set({ status: 'pm_review', handoverNotes: body.data.handoverNotes }).where(eq(projectOnboardings.id, o.id));
      // Close the BD's handover task.
      const open = await t.select().from(tasks).where(and(eq(tasks.projectId, o.projectId), eq(tasks.type, 'onboarding'), ne(tasks.status, 'done')));
      for (const tk of open) {
        const [done] = await t.update(tasks).set({ status: 'done', completedAt: new Date() }).where(eq(tasks.id, tk.id)).returning();
        await afterWrite(t, requireResource('tasks'), ctx.actor, done as Row, tk as Row);
      }
      const [p] = await t.select().from(projects).where(eq(projects.id, o.projectId));
      await notify(t, {
        roles: ['pm'], kind: 'approval_request', title: `${p.code} ${p.name}: handover ready for PM review`,
        entityType: 'projects', entityId: p.id, excludeUserId: ctx.actor.userId, dedupeKey: `onboarding:${o.id}:pm_review`,
      });
      await emit(t, { type: 'project.onboarding_advanced', entityType: 'projects', entityId: o.projectId, actorUserId: ctx.actor.userId, payload: { to: 'pm_review' } });
    });
    kick();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/onboarding/:id/pm-review', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'projects.assign')) throw forbidden();
    const o = await loadOnboarding(ctx, req.params.id);
    if (o.status !== 'pm_review') throw conflict('This onboarding is not awaiting PM review');
    const body = z.object({
      pmId: z.uuid(), techLeadId: z.uuid().optional().nullable(), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
      budgetHours: z.union([z.number(), z.string()]).optional().nullable(), pmNotes: z.string().max(20000).optional(),
      memberIds: z.array(z.uuid()).max(30).optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', z.flattenError(body.error).fieldErrors);
    const d = body.data;
    const active = await ctx.db.select({ id: users.id }).from(users).where(and(inArray(users.id, [d.pmId, ...(d.techLeadId ? [d.techLeadId] : []), ...(d.memberIds ?? [])]), eq(users.status, 'active')));
    if (active.length < new Set([d.pmId, ...(d.techLeadId ? [d.techLeadId] : []), ...(d.memberIds ?? [])]).size) throw invalid('Validation failed', { pmId: 'Unknown or inactive user selected' });
    await tx(ctx, async (t) => {
      const [prev] = await t.select().from(projects).where(eq(projects.id, o.projectId));
      const [p] = await t.update(projects).set({
        pmId: d.pmId, techLeadId: d.techLeadId ?? prev.techLeadId, dueDate: d.dueDate ?? prev.dueDate,
        budgetHours: d.budgetHours != null ? String(d.budgetHours) : prev.budgetHours,
      }).where(eq(projects.id, o.projectId)).returning();
      await afterWrite(t, requireResource('projects'), ctx.actor, p as Row, prev as Row);
      const members = [[d.pmId, 'pm'], ...(d.techLeadId ? [[d.techLeadId, 'tech_lead']] : []), ...(d.memberIds ?? []).map((m) => [m, 'developer'])];
      for (const [userId, role] of members) await t.insert(projectMembers).values({ projectId: p.id, userId, role }).onConflictDoNothing();
      await t.update(projectOnboardings).set({ status: 'cto_review', pmNotes: d.pmNotes }).where(eq(projectOnboardings.id, o.id));
      await requestApproval(t, {
        kind: 'technical_feasibility', entityType: 'projects', entityId: p.id, title: `Technical feasibility: ${p.code} ${p.name}`,
        details: d.pmNotes?.slice(0, 500), requestedBy: ctx.actor.userId, approverRoleKey: 'cto', dueDate: plusDays(2),
      });
    });
    kick();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/onboarding/:id/complete', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'projects.edit')) throw forbidden();
    const o = await loadOnboarding(ctx, req.params.id);
    if (o.status !== 'development_kickoff') throw conflict('Kickoff has not been approved yet');
    await tx(ctx, async (t) => {
      await t.update(projectOnboardings).set({ status: 'completed', completedAt: new Date() }).where(eq(projectOnboardings.id, o.id));
      const [prev] = await t.select().from(projects).where(eq(projects.id, o.projectId));
      const [p] = await t.update(projects).set({ stageId: await stageId(t, 'project', 'design') }).where(eq(projects.id, o.projectId)).returning();
      await afterWrite(t, requireResource('projects'), ctx.actor, p as Row, prev as Row);
    });
    kick();
    return { ok: true };
  });

  /** "My work": everything assigned to the current user, grouped for the developer dashboard. */
  app.get('/api/my-work', async (req) => {
    const ctx = ctxOf(req);
    const uid = ctx.actor.userId;
    const mine = await ctx.db.select({
      id: tasks.id, number: tasks.number, title: tasks.title, status: tasks.status, priority: tasks.priority, dueDate: tasks.dueDate,
      projectId: tasks.projectId, projectName: projects.name, projectCode: projects.code, estimateHours: tasks.estimateHours, type: tasks.type,
    }).from(tasks).leftJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(tasks.assigneeId, uid), ne(tasks.status, 'done')))
      .orderBy(sql`${tasks.dueDate} asc nulls last`, tasks.priority);
    const t0 = today();
    const myProjects = await ctx.db.selectDistinct({ id: projects.id, code: projects.code, name: projects.name, status: projects.status, dueDate: projects.dueDate })
      .from(projects).innerJoin(projectMembers, eq(projectMembers.projectId, projects.id))
      .where(and(eq(projectMembers.userId, uid), notInArray(projects.status, ['completed', 'cancelled'])));
    return {
      overdue: mine.filter((t) => t.dueDate && t.dueDate < t0),
      today: mine.filter((t) => t.dueDate === t0),
      upcoming: mine.filter((t) => !t.dueDate || t.dueDate > t0),
      projects: myProjects,
    };
  });
}

// ───────────── Scheduled jobs ─────────────

async function asSystem(db: DB, name: string, fn: (t: DB) => Promise<void>) {
  await withActor(db, null, `job:${name}`, fn);
}

JOBS.push(
  {
    name: 'projects.flag_delayed', everyMinutes: 60,
    async run(db) {
      await asSystem(db, 'projects.flag_delayed', async (t) => {
        const late = await t.select().from(projects).where(and(lt(projects.dueDate, today()), inArray(projects.status, ['on_track', 'at_risk'])));
        for (const p of late) {
          const [u] = await t.update(projects).set({ status: 'delayed' }).where(eq(projects.id, p.id)).returning();
          await afterWrite(t, requireResource('projects'), null, u as Row, p as Row);
        }
      });
    },
  },
  {
    name: 'tasks.deadline_reminders', everyMinutes: 60,
    async run(db) {
      await asSystem(db, 'tasks.deadline_reminders', async (t) => {
        const tomorrow = plusDays(1);
        const due = await t.select().from(tasks).where(and(inArray(tasks.dueDate, [tomorrow]), ne(tasks.status, 'done')));
        for (const tk of due) {
          await notify(t, { userIds: [tk.assigneeId], kind: 'deadline', title: `Due tomorrow: ${tk.number} ${tk.title}`, entityType: 'tasks', entityId: tk.id, dedupeKey: `due:${tk.id}:${tk.dueDate}` });
        }
        const overdue = await t.select().from(tasks).where(and(lt(tasks.dueDate, today()), ne(tasks.status, 'done')));
        for (const tk of overdue) {
          await notify(t, { userIds: [tk.assigneeId], kind: 'deadline', title: `Overdue: ${tk.number} ${tk.title}`, entityType: 'tasks', entityId: tk.id, dedupeKey: `overdue:${tk.id}:${tk.dueDate}` });
        }
      });
    },
  },
  {
    name: 'crm.follow_up_reminders', everyMinutes: 60,
    async run(db) {
      await asSystem(db, 'crm.follow_up_reminders', async (t) => {
        const due = await t.select().from(followUps).where(and(eq(followUps.status, 'open'), sql`${followUps.dueDate} <= ${today()}`));
        for (const f of due) {
          await notify(t, { userIds: [f.ownerId], kind: 'deadline', title: `Follow-up due: ${f.title}`, entityType: 'follow_ups', entityId: f.id, dedupeKey: `followup:${f.id}:${f.dueDate}` });
        }
      });
    },
  },
  {
    name: 'feedback.flag_overdue', everyMinutes: 60,
    async run(db) {
      await asSystem(db, 'feedback.flag_overdue', async (t) => {
        const late = await t.select().from(clientFeedback).where(and(eq(clientFeedback.status, 'requested'), lt(clientFeedback.dueDate, today())));
        for (const f of late) {
          const [u] = await t.update(clientFeedback).set({ status: 'overdue' }).where(eq(clientFeedback.id, f.id)).returning();
          await afterWrite(t, requireResource('client_feedback'), null, u as Row, f as Row);
        }
      });
    },
  },
);

