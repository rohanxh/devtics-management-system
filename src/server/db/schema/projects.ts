import {
  pgTable, pgEnum, text, boolean, integer, date, uuid, uniqueIndex, index, numeric, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { id, timestamps, money, tstz } from './_helpers.ts';
import { users, pipelineStages } from './core.ts';
import { companies, contacts, opportunities, contracts } from './crm.ts';
import { projectType } from './enums.ts';

export const projectStatus = pgEnum('project_status', [
  'on_track', 'at_risk', 'delayed', 'awaiting_client', 'awaiting_design', 'awaiting_development',
  'in_qa', 'ready_for_launch', 'on_hold', 'completed', 'cancelled',
]);
export const priority = pgEnum('priority', ['low', 'medium', 'high', 'critical']);
export const billingType = pgEnum('billing_type', ['fixed', 'hourly', 'retainer', 'internal']);

export const projects = pgTable('projects', {
  id: id(),
  code: text().notNull().unique(),
  name: text().notNull(),
  clientId: uuid().references(() => companies.id),
  opportunityId: uuid().references(() => opportunities.id),
  contractId: uuid().references(() => contracts.id),
  type: projectType().notNull().default('website'),
  description: text(),
  /** Lifecycle stage (configurable pipeline "project"). */
  stageId: uuid().notNull().references(() => pipelineStages.id),
  /** Delivery status shown on the PM pipeline board. */
  status: projectStatus().notNull().default('on_track'),
  priority: priority().notNull().default('medium'),
  pmId: uuid().references(() => users.id),
  techLeadId: uuid().references(() => users.id),
  startDate: date(),
  dueDate: date(),
  actualEndDate: date(),
  billingType: billingType().notNull().default('fixed'),
  /** Contract value (fixed) or expected revenue. */
  budgetAmount: money(),
  budgetHours: numeric({ precision: 10, scale: 2 }),
  currency: text().notNull().default('USD'),
  isInternal: boolean().notNull().default(false),
  qaApprovedAt: tstz(),
  launchedAt: tstz(),
  createdBy: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [
  index('projects_client_idx').on(t.clientId), index('projects_pm_idx').on(t.pmId),
  index('projects_stage_idx').on(t.stageId), index('projects_status_idx').on(t.status),
]);

export const projectMembers = pgTable('project_members', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id),
  role: text().notNull().default('developer'),
  allocationPct: integer().notNull().default(100),
  startDate: date(),
  endDate: date(),
  ...timestamps,
}, (t) => [uniqueIndex('project_members_uq').on(t.projectId, t.userId), index('project_members_user_idx').on(t.userId)]);

export const milestoneStatus = pgEnum('milestone_status', ['planned', 'in_progress', 'completed', 'missed']);

export const milestones = pgTable('milestones', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  description: text(),
  dueDate: date(),
  status: milestoneStatus().notNull().default('planned'),
  completedAt: date(),
  /** Amount billable when this milestone completes. */
  billingAmount: money(),
  sortOrder: integer().notNull().default(0),
  ...timestamps,
}, (t) => [index('milestones_project_idx').on(t.projectId)]);

export const taskStatus = pgEnum('task_status', ['todo', 'in_progress', 'in_review', 'qa', 'done', 'blocked']);
export const taskType = pgEnum('task_type', ['feature', 'task', 'design', 'content', 'research', 'devops', 'seo', 'support', 'onboarding']);

