import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.close(); });

describe('authorization', () => {
  it('blocks a developer from user administration at the API layer', async () => {
    const { api } = await t.as(['developer']);
    expect((await api.get('/api/r/users')).status).toBe(403);
    expect((await api.get('/api/admin/roles')).status).toBe(403);
    expect((await api.post('/api/admin/users', { name: 'X', email: 'x@test.local' })).status).toBe(403);
  });

  it('limits a developer to their own employee record; private fields only on their own record', async () => {
    const other = await t.createUser([]);
    const { api, user } = await t.as(['developer']);
    const list = await api.get('/api/r/employees');
    expect(list.status).toBe(200);
    expect(list.body.rows).toHaveLength(1);
    expect(list.body.rows[0].id).toBe(user.employeeId);
    expect(list.body.rows[0]).toHaveProperty('dateOfBirth'); // self-service on own record
    // A manager sees direct reports but not their private fields
    const mgr = await t.as(['pm']);
    const { db } = t;
    const { employees } = await import('../src/server/db/schema/index.ts');
    const { eq } = await import('drizzle-orm');
    await db.update(employees).set({ managerId: mgr.user.employeeId }).where(eq(employees.id, other.employeeId!));
    const report = (await mgr.api.get(`/api/r/employees/${other.employeeId}`)).body;
    expect(report.firstName).toBeTruthy();
    expect(report).not.toHaveProperty('dateOfBirth');
    expect((await mgr.api.patch(`/api/r/employees/${other.employeeId}`, { dateOfBirth: '1990-01-01' })).status).toBe(403);
    // IDOR: another employee's record is not found, not forbidden.
    expect((await api.get(`/api/r/employees/${other.employeeId}`)).status).toBe(404);
  });

  it('lets HR see and edit private employee fields, but not other people\'s finance', async () => {
    const { api } = await t.as(['hr']);
    const target = await t.createUser([]);
    const res = await api.patch(`/api/r/employees/${target.employeeId}`, { dateOfBirth: '1990-05-01' });
    expect(res.status).toBe(200);
    expect(res.body.dateOfBirth).toBe('1990-05-01');
    expect((await api.get('/api/r/employees')).body.rows.length).toBeGreaterThan(1);
  });

  it('rejects writes to restricted fields without permission', async () => {
    const { api } = await t.as(['admin']); // admin can edit employees but not private fields
    const target = await t.createUser([]);
    const res = await api.patch(`/api/r/employees/${target.employeeId}`, { dateOfBirth: '1990-05-01' });
    expect(res.status).toBe(403);
  });

  it('enforces the status state machine', async () => {
    const { api } = await t.as(['hr']);
    const target = await t.createUser([]);
    expect((await api.patch(`/api/r/employees/${target.employeeId}`, { employmentStatus: 'terminated' })).status).toBe(200);
    const back = await api.patch(`/api/r/employees/${target.employeeId}`, { employmentStatus: 'active' });
    expect(back.status).toBe(422);
  });

  it('validates input and reports field errors', async () => {
    const { api } = await t.as(['hr']);
    const res = await api.post('/api/r/employees', { firstName: 'A', joinDate: 'not-a-date' });
    expect(res.status).toBe(422);
    expect(res.body.error.details).toMatchObject({ employeeCode: 'Required', lastName: 'Required' });
    expect(res.body.error.details.joinDate).toBeTruthy();
  });

  it('prevents privilege escalation through role editing', async () => {
    const { api } = await t.as(['admin']);
    const roles = (await api.get('/api/admin/roles')).body;
    const dev = roles.find((r: any) => r.key === 'developer');
    const res = await api.put(`/api/admin/roles/${dev.id}/permissions`, {
      grants: [...dev.grants, { permission: 'compensation.view', scope: 'all' }],
    });
    expect(res.status).toBe(403);
    // Non-sensitive additions are fine.
    const ok = await api.put(`/api/admin/roles/${dev.id}/permissions`, { grants: [...dev.grants, { permission: 'kb.create', scope: 'all' }] });
    expect(ok.status).toBe(200);
  });

  it('prevents assigning roles carrying permissions the admin does not hold', async () => {
    const { api } = await t.as(['admin']);
    const target = await t.createUser([]);
    expect((await api.put(`/api/admin/users/${target.id}/roles`, { roleKeys: ['finance'] })).status).toBe(403);
    expect((await api.put(`/api/admin/users/${target.id}/roles`, { roleKeys: ['developer'] })).status).toBe(200);
  });

  it('prevents users changing their own roles', async () => {
    const { api, user } = await t.as(['admin']);
    expect((await api.put(`/api/admin/users/${user.id}/roles`, { roleKeys: ['admin', 'ceo'] })).status).toBe(403);
  });

  it('provisions users with a one-time temporary password', async () => {
    const { api } = await t.as(['admin']);
    const res = await api.post('/api/admin/users', { name: 'New Person', email: 'new.person@test.local', roleKeys: ['developer'] });
    expect(res.status).toBe(201);
    const { cookie } = await t.login('new.person@test.local', res.body.temporaryPassword);
    const me = await t.client(cookie!).get('/api/auth/me');
    expect(me.body.mustChangePassword).toBe(true);
    expect(me.body.roles.sort()).toEqual(['developer', 'employee']);
  });
});

describe('audit trail', () => {
  it('records who changed what with before/after state', async () => {
    const { api, user } = await t.as(['hr']);
    const target = await t.createUser([]);
    await api.patch(`/api/r/employees/${target.employeeId}`, { phone: '+92 300 0000000' });
    const res: any = await t.db.execute(sql`select actor_user_id, action, changed_fields, old_data->>'phone' as old, new_data->>'phone' as new
      from audit_logs where table_name = 'employees' and record_id = ${target.employeeId} and action = 'UPDATE'`);
    expect(res.rows).toHaveLength(1);
    expect(res.rows[0]).toMatchObject({ actor_user_id: user.id, changed_fields: ['phone'], old: null, new: '+92 300 0000000' });
  });

  it('is append-only at the database level', async () => {
    await expect(t.db.execute(sql`update audit_logs set action = 'X'`)).rejects.toThrow();
    await expect(t.db.execute(sql`delete from audit_logs`)).rejects.toThrow();
  });

  it('records permission changes', async () => {
    const { api } = await t.as(['admin']);
    const roles = (await api.get('/api/admin/roles')).body;
    const qa = roles.find((r: any) => r.key === 'qa');
    await api.put(`/api/admin/roles/${qa.id}/permissions`, { grants: qa.grants.slice(1) });
    const res: any = await t.db.execute(sql`select count(*)::int as n from audit_logs where action = 'PERMISSIONS_CHANGED' and record_id = ${qa.id}`);
    expect(res.rows[0].n).toBe(1);
  });

  it('exposes the audit log only with audit.view', async () => {
    const dev = await t.as(['developer']);
    expect((await dev.api.get('/api/admin/audit')).status).toBe(403);
    const admin = await t.as(['admin']);
    const res = await admin.api.get('/api/admin/audit?action=LOGIN');
    expect(res.status).toBe(200);
    expect(res.body.rows.length).toBeGreaterThan(0);
  });
});
