import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { await t.close(); });

const bearer = (token: string, method: string, url: string, payload?: unknown) =>
  t.app.inject({ method: method as any, url, payload: payload as any, headers: { authorization: `Bearer ${token}` } });

describe('API tokens', () => {
  it('authenticate integrations with the owner\'s permissions and can be revoked', async () => {
    const { api } = await t.as(['pm']);
    const created = await api.post('/api/auth/tokens', { name: 'GitHub sync', expiresInDays: 30 });
    expect(created.status).toBe(201);
    const token = created.body.token as string;
    expect(token).toMatch(/^dms_/);
    expect((await api.get('/api/auth/tokens')).body[0]).not.toHaveProperty('token');

    expect((await bearer(token, 'GET', '/api/r/projects')).statusCode).toBe(200);
    expect((await bearer(token, 'GET', '/api/r/users')).statusCode).toBe(403); // PM cannot list users
    // Mutations work without the CSRF header (no cookies involved)
    expect((await bearer(token, 'POST', '/api/r/companies', { name: 'Via API Ltd' })).statusCode).toBe(201);
    // Tokens cannot mint tokens or touch sessions
    expect((await bearer(token, 'POST', '/api/auth/tokens', { name: 'x' })).statusCode).toBe(403);
    expect((await bearer(token, 'GET', '/api/auth/me')).statusCode).toBe(403);

    expect((await api.del(`/api/auth/tokens/${created.body.id}`)).status).toBe(200);
    expect((await bearer(token, 'GET', '/api/r/projects')).statusCode).toBe(401);
    expect((await bearer('dms_' + 'x'.repeat(40), 'GET', '/api/r/projects')).statusCode).toBe(401);
  });

  it('cannot revoke someone else\'s token', async () => {
    const a = await t.as(['pm']);
    const b = await t.as(['pm']);
    const tok = (await a.api.post('/api/auth/tokens', { name: 'A' })).body;
    expect((await b.api.del(`/api/auth/tokens/${tok.id}`)).status).toBe(404);
  });
});
