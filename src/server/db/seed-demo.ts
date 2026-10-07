/**
 * Development/demo seed. All people, companies and figures are fictional; emails use reserved
 * `.example` domains. Never run against production (seed-cli refuses when NODE_ENV=production).
 */
import { eq, inArray } from 'drizzle-orm';
import type { DB } from './client.ts';
import * as s from './schema/index.ts';
import { hashPassword } from '../auth/password.ts';
import { withActor } from '../core/context.ts';

export interface SeedCtx {
  tx: DB;
  users: Record<string, string>; // handle → user id
  employees: Record<string, string>; // handle → employee id
  depts: Record<string, string>;
  stages: Record<string, Record<string, string>>; // pipeline → key → id
}

/** Phase seeders register here and run in order after the core seed. */
export const DEMO_SEEDERS: { name: string; run: (c: SeedCtx) => Promise<void> }[] = [];

export const PEOPLE = [
  { h: 'ayesha', first: 'Ayesha', last: 'Khan', roles: ['ceo'], dept: 'MGMT', title: 'Chief Executive Officer', level: 10 },
  { h: 'bilal', first: 'Bilal', last: 'Ahmed', roles: ['cto'], dept: 'ENG', title: 'Chief Technology Officer', level: 10, mgr: 'ayesha' },
  { h: 'sara', first: 'Sara', last: 'Malik', roles: ['finance'], dept: 'FIN', title: 'Finance Manager', level: 7, mgr: 'ayesha' },
  { h: 'usman', first: 'Usman', last: 'Tariq', roles: ['bd'], dept: 'BD', title: 'Business Development Manager', level: 7, mgr: 'ayesha' },
  { h: 'hina', first: 'Hina', last: 'Raza', roles: ['pm'], dept: 'PMO', title: 'Senior Project Manager', level: 7, mgr: 'ayesha' },
  { h: 'omar', first: 'Omar', last: 'Farooq', roles: ['pm'], dept: 'PMO', title: 'Project Manager', level: 6, mgr: 'hina' },
  { h: 'ali', first: 'Ali', last: 'Hassan', roles: ['developer'], dept: 'ENG', title: 'Senior Software Engineer', level: 6, mgr: 'bilal' },
  { h: 'zainab', first: 'Zainab', last: 'Qureshi', roles: ['developer'], dept: 'ENG', title: 'Software Engineer', level: 5, mgr: 'bilal' },
  { h: 'fahad', first: 'Fahad', last: 'Iqbal', roles: ['developer'], dept: 'ENG', title: 'WordPress Developer', level: 4, mgr: 'bilal', probation: true },
  { h: 'maryam', first: 'Maryam', last: 'Siddiqui', roles: ['designer'], dept: 'DES', title: 'UI/UX Designer', level: 5, mgr: 'hina' },
  { h: 'hamza', first: 'Hamza', last: 'Sheikh', roles: ['qa'], dept: 'QA', title: 'QA Lead', level: 6, mgr: 'bilal' },
  { h: 'nida', first: 'Nida', last: 'Javed', roles: ['qa'], dept: 'QA', title: 'QA Engineer', level: 4, mgr: 'hamza' },
  { h: 'kamran', first: 'Kamran', last: 'Butt', roles: ['marketing'], dept: 'MKT', title: 'SEO & Marketing Lead', level: 6, mgr: 'ayesha' },
  { h: 'rabia', first: 'Rabia', last: 'Aslam', roles: ['hr'], dept: 'HR', title: 'HR Manager', level: 7, mgr: 'ayesha' },
  { h: 'imran', first: 'Imran', last: 'Shah', roles: ['admin'], dept: 'OPS', title: 'Operations Administrator', level: 5, mgr: 'ayesha' },
  { h: 'danish', first: 'Danish', last: 'Mirza', roles: ['it'], dept: 'IT', title: 'IT Administrator', level: 5, mgr: 'bilal' },
  { h: 'sana', first: 'Sana', last: 'Yousaf', roles: ['support'], dept: 'SUP', title: 'Support Specialist', level: 4, mgr: 'hina' },
] as const;

const DEPTS = [
  ['MGMT', 'Management'], ['ENG', 'Engineering'], ['FIN', 'Finance'], ['BD', 'Business Development'], ['PMO', 'Project Management'],
  ['DES', 'Design'], ['QA', 'Quality Assurance'], ['MKT', 'Marketing & SEO'], ['HR', 'Human Resources'], ['OPS', 'Operations'],
  ['IT', 'IT'], ['SUP', 'Support'],
] as const;

