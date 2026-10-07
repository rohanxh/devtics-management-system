import { and, eq, or, sql } from 'drizzle-orm';
import {
  applications, attendanceRecords, candidates, certifications, emergencyContacts, employeeJobHistory, employees,
  employeeSkills, goals, initiatives, interviews, jobOpenings, kpis, kpiValues, leaveBalances, leaveRequests, leaveTypes,
  performanceReviews, skills, trainings,
} from '../../db/schema/index.ts';
import { conflict, forbidden, invalid } from '../../core/errors.ts';
import { requestApproval } from '../../core/approvals.ts';
import { notify } from '../../core/notify.ts';
import { can } from '../../rbac/actor.ts';
import { defineResource } from '../registry.ts';
import type { HookCtx } from '../types.ts';
import { ensureBalance, onLeaveCancelled, remaining, workingDays } from '../../modules/hr.ts';

const today = () => new Date().toISOString().slice(0, 10);
const me = (a: { userId: string }) => a.userId;
/** Rows belonging to the actor's own employee record. */
const ownEmp = (column: any, a: { userId: string }) => sql`${column} in (select e.id from employees e where e.user_id = ${a.userId})`;
/** Rows of the actor and their direct reports. */
const teamEmp = (column: any, a: { userId: string }) =>
  sql`${column} in (select e.id from employees e where e.user_id = ${a.userId} or e.manager_id in (select m.id from employees m where m.user_id = ${a.userId}))`;
const empScopes = (column: any) => ({ own: (a: any) => ownEmp(column, a), team: (a: any) => teamEmp(column, a) });

/** Defaults employeeId to the actor's own record; acting for someone else needs the action at "all" or team scope over them. */
async function selfOrAllowed(c: HookCtx, d: Record<string, any>, perm: string) {
  if (!d.employeeId) {
    if (!c.actor.employeeId) throw invalid('Validation failed', { employeeId: 'Your login is not linked to an employee record' });
    d.employeeId = c.actor.employeeId;
  }
  if (d.employeeId === c.actor.employeeId) return;
  const scope = c.actor.perms.get(perm);
  if (scope === 'all') return;
  if (scope === 'team') {
    const [r] = await c.tx.select({ id: employees.id }).from(employees).where(and(eq(employees.id, d.employeeId), teamEmp(employees.id, c.actor)));
    if (r) return;
  }
  throw forbidden('You can only do this for yourself');
}

// ───────────── Employee sub-records ─────────────

defineResource({
  key: 'emergency_contacts', table: emergencyContacts, label: 'Emergency contact', plural: 'Emergency contacts', module: 'people', perm: 'employees_sensitive',
  permissions: { create: 'employees_sensitive.edit', edit: 'employees_sensitive.edit', delete: 'employees_sensitive.edit', export: null },
  titleField: 'name', scopes: empScopes(emergencyContacts.employeeId),
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', createOnly: true, list: true },
    name: { type: 'text', label: 'Name', required: true, list: true },
    relationship: { type: 'text', label: 'Relationship', required: true, list: true },
    phone: { type: 'phone', label: 'Phone', required: true, list: true },
    email: { type: 'email', label: 'Email' },
  },
  hooks: { beforeCreate: (c, d) => selfOrAllowed(c, d, 'employees_sensitive.edit') },
});

defineResource({
  key: 'skills', table: skills, label: 'Skill', plural: 'Skills', module: 'people', perm: 'employees', directory: true,
  permissions: { create: 'employees.edit', edit: 'employees.edit', delete: 'employees.delete' },
  titleField: 'name', defaultSort: 'name', scopes: { own: () => sql`true` },
  fields: {
    name: { type: 'text', label: 'Skill', required: true, list: true, search: true },
    category: { type: 'text', label: 'Category', list: true, filter: true },
  },
  children: [{ resource: 'employee_skills', field: 'skillId', label: 'People with this skill' }],
});

