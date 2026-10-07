import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { pipelineStages, recurringBilling, tickets } from '../src/server/db/schema/index.ts';
import { JOBS } from '../src/server/jobs.ts';
import { mrr } from '../src/server/modules/finance.ts';
import { planUsage } from '../src/server/modules/support.ts';

let t: TestEnv;
let sup: Awaited<ReturnType<TestEnv['as']>>;
let pm: Awaited<ReturnType<TestEnv['as']>>;
let dev: Awaited<ReturnType<TestEnv['as']>>;
let qa: Awaited<ReturnType<TestEnv['as']>>;
let clientId: string;
let projectId: string;
let planId: string;

beforeAll(async () => {
  t = await setup();
  sup = await t.as(['support']); pm = await t.as(['pm']); dev = await t.as(['developer']); qa = await t.as(['qa']);
  const bd = await t.as(['bd']);
  clientId = (await bd.api.post('/api/r/clients', { name: 'Initech', accountManagerId: pm.user.id })).body.id;
  const [st] = await t.db.select().from(pipelineStages).where(eq(pipelineStages.key, 'maintenance'));
  projectId = (await pm.api.post('/api/r/projects', { name: 'Initech site', clientId, stageId: st.id, pmId: pm.user.id, techLeadId: dev.user.id })).body.id;
});
afterAll(async () => { await t.close(); });

describe('maintenance plans', () => {
  it('creates its own recurring billing and feeds MRR', async () => {
    const before = await mrr(t.db);
    const p = await sup.api.post('/api/r/maintenance_plans', { name: 'Initech care', companyId: clientId, projectId, monthlyHours: '10', monthlyFee: '800' });
    expect(p.status).toBe(201);
    planId = p.body.id;
    const [rb] = await t.db.select().from(recurringBilling).where(eq(recurringBilling.maintenancePlanId, planId));
    expect(rb).toMatchObject({ amount: '800.00', interval: 'monthly', active: true });
    expect(await mrr(t.db)).toBe(before + 800);
  });
});

describe('tickets', () => {
  let ticketId: string;

  it('applies SLA targets, auto-links the client plan and records first response', async () => {
    const r = await sup.api.post('/api/r/tickets', { companyId: clientId, title: 'Checkout broken', priority: 'urgent', type: 'bug' });
    expect(r.status).toBe(201);
    ticketId = r.body.id;
    expect(r.body.number).toMatch(/^TCK-/);
    expect(r.body.maintenancePlanId).toBe(planId);
    expect(r.body.projectId).toBe(projectId);
    const created = new Date(r.body.createdAt).getTime();
    expect(new Date(r.body.firstResponseDueAt).getTime() - created).toBeGreaterThan(55 * 60_000);
    expect(new Date(r.body.resolutionDueAt).getTime() - created).toBeLessThan(8 * 3600_000 + 60_000);
    const tri = await sup.api.patch(`/api/r/tickets/${ticketId}`, { status: 'triaged' });
    expect(tri.body.firstRespondedAt).toBeTruthy();
  });

  it('escalates to a bug and resolves automatically when QA verifies the fix', async () => {
    const esc = await sup.api.post(`/api/support/tickets/${ticketId}/escalate`, { kind: 'bug', assigneeId: dev.user.id });
    expect(esc.status).toBe(201);
    const bugId = esc.body.id;
    expect((await sup.api.get(`/api/r/tickets/${ticketId}`)).body.status).toBe('in_development');
    expect((await sup.api.post(`/api/support/tickets/${ticketId}/escalate`, { kind: 'task' })).status).toBe(409);
    await dev.api.patch(`/api/r/bugs/${bugId}`, { status: 'in_progress' });
    await dev.api.patch(`/api/r/bugs/${bugId}`, { status: 'fixed' });
    await qa.api.patch(`/api/r/bugs/${bugId}`, { status: 'ready_for_retest' });
    await t.events.processPending();
    expect((await sup.api.get(`/api/r/tickets/${ticketId}`)).body.status).toBe('in_qa');
    await qa.api.patch(`/api/r/bugs/${bugId}`, { status: 'verified' });
    await t.events.processPending();
    const done = (await sup.api.get(`/api/r/tickets/${ticketId}`)).body;
    expect(done.status).toBe('resolved');
    expect(done.resolvedAt).toBeTruthy();
  });

  it('flags SLA breaches via the scheduled job', async () => {
    const r = (await sup.api.post('/api/r/tickets', { companyId: clientId, title: 'Old question', priority: 'low' })).body;
    await t.db.update(tickets).set({ resolutionDueAt: new Date(Date.now() - 60_000) }).where(eq(tickets.id, r.id));
    for (const job of JOBS.filter((j) => j.name === 'support.sla')) await job.run(t.db);
    expect((await sup.api.get(`/api/r/tickets/${r.id}`)).body.slaBreached).toBe(true);
  });

  it('counts time logged on plan tickets as used hours', async () => {
    await sup.api.post('/api/r/time_entries', { ticketId, projectId, minutes: 150, description: 'Investigation' });
    const usage = await planUsage(t.db, [planId]);
    expect(usage.get(planId)).toBe(2.5);
    const api = (await sup.api.get('/api/support/plans/usage')).body.find((p: any) => p.id === planId);
    expect(api).toMatchObject({ used: 2.5, remaining: 7.5 });
  });

  it('scopes tickets for developers to their projects', async () => {
    const other = await t.as(['developer']);
    expect((await other.api.get('/api/r/tickets')).body.rows).toHaveLength(0);
    expect((await dev.api.get('/api/r/tickets')).body.rows.length).toBeGreaterThan(0);
    expect((await sup.api.get('/api/dashboard/support')).body.counts.open).toBeGreaterThan(0);
  });
});
