import { eq, or, sql } from 'drizzle-orm';
import { maintenancePlans, recurringBilling, slaPolicies, slaTargets, tickets } from '../../db/schema/index.ts';
import { invalid } from '../../core/errors.ts';
import { defineResource } from '../registry.ts';
import { inMyProjects } from '../scopes.ts';
import { slaDue } from '../../modules/support.ts';

const today = () => new Date().toISOString().slice(0, 10);
const nextMonthStart = (from: string) => {
  const d = new Date(from + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)).toISOString().slice(0, 10);
};

defineResource({
  key: 'sla_policies', table: slaPolicies, label: 'SLA policy', plural: 'SLA policies', module: 'support', perm: 'maintenance',
  titleField: 'name', defaultSort: 'name', directory: true,
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true },
    isDefault: { type: 'bool', label: 'Default policy', list: true, default: false },
    description: { type: 'textarea', label: 'Description' },
  },
  children: [{ resource: 'sla_targets', field: 'policyId', label: 'Targets' }],
  hooks: {
    async beforeUpdate(c, d) { if (d.isDefault) await c.tx.update(slaPolicies).set({ isDefault: false }).where(eq(slaPolicies.isDefault, true)); },
    async beforeCreate(c, d) { if (d.isDefault) await c.tx.update(slaPolicies).set({ isDefault: false }).where(eq(slaPolicies.isDefault, true)); },
  },
});

defineResource({
  key: 'sla_targets', table: slaTargets, label: 'SLA target', plural: 'SLA targets', module: 'support', perm: 'maintenance',
  titleField: 'priority', formatTitle: (r) => `${r.priority}: respond ${r.firstResponseMinutes}m / resolve ${r.resolutionMinutes}m`, defaultSort: 'priority',
  fields: {
    policyId: { type: 'ref', ref: 'sla_policies', label: 'Policy', required: true, createOnly: true, list: true },
    priority: { type: 'enum', label: 'Priority', options: ['low', 'medium', 'high', 'urgent'], required: true, createOnly: true, list: true },
    firstResponseMinutes: { type: 'int', label: 'First response (minutes)', required: true, min: 1, list: true },
    resolutionMinutes: { type: 'int', label: 'Resolution (minutes)', required: true, min: 1, list: true },
  },
});

defineResource({
  key: 'maintenance_plans', table: maintenancePlans, label: 'Maintenance plan', plural: 'Maintenance plans', module: 'support', perm: 'maintenance',
  titleField: 'name', defaultSort: 'name', collab: { comments: true, files: true },
  description: 'Monthly retainers: included hours and services, SLA, and recurring billing (created automatically).',
  scopes: { own: (a) => or(eq(maintenancePlans.accountManagerId, a.userId), inMyProjects(maintenancePlans.projectId, a))! },
  fields: {
    name: { type: 'text', label: 'Plan', required: true, list: true, search: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client', required: true, createOnly: true, list: true, filter: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', filter: true },
    status: { type: 'enum', label: 'Status', options: ['active', 'paused', 'cancelled', 'expired'], list: true, filter: true, default: 'active' },
    monthlyHours: { type: 'hours', label: 'Included hours / month', required: true, min: 0, list: true },
    monthlyFee: { type: 'money', label: 'Monthly fee', required: true, min: 0, list: true },
    currency: { type: 'text', label: 'Currency', max: 3, default: 'USD' },
    overageRate: { type: 'money', label: 'Overage rate / hour', min: 0 },
    slaPolicyId: { type: 'ref', ref: 'sla_policies', label: 'SLA policy' },
    startDate: { type: 'date', label: 'Start', required: true, list: true, default: () => today() },
    endDate: { type: 'date', label: 'End', list: true },
    accountManagerId: { type: 'ref', ref: 'users', label: 'Account manager', filter: true },
    includedServices: { type: 'markdown', label: 'Included services' },
  },
  children: [{ resource: 'tickets', field: 'maintenancePlanId' }, { resource: 'recurring_billing', field: 'maintenancePlanId', label: 'Billing schedule' }],
  hooks: {
    async afterCreate(c, row) {
      if (Number(row.monthlyFee) <= 0) return;
      // Plans bill themselves: one monthly schedule, drafted from the first of next month.
      await c.tx.insert(recurringBilling).values({
        companyId: row.companyId, projectId: row.projectId, maintenancePlanId: row.id, description: `Maintenance plan: ${row.name}`,
        amount: row.monthlyFee, currency: row.currency, interval: 'monthly', nextRunDate: nextMonthStart(row.startDate), active: row.status === 'active',
      });
    },
    async afterUpdate(c, row, prev) {
      if (row.monthlyFee !== prev.monthlyFee || row.status !== prev.status) {
        await c.tx.update(recurringBilling).set({ amount: row.monthlyFee, active: row.status === 'active' }).where(eq(recurringBilling.maintenancePlanId, row.id));
      }
    },
  },
});

