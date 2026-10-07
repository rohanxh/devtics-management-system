import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { and, eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { attendanceRecords, employees, leaveBalances, leaveTypes, notifications, pipelineStages } from '../src/server/db/schema/index.ts';
import { measureKpis } from '../src/server/modules/kpi.ts';
import { withActor } from '../src/server/core/context.ts';

let t: TestEnv;
let hr: Awaited<ReturnType<TestEnv['as']>>;
let mgr: Awaited<ReturnType<TestEnv['as']>>;
let emp: Awaited<ReturnType<TestEnv['as']>>;
let annual: string;

/** Next Monday at least a week away, so leave is in the future and spans working days. */
function nextMonday(weeksAhead = 1) {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + ((8 - d.getUTCDay()) % 7 || 7) + 7 * weeksAhead);
  return d.toISOString().slice(0, 10);
}
const plus = (d: string, k: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 86400_000).toISOString().slice(0, 10);

beforeAll(async () => {
  t = await setup();
  hr = await t.as(['hr']); mgr = await t.as(['pm']); emp = await t.as(['developer']);
  await t.db.update(employees).set({ managerId: mgr.user.employeeId }).where(eq(employees.id, emp.user.employeeId!));
  [{ id: annual }] = await t.db.select({ id: leaveTypes.id }).from(leaveTypes).where(eq(leaveTypes.code, 'AL'));
});
afterAll(async () => { await t.close(); });

describe('leave', () => {
  let reqId: string;
  const start = nextMonday();

  it('computes working days, routes approval to the manager and updates balance + attendance', async () => {
    const r = await emp.api.post('/api/r/leave_requests', { leaveTypeId: annual, startDate: start, endDate: plus(start, 6), reason: 'Family trip' });
    expect(r.status).toBe(201);
    expect(r.body.days).toBe('5.0'); // Mon–Sun → 5 working days
    expect(r.body.employeeId).toBe(emp.user.employeeId);
    reqId = r.body.id;
    expect((await emp.api.post('/api/r/leave_requests', { leaveTypeId: annual, startDate: plus(start, 2), endDate: plus(start, 3) })).status).toBe(409); // overlap
    const mine = (await emp.api.get('/api/approvals?status=pending')).body.find((a: any) => a.entityId === reqId);
    expect(mine.canDecide).toBe(false);
    const forMgr = (await mgr.api.get('/api/approvals?status=pending')).body.find((a: any) => a.entityId === reqId);
    expect(forMgr.canDecide).toBe(true);
    expect((await mgr.api.post(`/api/approvals/${forMgr.id}/decide`, { decision: 'approved' })).status).toBe(200);
    const [bal] = await t.db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, emp.user.employeeId!), eq(leaveBalances.leaveTypeId, annual)));
    expect(bal.usedDays).toBe('5.0');
    const att = await t.db.select().from(attendanceRecords).where(eq(attendanceRecords.employeeId, emp.user.employeeId!));
    expect(att.filter((a) => a.status === 'on_leave')).toHaveLength(5);
    await t.events.processPending();
    const n = await t.db.select().from(notifications).where(eq(notifications.userId, emp.user.id));
    expect(n.some((x) => x.title.includes('approved'))).toBe(true);
  });

  it('rejects requests beyond the balance', async () => {
    const far = nextMonday(6);
    const r = await emp.api.post('/api/r/leave_requests', { leaveTypeId: annual, startDate: far, endDate: plus(far, 25) });
    expect(r.status).toBe(422);
  });

  it('restores balance and attendance when approved future leave is cancelled', async () => {
    expect((await emp.api.patch(`/api/r/leave_requests/${reqId}`, { status: 'cancelled' })).status).toBe(200);
    const [bal] = await t.db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, emp.user.employeeId!), eq(leaveBalances.leaveTypeId, annual)));
    expect(bal.usedDays).toBe('0.0');
    const att = await t.db.select().from(attendanceRecords).where(and(eq(attendanceRecords.employeeId, emp.user.employeeId!), eq(attendanceRecords.status, 'on_leave')));
    expect(att).toHaveLength(0);
  });

  it('employees without a manager go to HR', async () => {
    const solo = await t.as(['developer']);
    const d = nextMonday(2);
    const r = await solo.api.post('/api/r/leave_requests', { leaveTypeId: annual, startDate: d, endDate: d });
    const a = (await hr.api.get('/api/approvals?status=pending')).body.find((x: any) => x.entityId === r.body.id);
    expect(a.approverRoleKey).toBe('hr');
    expect(a.canDecide).toBe(true);
  });
});

