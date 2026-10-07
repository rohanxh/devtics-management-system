import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { companies, employeeCompensation, notifications, pipelineStages, projectOnboardings, tasks } from '../src/server/db/schema/index.ts';

let t: TestEnv;
let bd: Awaited<ReturnType<TestEnv['as']>>;
let pm: Awaited<ReturnType<TestEnv['as']>>;
let pm2: Awaited<ReturnType<TestEnv['as']>>;
let cto: Awaited<ReturnType<TestEnv['as']>>;
let dev: Awaited<ReturnType<TestEnv['as']>>;
let stage: Record<string, string>;

beforeAll(async () => {
  t = await setup();
  bd = await t.as(['bd']); pm = await t.as(['pm']); pm2 = await t.as(['pm']); cto = await t.as(['cto']); dev = await t.as(['developer']);
  const rows = await t.db.select().from(pipelineStages);
  stage = Object.fromEntries(rows.map((r) => [`${r.pipeline}.${r.key}`, r.id]));
});
afterAll(async () => { await t.close(); });

describe('lead → opportunity → won → project onboarding', () => {
  let oppId: string;
  let projectId: string;
  let onboardingId: string;

  it('converts a qualified lead into company, contact and opportunity', async () => {
    const lead = await bd.api.post('/api/r/leads', { title: 'Website for Acme', companyName: 'Acme Widgets', contactName: 'Jane Doe', email: 'jane@acme.example', estimatedValue: '12000', projectType: 'wordpress' });
    expect(lead.status).toBe(201);
    expect(lead.body.number).toMatch(/^LD-\d{4}$/);
    const early = await bd.api.post(`/api/sales/leads/${lead.body.id}/convert`, {});
    expect(early.status).toBe(422); // must be qualified first
    expect((await bd.api.patch(`/api/r/leads/${lead.body.id}`, { status: 'qualified' })).status).toBe(200);
    const conv = await bd.api.post(`/api/sales/leads/${lead.body.id}/convert`, {});
    expect(conv.status).toBe(201);
    oppId = conv.body.id;
    expect(conv.body.stageId).toBe(stage['sales.discovery']);
    expect(conv.body.value).toBe('12000.00');
    const again = await bd.api.post(`/api/sales/leads/${lead.body.id}/convert`, {});
    expect(again.status).toBe(409);
  });

  it('requires a reason to lose a deal and blocks creating deals directly as won', async () => {
    const lost = await bd.api.patch(`/api/r/opportunities/${oppId}`, { stageId: stage['sales.lost'] });
    expect(lost.status).toBe(422);
    const [co] = await t.db.select().from(companies).where(eq(companies.name, 'Acme Widgets'));
    const direct = await bd.api.post('/api/r/opportunities', { name: 'X', companyId: co.id, stageId: stage['sales.won'], value: '10' });
    expect(direct.status).toBe(422);
  });

  it('winning the deal creates the client, project and onboarding through automation', async () => {
    for (const s of ['requirement', 'proposal', 'negotiation', 'won']) {
      const r = await bd.api.patch(`/api/r/opportunities/${oppId}`, { stageId: stage[`sales.${s}`] });
      expect(r.status).toBe(200);
    }
    await t.events.processPending();
    const opp = (await bd.api.get(`/api/r/opportunities/${oppId}`)).body;
    expect(opp.projectId).toBeTruthy();
    expect(opp.probability).toBe(100);
    projectId = opp.projectId;
    const [co] = await t.db.select().from(companies).where(eq(companies.id, opp.companyId));
    expect(co.lifecycle).toBe('client');
    expect(co.clientCode).toMatch(/^CL-/);
    const [onb] = await t.db.select().from(projectOnboardings).where(eq(projectOnboardings.projectId, projectId));
    expect(onb.status).toBe('bd_handover');
    onboardingId = onb.id;
    const handoverTask = await t.db.select().from(tasks).where(and(eq(tasks.projectId, projectId), eq(tasks.type, 'onboarding')));
    expect(handoverTask[0].assigneeId).toBe(bd.user.id);
    // The deal can no longer change stage once onboarded.
    expect((await bd.api.patch(`/api/r/opportunities/${oppId}`, { stageId: stage['sales.negotiation'] })).status).toBe(409);
    // Processing again is idempotent.
    await t.events.processPending();
    expect((await t.db.select().from(projectOnboardings).where(eq(projectOnboardings.projectId, projectId))).length).toBe(1);
  });

  it('runs BD handover → PM review → CTO approval → kickoff', async () => {
    expect((await bd.api.post(`/api/onboarding/${onboardingId}/handover`, { handoverNotes: 'short' })).status).toBe(422);
    expect((await bd.api.post(`/api/onboarding/${onboardingId}/handover`, { handoverNotes: 'Client wants a WordPress site with 8 pages, launch before Q4.' })).status).toBe(200);
    expect((await dev.api.post(`/api/onboarding/${onboardingId}/pm-review`, { pmId: pm.user.id })).status).toBe(403);
    const review = await pm.api.post(`/api/onboarding/${onboardingId}/pm-review`, { pmId: pm.user.id, techLeadId: dev.user.id, memberIds: [dev.user.id], pmNotes: 'Feasible in 6 weeks' });
    expect(review.status).toBe(200);

    const approvals = (await cto.api.get('/api/approvals?status=pending')).body;
    const feas = approvals.find((a: any) => a.kind === 'technical_feasibility' && a.entityId === projectId);
    expect(feas.canDecide).toBe(true);
    // The PM cannot approve the CTO's approval.
    expect((await pm.api.post(`/api/approvals/${feas.id}/decide`, { decision: 'approved' })).status).toBe(403);
    expect((await cto.api.post(`/api/approvals/${feas.id}/decide`, { decision: 'rejected' })).status).toBe(403); // reason required
    expect((await cto.api.post(`/api/approvals/${feas.id}/decide`, { decision: 'approved', note: 'Stack OK' })).status).toBe(200);

    const [onb] = await t.db.select().from(projectOnboardings).where(eq(projectOnboardings.id, onboardingId));
    expect(onb.status).toBe('development_kickoff');
    const kickoff = await t.db.select().from(tasks).where(eq(tasks.projectId, projectId));
    expect(kickoff.length).toBeGreaterThanOrEqual(5);

    expect((await pm.api.post(`/api/onboarding/${onboardingId}/complete`)).status).toBe(200);
    const project = (await pm.api.get(`/api/r/projects/${projectId}`)).body;
    expect(project.stageId).toBe(stage['project.design']);
    expect(project.pmId).toBe(pm.user.id);
  });

  it('notifies the developer who was added to the team (permission-aware)', async () => {
    await t.events.processPending();
    const n = await t.db.select().from(notifications).where(eq(notifications.userId, dev.user.id));
    expect(n.length).toBeGreaterThan(0);
  });

  it('scopes projects: members see them, others get 404; budgets only for project finance holders', async () => {
    const outsider = await t.as(['developer']);
    expect((await outsider.api.get(`/api/r/projects/${projectId}`)).status).toBe(404);
    expect((await outsider.api.get('/api/r/projects')).body.rows).toHaveLength(0);
    const asDev = (await dev.api.get(`/api/r/projects/${projectId}`)).body;
    expect(asDev.name).toBeTruthy();
    expect(asDev).not.toHaveProperty('budgetAmount');
    const asPm = (await pm.api.get(`/api/r/projects/${projectId}`)).body;
    expect(asPm.budgetAmount).toBe('12000.00');
    // Another PM can view the project (projects.view all) but not its budget (project_finance.view own).
    const asPm2 = (await pm2.api.get(`/api/r/projects/${projectId}`)).body;
    expect(asPm2.name).toBeTruthy();
    expect(asPm2).not.toHaveProperty('budgetAmount');
  });

  it('enforces task dependencies, cycles, and tracks QA rework', async () => {
    const a = (await pm.api.post('/api/r/tasks', { title: 'Design homepage', projectId, assigneeId: dev.user.id })).body;
    const b = (await pm.api.post('/api/r/tasks', { title: 'Build homepage', projectId, assigneeId: dev.user.id })).body;
    expect((await pm.api.post('/api/r/task_dependencies', { taskId: b.id, dependsOnTaskId: a.id })).status).toBe(201);
    expect((await pm.api.post('/api/r/task_dependencies', { taskId: a.id, dependsOnTaskId: b.id })).status).toBe(422);
    expect((await dev.api.patch(`/api/r/tasks/${b.id}`, { status: 'in_progress' })).status).toBe(409);
    expect((await dev.api.patch(`/api/r/tasks/${a.id}`, { status: 'done' })).status).toBe(200);
    expect((await dev.api.patch(`/api/r/tasks/${b.id}`, { status: 'in_progress' })).status).toBe(200);
    expect((await dev.api.patch(`/api/r/tasks/${b.id}`, { status: 'qa' })).status).toBe(200);
    const rejected = await pm.api.patch(`/api/r/tasks/${b.id}`, { status: 'in_progress' });
    expect(rejected.body.qaRejections).toBe(1);
    expect(rejected.body.isRework).toBe(true);
    // Invalid transition
    expect((await dev.api.patch(`/api/r/tasks/${a.id}`, { status: 'qa' })).status).toBe(422);
  });

  it('developers can only assign tasks to themselves', async () => {
    const r = await dev.api.post('/api/r/tasks', { title: 'Mine', projectId, assigneeId: pm.user.id });
    expect(r.status).toBe(403);
    expect((await dev.api.post('/api/r/tasks', { title: 'Mine', projectId, assigneeId: dev.user.id })).status).toBe(201);
  });

  it('cannot attach a task to a project the user cannot see', async () => {
    const outsider = await t.as(['developer']);
    const r = await outsider.api.post('/api/r/tasks', { title: 'Sneaky', projectId });
    expect(r.status).toBe(422);
  });

  it('logs time with a cost snapshot from the salary history, own entries only', async () => {
    await t.db.insert(employeeCompensation).values({ employeeId: dev.user.employeeId!, effectiveFrom: '2024-01-01', baseSalary: '3000', hourlyCost: '20' });
    const ok = await dev.api.post('/api/r/time_entries', { projectId, minutes: 90, description: 'Header' });
    expect(ok.status).toBe(201);
    expect(ok.body).not.toHaveProperty('costAmount'); // developers don't see cost
    const asPm = (await pm.api.get(`/api/r/time_entries/${ok.body.id}`)).body;
    expect(asPm.costAmount).toBe('30.00');
    expect((await dev.api.post('/api/r/time_entries', { projectId, minutes: 30, userId: pm.user.id })).status).toBe(403);
    expect((await dev.api.post('/api/r/time_entries', { projectId, minutes: 30, workDate: '2999-01-01' })).status).toBe(422);
  });

  it('routes change requests to the right approver and blocks self-approval', async () => {
    const cr = (await pm.api.post('/api/r/change_requests', { projectId, title: 'Add blog', impactHours: '12', isMajor: false })).body;
    expect((await pm.api.patch(`/api/r/change_requests/${cr.id}`, { status: 'submitted' })).status).toBe(200);
    const mine = (await pm.api.get('/api/approvals?status=pending')).body.find((a: any) => a.entityId === cr.id);
    expect(mine.canDecide).toBe(false); // own request
    const other = (await pm2.api.get('/api/approvals?status=pending')).body.find((a: any) => a.entityId === cr.id);
    expect((await pm2.api.post(`/api/approvals/${other.id}/decide`, { decision: 'approved' })).status).toBe(200);
    expect((await pm.api.get(`/api/r/change_requests/${cr.id}`)).body.status).toBe('approved');
  });
});

