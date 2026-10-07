import type { FastifyInstance } from 'fastify';
import { and, count, desc, eq, gte, inArray, lte, sql } from 'drizzle-orm';
import { z } from 'zod';
import {
  auditLogs, automationRules, employees, rolePermissions, roles, settings, userRoles, users,
} from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx } from '../core/context.ts';
import { auditEvent } from '../core/audit.ts';
import { badRequest, conflict, forbidden, invalid, notFound } from '../core/errors.ts';
import { listActions } from '../core/events.ts';
import { assertCan, type Actor } from '../rbac/actor.ts';
import { ALL_PERMISSIONS, PERMISSION_GROUPS, SCOPE_RANK, SENSITIVE_PREFIXES, isPermission, type Scope } from '../rbac/catalog.ts';
import { hashPassword, randomToken } from '../auth/password.ts';
import { revokeAllSessions } from '../auth/sessions.ts';
import { isUuid } from '../resources/validate.ts';
import { DEFAULT_SETTINGS, SETTINGS_SCHEMA } from './settings.ts';

const isSensitive = (p: string) => SENSITIVE_PREFIXES.some((s) => p.startsWith(s));

/** Privilege-escalation guard: sensitive permissions can only be granted by someone holding them at ≥ that scope. */
function assertCanGrant(actor: Actor, grants: { permission: string; scope: Scope }[]) {
  for (const g of grants) {
    if (!isSensitive(g.permission)) continue;
    const mine = actor.perms.get(g.permission);
    if (!mine || SCOPE_RANK[mine] < SCOPE_RANK[g.scope]) {
      throw forbidden(`You cannot grant "${g.permission}" because you do not hold it yourself`);
    }
  }
}

async function roleGrants(db: ReturnType<typeof ctxOf>['db'], roleIds: string[]) {
  if (!roleIds.length) return [];
  return db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleIds));
}

const tempPassword = () => randomToken().slice(0, 20);

