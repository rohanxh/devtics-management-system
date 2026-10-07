import { pgTable, pgEnum, text, date, uuid, index, uniqueIndex, integer, boolean, numeric } from 'drizzle-orm/pg-core';
import { id, timestamps, money, tstz } from './_helpers.ts';
import { users, employees } from './core.ts';
import { companies, contracts } from './crm.ts';
import { projects, milestones } from './projects.ts';
import { subscriptions, infraResources } from './it.ts';

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

// ───────────── Client finance ─────────────

export const invoiceStatus = pgEnum('invoice_status', ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void']);

export const invoices = pgTable('invoices', {
  id: id(),
  number: text().notNull().unique(),
  companyId: uuid().notNull().references(() => companies.id),
  projectId: uuid().references(() => projects.id),
  contractId: uuid().references(() => contracts.id),
  milestoneId: uuid().references(() => milestones.id),
  /** FK added with the support module. */
  maintenancePlanId: uuid(),
  recurringBillingId: uuid(),
  status: invoiceStatus().notNull().default('draft'),
  issueDate: date().notNull(),
  dueDate: date().notNull(),
  currency: text().notNull().default('USD'),
  subtotal: money().notNull().default('0'),
  discountAmount: money().notNull().default('0'),
  taxRate: numeric({ precision: 5, scale: 2 }).notNull().default('0'),
  taxAmount: money().notNull().default('0'),
  total: money().notNull().default('0'),
  amountPaid: money().notNull().default('0'),
  balanceDue: money().notNull().default('0'),
  notes: text(),
  terms: text(),
  sentAt: tstz(),
  paidAt: tstz(),
  voidReason: text(),
  createdById: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('invoices_company_idx').on(t.companyId), index('invoices_project_idx').on(t.projectId), index('invoices_status_due_idx').on(t.status, t.dueDate)]);

export const invoiceItems = pgTable('invoice_items', {
  id: id(),
  invoiceId: uuid().notNull().references(() => invoices.id, { onDelete: 'cascade' }),
  description: text().notNull(),
  quantity: numeric({ precision: 10, scale: 2 }).notNull().default('1'),
  unitPrice: money().notNull(),
  amount: money().notNull().default('0'),
  sortOrder: integer().notNull().default(0),
  ...timestamps,
}, (t) => [index('invoice_items_invoice_idx').on(t.invoiceId)]);

export const paymentMethod = pgEnum('payment_method', ['bank_transfer', 'card', 'cash', 'cheque', 'paypal', 'wise', 'payoneer', 'other']);

export const payments = pgTable('payments', {
  id: id(),
  number: text().notNull().unique(),
  invoiceId: uuid().notNull().references(() => invoices.id),
  companyId: uuid().notNull().references(() => companies.id),
  amount: money().notNull(),
  paidOn: date().notNull(),
  method: paymentMethod().notNull().default('bank_transfer'),
  reference: text(),
  notes: text(),
  recordedById: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('payments_invoice_idx').on(t.invoiceId), index('payments_date_idx').on(t.paidOn)]);

export const billingInterval = pgEnum('billing_interval', ['monthly', 'quarterly', 'yearly']);

/** Recurring billing schedules (retainers, maintenance, hosting re-billing). A job drafts invoices on the next run date. */
export const recurringBilling = pgTable('recurring_billing', {
  id: id(),
  companyId: uuid().notNull().references(() => companies.id),
  projectId: uuid().references(() => projects.id),
  /** FK added with the support module. */
  maintenancePlanId: uuid(),
  description: text().notNull(),
  amount: money().notNull(),
  currency: text().notNull().default('USD'),
  interval: billingInterval().notNull().default('monthly'),
  nextRunDate: date().notNull(),
  dueDays: integer().notNull().default(15),
  active: boolean().notNull().default(true),
  lastRunAt: tstz(),
  ...timestamps,
});

// ───────────── Expenses & payables ─────────────

export const expenseCategory = pgEnum('expense_category', ['infrastructure', 'software', 'contractors', 'marketing', 'office', 'travel', 'equipment', 'taxes_fees', 'other']);
export const expenseStatus = pgEnum('expense_status', ['submitted', 'approved', 'rejected', 'paid']);

export const expenses = pgTable('expenses', {
  id: id(),
  number: text().notNull().unique(),
  category: expenseCategory().notNull().default('other'),
  description: text().notNull(),
  vendor: text(),
  amount: money().notNull(),
  currency: text().notNull().default('USD'),
  expenseDate: date().notNull(),
  /** Payables: when it must be paid. */
  dueDate: date(),
  projectId: uuid().references(() => projects.id),
  companyId: uuid().references(() => companies.id),
  isBillable: boolean().notNull().default(false),
  status: expenseStatus().notNull().default('submitted'),
  submittedById: uuid().references(() => users.id),
  approvedById: uuid().references(() => users.id),
  paidAt: date(),
  subscriptionId: uuid().references(() => subscriptions.id),
  infraResourceId: uuid().references(() => infraResources.id),
  ...timestamps,
}, (t) => [index('expenses_project_idx').on(t.projectId), index('expenses_date_idx').on(t.expenseDate), index('expenses_status_idx').on(t.status)]);

// ───────────── Payroll ─────────────

export const payrollStatus = pgEnum('payroll_status', ['draft', 'approved', 'paid']);

export const payrollRuns = pgTable('payroll_runs', {
  id: id(),
  number: text().notNull().unique(),
  periodStart: date().notNull(),
  periodEnd: date().notNull(),
  status: payrollStatus().notNull().default('draft'),
  totalGross: money().notNull().default('0'),
  totalNet: money().notNull().default('0'),
  createdById: uuid().references(() => users.id),
  approvedById: uuid().references(() => users.id),
  approvedAt: tstz(),
  paidAt: date(),
  notes: text(),
  ...timestamps,
}, (t) => [uniqueIndex('payroll_period_uq').on(t.periodStart, t.periodEnd)]);

export const payrollItems = pgTable('payroll_items', {
  id: id(),
  runId: uuid().notNull().references(() => payrollRuns.id, { onDelete: 'cascade' }),
  employeeId: uuid().notNull().references(() => employees.id),
  baseSalary: money().notNull(),
  allowances: money().notNull().default('0'),
  bonuses: money().notNull().default('0'),
  deductions: money().notNull().default('0'),
  advances: money().notNull().default('0'),
  advanceRecovery: money().notNull().default('0'),
  gross: money().notNull(),
  net: money().notNull(),
  currency: text().notNull().default('USD'),
  notes: text(),
  ...timestamps,
}, (t) => [uniqueIndex('payroll_items_uq').on(t.runId, t.employeeId)]);

export const adjustmentKind = pgEnum('adjustment_kind', ['bonus', 'deduction', 'advance', 'advance_recovery']);
export const adjustmentStatus = pgEnum('adjustment_status', ['pending', 'approved', 'applied', 'cancelled']);

/** Bonuses, deductions and salary advances; approved items are applied by the next payroll run. */
export const employeeAdjustments = pgTable('employee_adjustments', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id),
  kind: adjustmentKind().notNull(),
  amount: money().notNull(),
  effectiveDate: date().notNull(),
  reason: text().notNull(),
  status: adjustmentStatus().notNull().default('pending'),
  approvedById: uuid().references(() => users.id),
  payrollItemId: uuid().references(() => payrollItems.id, { onDelete: 'set null' }),
  ...timestamps,
}, (t) => [index('adjustments_emp_idx').on(t.employeeId, t.status)]);