defineResource({
  key: 'employee_skills', table: employeeSkills, label: 'Skill', plural: 'Skills', module: 'people', perm: 'employees',
  titleField: 'level', formatTitle: (r) => `Skill (${r.level})`, scopes: empScopes(employeeSkills.employeeId), permissions: { export: null },
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    skillId: { type: 'ref', ref: 'skills', label: 'Skill', required: true, createOnly: true, list: true, filter: true },
    level: { type: 'enum', label: 'Level', options: ['beginner', 'intermediate', 'advanced', 'expert'], list: true, filter: true, default: 'intermediate' },
  },
});

defineResource({
  key: 'certifications', table: certifications, label: 'Certification', plural: 'Certifications', module: 'people', perm: 'employees',
  titleField: 'name', defaultSort: 'expiresOn', scopes: empScopes(certifications.employeeId),
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    name: { type: 'text', label: 'Certification', required: true, list: true, search: true },
    issuer: { type: 'text', label: 'Issuer', list: true },
    issuedOn: { type: 'date', label: 'Issued' },
    expiresOn: { type: 'date', label: 'Expires', list: true, filter: true },
    credentialUrl: { type: 'url', label: 'Credential link' },
  },
});

defineResource({
  key: 'employee_job_history', table: employeeJobHistory, label: 'Career event', plural: 'Career history', module: 'people', perm: 'employees',
  titleField: 'changeType', defaultSort: '-effectiveDate', scopes: empScopes(employeeJobHistory.employeeId),
  description: 'Hires, promotions and transfers. Recording a promotion/transfer updates the employee’s current department and designation.',
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    effectiveDate: { type: 'date', label: 'Effective', required: true, list: true, default: () => today() },
    changeType: { type: 'enum', label: 'Change', options: ['hire', 'promotion', 'transfer', 'role_change', 'exit'], required: true, list: true, filter: true },
    departmentId: { type: 'ref', ref: 'departments', label: 'Department', list: true },
    designationId: { type: 'ref', ref: 'designations', label: 'Designation', list: true },
    recordedById: { type: 'ref', ref: 'users', label: 'Recorded by', readonly: true },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    beforeCreate(c, d) { d.recordedById = c.actor.userId; },
    async afterCreate(c, row) {
      if (!['promotion', 'transfer', 'role_change'].includes(row.changeType) || row.effectiveDate > today()) return;
      const patch: Record<string, string> = {};
      if (row.departmentId) patch.departmentId = row.departmentId;
      if (row.designationId) patch.designationId = row.designationId;
      if (Object.keys(patch).length) await c.tx.update(employees).set(patch).where(eq(employees.id, row.employeeId));
    },
  },
});

// ───────────── Attendance & leave ─────────────

defineResource({
  key: 'attendance', table: attendanceRecords, label: 'Attendance record', plural: 'Attendance', module: 'people', perm: 'attendance',
  titleField: 'date', formatTitle: (r) => `Attendance ${r.date}`, defaultSort: '-date', scopes: empScopes(attendanceRecords.employeeId),
  description: 'Clock in/out, late arrivals, early departures, overtime and absence.',
  // Employees record attendance through clock in/out; manual entries and corrections need team/all scope.
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    date: { type: 'date', label: 'Date', required: true, createOnly: true, list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['present', 'late', 'absent', 'on_leave', 'holiday', 'remote', 'half_day'], list: true, filter: true, default: 'present' },
    clockIn: { type: 'datetime', label: 'Clock in', list: true },
    clockOut: { type: 'datetime', label: 'Clock out', list: true },
    minutesWorked: { type: 'int', label: 'Minutes worked', list: true, min: 0, max: 1440 },
    lateMinutes: { type: 'int', label: 'Late (min)', list: true, min: 0 },
    earlyLeaveMinutes: { type: 'int', label: 'Left early (min)', min: 0 },
    overtimeMinutes: { type: 'int', label: 'Overtime (min)', list: true, min: 0 },
    source: { type: 'enum', label: 'Source', options: ['web', 'manual', 'system', 'import'], readonly: true, filter: true },
    notes: { type: 'text', label: 'Notes', max: 500 },
  },
  hooks: {
    beforeCreate(c, d) {
      if (c.actor.perms.get('attendance.create') === 'own') throw forbidden('Use clock in / clock out to record your attendance');
      d.source = 'manual';
    },
    beforeUpdate(c, d) {
      if (c.actor.perms.get('attendance.edit') === 'own' || !c.actor.perms.has('attendance.edit')) throw forbidden('Ask HR or your manager to correct attendance');
      d.source = 'manual';
    },
  },
});

