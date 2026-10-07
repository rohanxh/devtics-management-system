import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { pipelineStages, qaTemplates } from '../src/server/db/schema/index.ts';

let t: TestEnv;
let pm: Awaited<ReturnType<TestEnv['as']>>;
let qa: Awaited<ReturnType<TestEnv['as']>>;
let dev: Awaited<ReturnType<TestEnv['as']>>;
let cto: Awaited<ReturnType<TestEnv['as']>>;
let projectId: string;
let stage: Record<string, string>;

beforeAll(async () => {
  t = await setup();
  pm = await t.as(['pm']); qa = await t.as(['qa']); dev = await t.as(['developer']); cto = await t.as(['cto']);
  stage = Object.fromEntries((await t.db.select().from(pipelineStages)).map((r) => [`${r.pipeline}.${r.key}`, r.id]));
  const p = await pm.api.post('/api/r/projects', { name: 'Shop build', stageId: stage['project.development'], pmId: pm.user.id, techLeadId: dev.user.id });
  projectId = p.body.id;
});
afterAll(async () => { await t.close(); });

describe('QA workflow', () => {
  let runId: string;
  let bugId: string;

  it('ships a default QA template library', async () => {
    const tpls = await t.db.select().from(qaTemplates);
    expect(tpls.map((x) => x.name)).toEqual(expect.arrayContaining(['WordPress QA', 'WooCommerce QA', 'Pre-launch QA', 'Security QA']));
  });

  it('moving a project into QA triggers the QA automation', async () => {
    expect((await pm.api.patch(`/api/r/projects/${projectId}`, { stageId: stage['project.qa'] })).status).toBe(200);
    await t.events.processPending();
    expect((await pm.api.get(`/api/r/projects/${projectId}`)).body.status).toBe('in_qa');
  });

  it('cannot launch or skip to launch before QA sign-off', async () => {
    expect((await pm.api.patch(`/api/r/projects/${projectId}`, { stageId: stage['project.launch'] })).status).toBe(409);
    expect((await pm.api.post(`/api/projects/${projectId}/launch`)).status).toBe(409);
  });

  it('creates a run from templates and records results; failures raise linked bugs', async () => {
    const [tpl] = await t.db.select().from(qaTemplates).where(eq(qaTemplates.name, 'WordPress QA'));
    expect((await dev.api.post('/api/qa/runs', { projectId, name: 'Cycle 1', templateIds: [tpl.id] })).status).toBe(403);
    const run = await qa.api.post('/api/qa/runs', { projectId, name: 'Cycle 1', templateIds: [tpl.id] });
    expect(run.status).toBe(201);
    runId = run.body.id;
    const res = (await qa.api.get(`/api/qa/runs/${runId}/results`)).body;
    expect(res.rows.length).toBe(8);
    for (const r of res.rows.slice(1)) expect((await qa.api.patch(`/api/r/qa_run_results/${r.id}`, { status: 'pass' })).status).toBe(200);
    const fail = await qa.api.post(`/api/qa/results/${res.rows[0].id}/fail`, { title: 'Plugin updates pending', severity: 'high', assigneeId: dev.user.id });
    expect(fail.status).toBe(201);
    bugId = fail.body.id;
    const runAfter = (await qa.api.get(`/api/r/qa_runs/${runId}`)).body;
    expect(runAfter).toMatchObject({ status: 'in_progress', passCount: 7, failCount: 1 });
    expect((await qa.api.post(`/api/qa/runs/${runId}/complete`)).status).toBe(200);
    expect((await qa.api.post(`/api/qa/runs/${runId}/approve`)).status).toBe(409); // failed case
  });

  it('enforces the bug lifecycle: developers fix, only QA verifies', async () => {
    expect((await dev.api.patch(`/api/r/bugs/${bugId}`, { status: 'in_progress' })).status).toBe(200);
    expect((await dev.api.patch(`/api/r/bugs/${bugId}`, { status: 'fixed' })).status).toBe(200);
    expect((await dev.api.patch(`/api/r/bugs/${bugId}`, { status: 'ready_for_retest' })).status).toBe(403);
    expect((await qa.api.patch(`/api/r/bugs/${bugId}`, { status: 'ready_for_retest' })).status).toBe(200);
    const reopened = await qa.api.patch(`/api/r/bugs/${bugId}`, { status: 'reopened' });
    expect(reopened.body.retestCount).toBe(1);
    await dev.api.patch(`/api/r/bugs/${bugId}`, { status: 'in_progress' });
    await dev.api.patch(`/api/r/bugs/${bugId}`, { status: 'fixed' });
    await qa.api.patch(`/api/r/bugs/${bugId}`, { status: 'ready_for_retest' });
    expect((await qa.api.patch(`/api/r/bugs/${bugId}`, { status: 'verified' })).status).toBe(200);
  });

  it('a clean retest run can be signed off, which enables launch', async () => {
    const run = (await qa.api.post('/api/qa/runs', { projectId, name: 'Cycle 2', includeProjectCases: true })).body;
    const res = (await qa.api.get(`/api/qa/runs/${run.id}/results`)).body;
    for (const r of res.rows) await qa.api.patch(`/api/r/qa_run_results/${r.id}`, { status: 'pass' });
    expect((await qa.api.post(`/api/qa/runs/${run.id}/complete`)).status).toBe(200);
    expect((await dev.api.post(`/api/qa/runs/${run.id}/approve`)).status).toBe(403);
    expect((await qa.api.post(`/api/qa/runs/${run.id}/approve`, { note: 'All green' })).status).toBe(200);
    const p = (await pm.api.get(`/api/r/projects/${projectId}`)).body;
    expect(p.status).toBe('ready_for_launch');
    expect(p.qaApprovedAt).toBeTruthy();
    expect(p.stageId).toBe(stage['project.client_feedback']);
    // closed runs are read-only
    expect((await qa.api.patch(`/api/r/qa_run_results/${res.rows[0].id}`, { status: 'fail' })).status).toBe(422);
    expect((await pm.api.post(`/api/projects/${projectId}/launch`)).status).toBe(200);
    expect((await pm.api.get(`/api/r/projects/${projectId}`)).body.launchedAt).toBeTruthy();
  });
});

