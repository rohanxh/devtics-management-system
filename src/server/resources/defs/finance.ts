import { eq, sql } from 'drizzle-orm';
import {
  employeeAdjustments, employeeCompensation, expenses, invoiceItems, invoices, payments, payrollItems,
  payrollRuns, recurringBilling,
} from '../../db/schema/index.ts';
import { conflict, forbidden, invalid } from '../../core/errors.ts';
import { can } from '../../rbac/actor.ts';
import { defineResource } from '../registry.ts';
import { inManagedProjects } from '../scopes.ts';
import type { HookCtx } from '../types.ts';
import { recalcInvoice } from '../../modules/finance.ts';
import { getSettings } from '../../modules/settings.ts';

const today = () => new Date().toISOString().slice(0, 10);
const me = (a: { userId: string }) => a.userId;
const ownEmployee = (column: any, a: { userId: string }) => sql`${column} in (select e.id from employees e where e.user_id = ${a.userId})`;
const CURRENCY = { type: 'text', label: 'Currency', max: 3, default: 'USD' } as const;

async function invoiceEditable(c: HookCtx, invoiceId: string) {
  const [i] = await c.tx.select({ status: invoices.status }).from(invoices).where(eq(invoices.id, invoiceId));
  if (i && i.status !== 'draft') throw conflict('Only draft invoices can be changed. Void and re-issue instead.');
}

defineResource({
  key: 'invoices', table: invoices, label: 'Invoice', plural: 'Invoices', module: 'finance', perm: 'invoices',
  titleField: 'number', defaultSort: '-issueDate', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'invoice', prefix: 'INV-', pad: 5 },
  description: 'Client invoices. Payment status (partially paid, paid, overdue) is derived from recorded payments.',
  scopes: { own: (a) => inManagedProjects(invoices.projectId, a) },
  eventFields: ['companyId', 'projectId'],
  status: { field: 'status', transitions: { draft: ['sent', 'void'], sent: ['void'], overdue: ['void'], partially_paid: [], paid: [], void: [] } },
  fields: {
    companyId: { type: 'ref', ref: 'clients', label: 'Client', required: true, createOnly: true, list: true, filter: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['draft', 'sent', 'partially_paid', 'paid', 'overdue', 'void'], list: true, filter: true },
    issueDate: { type: 'date', label: 'Issue date', required: true, list: true, filter: true, default: () => today() },
    dueDate: { type: 'date', label: 'Due date', list: true, filter: true },
    currency: CURRENCY,
    discountAmount: { type: 'money', label: 'Discount', min: 0, default: '0', group: 'Amounts' },
    taxRate: { type: 'percent', label: 'Tax rate', group: 'Amounts' },
    subtotal: { type: 'money', label: 'Subtotal', readonly: true, group: 'Amounts' },
    taxAmount: { type: 'money', label: 'Tax', readonly: true, group: 'Amounts' },
    total: { type: 'money', label: 'Total', readonly: true, list: true, group: 'Amounts' },
    amountPaid: { type: 'money', label: 'Paid', readonly: true, group: 'Amounts' },
    balanceDue: { type: 'money', label: 'Balance due', readonly: true, list: true, group: 'Amounts' },
    contractId: { type: 'ref', ref: 'contracts', label: 'Contract / SOW' },
    milestoneId: { type: 'ref', ref: 'milestones', label: 'Milestone', readonly: true },
    voidReason: { type: 'text', label: 'Void reason' },
    notes: { type: 'textarea', label: 'Notes to client' },
    terms: { type: 'textarea', label: 'Payment terms' },
    sentAt: { type: 'datetime', label: 'Sent', readonly: true },
    paidAt: { type: 'datetime', label: 'Paid in full', readonly: true },
  },
  children: [{ resource: 'invoice_items', field: 'invoiceId', label: 'Line items' }, { resource: 'payments', field: 'invoiceId' }],
  hooks: {
    async beforeCreate(c, d) {
      d.createdById = c.actor.userId;
      const s = await getSettings(c.tx);
      if (d.taxRate === undefined || d.taxRate === null) d.taxRate = String(s.defaultTaxRate);
      if (!d.dueDate) d.dueDate = new Date(new Date(d.issueDate + 'T00:00:00Z').getTime() + s.invoiceDueDays * 86400_000).toISOString().slice(0, 10);
      if (d.dueDate < d.issueDate) throw invalid('Validation failed', { dueDate: 'Due date is before the issue date' });
      d.status = 'draft';
    },
    async beforeUpdate(c, d, prev) {
      const amountsChanged = ['discountAmount', 'taxRate', 'currency', 'issueDate', 'dueDate', 'projectId'].some((k) => k in d && d[k] !== prev[k]);
      if (amountsChanged && prev.status !== 'draft') throw conflict('Only draft invoices can be changed. Void and re-issue instead.');
      if (d.status === 'sent' && prev.status === 'draft') {
        const [{ cnt }] = await c.tx.select({ cnt: sql<number>`count(*)::int` }).from(invoiceItems).where(eq(invoiceItems.invoiceId, prev.id));
        if (!cnt) throw invalid('Add at least one line item before sending', { status: 'Invoice has no line items' });
        d.sentAt = new Date();
      }
      if (d.status === 'void') {
        if (!(d.voidReason ?? prev.voidReason)) throw invalid('Validation failed', { voidReason: 'Give a reason for voiding' });
        const [{ cnt }] = await c.tx.select({ cnt: sql<number>`count(*)::int` }).from(payments).where(eq(payments.invoiceId, prev.id));
        if (cnt) throw conflict('Invoices with payments cannot be voided — record a refund or credit note instead');
      }
    },
    async afterUpdate(c, row, prev) {
      if (row.status !== prev.status || row.discountAmount !== prev.discountAmount || row.taxRate !== prev.taxRate) await recalcInvoice(c.tx, row.id, c.actor);
    },
    beforeDelete(_c, row) { if (row.status !== 'draft') throw conflict('Only draft invoices can be deleted; void it instead'); },
  },
});