defineResource({
  key: 'leave_types', table: leaveTypes, label: 'Leave type', plural: 'Leave types', module: 'people', perm: 'leave', directory: true,
  permissions: { create: 'org.manage', edit: 'org.manage', delete: 'org.manage' },
  titleField: 'name', defaultSort: 'name', scopes: { own: () => sql`true` },
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true },
    code: { type: 'text', label: 'Code', required: true, list: true, max: 10 },
    annualAllowanceDays: { type: 'decimal', label: 'Days per year', required: true, list: true, min: 0, max: 365 },
    isPaid: { type: 'bool', label: 'Paid', list: true, default: true },
    carryForwardMaxDays: { type: 'decimal', label: 'Max carry-forward', min: 0, default: '0' },
    isActive: { type: 'bool', label: 'Active', list: true, default: true },
  },
});

defineResource({
  key: 'leave_balances', table: leaveBalances, label: 'Leave balance', plural: 'Leave balances', module: 'people', perm: 'leave',
  permissions: { create: 'org.manage', edit: 'org.manage', delete: 'org.manage' },
  titleField: 'year', formatTitle: (r) => `Balance ${r.year}`, defaultSort: '-year', scopes: empScopes(leaveBalances.employeeId),
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    leaveTypeId: { type: 'ref', ref: 'leave_types', label: 'Type', required: true, createOnly: true, list: true, filter: true },
    year: { type: 'int', label: 'Year', required: true, createOnly: true, list: true, filter: true },
    allocatedDays: { type: 'decimal', label: 'Allocated', list: true, min: 0 },
    carriedDays: { type: 'decimal', label: 'Carried forward', list: true, min: 0 },
    usedDays: { type: 'decimal', label: 'Used', readonly: true, list: true },
  },
});

