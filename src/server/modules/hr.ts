import type { FastifyInstance } from 'fastify';
import { and, asc, eq, gte, inArray, lte, notInArray, or, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import {
  applications, attendanceRecords, candidates, certifications, employeeJobHistory, employees, files, holidays,
  jobOpenings, leaveBalances, leaveRequests, leaveTypes, performanceReviews, pipelineStages, workSchedules,
} from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx, withActor } from '../core/context.ts';
import { conflict, invalid } from '../core/errors.ts';
import { emit, registerAction } from '../core/events.ts';
import { nextNumber } from '../core/counters.ts';
import { notify } from '../core/notify.ts';
import { registerApprovalHandler } from '../core/approvals.ts';
import { afterWrite, requireResource } from '../resources/engine.ts';
import type { Row } from '../resources/types.ts';
import { JOBS } from '../jobs.ts';
import { daysAgo, registerDashboard, scopeOr, today } from './reports.ts';

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: string, k: number) => iso(new Date(new Date(d + 'T00:00:00Z').getTime() + k * 86400_000));
/** ISO weekday 1 (Mon) … 7 (Sun) */
const isoDow = (d: string) => ((new Date(d + 'T00:00:00Z').getUTCDay() + 6) % 7) + 1;

async function scheduleFor(db: DB, employeeId: string) {
  const [row] = await db.select({ s: workSchedules, locationId: employees.locationId }).from(employees)
    .leftJoin(workSchedules, eq(workSchedules.id, employees.workScheduleId)).where(eq(employees.id, employeeId));
  const s = row?.s ?? { startTime: '09:00:00', endTime: '18:00:00', workdays: [1, 2, 3, 4, 5], graceMinutes: 15 };
  return { ...s, locationId: row?.locationId ?? null };
}

/** Working days between two dates for an employee: their schedule's workdays minus holidays at their location. */
export async function workingDays(db: DB, employeeId: string, from: string, to: string): Promise<string[]> {
  const s = await scheduleFor(db, employeeId);
  const hol = new Set((await db.select({ date: holidays.date }).from(holidays)
    .where(and(gte(holidays.date, from), lte(holidays.date, to), s.locationId ? or(sql`${holidays.locationId} is null`, eq(holidays.locationId, s.locationId)) : sql`${holidays.locationId} is null`)))
    .map((h) => h.date));
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) if ((s.workdays as number[]).includes(isoDow(d)) && !hol.has(d)) out.push(d);
  return out;
}

const minutesOf = (t: string) => { const [h, m] = t.split(':').map(Number); return h * 60 + m; };

/**
 * Derives worked/late/early/overtime minutes and status from clock times and the schedule.
 * ponytail: uses the server's local time zone; switch to the employee location's time zone if teams span time zones.
 */
export async function computeAttendance(db: DB, employeeId: string, date: string, clockIn: Date | null, clockOut: Date | null) {
  const s = await scheduleFor(db, employeeId);
  const start = minutesOf(s.startTime), end = minutesOf(s.endTime);
  const local = (d: Date) => d.getHours() * 60 + d.getMinutes();
  const inM = clockIn ? local(clockIn) : null, outM = clockOut ? local(clockOut) : null;
  const late = inM !== null ? Math.max(0, inM - (start + s.graceMinutes)) : 0;
  const early = outM !== null ? Math.max(0, end - outM) : 0;
  const worked = clockIn && clockOut ? Math.max(0, Math.round((clockOut.getTime() - clockIn.getTime()) / 60000)) : 0;
  const overtime = Math.max(0, worked - (end - start));
  const status = late > 0 ? 'late' : clockOut && worked < (end - start) / 2 ? 'half_day' : 'present';
  return { lateMinutes: late, earlyLeaveMinutes: clockOut ? early : 0, minutesWorked: worked, overtimeMinutes: overtime, status: status as 'late' | 'half_day' | 'present' };
}

// ───────────── Leave ─────────────