defineResource({
  key: 'invoice_items', table: invoiceItems, label: 'Line item', plural: 'Line items', module: 'finance', perm: 'invoices',
  titleField: 'description', defaultSort: 'sortOrder', permissions: { export: null },
  scopes: { own: (a) => sql`${invoiceItems.invoiceId} in (select i.id from invoices i where ${inManagedProjects(sql`i.project_id`, a)})` },
  fields: {
    invoiceId: { type: 'ref', ref: 'invoices', label: 'Invoice', required: true, createOnly: true },
    description: { type: 'text', label: 'Description', required: true, list: true, max: 500 },
    quantity: { type: 'decimal', label: 'Qty', required: true, list: true, min: 0, default: '1' },
    unitPrice: { type: 'money', label: 'Unit price', required: true, list: true, min: 0 },
    amount: { type: 'money', label: 'Amount', readonly: true, list: true },
    sortOrder: { type: 'int', label: 'Order', default: 0 },
  },
  hooks: {
    async beforeCreate(c, d) { await invoiceEditable(c, d.invoiceId); },
    async beforeUpdate(c, _d, prev) { await invoiceEditable(c, prev.invoiceId); },
    async beforeDelete(c, row) { await invoiceEditable(c, row.invoiceId); },
    async afterCreate(c, row) { await recalcInvoice(c.tx, row.invoiceId, c.actor); },
    async afterUpdate(c, row) { await recalcInvoice(c.tx, row.invoiceId, c.actor); },
    async afterDelete(c, row) { await recalcInvoice(c.tx, row.invoiceId, c.actor); },
  },
});

