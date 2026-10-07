import { sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';

/** Atomically allocates the next human-readable number, e.g. nextNumber(tx, 'invoice', 'INV-', 5) → "INV-00042". */
export async function nextNumber(db: DB, key: string, prefix: string, pad = 4): Promise<string> {
  const res: any = await db.execute(sql`
    insert into counters (key, value) values (${key}, 1)
    on conflict (key) do update set value = counters.value + 1
    returning value`);
  return prefix + String(res.rows[0].value).padStart(pad, '0');
}
