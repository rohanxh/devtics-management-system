import fs from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { count } from 'drizzle-orm';
import { loadConfig } from '../config.ts';
import { bootstrap } from '../bootstrap.ts';
import { users } from './schema/index.ts';
import { seedDemo } from './seed-demo.ts';
import './seed-demo-modules.ts';
import { JOBS } from '../jobs.ts';

const cfg = loadConfig();
if (cfg.NODE_ENV === 'production') {
  console.error('Refusing to seed demo data in production.');
  process.exit(1);
}
if (process.argv.includes('--reset') && !cfg.DATABASE_URL) {
  fs.rmSync(cfg.PGLITE_DIR, { recursive: true, force: true });
  console.log(`Removed ${cfg.PGLITE_DIR}`);
}

const { database, events } = await bootstrap(cfg);
const [{ n }] = await database.db.select({ n: count() }).from(users);
if (Number(n) > 0) {
  console.log('Database already has users; skipping demo seed. Use --reset (PGlite) to start over.');
} else {
  const password = process.env.SEED_PASSWORD || randomBytes(12).toString('base64url');
  await seedDemo(database.db, password);
  await events.processPending();
  // Run periodic jobs once so derived data (health, delays, reminders) is current.
  for (const job of JOBS) await job.run(database.db);
  await events.processPending();
  const file = path.resolve('.data/seed-credentials.txt');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `Demo users: <handle>@devtics.example (e.g. ayesha = CEO, bilal = CTO, hina = PM, ali = developer, imran = admin)\nPassword: ${password}\n`);
  console.log(`Demo data seeded. Credentials written to ${file} (gitignored).`);
}
await database.close();
