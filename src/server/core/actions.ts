import { eq } from 'drizzle-orm';
import { registerAction } from './events.ts';
import { notify } from './notify.ts';
import { getResource, col } from '../resources/registry.ts';

/** Replaces {placeholders} with event payload values. */
export const fill = (tpl: string, payload: Record<string, unknown>) =>
  tpl.replace(/\{(\w+)\}/g, (_, k) => String(payload[k] ?? ''));

async function loadEntity(db: Parameters<Parameters<typeof registerAction>[1]['run']>[0]['db'], entityType?: string | null, entityId?: string | null) {
  const def = entityType ? getResource(entityType) : undefined;
  if (!def || !entityId) return null;
  const [row] = await db.select().from(def.table).where(eq(col(def, 'id'), entityId));
  return row as Record<string, any> | undefined ?? null;
}

registerAction('notify_roles', {
  description: 'Notify every user holding one of the given roles (params: roles[], title, body?). Recipients who cannot see the record are skipped.',
  async run({ db, event, params, rule }) {
    await notify(db, {
      roles: params.roles ?? [], kind: params.kind ?? 'status', title: fill(params.title ?? '{title}', event.payload),
      body: params.body ? fill(params.body, event.payload) : undefined,
      entityType: event.entityType ?? undefined, entityId: event.entityId ?? undefined,
      excludeUserId: event.actorUserId, dedupeKey: `${rule.key}:${event.id}`,
    });
  },
});

registerAction('notify_assignee', {
  description: 'Notify the newly assigned user (for *.assigned events).',
  async run({ db, event, params, rule }) {
    await notify(db, {
      userIds: [event.payload.userId], kind: 'assignment', title: fill(params.title ?? 'Assigned to you: {title}', event.payload),
      entityType: event.entityType ?? undefined, entityId: event.entityId ?? undefined,
      excludeUserId: event.actorUserId, dedupeKey: `${rule.key}:${event.id}`,
    });
  },
});

registerAction('notify_record_users', {
  description: 'Notify the users referenced by fields of the record (params: fields[], title).',
  async run({ db, event, params, rule }) {
    const row = await loadEntity(db, event.entityType, event.entityId);
    if (!row) return;
    await notify(db, {
      userIds: (params.fields ?? []).map((f: string) => row[f]), kind: params.kind ?? 'status',
      title: fill(params.title ?? '{title}', { ...row, ...event.payload }),
      entityType: event.entityType ?? undefined, entityId: event.entityId ?? undefined,
      excludeUserId: event.actorUserId, dedupeKey: `${rule.key}:${event.id}`,
    });
  },
});
