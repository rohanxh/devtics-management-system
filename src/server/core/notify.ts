import { and, eq, inArray } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { notifications, roles, userRoles, users } from '../db/schema/index.ts';
import { loadActor } from '../rbac/actor.ts';

export interface NotifyInput {
  userIds?: (string | null | undefined)[];
  roles?: string[];
  kind: string;
  title: string;
  body?: string;
  entityType?: string;
  entityId?: string;
  link?: string;
  /** Same (user, dedupeKey) is only ever notified once. */
  dedupeKey?: string;
  /** Usually the actor who caused the event — people are not notified about their own actions. */
  excludeUserId?: string | null;
}

export async function usersWithRoles(db: DB, roleKeys: string[]): Promise<string[]> {
  if (!roleKeys.length) return [];
  const rows = await db.selectDistinct({ id: users.id }).from(users)
    .innerJoin(userRoles, eq(userRoles.userId, users.id))
    .innerJoin(roles, eq(roles.id, userRoles.roleId))
    .where(and(inArray(roles.key, roleKeys), eq(users.status, 'active')));
  return rows.map((r) => r.id);
}

/**
 * Creates in-app notifications. Permission-aware: when an entity is referenced, recipients who
 * cannot see that record are skipped, so notifications never leak data.
 */
export async function notify(db: DB, n: NotifyInput): Promise<number> {
  const ids = new Set<string>(n.userIds?.filter((x): x is string => !!x) ?? []);
  for (const id of await usersWithRoles(db, n.roles ?? [])) ids.add(id);
  if (n.excludeUserId) ids.delete(n.excludeUserId);
  if (!ids.size) return 0;

  let recipients = [...ids];
  if (n.entityType && n.entityId) {
    const { isVisible } = await import('../resources/engine.ts');
    const { getResource } = await import('../resources/registry.ts');
    if (getResource(n.entityType)) {
      const visible: string[] = [];
      for (const uid of recipients) {
        const actor = await loadActor(db, uid);
        if (actor && (await isVisible(db, actor, n.entityType, n.entityId))) visible.push(uid);
      }
      recipients = visible;
    }
  }
  if (!recipients.length) return 0;
  const link = n.link ?? (n.entityType && n.entityId ? `/r/${n.entityType}/${n.entityId}` : undefined);
  const inserted = await db.insert(notifications).values(recipients.map((userId) => ({
    userId, kind: n.kind, title: n.title.slice(0, 300), body: n.body?.slice(0, 2000),
    entityType: n.entityType, entityId: n.entityId, link, dedupeKey: n.dedupeKey,
  }))).onConflictDoNothing().returning({ id: notifications.id });
  return inserted.length;
}