export const tasks = pgTable('tasks', {
  id: id(),
  number: text().notNull().unique(),
  /** Null for internal (non-project) work. */
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  milestoneId: uuid().references(() => milestones.id, { onDelete: 'set null' }),
  parentTaskId: uuid().references((): AnyPgColumn => tasks.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  description: text(),
  type: taskType().notNull().default('task'),
  status: taskStatus().notNull().default('todo'),
  priority: priority().notNull().default('medium'),
  assigneeId: uuid().references(() => users.id),
  reporterId: uuid().references(() => users.id),
  startDate: date(),
  dueDate: date(),
  estimateHours: numeric({ precision: 8, scale: 2 }),
  completedAt: tstz(),
  /** True when work had to be redone (reopened or rejected by QA). */
  isRework: boolean().notNull().default(false),
  qaRejections: integer().notNull().default(0),
  tags: text().array(),
  sortOrder: integer().notNull().default(0),
  ...timestamps,
}, (t) => [
  index('tasks_project_idx').on(t.projectId), index('tasks_assignee_idx').on(t.assigneeId, t.status),
  index('tasks_parent_idx').on(t.parentTaskId), index('tasks_due_idx').on(t.dueDate),
]);

export const taskDependencies = pgTable('task_dependencies', {
  id: id(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnTaskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  ...timestamps,
}, (t) => [uniqueIndex('task_deps_uq').on(t.taskId, t.dependsOnTaskId)]);

export const taskChecklistItems = pgTable('task_checklist_items', {
  id: id(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  label: text().notNull(),
  isDone: boolean().notNull().default(false),
  doneById: uuid().references(() => users.id),
  doneAt: tstz(),
  sortOrder: integer().notNull().default(0),
  ...timestamps,
}, (t) => [index('checklist_task_idx').on(t.taskId)]);

export const timeEntries = pgTable('time_entries', {
  id: id(),
  userId: uuid().notNull().references(() => users.id),
  projectId: uuid().references(() => projects.id),
  taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  /** FK added with the support module. */
  ticketId: uuid(),
  workDate: date().notNull(),
  minutes: integer().notNull(),
  description: text(),
  billable: boolean().notNull().default(true),
  /** Employee cost snapshot (hourly cost × hours) at the time of logging — basis for profitability. */
  costAmount: money(),
  ...timestamps,
}, (t) => [index('time_user_date_idx').on(t.userId, t.workDate), index('time_project_idx').on(t.projectId), index('time_task_idx').on(t.taskId)]);

export const riskKind = pgEnum('risk_kind', ['risk', 'issue']);
export const level3 = pgEnum('level3', ['low', 'medium', 'high']);
export const riskStatus = pgEnum('risk_status', ['open', 'mitigating', 'resolved', 'accepted', 'closed']);

/** Risks & issues. project_id NULL = company-level risk (strategy risk register). */
export const risks = pgTable('risks', {
  id: id(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  kind: riskKind().notNull().default('risk'),
  title: text().notNull(),
  description: text(),
  probability: level3().notNull().default('medium'),
  impact: priority().notNull().default('medium'),
  status: riskStatus().notNull().default('open'),
  ownerId: uuid().references(() => users.id),
  mitigation: text(),
  dueDate: date(),
  resolvedAt: date(),
  ...timestamps,
}, (t) => [index('risks_project_idx').on(t.projectId)]);

export const crStatus = pgEnum('change_request_status', ['draft', 'submitted', 'approved', 'rejected', 'implemented', 'cancelled']);

export const changeRequests = pgTable('change_requests', {
  id: id(),
  number: text().notNull().unique(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  description: text(),
  requestedByContactId: uuid().references(() => contacts.id),
  status: crStatus().notNull().default('draft'),
  priority: priority().notNull().default('medium'),
  impactHours: numeric({ precision: 8, scale: 2 }),
  impactCost: money(),
  impactDays: integer(),
  /** Major change requests require CTO approval; others are approved by the PM. */
  isMajor: boolean().notNull().default(false),
  decidedAt: tstz(),
  createdBy: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('crs_project_idx').on(t.projectId)]);

export const meetingKind = pgEnum('meeting_kind', ['internal', 'client']);

export const meetingNotes = pgTable('meeting_notes', {
  id: id(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  kind: meetingKind().notNull().default('internal'),
  meetingDate: date().notNull(),
  attendees: text(),
  notes: text(),
  actionItems: text(),
  createdBy: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('meetings_project_idx').on(t.projectId)]);

export const updateKind = pgEnum('project_update_kind', ['daily', 'weekly', 'escalation', 'client_update']);
export const healthLevel = pgEnum('health_level', ['on_track', 'at_risk', 'delayed']);

/** Daily updates, weekly reports, client updates and escalations. */
export const projectUpdates = pgTable('project_updates', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  kind: updateKind().notNull().default('daily'),
  title: text().notNull(),
  body: text(),
  health: healthLevel(),
  authorId: uuid().references(() => users.id),
  /** Escalations: who it is escalated to, and when it was resolved. */
  escalateToRole: text(),
  resolvedAt: tstz(),
  ...timestamps,
}, (t) => [index('updates_project_idx').on(t.projectId, t.createdAt)]);

export const feedbackKind = pgEnum('feedback_kind', ['review_request', 'feedback', 'testimonial', 'complaint']);
export const feedbackStatus = pgEnum('feedback_status', ['requested', 'received', 'overdue', 'closed']);

/** Client feedback & approvals requested from the client (drives "feedback delays" health signal). */
export const clientFeedback = pgTable('client_feedback', {
  id: id(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  companyId: uuid().notNull().references(() => companies.id),
  milestoneId: uuid().references(() => milestones.id),
  kind: feedbackKind().notNull().default('review_request'),
  title: text().notNull(),
  status: feedbackStatus().notNull().default('requested'),
  requestedAt: date(),
  dueDate: date(),
  receivedAt: date(),
  rating: integer(),
  comments: text(),
  ...timestamps,
}, (t) => [index('feedback_company_idx').on(t.companyId), index('feedback_project_idx').on(t.projectId)]);

export const onboardingStatus = pgEnum('onboarding_status', ['bd_handover', 'pm_review', 'cto_review', 'development_kickoff', 'completed', 'cancelled']);

/** Won deal → project onboarding workflow: BD → PM → CTO → Development. */
export const projectOnboardings = pgTable('project_onboardings', {
  id: id(),
  opportunityId: uuid().notNull().unique().references(() => opportunities.id),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  companyId: uuid().notNull().references(() => companies.id),
  status: onboardingStatus().notNull().default('bd_handover'),
  bdOwnerId: uuid().references(() => users.id),
  handoverNotes: text(),
  pmNotes: text(),
  ctoNotes: text(),
  completedAt: tstz(),
  ...timestamps,
});