defineResource({
  key: 'payments', table: payments, label: 'Payment', plural: 'Payments', module: 'finance', perm: 'payments',
  titleField: 'number', defaultSort: '-paidOn', collab: { files: true },
  numbering: { field: 'number', key: 'payment', prefix: 'PMT-', pad: 5 },
  scopes: { own: (a) => sql`${payments.invoiceId} in (select i.id from invoices i where ${inManagedProjects(sql`i.project_id`, a)})` },
  fields: {
    invoiceId: { type: 'ref', ref: 'invoices', label: 'Invoice', required: true, createOnly: true, list: true, filter: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client', readonly: true, list: true, filter: true },
    amount: { type: 'money', label: 'Amount', required: true, list: true, min: 0.01 },
    paidOn: { type: 'date', label: 'Received on', required: true, list: true, filter: true, default: () => today() },
    method: { type: 'enum', label: 'Method', options: ['bank_transfer', 'card', 'cash', 'cheque', 'paypal', 'wise', 'payoneer', 'other'], list: true, filter: true, default: 'bank_transfer' },
    reference: { type: 'text', label: 'Reference', list: true, search: true },
    recordedById: { type: 'ref', ref: 'users', label: 'Recorded by', readonly: true },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    async beforeCreate(c, d) {
      const [inv] = await c.tx.select().from(invoices).where(eq(invoices.id, d.invoiceId)).for('update');
      if (!['sent', 'partially_paid', 'overdue'].includes(inv.status)) throw conflict(`Payments can only be recorded against sent invoices (this one is ${inv.status})`);
      if (Number(d.amount) > Number(inv.balanceDue) + 0.001) throw invalid('Validation failed', { amount: `Exceeds the balance due (${inv.balanceDue})` });
      if (d.paidOn > today()) throw invalid('Validation failed', { paidOn: 'Cannot be in the future' });
      d.companyId = inv.companyId;
      d.recordedById = c.actor.userId;
    },
    async beforeUpdate(c, d, prev) {
      if (d.amount !== undefined && d.amount !== prev.amount) {
        const [inv] = await c.tx.select().from(invoices).where(eq(invoices.id, prev.invoiceId)).for('update');
        if (Number(d.amount) > Number(inv.balanceDue) + Number(prev.amount) + 0.001) throw invalid('Validation failed', { amount: 'Exceeds the invoice balance' });
      }
    },
    async afterCreate(c, row) { await recalcInvoice(c.tx, row.invoiceId, c.actor); },
    async afterUpdate(c, row) { await recalcInvoice(c.tx, row.invoiceId, c.actor); },
    async afterDelete(c, row) { await recalcInvoice(c.tx, row.invoiceId, c.actor); },
  },
});

defineResource({
  key: 'recurring_billing', table: recurringBilling, label: 'Recurring billing', plural: 'Recurring billing', module: 'finance', perm: 'invoices',
  titleField: 'description', defaultSort: 'nextRunDate',
  description: 'Retainers and subscriptions. Draft invoices are generated automatically on the next run date.',
  scopes: { own: (a) => inManagedProjects(recurringBilling.projectId, a) },
  fields: {
    description: { type: 'text', label: 'Description', required: true, list: true, search: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client', required: true, list: true, filter: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', filter: true },
    amount: { type: 'money', label: 'Amount', required: true, list: true, min: 0 },
    currency: CURRENCY,
    interval: { type: 'enum', label: 'Interval', options: ['monthly', 'quarterly', 'yearly'], list: true, filter: true, default: 'monthly' },
    nextRunDate: { type: 'date', label: 'Next invoice', required: true, list: true },
    dueDays: { type: 'int', label: 'Payment terms (days)', min: 0, max: 180, default: 15 },
    active: { type: 'bool', label: 'Active', list: true, filter: true, default: true },
    lastRunAt: { type: 'datetime', label: 'Last generated', readonly: true },
  },
});

defineResource({
  key: 'expenses', table: expenses, label: 'Expense', plural: 'Expenses & payables', module: 'finance', perm: 'expenses',
  titleField: 'description', defaultSort: '-expenseDate', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'expense', prefix: 'EXP-', pad: 5 },
  description: 'Company and project expenses. Approved-but-unpaid expenses are payables. Infrastructure/software expenses on a project count as infrastructure cost.',
  scopes: { own: (a) => eq(expenses.submittedById, me(a)) },
  status: { field: 'status', transitions: { submitted: ['approved', 'rejected'], approved: ['paid', 'submitted'], rejected: ['submitted'], paid: [] } },
  eventFields: ['status', 'category'],
  fields: {
    description: { type: 'text', label: 'Description', required: true, list: true, search: true },
    category: { type: 'enum', label: 'Category', options: ['infrastructure', 'software', 'contractors', 'marketing', 'office', 'travel', 'equipment', 'taxes_fees', 'other'], list: true, filter: true, default: 'other' },
    vendor: { type: 'text', label: 'Vendor', list: true, search: true },
    amount: { type: 'money', label: 'Amount', required: true, list: true, min: 0.01 },
    currency: CURRENCY,
    expenseDate: { type: 'date', label: 'Date', required: true, list: true, filter: true, default: () => today() },
    dueDate: { type: 'date', label: 'Pay by', filter: true },
    status: { type: 'enum', label: 'Status', options: ['submitted', 'approved', 'rejected', 'paid'], list: true, filter: true, default: 'submitted' },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', filter: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client (re-billable)' },
    isBillable: { type: 'bool', label: 'Re-bill to client', default: false },
    submittedById: { type: 'ref', ref: 'users', label: 'Submitted by', readonly: true, list: true },
    approvedById: { type: 'ref', ref: 'users', label: 'Approved by', readonly: true },
    paidAt: { type: 'date', label: 'Paid on', readonly: true },
  },
  hooks: {
    beforeCreate(c, d) { d.submittedById = c.actor.userId; d.status = 'submitted'; },
    beforeUpdate(c, d, prev) {
      if (!d.status || d.status === prev.status) return;
      if (['approved', 'rejected'].includes(d.status)) {
        if (!can(c.actor, 'expenses.approve')) throw forbidden('Only approvers can approve or reject expenses');
        if (prev.submittedById === c.actor.userId) throw forbidden('You cannot approve your own expense');
        d.approvedById = c.actor.userId;
      }
      if (d.status === 'paid') d.paidAt = today();
    },
  },
});