describe('engineering controls', () => {
  it('production deployments need CTO approval', async () => {
    const env = (await dev.api.post('/api/r/environments', { projectId, name: 'Production', kind: 'production' })).body;
    const staging = (await dev.api.post('/api/r/environments', { projectId, name: 'Staging', kind: 'staging' })).body;
    const sd = (await dev.api.post('/api/r/deployments', { projectId, environmentId: staging.id, version: '1.0.0-rc1' })).body;
    expect(sd.status).toBe('approved');
    const d = (await dev.api.post('/api/r/deployments', { projectId, environmentId: env.id, version: '1.0.0' })).body;
    expect(d.status).toBe('pending_approval');
    expect((await dev.api.patch(`/api/r/deployments/${d.id}`, { status: 'succeeded' })).status).toBe(422);
    const appr = (await cto.api.get('/api/approvals?status=pending')).body.find((a: any) => a.entityId === d.id);
    expect((await cto.api.post(`/api/approvals/${appr.id}/decide`, { decision: 'approved' })).status).toBe(200);
    const done = await dev.api.patch(`/api/r/deployments/${d.id}`, { status: 'succeeded' });
    expect(done.body.status).toBe('succeeded');
    expect(done.body.deployedById).toBe(dev.user.id);
  });

  it('authors cannot approve their own pull request', async () => {
    const repo = (await dev.api.post('/api/r/repositories', { name: 'shop', projectId })).body;
    const pr = (await dev.api.post('/api/r/pull_requests', { repositoryId: repo.id, title: 'Checkout', reviewerId: dev.user.id })).body;
    expect((await dev.api.patch(`/api/r/pull_requests/${pr.id}`, { status: 'approved' })).status).toBe(403);
  });

  it('CTO and QA dashboards load with scoped data', async () => {
    const c = await cto.api.get('/api/dashboard/cto');
    expect(c.status).toBe(200);
    expect(c.body.bugCounts.total).toBeGreaterThanOrEqual(0);
    const q = await qa.api.get('/api/dashboard/qa');
    expect(q.status).toBe(200);
    expect((await dev.api.get('/api/dashboard/cto')).status).toBe(403);
    const devDash = await dev.api.get('/api/dashboard/developer');
    expect(devDash.body.engineering).toBeTruthy();
    const fin = await t.as(['finance']);
    expect((await fin.api.get('/api/dashboard/qa')).status).toBe(403);
  });
});
