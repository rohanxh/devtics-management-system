/**
 * First-time setup: creates an administrator with a temporary password (must be changed at first sign-in).
 *   npm run create-admin -- --email you@company.com --name "Your Name" [--roles admin,ceo]
 * Running on the server is fully trusted, so the role-grant escalation guard does not apply here.
 */
import { inArray, sql } from 'drizzle-orm';
import { parseArgs } from 'node:util';
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.ts';
import { createDatabase } from './client.ts';
import { migrate } from './migrate.ts';
import { seedSystem } from './seed-system.ts';
import { roles, userRoles, users } from './schema/index.ts';
import { hashPassword } from '../auth/password.ts';
import { withActor } from '../core/context.ts';
import { auditEvent } from '../core/audit.ts';
import '../bootstrap.ts';

const { values } = parseArgs({ options: { email: { type: 'string' }, name: { type: 'string' }, roles: { type: 'string', default: 'admin' } } });
if (!values.email || !values.name || !/^[^@\s]+@[^@\s]+$/.test(values.email)) {
  console.error('Usage: npm run create-admin -- --email you@company.com --name "Your Name" [--roles admin,ceo]');
  process.exit(1);
}
const cfg = loadConfig();
const database = await createDatabase({ databaseUrl: cfg.DATABASE_URL, pgliteDir: cfg.PGLITE_DIR });
await migrate(database, cfg);
await seedSystem(database.db);
const roleKeys = [...new Set(['employee', ...values.roles!.split(',').map((r) => r.trim()).filter(Boolean)])];
const found = await database.db.select().from(roles).where(inArray(roles.key, roleKeys));
if (found.length !== roleKeys.length) {
  console.error(`Unknown role(s): ${roleKeys.filter((k) => !found.some((r) => r.key === k)).join(', ')}`);
  process.exit(1);
}
const [dupe] = await database.db.select().from(users).where(sql`lower(${users.email}) = ${values.email.toLowerCase()}`);
if (dupe) {
  console.error('A user with this email already exists.');
  process.exit(1);
}
const password = randomBytes(15).toString('base64url');
await withActor(database.db, null, 'cli:create-admin', async (tx) => {
  const [u] = await tx.insert(users).values({ email: values.email!.toLowerCase(), name: values.name!, passwordHash: await hashPassword(password), mustChangePassword: true }).returning();
  await tx.insert(userRoles).values(found.map((r) => ({ userId: u.id, roleId: r.id })));
  await auditEvent(tx, { action: 'USER_CREATED', tableName: 'users', recordId: u.id, newData: { roles: roleKeys, via: 'cli' } });
});
await database.close();
console.log(`Created ${values.email} with roles: ${roleKeys.join(', ')}`);
console.log(`Temporary password (shown once, must be changed at first sign-in): ${password}`);
