import { and, eq, isNotNull, notInArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { bugs, employees, goals, kpis, kpiValues, leads } from '../db/schema/index.ts';
import { withActor } from '../core/context.ts';
import { JOBS } from '../jobs.ts';
import { mrr, profitAndLoss } from './finance.ts';

const today = () => new Date().toISOString().slice(0, 10);
const monthStart = () => today().slice(0, 8) + '01';
const daysAgo = (k: number) => new Date(Date.now() - k * 86400_000).toISOString().slice(0, 10);
const quarterStart = () => {
  const d = new Date();
  return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1)).toISOString().slice(0, 10);
};
const one = async (db: DB, q: ReturnType<typeof sql>) => Number(((await db.execute(q)) as any).rows[0]?.v ?? 0);

/**
 * Automatic metrics shared by KPIs, goals and executive reports. Each returns the current-period value.
 * Finance metrics reuse the finance module so every screen shows the same figure.
 */
export const METRICS: Record<string, (db: DB) => Promise<number>> = {
  revenue_month: async (db) => (await profitAndLoss(db, monthStart(), today())).revenue,
  revenue_ytd: async (db) => (await profitAndLoss(db, today().slice(0, 4) + '-01-01', today())).revenue,
  profit_margin_month: async (db) => (await profitAndLoss(db, monthStart(), today())).marginPct ?? 0,
  mrr: (db) => mrr(db),
  new_clients_quarter: (db) => one(db, sql`select count(*)::int v from companies where lifecycle = 'client' and client_since >= ${quarterStart()}`),
  win_rate_pct: (db) => one(db, sql`select coalesce(round(100.0 * count(*) filter (where won_at is not null) / nullif(count(*), 0)), 0) v
    from opportunities where coalesce(won_at, lost_at) >= ${daysAgo(90)}::date`),
  utilization_pct: (db) => one(db, sql`select coalesce(round(100.0 * sum(te.minutes) / 60 / nullif((select count(*) from users where status = 'active') * 8 * 22, 0)), 0) v
    from time_entries te where te.work_date >= ${daysAgo(30)}::date`),
  on_time_delivery_pct: (db) => one(db, sql`select coalesce(round(100.0 * count(*) filter (where completed_at::date <= due_date) / nullif(count(*), 0)), 0) v
    from tasks where status = 'done' and due_date is not null and completed_at >= ${daysAgo(30)}::date`),
  open_bugs: async (db) => Number((await db.select({ v: sql<number>`count(*)::int` }).from(bugs).where(notInArray(bugs.status, ['verified', 'closed', 'wont_fix', 'duplicate'])))[0].v),
  headcount: async (db) => Number((await db.select({ v: sql<number>`count(*)::int` }).from(employees).where(notInArray(employees.employmentStatus, ['terminated', 'resigned'])))[0].v),
  attrition_pct: (db) => one(db, sql`select coalesce(round(100.0 * (select count(*) from employees where exit_date >= current_date - 365) / nullif((select count(*) from employees where employment_status not in ('terminated', 'resigned')), 0), 1), 0) v`),
  new_leads_month: async (db) => Number((await db.select({ v: sql<number>`count(*)::int` }).from(leads).where(sql`${leads.createdAt} >= ${monthStart()}::date`))[0].v),
};

/** Records this month's value for every automatic KPI and refreshes goals linked to a metric. */
export async function measureKpis(db: DB) {
  const cache = new Map<string, number>();
  const value = async (k: string) => {
    if (!METRICS[k]) return null;
    if (!cache.has(k)) cache.set(k, await METRICS[k](db));
    return cache.get(k)!;
  };
  const end = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
  for (const k of await db.select().from(kpis).where(isNotNull(kpis.metricKey))) {
    const v = await value(k.metricKey!);
    if (v === null) continue;
    await db.insert(kpiValues).values({ kpiId: k.id, periodStart: monthStart(), periodEnd: end, value: String(v), note: 'Measured automatically' })
      .onConflictDoUpdate({ target: [kpiValues.kpiId, kpiValues.periodStart], set: { value: String(v), updatedAt: new Date() } });
  }
  for (const g of await db.select().from(goals).where(and(isNotNull(goals.metricKey), notInArray(goals.status, ['achieved', 'missed'])))) {
    const v = await value(g.metricKey!);
    if (v === null || String(v) === g.currentValue) continue;
    await db.update(goals).set({ currentValue: String(v) }).where(eq(goals.id, g.id));
  }
}

JOBS.push({ name: 'kpis.measure', everyMinutes: 360, run: (db) => withActor(db, null, 'job:kpis.measure', measureKpis) });