defineResource({
  key: 'leave_requests', table: leaveRequests, label: 'Leave request', plural: 'Leave requests', module: 'people', perm: 'leave',
  titleField: 'startDate', formatTitle: (r) => `Leave ${r.startDate} → ${r.endDate}`, defaultSort: '-startDate', collab: { comments: true, files: true },
  description: 'Requests go to the employee’s manager (or HR) for approval; approval updates the balance and attendance.',
  scopes: empScopes(leaveRequests.employeeId), eventFields: ['employeeId'],
  status: { field: 'status', transitions: { pending: ['cancelled'], approved: ['cancelled'], rejected: [], cancelled: [] } },
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', createOnly: true, list: true, filter: true },
    leaveTypeId: { type: 'ref', ref: 'leave_types', label: 'Type', required: true, createOnly: true, list: true, filter: true },
    startDate: { type: 'date', label: 'From', required: true, createOnly: true, list: true, filter: true },
    endDate: { type: 'date', label: 'To', required: true, createOnly: true, list: true },
    halfDay: { type: 'bool', label: 'Half day', createOnly: true, default: false },
    days: { type: 'decimal', label: 'Working days', readonly: true, list: true },
    status: { type: 'enum', label: 'Status', options: ['pending', 'approved', 'rejected', 'cancelled'], list: true, filter: true },
    reason: { type: 'textarea', label: 'Reason' },
    decidedById: { type: 'ref', ref: 'users', label: 'Decided by', readonly: true },
    decidedAt: { type: 'datetime', label: 'Decided', readonly: true },
  },
  hooks: {
    async beforeCreate(c, d) {
      await selfOrAllowed(c, d, 'leave.create');
      if (d.endDate < d.startDate) throw invalid('Validation failed', { endDate: 'End date is before start date' });
      if (d.startDate.slice(0, 4) !== d.endDate.slice(0, 4)) throw invalid('Validation failed', { endDate: 'Split requests that cross a year boundary' });
      const days = await workingDays(c.tx, d.employeeId, d.startDate, d.endDate);
      if (!days.length) throw invalid('Validation failed', { startDate: 'No working days in this range' });
      if (d.halfDay && days.length !== 1) throw invalid('Validation failed', { halfDay: 'Half days must be a single day' });
      d.days = d.halfDay ? '0.5' : String(days.length);
      const overlap = await c.tx.select({ id: leaveRequests.id }).from(leaveRequests).where(and(eq(leaveRequests.employeeId, d.employeeId),
        sql`${leaveRequests.status} in ('pending', 'approved')`, sql`${leaveRequests.startDate} <= ${d.endDate}`, sql`${leaveRequests.endDate} >= ${d.startDate}`)).limit(1);
      if (overlap.length) throw conflict('This overlaps another leave request');
      const [lt] = await c.tx.select().from(leaveTypes).where(eq(leaveTypes.id, d.leaveTypeId));
      if (!lt.isActive) throw invalid('Validation failed', { leaveTypeId: 'This leave type is not available' });
      const bal = await ensureBalance(c.tx, d.employeeId, d.leaveTypeId, Number(d.startDate.slice(0, 4)));
      if (lt.isPaid && remaining(bal) < Number(d.days)) throw invalid('Validation failed', { leaveTypeId: `Not enough balance: ${remaining(bal)} day(s) left` });
      d.status = 'pending';
    },
    async afterCreate(c, row) {
      // Approver: the employee's manager (if they have a login), otherwise HR.
      const [emp] = await c.tx.select().from(employees).where(eq(employees.id, row.employeeId));
      const [mgr] = emp.managerId ? await c.tx.select({ userId: employees.userId }).from(employees).where(eq(employees.id, emp.managerId)) : [];
      const approverUserId = mgr?.userId && mgr.userId !== c.actor.userId ? mgr.userId : undefined;
      const a = await requestApproval(c.tx, {
        kind: 'leave', entityType: 'leave_requests', entityId: row.id, title: `Leave: ${emp.firstName} ${emp.lastName}, ${row.startDate} → ${row.endDate} (${row.days} day(s))`,
        details: row.reason ?? undefined, requestedBy: c.actor.userId, approverUserId, approverRoleKey: approverUserId ? undefined : 'hr',
      });
      await c.tx.update(leaveRequests).set({ approvalId: a.id }).where(eq(leaveRequests.id, row.id));
    },
    async beforeUpdate(c, d, prev) {
      if (d.status === 'cancelled' && prev.status === 'approved' && prev.startDate <= today() && c.actor.perms.get('leave.edit') !== 'all') {
        throw forbidden('Leave that has started can only be cancelled by HR');
      }
    },
    async afterUpdate(c, row, prev) {
      if (row.status === 'cancelled' && prev.status !== 'cancelled') await onLeaveCancelled(c.tx, row as any, prev.status);
    },
  },
});

// ───────────── Performance & training ─────────────

const REVIEW_SELF_FIELDS = new Set(['selfAssessment', 'status']);

