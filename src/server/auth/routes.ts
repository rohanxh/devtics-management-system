import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { users } from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { withActor } from '../core/context.ts';
import { auditEvent } from '../core/audit.ts';
import { AppError, invalid } from '../core/errors.ts';
import { getDummyHash, hashPassword, passwordProblems, verifyPassword } from './password.ts';
import { createSession, revokeAllSessions, revokeSession, SESSION_COOKIE } from './sessions.ts';

const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export function actorPayload(a: ReturnType<typeof ctxOf>['actor']) {
  return {
    id: a.userId, name: a.name, email: a.email, roles: a.roles, homeDashboard: a.homeDashboard,
    employeeId: a.employeeId, mustChangePassword: a.mustChangePassword,
    permissions: Object.fromEntries(a.perms),
  };
}

export async function authRoutes(app: FastifyInstance) {
  const { db, config } = app.deps;
  const cookieOpts = {
    httpOnly: true, sameSite: 'lax' as const, secure: config.NODE_ENV === 'production', path: '/',
    maxAge: config.SESSION_MAX_DAYS * 86400,
  };
  const invalidLogin = () => new AppError(401, 'invalid_credentials', 'Invalid email or password');

  app.post('/api/auth/login', {
    config: { rateLimit: { max: config.AUTH_RATE_PER_MIN, timeWindow: '1 minute' } },
  }, async (req, reply) => {
    const body = z.object({ email: z.string().trim().max(254), password: z.string().max(256) }).safeParse(req.body);
    if (!body.success) throw invalidLogin();
    const { email, password } = body.data;
    const [user] = await db.select().from(users).where(sql`lower(${users.email}) = ${email.toLowerCase()}`);

    if (!user) {
      await verifyPassword(password, await getDummyHash()); // constant-ish timing
      await auditEvent(db, { action: 'LOGIN_FAILED', newData: { email: email.toLowerCase(), reason: 'unknown_user' }, ip: req.ip, requestId: req.id });
      throw invalidLogin();
    }
    const locked = user.lockedUntil && user.lockedUntil > new Date();
    const ok = !locked && user.status === 'active' && (await verifyPassword(password, user.passwordHash));
    if (!ok) {
      await withActor(db, null, req.id, async (tx) => {
        if (!locked) {
          const failed = user.failedLoginCount + 1;
          await tx.update(users).set(failed >= MAX_FAILED
            ? { failedLoginCount: 0, lockedUntil: new Date(Date.now() + LOCK_MINUTES * 60_000) }
            : { failedLoginCount: failed }).where(eq(users.id, user.id));
        }
        await auditEvent(tx, {
          action: 'LOGIN_FAILED', tableName: 'users', recordId: user.id, ip: req.ip, requestId: req.id,
          newData: { reason: locked ? 'locked' : user.status !== 'active' ? 'disabled' : 'bad_password' },
        });
      });
      throw invalidLogin();
    }

    const { token } = await withActor(db, user.id, req.id, async (tx) => {
      await tx.update(users).set({ failedLoginCount: 0, lockedUntil: null, lastLoginAt: new Date() }).where(eq(users.id, user.id));
      await auditEvent(tx, { action: 'LOGIN', actorUserId: user.id, tableName: 'users', recordId: user.id, ip: req.ip, requestId: req.id });
      return createSession(tx, user.id, { idleHours: config.SESSION_IDLE_HOURS, maxDays: config.SESSION_MAX_DAYS }, { ip: req.ip, userAgent: req.headers['user-agent'] });
    });
    reply.setCookie(SESSION_COOKIE, token, cookieOpts);
    return { ok: true, mustChangePassword: user.mustChangePassword };
  });

  app.post('/api/auth/logout', async (req, reply) => {
    const ctx = ctxOf(req);
    await revokeSession(db, req.session!.id);
    await auditEvent(db, { action: 'LOGOUT', actorUserId: ctx.actor.userId, tableName: 'users', recordId: ctx.actor.userId, ip: req.ip, requestId: req.id });
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/auth/me', async (req) => actorPayload(ctxOf(req).actor));

  app.post('/api/auth/change-password', {
    config: { rateLimit: { max: config.AUTH_RATE_PER_MIN, timeWindow: '1 minute' } },
  }, async (req) => {
    const ctx = ctxOf(req);
    const body = z.object({ currentPassword: z.string().max(256), newPassword: z.string().max(256) }).parse(req.body);
    const [user] = await db.select().from(users).where(eq(users.id, ctx.actor.userId));
    if (!(await verifyPassword(body.currentPassword, user.passwordHash))) {
      throw invalid('Validation failed', { currentPassword: 'Current password is incorrect' });
    }
    const problem = passwordProblems(body.newPassword, user.email);
    if (problem) throw invalid('Validation failed', { newPassword: problem });
    if (body.newPassword === body.currentPassword) throw invalid('Validation failed', { newPassword: 'Choose a different password' });
    const hash = await hashPassword(body.newPassword);
    await withActor(db, user.id, req.id, async (tx) => {
      await tx.update(users).set({ passwordHash: hash, mustChangePassword: false }).where(eq(users.id, user.id));
      await revokeAllSessions(tx, user.id, req.session!.id);
      await auditEvent(tx, { action: 'PASSWORD_CHANGED', actorUserId: user.id, tableName: 'users', recordId: user.id, ip: req.ip, requestId: req.id });
    });
    return { ok: true };
  });
}