export async function adminRoutes(app: FastifyInstance) {
  // ── Permission catalog ──
  app.get('/api/admin/permissions', async (req) => {
    assertCan(ctxOf(req).actor, 'roles.view');
    return Object.entries(PERMISSION_GROUPS).map(([key, g]) => ({ key, label: g.label, actions: g.actions }));
  });

  // ── Roles ──
  app.get('/api/admin/roles', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'roles.view');
    const list = await ctx.db.select({
      id: roles.id, key: roles.key, name: roles.name, description: roles.description, isSystem: roles.isSystem,
      homeDashboard: roles.homeDashboard, userCount: sql<number>`(select count(*)::int from user_roles ur where ur.role_id = roles.id)`,
    }).from(roles).orderBy(roles.name);
    const grants = await roleGrants(ctx.db, list.map((r) => r.id));
    return list.map((r) => ({ ...r, grants: grants.filter((g) => g.roleId === r.id).map((g) => ({ permission: g.permission, scope: g.scope })) }));
  });

  app.post('/api/admin/roles', async (req, reply) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'roles.manage');
    const body = z.object({
      key: z.string().regex(/^[a-z][a-z0-9_]{1,30}$/, 'Lowercase letters, digits and underscores'),
      name: z.string().trim().min(2).max(80),
      description: z.string().max(500).optional(),
      homeDashboard: z.enum(['employee', 'ceo', 'cto', 'pm', 'developer', 'qa', 'finance', 'bd', 'marketing', 'hr', 'admin', 'it', 'support']).default('employee'),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', z.flattenError(body.error).fieldErrors);
    const [exists] = await ctx.db.select({ id: roles.id }).from(roles).where(eq(roles.key, body.data.key));
    if (exists) throw conflict('A role with this key already exists');
    const [role] = await tx(ctx, (t) => t.insert(roles).values(body.data).returning());
    return reply.status(201).send(role);
  });

  app.put<{ Params: { id: string } }>('/api/admin/roles/:id/permissions', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'roles.manage');
    if (!isUuid(req.params.id)) throw notFound('Role');
    const body = z.object({
      grants: z.array(z.object({ permission: z.string(), scope: z.enum(['own', 'team', 'all']) })).max(ALL_PERMISSIONS.length),
    }).parse(req.body);
    const unknown = body.grants.filter((g) => !isPermission(g.permission));
    if (unknown.length) throw badRequest(`Unknown permissions: ${unknown.map((u) => u.permission).join(', ')}`);
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, req.params.id));
    if (!role) throw notFound('Role');
    if (ctx.actor.roles.includes(role.key)) throw forbidden('You cannot change the permissions of a role you hold');

    const before = await roleGrants(ctx.db, [role.id]);
    const beforeMap = new Map(before.map((g) => [g.permission, g.scope]));
    // Only additions/upgrades need the escalation check; removing access is always allowed.
    const added = body.grants.filter((g) => !beforeMap.has(g.permission) || SCOPE_RANK[g.scope] > SCOPE_RANK[beforeMap.get(g.permission)!]);
    assertCanGrant(ctx.actor, added);
    const removedSensitive = before.filter((g) => isSensitive(g.permission) && !body.grants.some((n) => n.permission === g.permission));
    assertCanGrant(ctx.actor, removedSensitive.map((g) => ({ permission: g.permission, scope: 'own' as Scope })));

    await tx(ctx, async (t) => {
      await t.delete(rolePermissions).where(eq(rolePermissions.roleId, role.id));
      if (body.grants.length) await t.insert(rolePermissions).values(body.grants.map((g) => ({ roleId: role.id, ...g })));
      await auditEvent(t, {
        action: 'PERMISSIONS_CHANGED', actorUserId: ctx.actor.userId, tableName: 'roles', recordId: role.id,
        oldData: before.map((g) => `${g.permission}@${g.scope}`), newData: body.grants.map((g) => `${g.permission}@${g.scope}`),
        ip: ctx.ip, requestId: ctx.requestId,
      });
    });
    return { ok: true };
  });

  app.delete<{ Params: { id: string } }>('/api/admin/roles/:id', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'roles.manage');
    if (!isUuid(req.params.id)) throw notFound('Role');
    const [role] = await ctx.db.select().from(roles).where(eq(roles.id, req.params.id));
    if (!role) throw notFound('Role');
    if (role.isSystem) throw conflict('System roles cannot be deleted');
    const [{ n }] = await ctx.db.select({ n: count() }).from(userRoles).where(eq(userRoles.roleId, role.id));
    if (Number(n) > 0) throw conflict('Remove this role from all users first');
    await tx(ctx, (t) => t.delete(roles).where(eq(roles.id, role.id)));
    return { ok: true };
  });

  // ── Users ──
  app.get<{ Params: { id: string } }>('/api/admin/users/:id/roles', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'users.view');
    if (!isUuid(req.params.id)) throw notFound('User');
    const rows = await ctx.db.select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, req.params.id));
    return rows.map((r) => r.key);
  });

  async function setUserRoles(t: typeof app.deps.db, actor: Actor, userId: string, roleKeys: string[]) {
    const keys = [...new Set(['employee', ...roleKeys])];
    const found = await t.select().from(roles).where(inArray(roles.key, keys));
    if (found.length !== keys.length) throw badRequest('Unknown role');
    const grants = await roleGrants(t, found.map((r) => r.id));
    assertCanGrant(actor, grants.map((g) => ({ permission: g.permission, scope: g.scope })));
    await t.delete(userRoles).where(eq(userRoles.userId, userId));
    await t.insert(userRoles).values(found.map((r) => ({ userId, roleId: r.id })));
    return keys;
  }

  app.post('/api/admin/users', async (req, reply) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'users.create');
    const body = z.object({
      name: z.string().trim().min(2).max(120),
      email: z.string().trim().toLowerCase().pipe(z.email()),
      roleKeys: z.array(z.string()).max(20).default([]),
      employeeId: z.uuid().optional(),
    }).safeParse(req.body);
    if (!body.success) throw invalid('Validation failed', z.flattenError(body.error).fieldErrors);
    const [dupe] = await ctx.db.select({ id: users.id }).from(users).where(sql`lower(${users.email}) = ${body.data.email}`);
    if (dupe) throw invalid('Validation failed', { email: 'A user with this email already exists' });
    const password = tempPassword();
    const hash = await hashPassword(password);
    const user = await tx(ctx, async (t) => {
      const [u] = await t.insert(users).values({ name: body.data.name, email: body.data.email, passwordHash: hash, mustChangePassword: true }).returning();
      const keys = await setUserRoles(t, ctx.actor, u.id, body.data.roleKeys);
      if (body.data.employeeId) {
        const [emp] = await t.select().from(employees).where(eq(employees.id, body.data.employeeId));
        if (!emp) throw invalid('Validation failed', { employeeId: 'Employee not found' });
        if (emp.userId) throw invalid('Validation failed', { employeeId: 'Employee already has a login' });
        await t.update(employees).set({ userId: u.id }).where(eq(employees.id, emp.id));
      }
      await auditEvent(t, { action: 'USER_CREATED', actorUserId: ctx.actor.userId, tableName: 'users', recordId: u.id, newData: { roles: keys }, ip: ctx.ip, requestId: ctx.requestId });
      return u;
    });
    // The temporary password is shown once to the admin and never stored in plain text.
    return reply.status(201).send({ id: user.id, temporaryPassword: password });
  });

  app.put<{ Params: { id: string } }>('/api/admin/users/:id/roles', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'roles.manage');
    if (!isUuid(req.params.id)) throw notFound('User');
    if (req.params.id === ctx.actor.userId) throw forbidden('You cannot change your own roles');
    const body = z.object({ roleKeys: z.array(z.string()).max(20) }).parse(req.body);
    const [u] = await ctx.db.select().from(users).where(eq(users.id, req.params.id));
    if (!u) throw notFound('User');
    const before = await ctx.db.select({ key: roles.key }).from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId)).where(eq(userRoles.userId, u.id));
    // Removing roles that carry sensitive permissions also requires holding them.
    const removed = before.map((r) => r.key).filter((k) => !body.roleKeys.includes(k) && k !== 'employee');
    if (removed.length) {
      const rr = await ctx.db.select().from(roles).where(inArray(roles.key, removed));
      const g = await roleGrants(ctx.db, rr.map((r) => r.id));
      assertCanGrant(ctx.actor, g.map((x) => ({ permission: x.permission, scope: x.scope })));
    }
    const keys = await tx(ctx, async (t) => {
      const k = await setUserRoles(t, ctx.actor, u.id, body.roleKeys);
      await auditEvent(t, { action: 'ROLES_CHANGED', actorUserId: ctx.actor.userId, tableName: 'users', recordId: u.id, oldData: before.map((r) => r.key), newData: k, ip: ctx.ip, requestId: ctx.requestId });
      return k;
    });
    return { roleKeys: keys };
  });

  app.post<{ Params: { id: string } }>('/api/admin/users/:id/reset-password', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'users.edit');
    if (!isUuid(req.params.id)) throw notFound('User');
    const [u] = await ctx.db.select().from(users).where(eq(users.id, req.params.id));
    if (!u) throw notFound('User');
    const password = tempPassword();
    const hash = await hashPassword(password);
    await tx(ctx, async (t) => {
      await t.update(users).set({ passwordHash: hash, mustChangePassword: true, failedLoginCount: 0, lockedUntil: null }).where(eq(users.id, u.id));
      await revokeAllSessions(t, u.id);
      await auditEvent(t, { action: 'PASSWORD_RESET', actorUserId: ctx.actor.userId, tableName: 'users', recordId: u.id, ip: ctx.ip, requestId: ctx.requestId });
    });
    return { temporaryPassword: password };
  });

  // ── Audit log ──
  app.get<{ Querystring: Record<string, string | undefined> }>('/api/admin/audit', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'audit.view');
    const q = req.query;
    const pageSize = Math.min(Number(q.pageSize) || 50, 200);
    const page = Math.max(Number(q.page) || 1, 1);
    const where = and(
      q.table ? eq(auditLogs.tableName, q.table) : undefined,
      q.action ? eq(auditLogs.action, q.action) : undefined,
      q.actor && isUuid(q.actor) ? eq(auditLogs.actorUserId, q.actor) : undefined,
      q.record ? eq(auditLogs.recordId, q.record) : undefined,
      q.from && /^\d{4}-\d{2}-\d{2}$/.test(q.from) ? gte(auditLogs.occurredAt, new Date(q.from)) : undefined,
      q.to && /^\d{4}-\d{2}-\d{2}$/.test(q.to) ? lte(auditLogs.occurredAt, new Date(q.to + 'T23:59:59Z')) : undefined,
    );
    const [rows, [{ total }]] = await Promise.all([
      ctx.db.select({
        id: auditLogs.id, occurredAt: auditLogs.occurredAt, action: auditLogs.action, tableName: auditLogs.tableName,
        recordId: auditLogs.recordId, changedFields: auditLogs.changedFields, oldData: auditLogs.oldData, newData: auditLogs.newData,
        actorUserId: auditLogs.actorUserId, actorName: users.name, ip: auditLogs.ip, requestId: auditLogs.requestId,
      }).from(auditLogs).leftJoin(users, eq(users.id, auditLogs.actorUserId)).where(where)
        .orderBy(desc(auditLogs.id)).limit(pageSize).offset((page - 1) * pageSize),
      ctx.db.select({ total: count() }).from(auditLogs).where(where),
    ]);
    return { rows, total: Number(total), page, pageSize };
  });

  // ── Automation rules ──
  app.get('/api/admin/automation', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'automation.view');
    const rules = await ctx.db.select().from(automationRules).orderBy(automationRules.eventType, automationRules.name);
    return { rules, actions: listActions() };
  });

  app.patch<{ Params: { id: string } }>('/api/admin/automation/:id', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'automation.manage');
    if (!isUuid(req.params.id)) throw notFound('Rule');
    const body = z.object({
      enabled: z.boolean().optional(),
      conditions: z.record(z.string(), z.unknown()).optional(),
      actions: z.array(z.object({ action: z.string(), params: z.record(z.string(), z.unknown()).optional() })).min(1).max(20).optional(),
    }).parse(req.body);
    const known = new Set(listActions().map((a) => a.name));
    const bad = body.actions?.find((a) => !known.has(a.action));
    if (bad) throw badRequest(`Unknown action "${bad.action}"`);
    const [rule] = await tx(ctx, (t) => t.update(automationRules).set(body).where(eq(automationRules.id, req.params.id)).returning());
    if (!rule) throw notFound('Rule');
    return rule;
  });

  // ── Settings ──
  app.get('/api/admin/settings', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'settings.manage');
    const rows = await ctx.db.select().from(settings);
    return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) };
  });

  app.put('/api/admin/settings', async (req) => {
    const ctx = ctxOf(req);
    assertCan(ctx.actor, 'settings.manage');
    const parsed = SETTINGS_SCHEMA.partial().safeParse(req.body);
    if (!parsed.success) throw invalid('Validation failed', z.flattenError(parsed.error).fieldErrors);
    await tx(ctx, async (t) => {
      for (const [key, value] of Object.entries(parsed.data)) {
        await t.insert(settings).values({ key, value }).onConflictDoUpdate({ target: settings.key, set: { value, updatedAt: new Date() } });
      }
    });
    return { ok: true };
  });
}
