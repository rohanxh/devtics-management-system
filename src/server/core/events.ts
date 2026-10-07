import { and, asc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { automationRules, domainEvents } from '../db/schema/index.ts';
import { withActor } from './context.ts';

export interface DomainEvent {
  type: string;
  entityType?: string;
  entityId?: string;
  payload?: Record<string, unknown>;
  actorUserId?: string | null;
}

export type EventRow = typeof domainEvents.$inferSelect & { payload: Record<string, any> };

/** Writes an event to the outbox. Call inside the same transaction as the change it describes. */
export async function emit(db: DB, e: DomainEvent) {
  await db.insert(domainEvents).values({
    type: e.type,
    entityType: e.entityType,
    entityId: e.entityId,
    payload: e.payload ?? {},
    actorUserId: e.actorUserId ?? null,
  });
}

export interface ActionArgs {
  db: DB;
  event: EventRow;
  params: Record<string, any>;
  rule: { key: string; name: string };
}
export interface ActionDef {
  description: string;
  run: (args: ActionArgs) => Promise<void>;
}

const actions = new Map<string, ActionDef>();
export function registerAction(name: string, def: ActionDef) {
  actions.set(name, def);
}
export const listActions = () => [...actions.entries()].map(([name, d]) => ({ name, description: d.description }));

/** Event payload condition match: every key must equal (or be one of) the expected value(s). */
export function matches(conditions: Record<string, unknown>, payload: Record<string, unknown>) {
  return Object.entries(conditions ?? {}).every(([k, expected]) =>
    Array.isArray(expected) ? expected.includes(payload[k]) : payload[k] === expected,
  );
}

const MAX_ATTEMPTS = 5;

/**
 * Processes outbox events against enabled automation rules. All actions for one event run in a
 * single transaction (audited as actor = system, request = rule key), so a failure retries cleanly.
 * ponytail: single in-process worker; move to SKIP LOCKED claiming or a queue if running multiple app instances.
 */
export class EventProcessor {
  private db: DB;
  private running = false;
  private again = false;
  log: (msg: string, err?: unknown) => void;

  constructor(db: DB, log?: (msg: string, err?: unknown) => void) {
    this.db = db;
    this.log = log ?? ((m, e) => console.error(m, e));
  }

  /** Schedules a processing pass soon (coalesces bursts). */
  kick() {
    if (this.running) { this.again = true; return; }
    setImmediate(() => this.processPending().catch((e) => this.log('event processing failed', e)));
  }

  async processPending(limit = 200): Promise<number> {
    if (this.running) { this.again = true; return 0; }
    this.running = true;
    let total = 0;
    try {
      do {
        this.again = false;
        const batch = (await this.db.select().from(domainEvents)
          .where(and(isNull(domainEvents.processedAt), lt(domainEvents.attempts, MAX_ATTEMPTS)))
          .orderBy(asc(domainEvents.id)).limit(limit)) as EventRow[];
        if (!batch.length) break;
        const rules = await this.db.select().from(automationRules).where(eq(automationRules.enabled, true));
        for (const event of batch) {
          await this.processOne(event, rules);
          total++;
        }
        if (batch.length === limit) this.again = true;
      } while (this.again);
    } finally {
      this.running = false;
    }
    return total;
  }

  private async processOne(event: EventRow, rules: (typeof automationRules.$inferSelect)[]) {
    const applicable = rules.filter((r) => r.eventType === event.type && matches(r.conditions as any, event.payload));
    try {
      await withActor(this.db, null, `event:${event.id}`, async (tx) => {
        for (const rule of applicable) {
          for (const step of rule.actions as { action: string; params?: Record<string, any> }[]) {
            const def = actions.get(step.action);
            if (!def) throw new Error(`Rule ${rule.key}: unknown action "${step.action}"`);
            await def.run({ db: tx, event, params: step.params ?? {}, rule: { key: rule.key, name: rule.name } });
          }
        }
        await tx.update(domainEvents).set({ processedAt: new Date(), attempts: sql`${domainEvents.attempts} + 1`, lastError: null })
          .where(eq(domainEvents.id, event.id));
      });
    } catch (err) {
      this.log(`event ${event.id} (${event.type}) failed`, err);
      await this.db.update(domainEvents)
        .set({ attempts: sql`${domainEvents.attempts} + 1`, lastError: String((err as Error)?.message ?? err).slice(0, 2000) })
        .where(eq(domainEvents.id, event.id));
    }
  }
}