defineResource({
  key: 'performance_reviews', table: performanceReviews, label: 'Performance review', plural: 'Performance reviews', module: 'people', perm: 'performance',
  titleField: 'period', formatTitle: (r) => `Review ${r.period}`, defaultSort: 'dueDate', collab: { comments: true, files: true },
  scopes: {
    own: (a) => or(ownEmp(performanceReviews.employeeId, a), eq(performanceReviews.reviewerId, me(a)))!,
    team: (a) => or(teamEmp(performanceReviews.employeeId, a), eq(performanceReviews.reviewerId, me(a)))!,
  },
  assignees: ['reviewerId'], eventFields: ['recommendPromotion', 'recommendSalaryReview'],
  status: { field: 'status', transitions: { scheduled: ['self_review', 'manager_review', 'cancelled'], self_review: ['manager_review', 'cancelled'], manager_review: ['completed', 'self_review', 'cancelled'], completed: [], cancelled: [] } },
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    period: { type: 'text', label: 'Period', required: true, list: true, search: true, help: 'e.g. 2026 H2' },
    reviewerId: { type: 'ref', ref: 'users', label: 'Reviewer', list: true, filter: true },
    dueDate: { type: 'date', label: 'Due', list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['scheduled', 'self_review', 'manager_review', 'completed', 'cancelled'], list: true, filter: true, default: 'scheduled' },
    overallRating: { type: 'int', label: 'Overall rating (1–5)', min: 1, max: 5, list: true },
    recommendPromotion: { type: 'bool', label: 'Recommend promotion', default: false },
    recommendSalaryReview: { type: 'bool', label: 'Recommend salary review', default: false },
    selfAssessment: { type: 'markdown', label: 'Self assessment' },
    managerFeedback: { type: 'markdown', label: 'Manager feedback' },
    strengths: { type: 'textarea', label: 'Strengths' },
    improvements: { type: 'textarea', label: 'Areas to improve' },
    goalsNextPeriod: { type: 'textarea', label: 'Goals for next period' },
    completedAt: { type: 'datetime', label: 'Completed', readonly: true },
  },
  hooks: {
    async beforeUpdate(c, d, prev) {
      const [emp] = await c.tx.select({ userId: employees.userId }).from(employees).where(eq(employees.id, prev.employeeId));
      const isSubject = emp?.userId === c.actor.userId && prev.reviewerId !== c.actor.userId;
      if (isSubject) {
        const bad = Object.keys(d).filter((k) => !REVIEW_SELF_FIELDS.has(k));
        if (bad.length) throw forbidden('You can only write your self assessment');
        if (d.status && !(prev.status === 'self_review' && d.status === 'manager_review')) throw forbidden('You can only submit your self assessment');
      }
      if (d.status === 'completed') {
        if (!(d.overallRating ?? prev.overallRating)) throw invalid('Validation failed', { overallRating: 'Rate the review before completing it' });
        d.completedAt = new Date();
      }
    },
    async afterUpdate(c, row, prev) {
      if (row.status === 'completed' && prev.status !== 'completed' && (row.recommendPromotion || row.recommendSalaryReview)) {
        await notify(c.tx, {
          roles: row.recommendSalaryReview ? ['hr', 'finance'] : ['hr'], kind: 'status',
          title: `Review recommends ${[row.recommendPromotion && 'promotion', row.recommendSalaryReview && 'salary review'].filter(Boolean).join(' & ')}`,
          entityType: 'performance_reviews', entityId: row.id, dedupeKey: `review-reco:${row.id}`,
        });
      }
    },
  },
});

defineResource({
  key: 'trainings', table: trainings, label: 'Training', plural: 'Training', module: 'people', perm: 'performance',
  titleField: 'title', defaultSort: '-startDate', scopes: empScopes(trainings.employeeId),
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    title: { type: 'text', label: 'Training', required: true, list: true, search: true },
    provider: { type: 'text', label: 'Provider', list: true },
    status: { type: 'enum', label: 'Status', options: ['planned', 'in_progress', 'completed', 'cancelled'], list: true, filter: true, default: 'planned' },
    startDate: { type: 'date', label: 'Start', list: true },
    completedOn: { type: 'date', label: 'Completed', list: true },
    cost: { type: 'money', label: 'Cost', min: 0, readPermission: 'expenses.view' },
    notes: { type: 'textarea', label: 'Notes' },
  },
});

// ───────────── Recruitment ─────────────