// ── People finance ──

defineResource({
  key: 'compensation', table: employeeCompensation, label: 'Salary record', plural: 'Compensation', module: 'finance', perm: 'compensation',
  titleField: 'effectiveFrom', formatTitle: (r) => `Salary from ${r.effectiveFrom}`, defaultSort: '-effectiveFrom',
  description: 'Effective-dated salary history (salary reviews & promotions). Drives payroll and project cost.',
  permissions: { create: 'compensation.edit', edit: 'compensation.edit', delete: 'compensation.edit', export: 'compensation.view' },
  scopes: { own: (a) => ownEmployee(employeeCompensation.employeeId, a) },
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    effectiveFrom: { type: 'date', label: 'Effective from', required: true, list: true },
    baseSalary: { type: 'money', label: 'Monthly base salary', required: true, list: true, min: 0 },
    allowances: { type: 'money', label: 'Monthly allowances', min: 0, default: '0', list: true },
    currency: CURRENCY,
    hourlyCost: { type: 'money', label: 'Loaded hourly cost', min: 0, list: true, help: 'Leave blank to derive from salary, working hours and overhead' },
    reason: { type: 'enum', label: 'Reason', options: ['hire', 'annual_review', 'promotion', 'adjustment', 'correction'], list: true, filter: true, default: 'annual_review' },
    approvedById: { type: 'ref', ref: 'users', label: 'Approved by', readonly: true },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    async beforeCreate(c, d) {
      d.approvedById = c.actor.userId;
      if (!d.hourlyCost) {
        const s = await getSettings(c.tx);
        d.hourlyCost = (((Number(d.baseSalary) + Number(d.allowances ?? 0)) * (1 + s.costOverheadPct / 100)) / (22 * s.workdayHours)).toFixed(2);
      }
    },
  },
});