export async function ensureBalance(db: DB, employeeId: string, leaveTypeId: string, year: number) {
  const [b] = await db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, employeeId), eq(leaveBalances.leaveTypeId, leaveTypeId), eq(leaveBalances.year, year)));
  if (b) return b;
  const [lt] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, leaveTypeId));
  const [created] = await db.insert(leaveBalances).values({ employeeId, leaveTypeId, year, allocatedDays: lt.annualAllowanceDays }).onConflictDoNothing().returning();
  return created ?? (await db.select().from(leaveBalances).where(and(eq(leaveBalances.employeeId, employeeId), eq(leaveBalances.leaveTypeId, leaveTypeId), eq(leaveBalances.year, year))))[0];
}

export const remaining = (b: typeof leaveBalances.$inferSelect) => Number(b.allocatedDays) + Number(b.carriedDays) - Number(b.usedDays);

async function applyLeave(db: DB, req: typeof leaveRequests.$inferSelect, sign: 1 | -1) {
  const b = await ensureBalance(db, req.employeeId, req.leaveTypeId, Number(req.startDate.slice(0, 4)));
  await db.update(leaveBalances).set({ usedDays: sql`${leaveBalances.usedDays} + ${sign * Number(req.days)}` }).where(eq(leaveBalances.id, b.id));
  const days = await workingDays(db, req.employeeId, req.startDate, req.endDate);
  if (sign === 1) {
    for (const d of days) {
      await db.insert(attendanceRecords).values({ employeeId: req.employeeId, date: d, status: 'on_leave', source: 'system', notes: 'Approved leave' })
        .onConflictDoUpdate({ target: [attendanceRecords.employeeId, attendanceRecords.date], set: { status: 'on_leave', notes: 'Approved leave' } });
    }
  } else if (days.length) {
    await db.delete(attendanceRecords).where(and(eq(attendanceRecords.employeeId, req.employeeId), inArray(attendanceRecords.date, days), eq(attendanceRecords.status, 'on_leave'), eq(attendanceRecords.source, 'system')));
  }
}

registerApprovalHandler('leave', {
  async onApproved(db, a, actor) {
    const [prev] = await db.select().from(leaveRequests).where(eq(leaveRequests.id, a.entityId));
    if (!prev || prev.status !== 'pending') return;
    const b = await ensureBalance(db, prev.employeeId, prev.leaveTypeId, Number(prev.startDate.slice(0, 4)));
    const [lt] = await db.select().from(leaveTypes).where(eq(leaveTypes.id, prev.leaveTypeId));
    if (lt.isPaid && remaining(b) < Number(prev.days)) throw conflict(`Insufficient ${lt.name} balance (${remaining(b)} day(s) left)`);
    const [next] = await db.update(leaveRequests).set({ status: 'approved', decidedById: actor.userId, decidedAt: new Date() }).where(eq(leaveRequests.id, prev.id)).returning();
    await applyLeave(db, next, 1);
    await afterWrite(db, requireResource('leave_requests'), actor, next as Row, prev as Row);
  },
  async onRejected(db, a, actor) {
    const [prev] = await db.select().from(leaveRequests).where(eq(leaveRequests.id, a.entityId));
    if (!prev || prev.status !== 'pending') return;
    const [next] = await db.update(leaveRequests).set({ status: 'rejected', decidedById: actor.userId, decidedAt: new Date() }).where(eq(leaveRequests.id, prev.id)).returning();
    await afterWrite(db, requireResource('leave_requests'), actor, next as Row, prev as Row);
  },
});

/** Cancelling an approved leave gives the days back and clears the attendance markers. */
export async function onLeaveCancelled(db: DB, req: typeof leaveRequests.$inferSelect, prevStatus: string) {
  if (prevStatus === 'approved') await applyLeave(db, req, -1);
  if (prevStatus === 'pending' && req.approvalId) await db.execute(sql`update approvals set status = 'cancelled' where id = ${req.approvalId} and status = 'pending'`);
}

// ───────────── Hiring ─────────────