defineResource({
  key: 'job_openings', table: jobOpenings, label: 'Job opening', plural: 'Job openings', module: 'people', perm: 'recruitment',
  titleField: 'title', defaultSort: '-createdAt', collab: { comments: true },
  scopes: { own: (a) => eq(jobOpenings.hiringManagerId, me(a)) },
  status: { field: 'status', transitions: { draft: ['open'], open: ['on_hold', 'closed', 'filled'], on_hold: ['open', 'closed'], closed: ['open'], filled: ['open'] } },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    departmentId: { type: 'ref', ref: 'departments', label: 'Department', list: true, filter: true },
    designationId: { type: 'ref', ref: 'designations', label: 'Designation' },
    hiringManagerId: { type: 'ref', ref: 'users', label: 'Hiring manager', list: true, filter: true },
    openings: { type: 'int', label: 'Openings', min: 1, max: 100, default: 1, list: true },
    hiredCount: { type: 'int', label: 'Hired', readonly: true, list: true },
    employmentType: { type: 'enum', label: 'Type', options: ['full_time', 'part_time', 'contract', 'intern'], default: 'full_time' },
    location: { type: 'text', label: 'Location' },
    status: { type: 'enum', label: 'Status', options: ['draft', 'open', 'on_hold', 'closed', 'filled'], list: true, filter: true, default: 'draft' },
    postedOn: { type: 'date', label: 'Posted', readonly: true, list: true },
    description: { type: 'markdown', label: 'Job description' },
  },
  children: [{ resource: 'applications', field: 'jobOpeningId', label: 'Candidates' }],
  hooks: {
    beforeUpdate(_c, d, prev) {
      if (d.status === 'open' && !prev.postedOn) d.postedOn = today();
      if (['closed', 'filled'].includes(d.status)) d.closedOn = today();
    },
  },
});

defineResource({
  key: 'candidates', table: candidates, label: 'Candidate', plural: 'Candidates', module: 'people', perm: 'recruitment',
  titleField: 'firstName', titleSql: sql`trim(${candidates.firstName} || ' ' || coalesce(${candidates.lastName}, ''))`,
  formatTitle: (r) => `${r.firstName} ${r.lastName ?? ''}`.trim(), defaultSort: '-createdAt', collab: { comments: true, files: true },
  scopes: { own: (a) => sql`${candidates.id} in (select ap.candidate_id from applications ap join job_openings j on j.id = ap.job_opening_id where j.hiring_manager_id = ${a.userId} or ap.id in (select i.application_id from interviews i where i.interviewer_id = ${a.userId}))` },
  fields: {
    firstName: { type: 'text', label: 'First name', required: true, list: true, search: true },
    lastName: { type: 'text', label: 'Last name', list: true, search: true },
    email: { type: 'email', label: 'Email', required: true, list: true, search: true },
    phone: { type: 'phone', label: 'Phone' },
    source: { type: 'text', label: 'Source', list: true, filter: true },
    currentCompany: { type: 'text', label: 'Current company' },
    linkedinUrl: { type: 'url', label: 'LinkedIn' },
    notes: { type: 'textarea', label: 'Notes' },
  },
  children: [{ resource: 'applications', field: 'candidateId' }],
});

defineResource({
  key: 'applications', table: applications, label: 'Application', plural: 'Applications', module: 'people', perm: 'recruitment',
  titleField: 'appliedOn', formatTitle: (r) => `Application ${r.appliedOn}`, defaultSort: '-appliedOn', board: 'stageId', collab: { comments: true, files: true },
  description: 'Job Opening → Applications → Screening → Interview → Technical Test → Final Interview → Offer → Hired.',
  scopes: { own: (a) => sql`(${applications.jobOpeningId} in (select j.id from job_openings j where j.hiring_manager_id = ${a.userId}) or ${applications.id} in (select i.application_id from interviews i where i.interviewer_id = ${a.userId}))` },
  fields: {
    candidateId: { type: 'ref', ref: 'candidates', label: 'Candidate', required: true, createOnly: true, list: true, filter: true },
    jobOpeningId: { type: 'ref', ref: 'job_openings', label: 'Opening', required: true, createOnly: true, list: true, filter: true },
    stageId: { type: 'stage', pipeline: 'recruitment', label: 'Stage', required: true, list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['active', 'rejected', 'withdrawn', 'hired'], readonly: true, list: true, filter: true },
    rating: { type: 'int', label: 'Rating (1–5)', min: 1, max: 5, list: true },
    appliedOn: { type: 'date', label: 'Applied', required: true, list: true, default: () => today() },
    expectedSalary: { type: 'money', label: 'Expected salary', min: 0, readPermission: 'recruitment.create' },
    rejectionReason: { type: 'text', label: 'Rejection reason' },
    hiredEmployeeId: { type: 'ref', ref: 'employees', label: 'Employee record', readonly: true },
  },
  children: [{ resource: 'interviews', field: 'applicationId' }],
  hooks: {
    async beforeUpdate(c, d, prev) {
      if (prev.status !== 'active' && d.stageId && d.stageId !== prev.stageId) throw conflict('This application is closed');
      if (!d.stageId || d.stageId === prev.stageId) return;
      const res: any = await c.tx.execute(sql`select key from pipeline_stages where id = ${d.stageId}`);
      const key = res.rows[0]?.key;
      if (key === 'rejected') {
        if (!(d.rejectionReason ?? prev.rejectionReason)) throw invalid('Validation failed', { rejectionReason: 'Give a reason when rejecting' });
        d.status = 'rejected';
      }
      if (key === 'hired' && !can(c.actor, 'recruitment.create')) throw forbidden('Only HR can mark a candidate as hired');
    },
  },
});

