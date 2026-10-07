import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { eq, inArray } from 'drizzle-orm';
import { loadConfig } from '../src/server/config.ts';
import { bootstrap } from '../src/server/bootstrap.ts';
import { hashPassword } from '../src/server/auth/password.ts';
import { employees, roles, userRoles, users } from '../src/server/db/schema/index.ts';

export const PASSWORD = 'correct-horse-battery-staple';

export async function setup() {
  const config = loadConfig({
    NODE_ENV: 'test', APP_ORIGIN: 'http://localhost:5173', AUTH_RATE_PER_MIN: '10000',
    STORAGE_DIR: path.join(os.tmpdir(), 'dms-test-' + randomUUID()),
  });
  const env = await bootstrap(config, { inMemory: true });
  const { db } = env.database;
  const hash = await hashPassword(PASSWORD);
  let n = 0;

  async function createUser(roleKeys: string[], opts: { name?: string; employee?: boolean; mustChangePassword?: boolean } = {}) {
    const i = ++n;
    const email = `user${i}-${roleKeys.join('-') || 'base'}@test.local`;
    const [u] = await db.insert(users).values({ email, name: opts.name ?? `User ${i}`, passwordHash: hash, mustChangePassword: !!opts.mustChangePassword }).returning();
    const rs = await db.select().from(roles).where(inArray(roles.key, ['employee', ...roleKeys]));
    await db.insert(userRoles).values(rs.map((r) => ({ userId: u.id, roleId: r.id })));
    let employeeId: string | undefined;
    if (opts.employee !== false) {
      const [e] = await db.insert(employees).values({ userId: u.id, employeeCode: `E${i}`, firstName: 'Test', lastName: `User${i}`, joinDate: '2024-01-01' }).returning();
      employeeId = e.id;
    }
    return { id: u.id, email, employeeId };
  }

  async function login(email: string, password = PASSWORD) {
    const res = await env.app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'x-requested-with': 'dms' }, payload: { email, password } });
    const cookie = res.cookies.find((c) => c.name === 'dms_session');
    return { res, cookie: cookie ? `dms_session=${cookie.value}` : undefined };
  }

  /** Creates a user with roles and returns an authenticated API client. */
  async function as(roleKeys: string[], opts: Parameters<typeof createUser>[1] = {}) {
    const user = await createUser(roleKeys, opts);
    const { cookie } = await login(user.email);
    return { user, api: client(cookie!) };
  }

  function client(cookie: string) {
    const call = async (method: string, url: string, payload?: unknown) => {
      const res = await env.app.inject({ method: method as any, url, payload: payload as any, headers: { cookie, 'x-requested-with': 'dms' } });
      let body: any;
      try { body = res.json(); } catch { body = res.body; }
      return { status: res.statusCode, body, res };
    };
    return {
      get: (url: string) => call('GET', url),
      post: (url: string, body?: unknown) => call('POST', url, body ?? {}),
      patch: (url: string, body: unknown) => call('PATCH', url, body),
      put: (url: string, body: unknown) => call('PUT', url, body),
      del: (url: string) => call('DELETE', url),
    };
  }

  return { ...env, db, createUser, login, as, client, close: () => env.database.close() };
}

export type TestEnv = Awaited<ReturnType<typeof setup>>;
export { eq };
