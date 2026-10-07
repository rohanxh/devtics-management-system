import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';

/** Hourly cost of a user's time on a date, from the effective-dated compensation history (null if unknown). */
export async function hourlyCost(db: DB, userId: string, onDate: string): Promise<number | null> {
  const res: any = await db.execute(sql`
    select ec.hourly_cost from employee_compensation ec
    join employees e on e.id = ec.employee_id
    where e.user_id = ${userId} and ec.effective_from <= ${onDate}
    order by ec.effective_from desc limit 1`);
  return res.rows[0] ? Number(res.rows[0].hourly_cost) : null;
}

/** Cost snapshot for a time entry (rounded to cents), or null when no compensation is on record. */
export async function labourCost(db: DB, userId: string, onDate: string, minutes: number): Promise<string | null> {
  const rate = await hourlyCost(db, userId, onDate);
  return rate === null ? null : ((rate * minutes) / 60).toFixed(2);
}