defineResource({
  key: 'interviews', table: interviews, label: 'Interview', plural: 'Interviews', module: 'people', perm: 'recruitment',
  titleField: 'kind', formatTitle: (r) => `${String(r.kind).replace('_', ' ')} interview`, defaultSort: 'scheduledAt',
  scopes: { own: (a) => eq(interviews.interviewerId, me(a)) }, assignees: ['interviewerId'],
  fields: {
    applicationId: { type: 'ref', ref: 'applications', label: 'Application', required: true, createOnly: true, list: true, filter: true },
    kind: { type: 'enum', label: 'Round', options: ['screening', 'interview', 'technical_test', 'final_interview'], list: true, filter: true, default: 'interview' },
    scheduledAt: { type: 'datetime', label: 'When', required: true, list: true, filter: true },
    interviewerId: { type: 'ref', ref: 'users', label: 'Interviewer', list: true, filter: true },
    outcome: { type: 'enum', label: 'Outcome', options: ['pending', 'pass', 'fail', 'no_show'], list: true, filter: true, default: 'pending' },
    score: { type: 'int', label: 'Score (1–10)', min: 1, max: 10, list: true },
    feedback: { type: 'markdown', label: 'Feedback' },
  },
});

// ───────────── Strategy ─────────────

defineResource({
  key: 'goals', table: goals, label: 'Goal', plural: 'Goals & OKRs', module: 'strategy', perm: 'goals',
  titleField: 'title', defaultSort: '-period', collab: { comments: true },
  description: 'Company goals, quarterly objectives & key results, department and individual goals, revenue and growth targets.',
  scopes: { own: (a) => or(eq(goals.ownerId, me(a)), ownEmp(goals.employeeId, a), eq(goals.level, 'company'))! },
  assignees: ['ownerId'],
  fields: {
    title: { type: 'text', label: 'Goal', required: true, list: true, search: true },
    level: { type: 'enum', label: 'Level', options: ['company', 'department', 'team', 'individual'], list: true, filter: true, default: 'company' },
    kind: { type: 'enum', label: 'Type', options: ['objective', 'key_result', 'revenue_target', 'growth_target'], list: true, filter: true, default: 'objective' },
    period: { type: 'text', label: 'Period', required: true, list: true, filter: true, help: 'e.g. 2026-Q4 or 2026' },
    status: { type: 'enum', label: 'Status', options: ['not_started', 'on_track', 'at_risk', 'behind', 'achieved', 'missed'], list: true, filter: true, default: 'not_started' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true },
    parentGoalId: { type: 'ref', ref: 'goals', label: 'Contributes to', filter: true },
    departmentId: { type: 'ref', ref: 'departments', label: 'Department', filter: true },
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee (individual goals)' },
    unit: { type: 'text', label: 'Unit', max: 20 },
    startValue: { type: 'decimal', label: 'Start value' },
    targetValue: { type: 'decimal', label: 'Target', list: true },
    currentValue: { type: 'decimal', label: 'Current', list: true },
    metricKey: { type: 'enum', label: 'Measure automatically from', options: ['revenue_month', 'revenue_ytd', 'profit_margin_month', 'mrr', 'new_clients_quarter', 'win_rate_pct', 'utilization_pct', 'on_time_delivery_pct', 'open_bugs', 'headcount', 'attrition_pct', 'new_leads_month'] },
    startDate: { type: 'date', label: 'Start' },
    endDate: { type: 'date', label: 'End', list: true },
    description: { type: 'textarea', label: 'Description' },
  },
  children: [{ resource: 'goals', field: 'parentGoalId', label: 'Key results / sub-goals' }, { resource: 'initiatives', field: 'goalId' }],
});

