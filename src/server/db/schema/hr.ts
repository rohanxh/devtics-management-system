import { pgTable, pgEnum, text, boolean, integer, date, uuid, index, uniqueIndex, numeric, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, money, tstz } from './_helpers.ts';
import { users, employees, departments, designations, pipelineStages, approvals, employmentType } from './core.ts';

// ───────────── Employee records ─────────────

export const emergencyContacts = pgTable('emergency_contacts', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  relationship: text().notNull(),
  phone: text().notNull(),
  email: text(),
  ...timestamps,
}, (t) => [index('emergency_emp_idx').on(t.employeeId)]);

export const skills = pgTable('skills', {
  id: id(),
  name: text().notNull().unique(),
  category: text(),
  ...timestamps,
});

export const skillLevel = pgEnum('skill_level', ['beginner', 'intermediate', 'advanced', 'expert']);

export const employeeSkills = pgTable('employee_skills', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  skillId: uuid().notNull().references(() => skills.id, { onDelete: 'cascade' }),
  level: skillLevel().notNull().default('intermediate'),
  ...timestamps,
}, (t) => [uniqueIndex('employee_skills_uq').on(t.employeeId, t.skillId)]);

export const certifications = pgTable('certifications', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  issuer: text(),
  issuedOn: date(),
  expiresOn: date(),
  credentialUrl: text(),
  ...timestamps,
}, (t) => [index('certs_emp_idx').on(t.employeeId)]);

export const jobChangeType = pgEnum('job_change_type', ['hire', 'promotion', 'transfer', 'role_change', 'exit']);

/** Career history: hires, promotions, transfers (salary changes live in employee_compensation). */
export const employeeJobHistory = pgTable('employee_job_history', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  effectiveDate: date().notNull(),
  changeType: jobChangeType().notNull(),
  departmentId: uuid().references(() => departments.id),
  designationId: uuid().references(() => designations.id),
  notes: text(),
  recordedById: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('job_history_emp_idx').on(t.employeeId)]);

// ───────────── Attendance ─────────────

export const attendanceStatus = pgEnum('attendance_status', ['present', 'late', 'absent', 'on_leave', 'holiday', 'remote', 'half_day']);
export const attendanceSource = pgEnum('attendance_source', ['web', 'manual', 'system', 'import']);

export const attendanceRecords = pgTable('attendance_records', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  date: date().notNull(),
  clockIn: tstz(),
  clockOut: tstz(),
  status: attendanceStatus().notNull().default('present'),
  minutesWorked: integer().notNull().default(0),
  lateMinutes: integer().notNull().default(0),
  earlyLeaveMinutes: integer().notNull().default(0),
  overtimeMinutes: integer().notNull().default(0),
  source: attendanceSource().notNull().default('web'),
  notes: text(),
  ...timestamps,
}, (t) => [uniqueIndex('attendance_emp_date_uq').on(t.employeeId, t.date), index('attendance_date_idx').on(t.date)]);

// ───────────── Leave ─────────────

export const leaveTypes = pgTable('leave_types', {
  id: id(),
  name: text().notNull().unique(),
  code: text().notNull().unique(),
  annualAllowanceDays: numeric({ precision: 5, scale: 1 }).notNull().default('0'),
  isPaid: boolean().notNull().default(true),
  carryForwardMaxDays: numeric({ precision: 5, scale: 1 }).notNull().default('0'),
  isActive: boolean().notNull().default(true),
  ...timestamps,
});

export const leaveBalances = pgTable('leave_balances', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  leaveTypeId: uuid().notNull().references(() => leaveTypes.id),
  year: integer().notNull(),
  allocatedDays: numeric({ precision: 5, scale: 1 }).notNull().default('0'),
  carriedDays: numeric({ precision: 5, scale: 1 }).notNull().default('0'),
  usedDays: numeric({ precision: 5, scale: 1 }).notNull().default('0'),
  ...timestamps,
}, (t) => [uniqueIndex('leave_balance_uq').on(t.employeeId, t.leaveTypeId, t.year)]);

export const leaveStatus = pgEnum('leave_status', ['pending', 'approved', 'rejected', 'cancelled']);

