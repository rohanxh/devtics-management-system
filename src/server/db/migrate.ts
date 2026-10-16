import path from 'node:path';
import { sql } from 'drizzle-orm';
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator';
import { migrate as migratePg } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client.ts';
import { createDatabase } from './client.ts';

const migrationsFolder = path.resolve(import.meta.dirname, '../../../drizzle');

/**
 * Runs migrations over a direct connection when one is configured (poolers such as Neon's PgBouncer
 * are for application traffic; migrations belong on the direct endpoint), otherwise over `database`.
 */
export async function migrate(database: Database, cfg: { DATABASE_URL?: string; DATABASE_URL_UNPOOLED?: string }) {
  if (database.kind !== 'postgres' || !cfg.DATABASE_URL_UNPOOLED || cfg.DATABASE_URL_UNPOOLED === cfg.DATABASE_URL) {
    return runMigrations(database);
  }
  const direct = await createDatabase({ databaseUrl: cfg.DATABASE_URL_UNPOOLED });
  try {
    await runMigrations(direct);
  } finally {
    await direct.close();
  }
}

export async function runMigrations(database: Database): Promise<void> {
  const db = database.db as any;
  if (database.kind === 'pglite') await migratePglite(db, { migrationsFolder });
  else await migratePg(db, { migrationsFolder });
  // Every table added by any migration gets the audit trigger.
  await database.db.execute(sql`select attach_audit_triggers()`);
}