describe('attendance', () => {
  it('clocks in and out once per day; employees cannot hand-edit attendance', async () => {
    const a = await t.as(['developer']);
    expect((await a.api.post('/api/attendance/clock-in')).status).toBe(200);
    expect((await a.api.post('/api/attendance/clock-in')).status).toBe(409);
    const out = await a.api.post('/api/attendance/clock-out');
    expect(out.status).toBe(200);
    expect(out.body.clockOut).toBeTruthy();
    const me = await a.api.get('/api/attendance/me');
    expect(me.body.today.clockIn).toBeTruthy();
    expect(me.body.balances).toBeDefined();
    expect((await a.api.post('/api/r/attendance', { employeeId: a.user.employeeId, date: '2026-01-05', status: 'present' })).status).toBe(403);
    expect((await a.api.patch(`/api/r/attendance/${me.body.today.id}`, { minutesWorked: 600 })).status).toBe(403);
    expect((await hr.api.patch(`/api/r/attendance/${me.body.today.id}`, { notes: 'Corrected' })).status).toBe(200);
  });
});

describe('HR privacy', () => {
  it('keeps private employee documents and emergency contacts away from managers', async () => {
    const fd = (name: string, category: string) => ({
      payload: `--b\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\nhello\r\n--b--\r\n`,
      headers: { 'content-type': 'multipart/form-data; boundary=b' }, category,
    });
    const up = async (cookieUser: any, category: string) => {
      const { payload, headers } = fd('doc.txt', category);
      const { cookie } = await t.login(cookieUser.user.email);
      return t.app.inject({ method: 'POST', url: `/api/r/employees/${emp.user.employeeId}/files?category=${category}`, payload, headers: { ...headers, cookie: cookie!, 'x-requested-with': 'dms' } });
    };
    expect((await up(hr, 'contract')).statusCode).toBe(201);
    expect((await up(hr, 'certificate')).statusCode).toBe(201);
    const asMgr = (await mgr.api.get(`/api/r/employees/${emp.user.employeeId}/files`)).body;
    expect(asMgr.map((f: any) => f.category)).toEqual(['certificate']);
    const asSelf = (await emp.api.get(`/api/r/employees/${emp.user.employeeId}/files`)).body;
    expect(asSelf).toHaveLength(2);
    const asHr = (await hr.api.get(`/api/r/employees/${emp.user.employeeId}/files`)).body;
    expect(asHr).toHaveLength(2);
    const contract = asHr.find((f: any) => f.category === 'contract');
    expect((await mgr.api.get(`/api/files/${contract.id}`)).status).toBe(404);
    expect((await emp.api.get(`/api/files/${contract.id}`)).status).toBe(200);

    expect((await emp.api.post('/api/r/emergency_contacts', { name: 'Parent', relationship: 'Father', phone: '+92 300 1111111' })).status).toBe(201);
    expect((await mgr.api.get('/api/r/emergency_contacts')).body.rows ?? []).toHaveLength(0);
    expect((await hr.api.get('/api/r/emergency_contacts')).body.rows.length).toBeGreaterThan(0);
  });
});