export const daysFromNow = (n: number) => new Date(Date.now() + n * 86400_000).toISOString().slice(0, 10);

export async function seedDemo(db: DB, password: string) {
  const hash = await hashPassword(password);
  await withActor(db, null, 'seed:demo', async (tx) => {
    const [loc] = await tx.insert(s.locations).values({ name: 'Lahore HQ', address: '1 Example Boulevard, Lahore', timezone: 'Asia/Karachi' }).returning();
    await tx.insert(s.locations).values({ name: 'Remote', timezone: 'UTC' });
    const [sched] = await tx.insert(s.workSchedules).values({ name: 'Standard (Mon–Fri 9–6)', startTime: '09:00', endTime: '18:00', workdays: [1, 2, 3, 4, 5], graceMinutes: 15 }).returning();
    const year = new Date().getFullYear();
    await tx.insert(s.holidays).values([
      { date: `${year}-02-05`, name: 'Kashmir Day' }, { date: `${year}-03-23`, name: 'Pakistan Day' },
      { date: `${year}-05-01`, name: 'Labour Day' }, { date: `${year}-08-14`, name: 'Independence Day' },
      { date: `${year}-11-09`, name: 'Iqbal Day' }, { date: `${year}-12-25`, name: 'Quaid-e-Azam Day' },
    ]);

    const depts: Record<string, string> = {};
    for (const [code, name] of DEPTS) {
      const [d] = await tx.insert(s.departments).values({ code, name }).returning();
      depts[code] = d.id;
    }
    const roleRows = await tx.select().from(s.roles);
    const roleId = (k: string) => roleRows.find((r) => r.key === k)!.id;

    const users: Record<string, string> = {};
    const employees: Record<string, string> = {};
    let n = 0;
    for (const p of PEOPLE) {
      n++;
      const [u] = await tx.insert(s.users).values({ email: `${p.h}@devtics.example`, name: `${p.first} ${p.last}`, passwordHash: hash }).returning();
      users[p.h] = u.id;
      await tx.insert(s.userRoles).values(['employee', ...p.roles].map((r) => ({ userId: u.id, roleId: roleId(r) })));
      const [des] = await tx.insert(s.designations).values({ title: p.title, departmentId: depts[p.dept], level: p.level }).onConflictDoNothing().returning();
      const joined = daysFromNow(-(60 + n * 97) % 1500 - 60);
      const [e] = await tx.insert(s.employees).values({
        userId: u.id, employeeCode: `DEV-${String(n).padStart(3, '0')}`, firstName: p.first, lastName: p.last,
        workEmail: `${p.h}@devtics.example`, phone: `+92 300 555 ${String(1000 + n).slice(-4)}`,
        departmentId: depts[p.dept], designationId: des?.id, locationId: loc.id, workScheduleId: sched.id,
        employmentStatus: 'probation' in p && p.probation ? 'probation' : 'active',
        joinDate: 'probation' in p && p.probation ? daysFromNow(-40) : joined,
        probationEndDate: 'probation' in p && p.probation ? daysFromNow(50) : null,
        personalEmail: `${p.h}.personal@mail.example`, dateOfBirth: `${1985 + (n % 12)}-0${1 + (n % 9)}-1${n % 9}`,
        address: `${10 + n} Sample Street, Lahore`, nationalIdLast4: String(1000 + n * 37).slice(-4),
      }).returning();
      employees[p.h] = e.id;
    }
    for (const p of PEOPLE) {
      if ('mgr' in p && p.mgr) await tx.update(s.employees).set({ managerId: employees[p.mgr] }).where(eq(s.employees.id, employees[p.h]));
    }
    await tx.update(s.departments).set({ headUserId: users.bilal }).where(inArray(s.departments.id, [depts.ENG, depts.IT]));
    await tx.update(s.departments).set({ headUserId: users.hina }).where(eq(s.departments.id, depts.PMO));
    await tx.update(s.departments).set({ headUserId: users.rabia }).where(eq(s.departments.id, depts.HR));
    await tx.update(s.departments).set({ headUserId: users.sara }).where(eq(s.departments.id, depts.FIN));

    const stageRows = await tx.select().from(s.pipelineStages);
    const stages: SeedCtx['stages'] = {};
    for (const st of stageRows) (stages[st.pipeline] ??= {})[st.key] = st.id;

    const c: SeedCtx = { tx, users, employees, depts, stages };
    for (const seeder of DEMO_SEEDERS) await seeder.run(c);
  });
}