defineResource({
  key: 'tickets', table: tickets, label: 'Ticket', plural: 'Support tickets', module: 'support', perm: 'tickets',
  titleField: 'title', board: 'status', defaultSort: '-createdAt', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'ticket', prefix: 'TCK-', pad: 5 },
  description: 'Client → Project → Issue → Priority → Assigned team → Development → QA → Resolved, with SLA tracking.',
  scopes: {
    own: (a) => or(eq(tickets.assigneeId, a.userId), inMyProjects(tickets.projectId, a),
      sql`${tickets.companyId} in (select c.id from companies c where c.account_manager_id = ${a.userId})`)!,
  },
  assignees: ['assigneeId'], eventFields: ['priority', 'companyId', 'projectId'],
  status: {
    field: 'status',
    transitions: {
      new: ['triaged', 'assigned', 'waiting_for_client', 'resolved', 'closed'],
      triaged: ['assigned', 'in_development', 'waiting_for_client', 'resolved'],
      assigned: ['in_development', 'waiting_for_client', 'resolved', 'triaged'],
      in_development: ['in_qa', 'waiting_for_client', 'assigned'],
      in_qa: ['resolved', 'in_development'],
      waiting_for_client: ['assigned', 'in_development', 'resolved', 'closed'],
      resolved: ['closed', 'assigned'],
      closed: ['assigned'],
    },
  },
  fields: {
    title: { type: 'text', label: 'Issue', required: true, list: true, search: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client', required: true, createOnly: true, list: true, filter: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    maintenancePlanId: { type: 'ref', ref: 'maintenance_plans', label: 'Maintenance plan', filter: true },
    contactId: { type: 'ref', ref: 'contacts', label: 'Reported by' },
    type: { type: 'enum', label: 'Type', options: ['bug', 'change_request', 'question', 'incident', 'maintenance'], list: true, filter: true, default: 'question' },
    priority: { type: 'enum', label: 'Priority', options: ['low', 'medium', 'high', 'urgent'], list: true, filter: true, default: 'medium' },
    status: { type: 'enum', label: 'Status', options: ['new', 'triaged', 'assigned', 'in_development', 'in_qa', 'waiting_for_client', 'resolved', 'closed'], list: true, filter: true, default: 'new' },
    source: { type: 'enum', label: 'Channel', options: ['email', 'phone', 'portal', 'chat', 'internal'], default: 'email' },
    assignedDepartmentId: { type: 'ref', ref: 'departments', label: 'Assigned team', filter: true },
    assigneeId: { type: 'ref', ref: 'users', label: 'Assignee', list: true, filter: true },
    slaBreached: { type: 'bool', label: 'SLA breached', readonly: true, list: true, filter: true },
    firstResponseDueAt: { type: 'datetime', label: 'Respond by', readonly: true, group: 'SLA' },
    resolutionDueAt: { type: 'datetime', label: 'Resolve by', readonly: true, list: true, group: 'SLA' },
    firstRespondedAt: { type: 'datetime', label: 'First response', readonly: true, group: 'SLA' },
    resolvedAt: { type: 'datetime', label: 'Resolved', readonly: true, group: 'SLA' },
    taskId: { type: 'ref', ref: 'tasks', label: 'Development task', readonly: true },
    bugId: { type: 'ref', ref: 'bugs', label: 'Bug', readonly: true },
    satisfaction: { type: 'int', label: 'Client satisfaction (1–5)', min: 1, max: 5 },
    description: { type: 'markdown', label: 'Description' },
  },
  children: [{ resource: 'time_entries', field: 'ticketId', label: 'Time' }],
  hooks: {
    async beforeCreate(c, d) {
      if (d.maintenancePlanId) {
        const [p] = await c.tx.select().from(maintenancePlans).where(eq(maintenancePlans.id, d.maintenancePlanId));
        if (p.companyId !== d.companyId) throw invalid('Validation failed', { maintenancePlanId: 'Plan belongs to another client' });
        d.projectId = d.projectId ?? p.projectId;
      } else {
        const [p] = await c.tx.select({ id: maintenancePlans.id, projectId: maintenancePlans.projectId }).from(maintenancePlans).where(sql`${maintenancePlans.companyId} = ${d.companyId} and ${maintenancePlans.status} = 'active'`).limit(1);
        if (p) { d.maintenancePlanId = p.id; d.projectId = d.projectId ?? p.projectId; }
      }
      Object.assign(d, await slaDue(c.tx, d.priority ?? 'medium', d.maintenancePlanId ?? null, new Date()));
      if (d.assigneeId && (!d.status || d.status === 'new')) d.status = 'assigned';
    },
    async beforeUpdate(c, d, prev) {
      if (d.status && d.status !== prev.status) {
        if (prev.status === 'new' && !prev.firstRespondedAt) d.firstRespondedAt = new Date();
        if (d.status === 'resolved') d.resolvedAt = new Date();
        if (d.status === 'closed') d.closedAt = new Date();
        if (['assigned', 'in_development'].includes(d.status) && ['resolved', 'closed'].includes(prev.status)) { d.resolvedAt = null; d.closedAt = null; }
      }
      if (d.assigneeId && d.assigneeId !== prev.assigneeId && prev.status === 'new' && !d.status) d.status = 'assigned';
      if (d.priority && d.priority !== prev.priority) {
        const due = await slaDue(c.tx, d.priority, prev.maintenancePlanId, new Date(prev.createdAt));
        d.firstResponseDueAt = due.firstResponseDueAt; d.resolutionDueAt = due.resolutionDueAt;
      }
    },
  },
});