registerAction('notify_employee', {
  description: 'Notify the user account of the employee in the event payload (params: title).',
  async run({ db, event, params, rule }) {
    const [e] = await db.select({ userId: employees.userId }).from(employees).where(eq(employees.id, String(event.payload.employeeId ?? '')));
    await notify(db, {
      userIds: [e?.userId], kind: params.kind ?? 'status',
      title: String(params.title ?? '{title}').replace('{title}', String(event.payload.title ?? '')).replace('{to}', String(event.payload.to ?? '')),
      entityType: event.entityType ?? undefined, entityId: event.entityId ?? undefined, excludeUserId: event.actorUserId, dedupeKey: `${rule.key}:${event.id}`,
    });
  },
});

registerAction('hr.hire_candidate', {
  description: 'Candidate moved to “Hired”: create the employee record (probation), record the hire, update the opening and notify HR, IT and Admin to onboard.',
  async run({ db, event }) {
    const [app] = await db.select().from(applications).where(eq(applications.id, event.entityId!));
    if (!app || app.hiredEmployeeId) return;
    const [cand] = await db.select().from(candidates).where(eq(candidates.id, app.candidateId));
    const [op] = await db.select().from(jobOpenings).where(eq(jobOpenings.id, app.jobOpeningId));
    const [emp] = await db.insert(employees).values({
      employeeCode: await nextNumber(db, 'employee', 'DEV-', 3), firstName: cand.firstName, lastName: cand.lastName ?? '', personalEmail: cand.email,
      phone: cand.phone, departmentId: op.departmentId, designationId: op.designationId, employmentType: op.employmentType, employmentStatus: 'probation',
      joinDate: addDays(today(), 14), probationEndDate: addDays(today(), 14 + 90),
      managerId: op.hiringManagerId ? (await db.select({ id: employees.id }).from(employees).where(eq(employees.userId, op.hiringManagerId)))[0]?.id ?? null : null,
    }).returning();
    await afterWrite(db, requireResource('employees'), null, emp as Row, undefined);
    await db.insert(employeeJobHistory).values({ employeeId: emp.id, effectiveDate: emp.joinDate, changeType: 'hire', departmentId: op.departmentId, designationId: op.designationId, notes: `Hired via ${op.title}` });
    await db.update(applications).set({ status: 'hired', hiredEmployeeId: emp.id }).where(eq(applications.id, app.id));
    const hired = op.hiredCount + 1;
    await db.update(jobOpenings).set({ hiredCount: hired, status: hired >= op.openings ? 'filled' : op.status, closedOn: hired >= op.openings ? today() : op.closedOn }).where(eq(jobOpenings.id, op.id));
    await notify(db, {
      roles: ['hr', 'it', 'admin'], userIds: [op.hiringManagerId], kind: 'status',
      title: `New hire: ${cand.firstName} ${cand.lastName ?? ''} (${op.title}) starts ${emp.joinDate}`,
      body: 'Prepare the employee record, login, company email, equipment and system access.', entityType: 'employees', entityId: emp.id, dedupeKey: `hire:${app.id}`,
    });
    await emit(db, { type: 'employee.hired', entityType: 'employees', entityId: emp.id, payload: { title: `${cand.firstName} ${cand.lastName ?? ''}`, jobOpeningId: op.id } });
  },
});

// ───────────── Routes ─────────────

