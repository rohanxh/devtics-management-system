import { and, desc, eq, gt, isNull, sql } from 'drizzle-orm';
import { auditLogs, domainEvents, users } from '../db/schema/index.ts';
import { registerDashboard } from './reports.ts';

/** System administration: accounts, security events and automation health. */
registerDashboard({
  key: 'admin', perm: 'users.view',
  async build(ctx) {
    const [acc] = await ctx.db.select({
      total: sql<number>`count(*)::int`,
      active: sql<number>`count(*) filter (where ${users.status} = 'active')::int`,
      disabled: sql<number>`count(*) filter (where ${users.status} = 'disabled')::int`,
      locked: sql<number>`count(*) filter (where ${users.lockedUntil} > now())::int`,
      pendingPassword: sql<number>`count(*) filter (where ${users.mustChangePassword})::int`,
      neverLoggedIn: sql<number>`count(*) filter (where ${users.lastLoginAt} is null and ${users.status} = 'active')::int`,
    }).from(users);
    const canAudit = ctx.actor.perms.has('audit.view');
    const security = canAudit ? await ctx.db.select({
      id: auditLogs.id, action: auditLogs.action, occurredAt: auditLogs.occurredAt, ip: auditLogs.ip, actorName: users.name, newData: auditLogs.newData,
    }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId))
      .where(sql`${auditLogs.action} in ('LOGIN_FAILED', 'PERMISSIONS_CHANGED', 'ROLES_CHANGED', 'PASSWORD_RESET', 'USER_CREATED')`)
      .orderBy(desc(auditLogs.id)).limit(15) : [];
    const [failed24h] = canAudit ? await ctx.db.select({ n: sql<number>`count(*)::int` }).from(auditLogs)
      .where(and(eq(auditLogs.action, 'LOGIN_FAILED'), gt(auditLogs.occurredAt, new Date(Date.now() - 86400_000)))) : [{ n: 0 }];
    const failingEvents = await ctx.db.select({ id: domainEvents.id, type: domainEvents.type, attempts: domainEvents.attempts, lastError: domainEvents.lastError, createdAt: domainEvents.createdAt })
      .from(domainEvents).where(and(isNull(domainEvents.processedAt), gt(domainEvents.attempts, 0))).orderBy(desc(domainEvents.id)).limit(10);
    const [{ backlog }] = await ctx.db.select({ backlog: sql<number>`count(*)::int` }).from(domainEvents).where(isNull(domainEvents.processedAt));
    return { accounts: acc, security, failedLogins24h: failed24h.n, failingEvents, eventBacklog: backlog };
  },
});
