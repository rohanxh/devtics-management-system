import { loadConfig } from '../config.ts';
import { createDatabase } from './client.ts';
import { runMigrations } from './migrate.ts';

const cfg = loadConfig();
const database = await createDatabase({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
await runMigrations(database);
await database.close();
console.log('Migrations applied.');
