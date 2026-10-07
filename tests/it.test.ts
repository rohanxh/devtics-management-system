import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { notifications } from '../src/server/db/schema/index.ts';

let t: TestEnv;
let it_: Awaited<ReturnType<TestEnv['as']>>;
let hr: Awaited<ReturnType<TestEnv['as']>>;
let emp: Awaited<ReturnType<TestEnv['as']>>;

beforeAll(async () => {
  t = await setup();
  it_ = await t.as(['it']); hr = await t.as(['hr']); emp = await t.as(['developer']);
});
afterAll(async () => { await t.close(); });

describe('IT', () => {
  it('never stores credentials: vault references only, secret-looking notes rejected', async () => {
    const bad = await it_.api.post('/api/r/subscriptions', { name: 'GitHub', vaultReference: 'hunter2!' });
    expect(bad.status).toBe(422);
    expect(bad.body.error.details.vaultReference).toMatch(/password-manager reference/);
    const leaked = await it_.api.post('/api/r/infra_resources', { name: 'prod', kind: 'server', notes: 'root password: Sup3rSecret' });
    expect(leaked.status).toBe(422);
    const key = await it_.api.post('/api/r/infra_resources', { name: 'aws', kind: 'cloud_account', notes: 'key AKIAABCDEFGHIJKLMNOP' });
    expect(key.status).toBe(422);
    const ok = await it_.api.post('/api/r/subscriptions', { name: 'GitHub Team', seatsTotal: 1, vaultReference: 'op://Devtics/GitHub/admin', notes: 'Admin is the CTO' });
    expect(ok.status).toBe(201);
  });

  it('enforces seat limits and tracks seats used', async () => {
    const sub = (await it_.api.post('/api/r/subscriptions', { name: 'Figma', seatsTotal: 1 })).body;
    expect((await it_.api.post('/api/r/license_assignments', { subscriptionId: sub.id, employeeId: emp.user.employeeId })).status).toBe(201);
    expect((await it_.api.get(`/api/r/subscriptions/${sub.id}`)).body.seatsUsed).toBe(1);
    expect((await it_.api.post('/api/r/license_assignments', { subscriptionId: sub.id, employeeId: hr.user.employeeId })).status).toBe(409);
    // the employee can see the tools they have seats on
    expect((await emp.api.get('/api/r/subscriptions')).body.rows.map((r: any) => r.name)).toEqual(['Figma']);
  });

  it('keeps an assignment history and shows employees their own equipment', async () => {
    const a = (await it_.api.post('/api/r/assets', { tag: 'LT-001', kind: 'laptop', brand: 'Dell', assignedEmployeeId: emp.user.employeeId })).body;
    expect(a.status).toBe('assigned');
    await it_.api.patch(`/api/r/assets/${a.id}`, { assignedEmployeeId: null, condition: 'Good' });
    await it_.api.patch(`/api/r/assets/${a.id}`, { assignedEmployeeId: hr.user.employeeId });
    const hist = (await it_.api.get(`/api/r/asset_assignments?assetId=${a.id}`)).body.rows;
    expect(hist).toHaveLength(2);
    expect(hist.find((h: any) => h.employeeId === emp.user.employeeId).returnedOn).toBeTruthy();
    expect((await hr.api.get('/api/r/assets')).body.rows.map((r: any) => r.tag)).toEqual(['LT-001']);
    expect((await emp.api.get('/api/r/assets')).body.rows).toHaveLength(0);
    expect((await emp.api.post('/api/r/assets', { tag: 'X' })).status).toBe(403);
  });

  it('alerts IT with an offboarding checklist when an employee leaves', async () => {
    const leaver = await t.as(['developer']);
    await it_.api.post('/api/r/access_grants', { employeeId: leaver.user.employeeId, system: 'github', systemName: 'GitHub', accountIdentifier: 'leaver-gh' });
    await it_.api.post('/api/r/assets', { tag: 'LT-099', assignedEmployeeId: leaver.user.employeeId });
    expect((await hr.api.patch(`/api/r/employees/${leaver.user.employeeId}`, { employmentStatus: 'resigned' })).status).toBe(200);
    await t.events.processPending();
    const n = await t.db.select().from(notifications).where(eq(notifications.userId, it_.user.id));
    const off = n.find((x) => x.title.startsWith('Offboard'));
    expect(off?.title).toMatch(/revoke 1 access record\(s\), recover 1 device/);
    const dash = (await it_.api.get('/api/dashboard/it')).body;
    expect(dash.leaverAccess.length).toBe(1);
    expect(dash.leaverDevices.length).toBe(1);
  });
});