defineResource({
  key: 'kpis', table: kpis, label: 'KPI', plural: 'KPIs', module: 'strategy', perm: 'goals',
  titleField: 'name', defaultSort: 'name',
  description: 'Department KPIs. KPIs with a metric are measured automatically every day from live data.',
  fields: {
    name: { type: 'text', label: 'KPI', required: true, list: true, search: true },
    departmentId: { type: 'ref', ref: 'departments', label: 'Department', list: true, filter: true },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true },
    unit: { type: 'text', label: 'Unit', list: true, max: 20 },
    direction: { type: 'enum', label: 'Better when', options: ['higher_is_better', 'lower_is_better'], default: 'higher_is_better' },
    target: { type: 'decimal', label: 'Target', list: true },
    frequency: { type: 'enum', label: 'Frequency', options: ['weekly', 'monthly', 'quarterly'], default: 'monthly' },
    metricKey: { type: 'enum', label: 'Automatic metric', list: true, options: ['revenue_month', 'revenue_ytd', 'profit_margin_month', 'mrr', 'new_clients_quarter', 'win_rate_pct', 'utilization_pct', 'on_time_delivery_pct', 'open_bugs', 'headcount', 'attrition_pct', 'new_leads_month'] },
    description: { type: 'textarea', label: 'Definition' },
  },
  children: [{ resource: 'kpi_values', field: 'kpiId', label: 'History' }],
});

defineResource({
  key: 'kpi_values', table: kpiValues, label: 'KPI value', plural: 'KPI values', module: 'strategy', perm: 'goals',
  titleField: 'periodStart', formatTitle: (r) => `${r.periodStart}: ${r.value}`, defaultSort: '-periodStart', permissions: { export: 'goals.view' },
  fields: {
    kpiId: { type: 'ref', ref: 'kpis', label: 'KPI', required: true, createOnly: true, list: true, filter: true },
    periodStart: { type: 'date', label: 'Period start', required: true, list: true },
    periodEnd: { type: 'date', label: 'Period end', required: true, list: true },
    value: { type: 'decimal', label: 'Value', required: true, list: true },
    note: { type: 'text', label: 'Note' },
  },
});

defineResource({
  key: 'initiatives', table: initiatives, label: 'Initiative', plural: 'Strategic initiatives', module: 'strategy', perm: 'goals',
  titleField: 'title', defaultSort: '-startDate', collab: { comments: true, files: true }, assignees: ['ownerId'],
  fields: {
    title: { type: 'text', label: 'Initiative', required: true, list: true, search: true },
    status: { type: 'enum', label: 'Status', options: ['proposed', 'active', 'on_hold', 'completed', 'cancelled'], list: true, filter: true, default: 'proposed' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true },
    goalId: { type: 'ref', ref: 'goals', label: 'Supports goal' },
    progressPct: { type: 'percent', label: 'Progress', list: true, default: 0 },
    startDate: { type: 'date', label: 'Start', list: true },
    endDate: { type: 'date', label: 'End', list: true },
    budget: { type: 'money', label: 'Budget', min: 0, readPermission: 'expenses.view' },
    description: { type: 'markdown', label: 'Description' },
  },
});
