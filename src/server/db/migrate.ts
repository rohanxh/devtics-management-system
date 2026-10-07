import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.ts';

const migrationsFolder = path.resolve(import.meta.dirname, '../../../drizzle');

export async function runMigrations(database: Database): Promise<void> {
  const db = database.db as any;
  if (database.kind === 'pglite') await migratePglite(db, { migrationsFolder });
  else await migratePg(db, { migrationsFolder });
  // Every table added by any migration gets the audit trigger.
  await database.db.execute(sql`select attach_audit_triggers()`);
}