describe('performance & recruitment', () => {
  it('lets the employee only write their self assessment', async () => {
    const r = (await hr.api.post('/api/r/performance_reviews', { employeeId: emp.user.employeeId, period: '2026 H2', reviewerId: mgr.user.id, status: 'scheduled' })).body;
    await hr.api.patch(`/api/r/performance_reviews/${r.id}`, { status: 'self_review' });
    expect((await emp.api.patch(`/api/r/performance_reviews/${r.id}`, { overallRating: 5 })).status).toBe(403);
    expect((await emp.api.patch(`/api/r/performance_reviews/${r.id}`, { selfAssessment: 'Shipped a lot' })).status).toBe(200);
    expect((await emp.api.patch(`/api/r/performance_reviews/${r.id}`, { status: 'manager_review' })).status).toBe(200);
    expect((await mgr.api.patch(`/api/r/performance_reviews/${r.id}`, { status: 'completed' })).status).toBe(422); // needs rating
    expect((await mgr.api.patch(`/api/r/performance_reviews/${r.id}`, { overallRating: 4, status: 'completed' })).status).toBe(200);
  });

  it('hiring a candidate creates the employee and alerts IT', async () => {
    const it2 = await t.as(['it']);
    const stages = Object.fromEntries((await t.db.select().from(pipelineStages).where(eq(pipelineStages.pipeline, 'recruitment'))).map((s) => [s.key, s.id]));
    const op = (await hr.api.post('/api/r/job_openings', { title: 'Frontend Developer', openings: 1, hiringManagerId: mgr.user.id })).body;
    await hr.api.patch(`/api/r/job_openings/${op.id}`, { status: 'open' });
    const cand = (await hr.api.post('/api/r/candidates', { firstName: 'Nadia', lastName: 'Rahman', email: 'nadia@mail.example' })).body;
    const app = (await hr.api.post('/api/r/applications', { candidateId: cand.id, jobOpeningId: op.id, stageId: stages.applied, expectedSalary: '1500' })).body;
    // The hiring manager can see the application but not the salary expectation, and cannot hire
    const asMgr = (await mgr.api.get(`/api/r/applications/${app.id}`)).body;
    expect(asMgr).not.toHaveProperty('expectedSalary');
    expect((await mgr.api.patch(`/api/r/applications/${app.id}`, { stageId: stages.hired })).status).toBe(403);
    expect((await hr.api.patch(`/api/r/applications/${app.id}`, { stageId: stages.rejected })).status).toBe(422); // reason needed
    expect((await hr.api.patch(`/api/r/applications/${app.id}`, { stageId: stages.hired })).status).toBe(200);
    await t.events.processPending();
    const a = (await hr.api.get(`/api/r/applications/${app.id}`)).body;
    expect(a.status).toBe('hired');
    expect(a.hiredEmployeeId).toBeTruthy();
    expect((await hr.api.get(`/api/r/job_openings/${op.id}`)).body.status).toBe('filled');
    const itNotes = await t.db.select().from(notifications).where(eq(notifications.userId, it2.user.id));
    expect(itNotes.some((x) => x.title.includes('Nadia'))).toBe(true);
  });

  it('measures KPIs automatically from live data', async () => {
    const k = (await hr.api.post('/api/r/goals', { title: 'Grow team', period: '2026', metricKey: 'headcount', targetValue: '50' })).body;
    expect(k.id).toBeTruthy();
    const ceo = await t.as(['ceo']);
    const kpi = (await ceo.api.post('/api/r/kpis', { name: 'Headcount', metricKey: 'headcount', target: '40' })).body;
    await withActor(t.db, null, 'test', measureKpis);
    const vals = (await ceo.api.get(`/api/r/kpi_values?kpiId=${kpi.id}`)).body.rows;
    expect(Number(vals[0].value)).toBeGreaterThan(0);
    expect(Number((await hr.api.get(`/api/r/goals/${k.id}`)).body.currentValue)).toBeGreaterThan(0);
  });

  it('serves the HR dashboard only to HR reporting roles', async () => {
    expect((await hr.api.get('/api/dashboard/hr')).status).toBe(200);
    expect((await emp.api.get('/api/dashboard/hr')).status).toBe(403);
  });
});
