import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { setup, PASSWORD, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.close(); });

describe('authentication', () => {
  it('rejects unauthenticated API access', async () => {
    const res = await t.app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(res.statusCode).toBe(401);
  });

  it('logs in with valid credentials and sets a hardened session cookie', async () => {
    const u = await t.createUser(['developer']);
    const { res, cookie } = await t.login(u.email);
    expect(res.statusCode).toBe(200);
    expect(cookie).toBeTruthy();
    const set = String(res.headers['set-cookie']);
    expect(set).toMatch(/HttpOnly/i);
    expect(set).toMatch(/SameSite=Lax/i);
    const me = await t.client(cookie!).get('/api/auth/me');
    expect(me.body.email).toBe(u.email);
    expect(me.body.roles).toContain('developer');
  });

  it('returns the same generic error for unknown email and wrong password', async () => {
    const u = await t.createUser([]);
    const a = await t.login('nobody@test.local');
    const b = await t.login(u.email, 'wrong-password-123');
    expect(a.res.statusCode).toBe(401);
    expect(b.res.statusCode).toBe(401);
    expect(a.res.json().error.message).toBe(b.res.json().error.message);
  });

  it('locks the account after repeated failures', async () => {
    const u = await t.createUser([]);
    for (let i = 0; i < 5; i++) await t.login(u.email, 'wrong-password-123');
    const { res } = await t.login(u.email);
    expect(res.statusCode).toBe(401);
  });

  it('requires the CSRF header on mutating requests', async () => {
    const u = await t.createUser([]);
    const res = await t.app.inject({ method: 'POST', url: '/api/auth/login', payload: { email: u.email, password: PASSWORD } });
    expect(res.statusCode).toBe(403);
    const cross = await t.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'dms', origin: 'https://evil.example' }, payload: { email: u.email, password: PASSWORD } });
    expect(cross.statusCode).toBe(403);
  });

  it('invalidates the session on logout', async () => {
    const u = await t.createUser([]);
    const { cookie } = await t.login(u.email);
    const api = t.client(cookie!);
    expect((await api.post('/api/auth/logout')).status).toBe(200);
    expect((await api.get('/api/auth/me')).status).toBe(401);
  });

  it('forces a password change before other access when required', async () => {
    const u = await t.createUser([], { mustChangePassword: true });
    const { cookie } = await t.login(u.email);
    const api = t.client(cookie!);
    expect((await api.get('/api/meta')).status).toBe(403);
    const weak = await api.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'short' });
    expect(weak.status).toBe(422);
    const ok = await api.post('/api/auth/change-password', { currentPassword: PASSWORD, newPassword: 'a-much-longer-new-passphrase' });
    expect(ok.status).toBe(200);
    expect((await api.get('/api/meta')).status).toBe(200);
  });

  it('records login and failed login in the audit log', async () => {
    const u = await t.createUser([]);
    await t.login(u.email, 'wrong-password-123');
    await t.login(u.email);
    const rows: any = await t.db.execute(sql`select action from audit_logs where record_id = ${u.id} and action like 'LOGIN%' order by id`);
    expect(rows.rows.map((r: any) => r.action)).toEqual(['LOGIN_FAILED', 'LOGIN']);
  });
});
