import { pgTable, pgEnum, text, date, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, money } from './_helpers.ts';
import { users, employees } from './core.ts';

export const compensationReason = pgEnum('compensation_reason', ['hire', 'annual_review', 'promotion', 'adjustment', 'correction']);

/** Salary history (effective-dated). The latest row on or before a date is the salary in force. */
export const employeeCompensation = pgTable('employee_compensation', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id, { onDelete: 'cascade' }),
  effectiveFrom: date().notNull(),
  /** Monthly base salary. */
  baseSalary: money().notNull(),
  allowances: money().notNull().default('0'),
  currency: text().notNull().default('USD'),
  /** Fully-loaded hourly cost used for project costing (derived from salary if not set explicitly). */
  hourlyCost: money().notNull(),
  reason: compensationReason().notNull().default('hire'),
  notes: text(),
  approvedById: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [uniqueIndex('compensation_emp_date_uq').on(t.employeeId, t.effectiveFrom), index('compensation_emp_idx').on(t.employeeId)]);
