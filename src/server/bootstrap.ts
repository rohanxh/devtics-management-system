import './resources/defs/index.ts';
import './core/actions.ts';
import './modules/rules.ts';
import './modules/delivery.ts';
import './modules/clients.ts';
import './core/mailer.ts';
import type { Config } from './config.ts';
import { createDatabase } from './db/client.ts';
import { runMigrations } from './db/migrate.ts';
import { seedSystem } from './db/seed-system.ts';
import { EventProcessor } from './core/events.ts';
import { Storage } from './core/storage.ts';
import { buildApp } from './app.ts';

/** Creates a fully wired application: database (migrated + system-seeded), event processor, storage, HTTP app. */
export async function bootstrap(config: Config, opts: { inMemory?: boolean; logger?: boolean } = {}) {
  const database = await createDatabase({
    databaseUrl: opts.inMemory ? undefined : config.DATABASE_URL,
    pgliteDir: opts.inMemory ? undefined : config.PGLITE_DIR,
  });
  await runMigrations(database);
  await seedSystem(database.db);
  const events = new EventProcessor(database.db);
  const storage = new Storage(config.STORAGE_DIR);
  const app = await buildApp({ db: database.db, config, events, storage }, { logger: opts.logger });
  return { app, database, events, storage };
}
