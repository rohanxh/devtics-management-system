import { pgTable, pgEnum, text, boolean, integer, date, uuid, index, uniqueIndex, numeric } from 'drizzle-orm/pg-core';
import { id, timestamps, money, tstz } from './_helpers.ts';
import { users, departments } from './core.ts';
import { companies, contacts } from './crm.ts';
import { projects, tasks } from './projects.ts';
import { bugs } from './engineering.ts';

export const slaPolicies = pgTable('sla_policies', {
  id: id(),
  name: text().notNull().unique(),
  description: text(),
  isDefault: boolean().notNull().default(false),
  ...timestamps,
});

export const ticketPriority = pgEnum('ticket_priority', ['low', 'medium', 'high', 'urgent']);

/** Response / resolution targets per priority (wall-clock minutes). */
export const slaTargets = pgTable('sla_targets', {
  id: id(),
  policyId: uuid().notNull().references(() => slaPolicies.id, { onDelete: 'cascade' }),
  priority: ticketPriority().notNull(),
  firstResponseMinutes: integer().notNull(),
  resolutionMinutes: integer().notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('sla_targets_uq').on(t.policyId, t.priority)]);

export const planStatus = pgEnum('maintenance_plan_status', ['active', 'paused', 'cancelled', 'expired']);

export const maintenancePlans = pgTable('maintenance_plans', {
  id: id(),
  name: text().notNull(),
  companyId: uuid().notNull().references(() => companies.id),
  projectId: uuid().references(() => projects.id),
  status: planStatus().notNull().default('active'),
  monthlyHours: numeric({ precision: 6, scale: 2 }).notNull(),
  monthlyFee: money().notNull(),
  currency: text().notNull().default('USD'),
  overageRate: money(),
  includedServices: text(),
  slaPolicyId: uuid().references(() => slaPolicies.id),
  startDate: date().notNull(),
  endDate: date(),
  accountManagerId: uuid().references(() => users.id),
  ...timestamps,
});

export const ticketType = pgEnum('ticket_type', ['bug', 'change_request', 'question', 'incident', 'maintenance']);
export const ticketStatus = pgEnum('ticket_status', ['new', 'triaged', 'assigned', 'in_development', 'in_qa', 'waiting_for_client', 'resolved', 'closed']);
export const ticketSource = pgEnum('ticket_source', ['email', 'phone', 'portal', 'chat', 'internal']);

/** Client → Project → Issue → Priority → Assigned team → Development → QA → Resolved. */
export const tickets = pgTable('tickets', {
  id: id(),
  number: text().notNull().unique(),
  companyId: uuid().notNull().references(() => companies.id),
  projectId: uuid().references(() => projects.id),
  maintenancePlanId: uuid().references(() => maintenancePlans.id),
  contactId: uuid().references(() => contacts.id),
  title: text().notNull(),
  description: text(),
  type: ticketType().notNull().default('question'),
  priority: ticketPriority().notNull().default('medium'),
  status: ticketStatus().notNull().default('new'),
  source: ticketSource().notNull().default('email'),
  assignedDepartmentId: uuid().references(() => departments.id),
  assigneeId: uuid().references(() => users.id),
  firstResponseDueAt: tstz(),
  resolutionDueAt: tstz(),
  firstRespondedAt: tstz(),
  resolvedAt: tstz(),
  closedAt: tstz(),
  slaBreached: boolean().notNull().default(false),
  breachedAt: tstz(),
  taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  bugId: uuid().references(() => bugs.id, { onDelete: 'set null' }),
  satisfaction: integer(),
  ...timestamps,
}, (t) => [index('tickets_company_idx').on(t.companyId), index('tickets_status_idx').on(t.status, t.priority), index('tickets_assignee_idx').on(t.assigneeId)]);