describe('quotes', () => {
  it('computes totals in SQL and locks sent quotes', async () => {
    const [co] = await t.db.select().from(companies).limit(1);
    const q = (await bd.api.post('/api/r/quotes', { title: 'Website', companyId: co.id, taxRate: '10', discountAmount: '100' })).body;
    expect(q.number).toMatch(/^QT-/);
    expect((await bd.api.patch(`/api/r/quotes/${q.id}`, { status: 'sent' })).status).toBe(422); // no items
    await bd.api.post('/api/r/quote_items', { quoteId: q.id, description: 'Design', quantity: '2', unitPrice: '500.50' });
    await bd.api.post('/api/r/quote_items', { quoteId: q.id, description: 'Build', quantity: '1', unitPrice: '1000' });
    const after = (await bd.api.get(`/api/r/quotes/${q.id}`)).body;
    expect(after.subtotal).toBe('2001.00');
    expect(after.taxAmount).toBe('190.10');
    expect(after.total).toBe('2091.10');
    // Totals are read-only through the API
    await bd.api.patch(`/api/r/quotes/${q.id}`, { total: '1' });
    expect((await bd.api.get(`/api/r/quotes/${q.id}`)).body.total).toBe('2091.10');
    expect((await bd.api.patch(`/api/r/quotes/${q.id}`, { status: 'sent' })).status).toBe(200);
    const items = (await bd.api.get(`/api/r/quote_items?quoteId=${q.id}`)).body.rows;
    expect((await bd.api.patch(`/api/r/quote_items/${items[0].id}`, { unitPrice: '1' })).status).toBe(409);
  });
});