export const leaveRequests = pgTable('leave_requests', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  leaveTypeId: uuid().notNull().references(() => leaveTypes.id),
  startDate: date().notNull(),
  endDate: date().notNull(),
  halfDay: boolean().notNull().default(false),
  /** Working days requested (weekends and holidays excluded). */
  days: numeric({ precision: 5, scale: 1 }).notNull(),
  reason: text(),
  status: leaveStatus().notNull().default('pending'),
  approvalId: uuid().references(() => approvals.id),
  decidedById: uuid().references(() => users.id),
  decidedAt: tstz(),
  ...timestamps,
}, (t) => [index('leave_emp_idx').on(t.employeeId, t.startDate), index('leave_status_idx').on(t.status)]);

// ───────────── Performance & development ─────────────

export const reviewStatusHr = pgEnum('performance_review_status', ['scheduled', 'self_review', 'manager_review', 'completed', 'cancelled']);

export const performanceReviews = pgTable('performance_reviews', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  reviewerId: uuid().references(() => users.id),
  period: text().notNull(),
  dueDate: date(),
  status: reviewStatusHr().notNull().default('scheduled'),
  selfAssessment: text(),
  managerFeedback: text(),
  strengths: text(),
  improvements: text(),
  goalsNextPeriod: text(),
  overallRating: integer(),
  /** Outcome flags feeding promotions and salary reviews. */
  recommendPromotion: boolean().notNull().default(false),
  recommendSalaryReview: boolean().notNull().default(false),
  completedAt: tstz(),
  ...timestamps,
}, (t) => [index('reviews_emp_idx').on(t.employeeId)]);

export const trainingStatus = pgEnum('training_status', ['planned', 'in_progress', 'completed', 'cancelled']);

export const trainings = pgTable('trainings', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  provider: text(),
  status: trainingStatus().notNull().default('planned'),
  startDate: date(),
  completedOn: date(),
  cost: money(),
  notes: text(),
  ...timestamps,
});

// ───────────── Recruitment ─────────────

export const openingStatus = pgEnum('job_opening_status', ['draft', 'open', 'on_hold', 'closed', 'filled']);

export const jobOpenings = pgTable('job_openings', {
  id: id(),
  title: text().notNull(),
  departmentId: uuid().references(() => departments.id),
  designationId: uuid().references(() => designations.id),
  hiringManagerId: uuid().references(() => users.id),
  openings: integer().notNull().default(1),
  hiredCount: integer().notNull().default(0),
  employmentType: employmentType().notNull().default('full_time'),
  location: text(),
  status: openingStatus().notNull().default('draft'),
  description: text(),
  postedOn: date(),
  closedOn: date(),
  ...timestamps,
});

export const candidates = pgTable('candidates', {
  id: id(),
  firstName: text().notNull(),
  lastName: text(),
  email: text().notNull(),
  phone: text(),
  source: text(),
  linkedinUrl: text(),
  currentCompany: text(),
  notes: text(),
  ...timestamps,
}, (t) => [uniqueIndex('candidates_email_uq').on(t.email)]);

export const applicationStatus = pgEnum('application_status', ['active', 'rejected', 'withdrawn', 'hired']);

export const applications = pgTable('applications', {
  id: id(),
  jobOpeningId: uuid().notNull().references(() => jobOpenings.id, { onDelete: 'cascade' }),
  candidateId: uuid().notNull().references(() => candidates.id, { onDelete: 'cascade' }),
  stageId: uuid().notNull().references(() => pipelineStages.id),
  status: applicationStatus().notNull().default('active'),
  rating: integer(),
  expectedSalary: money(),
  appliedOn: date().notNull(),
  rejectionReason: text(),
  hiredEmployeeId: uuid().references((): AnyPgColumn => employees.id),
  ...timestamps,
}, (t) => [uniqueIndex('applications_uq').on(t.jobOpeningId, t.candidateId), index('applications_stage_idx').on(t.stageId)]);

export const interviewKind = pgEnum('interview_kind', ['screening', 'interview', 'technical_test', 'final_interview']);
export const interviewOutcome = pgEnum('interview_outcome', ['pending', 'pass', 'fail', 'no_show']);

export const interviews = pgTable('interviews', {
  id: id(),
  applicationId: uuid().notNull().references(() => applications.id, { onDelete: 'cascade' }),
  kind: interviewKind().notNull().default('interview'),
  scheduledAt: tstz().notNull(),
  interviewerId: uuid().references(() => users.id),
  outcome: interviewOutcome().notNull().default('pending'),
  score: integer(),
  feedback: text(),
  ...timestamps,
}, (t) => [index('interviews_app_idx').on(t.applicationId)]);
