import { eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { users, userRoles, roles, rolePermissions, employees } from '../db/schema/index.ts';
import { SCOPE_RANK, type Scope } from './catalog.ts';
import { forbidden } from '../core/errors.ts';

export interface Actor {
  userId: string;
  name: string;
  email: string;
  roles: string[];
  homeDashboard: string;
  perms: Map<string, Scope>;
  employeeId: string | null;
  mustChangePassword: boolean;
}

/** Order decides which dashboard a multi-role user lands on. */
const DASHBOARD_PRIORITY = ['ceo', 'cto', 'finance', 'hr', 'pm', 'bd', 'qa', 'marketing', 'support', 'it', 'admin', 'developer', 'employee'];

export async function loadActor(db: DB, userId: string): Promise<Actor | null> {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user || user.status !== 'active') return null;
  const roleRows = await db
    .select({ id: roles.id, key: roles.key, home: roles.homeDashboard })
    .from(userRoles).innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(eq(userRoles.userId, userId));
  const perms = new Map<string, Scope>();
  if (roleRows.length) {
    const grants = await db.select().from(rolePermissions).where(inArray(rolePermissions.roleId, roleRows.map((r) => r.id)));
    for (const g of grants) {
      const prev = perms.get(g.permission);
      if (!prev || SCOPE_RANK[g.scope] > SCOPE_RANK[prev]) perms.set(g.permission, g.scope);
    }
  }
  const [emp] = await db.select({ id: employees.id }).from(employees).where(eq(employees.userId, userId));
  const homes = roleRows.map((r) => r.home);
  const homeDashboard = DASHBOARD_PRIORITY.find((d) => homes.includes(d)) ?? 'employee';
  return {
    userId: user.id, name: user.name, email: user.email, roles: roleRows.map((r) => r.key), homeDashboard,
    perms, employeeId: emp?.id ?? null, mustChangePassword: user.mustChangePassword,
  };
}

export const can = (actor: Actor | null | undefined, perm: string) => !!actor?.perms.has(perm);
export const scopeOf = (actor: Actor, perm: string): Scope | null => actor.perms.get(perm) ?? null;

export function assertCan(actor: Actor, perm: string, message?: string): Scope {
  const s = actor.perms.get(perm);
  if (!s) throw forbidden(message);
  return s;
}