export async function hrRoutes(app: FastifyInstance) {
  const myEmployee = async (ctx: ReturnType<typeof ctxOf>) => {
    if (!ctx.actor.employeeId) throw invalid('Your login is not linked to an employee record', {});
    return ctx.actor.employeeId;
  };

  app.get('/api/attendance/me', async (req) => {
    const ctx = ctxOf(req);
    const empId = await myEmployee(ctx);
    const [todayRec] = await ctx.db.select().from(attendanceRecords).where(and(eq(attendanceRecords.employeeId, empId), eq(attendanceRecords.date, today())));
    const monthStart = today().slice(0, 8) + '01';
    const month = await ctx.db.select().from(attendanceRecords).where(and(eq(attendanceRecords.employeeId, empId), gte(attendanceRecords.date, monthStart))).orderBy(asc(attendanceRecords.date));
    const balances = await ctx.db.select({ b: leaveBalances, name: leaveTypes.name, isPaid: leaveTypes.isPaid }).from(leaveBalances)
      .innerJoin(leaveTypes, eq(leaveTypes.id, leaveBalances.leaveTypeId))
      .where(and(eq(leaveBalances.employeeId, empId), eq(leaveBalances.year, Number(today().slice(0, 4)))));
    return {
      today: todayRec ?? null, month,
      summary: {
        present: month.filter((m) => ['present', 'late', 'remote', 'half_day'].includes(m.status)).length,
        late: month.filter((m) => m.status === 'late').length, absent: month.filter((m) => m.status === 'absent').length,
        leave: month.filter((m) => m.status === 'on_leave').length, hours: Math.round(month.reduce((a, m) => a + m.minutesWorked, 0) / 6) / 10,
        overtimeHours: Math.round(month.reduce((a, m) => a + m.overtimeMinutes, 0) / 6) / 10,
      },
      balances: balances.map((x) => ({ ...x.b, name: x.name, isPaid: x.isPaid, remaining: remaining(x.b) })),
    };
  });

  app.post<{ Body: { remote?: boolean } }>('/api/attendance/clock-in', async (req) => {
    const ctx = ctxOf(req);
    const empId = await myEmployee(ctx);
    const now = new Date();
    const [existing] = await ctx.db.select().from(attendanceRecords).where(and(eq(attendanceRecords.employeeId, empId), eq(attendanceRecords.date, today())));
    if (existing?.clockIn) throw conflict('You have already clocked in today');
    if (existing?.status === 'on_leave') throw conflict('You are on approved leave today');
    const calc = await computeAttendance(ctx.db, empId, today(), now, null);
    const status = req.body?.remote ? 'remote' : calc.status;
    return tx(ctx, async (t) => {
      const [row] = await t.insert(attendanceRecords).values({ employeeId: empId, date: today(), clockIn: now, status, lateMinutes: calc.lateMinutes, source: 'web' })
        .onConflictDoUpdate({ target: [attendanceRecords.employeeId, attendanceRecords.date], set: { clockIn: now, status, lateMinutes: calc.lateMinutes, source: 'web' } }).returning();
      return row;
    });
  });

  app.post('/api/attendance/clock-out', async (req) => {
    const ctx = ctxOf(req);
    const empId = await myEmployee(ctx);
    const [rec] = await ctx.db.select().from(attendanceRecords).where(and(eq(attendanceRecords.employeeId, empId), eq(attendanceRecords.date, today())));
    if (!rec?.clockIn) throw conflict('Clock in first');
    if (rec.clockOut) throw conflict('You have already clocked out today');
    const now = new Date();
    const calc = await computeAttendance(ctx.db, empId, today(), rec.clockIn, now);
    return tx(ctx, async (t) => {
      const [row] = await t.update(attendanceRecords).set({ ...calc, status: rec.status === 'remote' ? 'remote' : calc.status, clockOut: now }).where(eq(attendanceRecords.id, rec.id)).returning();
      return row;
    });
  });

  /** Who is in / late / absent / on leave on a date (HR & managers, record-scoped). */
  app.get<{ Querystring: { date?: string } }>('/api/attendance/day', async (req) => {
    const ctx = ctxOf(req);
    const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date ?? '') ? req.query.date! : today();
    const rows = await ctx.db.select({
      employeeId: employees.id, name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`, status: attendanceRecords.status,
      clockIn: attendanceRecords.clockIn, clockOut: attendanceRecords.clockOut, lateMinutes: attendanceRecords.lateMinutes, minutesWorked: attendanceRecords.minutesWorked,
    }).from(employees).leftJoin(attendanceRecords, and(eq(attendanceRecords.employeeId, employees.id), eq(attendanceRecords.date, date)))
      .where(and(scopeOr(ctx, 'attendance'), notInArray(employees.employmentStatus, ['terminated', 'resigned']))).orderBy(employees.firstName);
    return { date, rows };
  });
}

// ───────────── Jobs ─────────────

JOBS.push(
  {
    name: 'attendance.mark_absences', everyMinutes: 120,
    run: (db) => withActor(db, null, 'job:attendance.mark_absences', async (t) => {
      const day = addDays(today(), -1);
      const staff = await t.select().from(employees).where(and(notInArray(employees.employmentStatus, ['terminated', 'resigned']), lte(employees.joinDate, day)));
      for (const e of staff) {
        if (!(await workingDays(t, e.id, day, day)).length) continue;
        await t.insert(attendanceRecords).values({ employeeId: e.id, date: day, status: 'absent', source: 'system', notes: 'No clock-in recorded' }).onConflictDoNothing();
      }
    }),
  },
  {
    name: 'hr.reminders', everyMinutes: 360,
    run: (db) => withActor(db, null, 'job:hr.reminders', async (t) => {
      const soon = addDays(today(), 14);
      const probation = await t.select().from(employees).where(and(eq(employees.employmentStatus, 'probation'), gte(employees.probationEndDate, today()), lte(employees.probationEndDate, soon)));
      for (const e of probation) {
        const mgr = e.managerId ? (await t.select({ userId: employees.userId }).from(employees).where(eq(employees.id, e.managerId)))[0]?.userId : null;
        await notify(t, { roles: ['hr'], userIds: [mgr], kind: 'deadline', title: `Probation ends ${e.probationEndDate}: ${e.firstName} ${e.lastName}`, entityType: 'employees', entityId: e.id, dedupeKey: `probation:${e.id}:${e.probationEndDate}` });
      }
      const reviews = await t.select().from(performanceReviews).where(and(notInArray(performanceReviews.status, ['completed', 'cancelled']), lte(performanceReviews.dueDate, addDays(today(), 7))));
      for (const r of reviews) {
        await notify(t, { userIds: [r.reviewerId], roles: ['hr'], kind: 'deadline', title: `Performance review due ${r.dueDate} (${r.period})`, entityType: 'performance_reviews', entityId: r.id, dedupeKey: `review-due:${r.id}:${r.dueDate}` });
      }
      const certs = await t.select().from(certifications).where(and(gte(certifications.expiresOn, today()), lte(certifications.expiresOn, addDays(today(), 30))));
      for (const c of certs) {
        await notify(t, { roles: ['hr'], kind: 'deadline', title: `Certification expiring ${c.expiresOn}: ${c.name}`, entityType: 'employees', entityId: c.employeeId, dedupeKey: `cert:${c.id}:${c.expiresOn}` });
      }
      const docs = await t.select().from(files).where(and(eq(files.entityType, 'employees'), sql`${files.deletedAt} is null`, gte(files.expiresOn, today()), lte(files.expiresOn, addDays(today(), 30))));
      for (const f of docs) {
        await notify(t, { roles: ['hr'], kind: 'deadline', title: `Employee document expiring ${f.expiresOn}: ${f.originalName}`, entityType: 'employees', entityId: f.entityId, dedupeKey: `doc:${f.id}:${f.expiresOn}` });
      }
    }),
  },
);

// ───────────── HR dashboard ─────────────

registerDashboard({
  key: 'hr', perm: 'reports.hr',
  async build(ctx) {
    const active = notInArray(employees.employmentStatus, ['terminated', 'resigned']);
    const [{ total }] = await ctx.db.select({ total: sql<number>`count(*)::int` }).from(employees).where(active);
    const newHires = await ctx.db.select({ id: employees.id, name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`, joinDate: employees.joinDate })
      .from(employees).where(and(active, gte(employees.joinDate, daysAgo(30)))).orderBy(asc(employees.joinDate));
    const probation = await ctx.db.select({ id: employees.id, name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`, probationEndDate: employees.probationEndDate })
      .from(employees).where(eq(employees.employmentStatus, 'probation')).orderBy(asc(employees.probationEndDate));
    const todayRows = await ctx.db.select({ status: attendanceRecords.status, n: sql<number>`count(*)::int` }).from(attendanceRecords).where(eq(attendanceRecords.date, today())).groupBy(attendanceRecords.status);
    const att = Object.fromEntries(todayRows.map((r) => [r.status, r.n]));
    const onLeave = await ctx.db.select({ id: leaveRequests.id, name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`, startDate: leaveRequests.startDate, endDate: leaveRequests.endDate, type: leaveTypes.name })
      .from(leaveRequests).innerJoin(employees, eq(employees.id, leaveRequests.employeeId)).innerJoin(leaveTypes, eq(leaveTypes.id, leaveRequests.leaveTypeId))
      .where(and(eq(leaveRequests.status, 'approved'), lte(leaveRequests.startDate, today()), gte(leaveRequests.endDate, today())));
    const pendingLeave = await ctx.db.select({ n: sql<number>`count(*)::int` }).from(leaveRequests).where(eq(leaveRequests.status, 'pending'));
    const reviews = await ctx.db.select({ id: performanceReviews.id, period: performanceReviews.period, dueDate: performanceReviews.dueDate, status: performanceReviews.status, name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}` })
      .from(performanceReviews).innerJoin(employees, eq(employees.id, performanceReviews.employeeId))
      .where(and(notInArray(performanceReviews.status, ['completed', 'cancelled']), lte(performanceReviews.dueDate, sql`current_date + 30`))).orderBy(asc(performanceReviews.dueDate));
    const openings = await ctx.db.select({ id: jobOpenings.id, title: jobOpenings.title, openings: jobOpenings.openings, hiredCount: jobOpenings.hiredCount,
      applicants: sql<number>`(select count(*)::int from applications a where a.job_opening_id = job_openings.id and a.status = 'active')` })
      .from(jobOpenings).where(eq(jobOpenings.status, 'open'));
    const funnel = await ctx.db.select({ name: pipelineStages.name, key: pipelineStages.key, count: sql<number>`count(${applications.id})::int` }).from(pipelineStages)
      .leftJoin(applications, and(eq(applications.stageId, pipelineStages.id), inArray(applications.status, ['active', 'hired'])))
      .where(eq(pipelineStages.pipeline, 'recruitment')).groupBy(pipelineStages.id).orderBy(pipelineStages.sortOrder);
    const expiring = await ctx.db.select({ id: certifications.id, name: certifications.name, expiresOn: certifications.expiresOn, employeeId: certifications.employeeId, who: sql<string>`(select e.first_name || ' ' || e.last_name from employees e where e.id = certifications.employee_id)` })
      .from(certifications).where(and(gte(certifications.expiresOn, today()), lte(certifications.expiresOn, sql`current_date + 60`)));
    const expiringDocs = await ctx.db.select({ id: files.id, name: files.originalName, expiresOn: files.expiresOn, employeeId: files.entityId })
      .from(files).where(and(eq(files.entityType, 'employees'), sql`${files.deletedAt} is null`, gte(files.expiresOn, today()), lte(files.expiresOn, sql`current_date + 60`)));
    const lateWeek = await ctx.db.select({ name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`, late: sql<number>`count(*)::int` })
      .from(attendanceRecords).innerJoin(employees, eq(employees.id, attendanceRecords.employeeId))
      .where(and(eq(attendanceRecords.status, 'late'), gte(attendanceRecords.date, daysAgo(30)))).groupBy(employees.firstName, employees.lastName).orderBy(sql`count(*) desc`).limit(8);
    const exits12m: any = await ctx.db.execute(sql`select count(*)::int as n from employees where exit_date >= current_date - 365`);
    return {
      total, newHires, probation, attendanceToday: att, onLeave, pendingLeave: pendingLeave[0].n, reviews, openings, funnel, expiring, expiringDocs, lateWeek,
      attritionPct: total ? Math.round((exits12m.rows[0].n / total) * 1000) / 10 : 0, unmarkedToday: Math.max(0, total - todayRows.reduce((a, r) => a + r.n, 0)),
    };
  },
});

