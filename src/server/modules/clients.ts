import { and, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { clientFeedback, companies, projects } from '../db/schema/index.ts';
import { withActor } from '../core/context.ts';
import { emit } from '../core/events.ts';
import { afterWrite, requireResource } from '../resources/engine.ts';
import type { Row } from '../resources/types.ts';
import { JOBS } from '../jobs.ts';

export interface Signal { penalty: number; reason: string }
/** A health signal provider returns penalties per client id. Modules (finance, support…) add their own. */
export type SignalProvider = (db: DB, clientIds: string[]) => Promise<Map<string, Signal[]>>;
export const HEALTH_SIGNALS: SignalProvider[] = [];

const push = (m: Map<string, Signal[]>, id: string, s: Signal) => m.set(id, [...(m.get(id) ?? []), s]);

HEALTH_SIGNALS.push(
  // Project delays
  async (db, ids) => {
    const m = new Map<string, Signal[]>();
    const rows = await db.select({ clientId: projects.clientId, code: projects.code, status: projects.status }).from(projects)
      .where(and(inArray(projects.clientId, ids), inArray(projects.status, ['delayed', 'at_risk'])));
    for (const r of rows) push(m, r.clientId!, { penalty: r.status === 'delayed' ? 20 : 10, reason: `Project ${r.code} is ${r.status.replace('_', ' ')}` });
    return m;
  },
  // Feedback delays and low satisfaction
  async (db, ids) => {
    const m = new Map<string, Signal[]>();
    const overdue = await db.select({ companyId: clientFeedback.companyId, n: sql<number>`count(*)::int` }).from(clientFeedback)
      .where(and(inArray(clientFeedback.companyId, ids), eq(clientFeedback.status, 'overdue'))).groupBy(clientFeedback.companyId);
    for (const r of overdue) push(m, r.companyId, { penalty: Math.min(10 * r.n, 20), reason: `${r.n} overdue feedback request(s)` });
    const ratings = await db.select({ companyId: clientFeedback.companyId, avg: sql<number>`avg(${clientFeedback.rating})::float` }).from(clientFeedback)
      .where(and(inArray(clientFeedback.companyId, ids), sql`${clientFeedback.rating} is not null`, sql`${clientFeedback.receivedAt} >= current_date - 180`))
      .groupBy(clientFeedback.companyId);
    for (const r of ratings) if (r.avg < 3) push(m, r.companyId, { penalty: 20, reason: `Low satisfaction (avg ${r.avg.toFixed(1)}/5)` });
    return m;
  },
);

/** Recomputes health for clients (all, or the given ids). Writes only when something changed. */
export async function recomputeClientHealth(db: DB, onlyIds?: string[]) {
  const clients = await db.select().from(companies)
    .where(and(eq(companies.lifecycle, 'client'), onlyIds?.length ? inArray(companies.id, onlyIds) : undefined));
  if (!clients.length) return 0;
  const ids = clients.map((c) => c.id);
  const signals = new Map<string, Signal[]>();
  for (const provider of HEALTH_SIGNALS) {
    for (const [id, list] of await provider(db, ids)) signals.set(id, [...(signals.get(id) ?? []), ...list]);
  }
  const activeWork = new Set((await db.selectDistinct({ id: projects.clientId }).from(projects)
    .where(and(inArray(projects.clientId, ids), notInArray(projects.status, ['completed', 'cancelled'])))).map((r) => r.id));
  const recentWork = new Set((await db.selectDistinct({ id: projects.clientId }).from(projects)
    .where(and(inArray(projects.clientId, ids), sql`coalesce(${projects.actualEndDate}, ${projects.dueDate}, current_date) >= current_date - 90`))).map((r) => r.id));

  let changed = 0;
  for (const c of clients) {
    const s = signals.get(c.id) ?? [];
    const score = Math.max(0, 100 - s.reduce((a, x) => a + x.penalty, 0));
    let health: 'active' | 'stable' | 'attention_required' | 'at_risk' | 'inactive';
    if (score < 60) health = 'at_risk';
    else if (score < 80) health = 'attention_required';
    else if (activeWork.has(c.id)) health = 'active';
    else if (recentWork.has(c.id) || (c.clientSince && c.clientSince >= new Date(Date.now() - 90 * 86400_000).toISOString().slice(0, 10))) health = 'stable';
    else health = 'inactive';
    const reasons = s.map((x) => `• ${x.reason}`).join('\n') || null;
    if (health === c.health && score === c.healthScore && reasons === c.healthReasons) continue;
    const [u] = await db.update(companies).set({ health, healthScore: score, healthReasons: reasons, healthUpdatedAt: new Date() })
      .where(eq(companies.id, c.id)).returning();
    await afterWrite(db, requireResource('clients'), null, u as Row, c as Row);
    if (health !== c.health) {
      await emit(db, { type: 'clients.health_changed', entityType: 'clients', entityId: c.id, payload: { title: c.name, from: c.health, to: health, score } });
    }
    changed++;
  }
  return changed;
}

JOBS.push({
  name: 'clients.recompute_health', everyMinutes: 30,
  run: (db) => withActor(db, null, 'job:clients.recompute_health', async (t) => { await recomputeClientHealth(t); }),
});