defineResource({
  key: 'employee_adjustments', table: employeeAdjustments, label: 'Adjustment', plural: 'Bonuses, deductions & advances', module: 'finance', perm: 'payroll',
  titleField: 'reason', defaultSort: '-effectiveDate',
  scopes: { own: (a) => ownEmployee(employeeAdjustments.employeeId, a) },
  status: { field: 'status', transitions: { pending: ['approved', 'cancelled'], approved: ['cancelled', 'pending'], applied: [], cancelled: [] } },
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    kind: { type: 'enum', label: 'Type', options: ['bonus', 'deduction', 'advance', 'advance_recovery'], required: true, list: true, filter: true },
    amount: { type: 'money', label: 'Amount', required: true, list: true, min: 0.01 },
    effectiveDate: { type: 'date', label: 'Effective', required: true, list: true, default: () => today() },
    reason: { type: 'text', label: 'Reason', required: true, list: true },
    status: { type: 'enum', label: 'Status', options: ['pending', 'approved', 'applied', 'cancelled'], list: true, filter: true, default: 'pending' },
    approvedById: { type: 'ref', ref: 'users', label: 'Approved by', readonly: true },
  },
  hooks: {
    beforeCreate(_c, d) { d.status = 'pending'; },
    beforeUpdate(c, d, prev) {
      if (prev.status === 'applied') throw conflict('Applied adjustments are locked');
      if (d.status === 'approved' && prev.status !== 'approved') {
        if (!can(c.actor, 'payroll.approve')) throw forbidden('Only payroll approvers can approve adjustments');
        d.approvedById = c.actor.userId;
      }
    },
  },
});

defineResource({
  key: 'payroll_runs', table: payrollRuns, label: 'Payroll run', plural: 'Payroll runs', module: 'finance', perm: 'payroll',
  titleField: 'number', defaultSort: '-periodEnd', permissions: { create: null, delete: null },
  description: 'Monthly payroll generated from salary history and approved adjustments. Requires a second person to approve.',
  scopes: { own: (a) => sql`${payrollRuns.id} in (select pi.run_id from payroll_items pi where ${ownEmployee(sql`pi.employee_id`, a)})` },
  fields: {
    number: { type: 'text', label: 'Run', readonly: true, list: true },
    periodStart: { type: 'date', label: 'From', readonly: true, list: true },
    periodEnd: { type: 'date', label: 'To', readonly: true, list: true },
    status: { type: 'enum', label: 'Status', options: ['draft', 'approved', 'paid'], readonly: true, list: true, filter: true },
    // Company-wide totals: hidden from employees who can only see their own payslip.
    totalGross: { type: 'money', label: 'Gross', readonly: true, list: true, readPermission: 'payroll.view', readScope: () => sql`false` },
    totalNet: { type: 'money', label: 'Net', readonly: true, list: true, readPermission: 'payroll.view', readScope: () => sql`false` },
    approvedById: { type: 'ref', ref: 'users', label: 'Approved by', readonly: true },
    paidAt: { type: 'date', label: 'Paid on', readonly: true, list: true },
    notes: { type: 'textarea', label: 'Notes' },
  },
  children: [{ resource: 'payroll_items', field: 'runId', label: 'Payslips' }],
});

defineResource({
  key: 'payroll_items', table: payrollItems, label: 'Payslip', plural: 'Payslips', module: 'finance', perm: 'payroll',
  titleField: 'net', formatTitle: (r) => `Payslip ${r.net}`, permissions: { create: null, delete: null },
  scopes: { own: (a) => ownEmployee(payrollItems.employeeId, a) },
  fields: {
    runId: { type: 'ref', ref: 'payroll_runs', label: 'Payroll run', readonly: true, list: true, filter: true },
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', readonly: true, list: true, filter: true },
    baseSalary: { type: 'money', label: 'Base', readonly: true, list: true },
    allowances: { type: 'money', label: 'Allowances', readonly: true },
    bonuses: { type: 'money', label: 'Bonuses', readonly: true, list: true },
    deductions: { type: 'money', label: 'Deductions', readonly: true, list: true },
    advances: { type: 'money', label: 'Advances paid', readonly: true },
    advanceRecovery: { type: 'money', label: 'Advance recovery', readonly: true },
    gross: { type: 'money', label: 'Gross', readonly: true, list: true },
    net: { type: 'money', label: 'Net pay', readonly: true, list: true },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    async beforeUpdate(c, _d, prev) {
      const [r] = await c.tx.select({ status: payrollRuns.status }).from(payrollRuns).where(eq(payrollRuns.id, prev.runId));
      if (r.status !== 'draft') throw conflict('Payroll is locked after approval');
    },
  },
});

