import { PGlite } from '@electric-sql/pglite';
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite';
import { drizzle as drizzlePg } from 'drizzle-orm/node-postgres';
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core';
import pg from 'pg';
import fs from 'node:fs';
import * as schema from './schema/index.ts';

export type Schema = typeof schema;
/** Works for both the root database and a transaction. */
export type DB = PgDatabase<PgQueryResultHKT, Schema>;

export interface Database {
  db: DB;
  kind: 'pglite' | 'postgres';
  close(): Promise<void>;
}

/** `pgliteDir` undefined → in-memory (tests). */
export async function createDatabase(opts: { databaseUrl?: string; pgliteDir?: string }): Promise<Database> {
  if (opts.databaseUrl) {
    const pool = new pg.Pool({ connectionString: opts.databaseUrl, max: 10 });
    const db = drizzlePg(pool, { schema, casing: 'snake_case' }) as unknown as DB;
    return { db, kind: 'postgres', close: () => pool.end() };
  }
  if (opts.pgliteDir) fs.mkdirSync(opts.pgliteDir, { recursive: true });
  const client = opts.pgliteDir ? new PGlite(opts.pgliteDir) : new PGlite();
  await client.waitReady;
  const db = drizzlePglite(client, { schema, casing: 'snake_case' }) as unknown as DB;
  return { db, kind: 'pglite', close: () => client.close() };
}
