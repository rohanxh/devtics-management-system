import { and, eq, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  changeRequests, clientFeedback, pipelineStages, meetingNotes, milestones, projectMembers, projectOnboardings, projects,
  projectUpdates, risks, taskChecklistItems, taskDependencies, tasks, timeEntries,
} from '../../db/schema/index.ts';
import { conflict, forbidden, invalid } from '../../core/errors.ts';
import { requestApproval } from '../../core/approvals.ts';
import { defineResource } from '../registry.ts';
import { inManagedProjects, inMyProjects, myTaskIds } from '../scopes.ts';
import type { HookCtx } from '../types.ts';
import { labourCost } from '../../modules/costing.ts';

const me = (a: { userId: string }) => a.userId;
const today = () => new Date().toISOString().slice(0, 10);
const PRIORITY = ['low', 'medium', 'high', 'critical'] as const;
const FIN = 'project_finance.view';

defineResource({
  key: 'projects', table: projects, label: 'Project', plural: 'Projects', module: 'delivery', perm: 'projects',
  titleField: 'name', board: 'status', collab: { comments: true, files: true },
  numbering: { field: 'code', key: 'project', prefix: 'PRJ-', pad: 4 },
  description: 'Client and internal projects through Scope → Design → Development → QA → Client Feedback → Launch → Maintenance.',
  scopes: { own: (a) => inMyProjects(projects.id, a) },
  eventFields: ['status', 'pmId', 'techLeadId'],
  assignees: ['pmId', 'techLeadId'],
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    clientId: { type: 'ref', ref: 'clients', label: 'Client', list: true, filter: true },
    stageId: { type: 'stage', pipeline: 'project', label: 'Lifecycle stage', required: true, list: true, filter: true },
    status: {
      type: 'enum', label: 'Status', list: true, filter: true, default: 'on_track',
      options: ['on_track', 'at_risk', 'delayed', 'awaiting_client', 'awaiting_design', 'awaiting_development', 'in_qa', 'ready_for_launch', 'on_hold', 'completed', 'cancelled'],
    },
    priority: { type: 'enum', label: 'Priority', options: PRIORITY, filter: true, default: 'medium' },
    type: { type: 'enum', label: 'Type', options: ['website', 'wordpress', 'woocommerce', 'web_app', 'mobile_app', 'seo', 'maintenance', 'design', 'other'], filter: true, default: 'website' },
    pmId: { type: 'ref', ref: 'users', label: 'Project manager', list: true, filter: true },
    techLeadId: { type: 'ref', ref: 'users', label: 'Tech lead', filter: true },
    startDate: { type: 'date', label: 'Start', group: 'Schedule' },
    dueDate: { type: 'date', label: 'Due', list: true, filter: true, group: 'Schedule' },
    actualEndDate: { type: 'date', label: 'Completed on', group: 'Schedule' },
    billingType: { type: 'enum', label: 'Billing', options: ['fixed', 'hourly', 'retainer', 'internal'], default: 'fixed', group: 'Budget', readPermission: FIN, writePermission: 'projects.edit' },
    budgetAmount: { type: 'money', label: 'Budget / contract value', min: 0, group: 'Budget', readPermission: FIN, writePermission: 'projects.edit' },
    budgetHours: { type: 'hours', label: 'Budget hours', min: 0, group: 'Budget' },
    currency: { type: 'text', label: 'Currency', max: 3, default: 'USD', group: 'Budget' },
    isInternal: { type: 'bool', label: 'Internal project', default: false },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Originating deal', readonly: true },
    contractId: { type: 'ref', ref: 'contracts', label: 'Contract / SOW' },
    qaApprovedAt: { type: 'datetime', label: 'QA approved', readonly: true },
    launchedAt: { type: 'datetime', label: 'Launched', readonly: true },
    description: { type: 'markdown', label: 'Description' },
  },
  children: [
    { resource: 'tasks', field: 'projectId' }, { resource: 'milestones', field: 'projectId' },
    { resource: 'project_members', field: 'projectId', label: 'Team' }, { resource: 'project_risks', field: 'projectId' },
    { resource: 'change_requests', field: 'projectId' }, { resource: 'project_updates', field: 'projectId', label: 'Updates' },
    { resource: 'meeting_notes', field: 'projectId' }, { resource: 'client_feedback', field: 'projectId', label: 'Client feedback' },
    { resource: 'communications', field: 'projectId' }, { resource: 'time_entries', field: 'projectId' },
    { resource: 'bugs', field: 'projectId' }, { resource: 'qa_runs', field: 'projectId' }, { resource: 'test_cases', field: 'projectId' },
    { resource: 'repositories', field: 'projectId' }, { resource: 'environments', field: 'projectId' }, { resource: 'deployments', field: 'projectId' },
    { resource: 'project_technologies', field: 'projectId', label: 'Tech stack' }, { resource: 'tech_reviews', field: 'projectId' },
  ],
  hooks: {
    beforeCreate(c, d) {
      d.createdBy = c.actor.userId;
      if (!d.pmId && c.actor.roles.includes('pm')) d.pmId = c.actor.userId;
    },
    async beforeUpdate(c, d, prev) {
      if (d.stageId && d.stageId !== prev.stageId && !prev.qaApprovedAt && !prev.isInternal) {
        const [st] = await c.tx.select({ key: pipelineStages.key }).from(pipelineStages).where(eq(pipelineStages.id, d.stageId));
        if (st?.key === 'launch' || st?.key === 'maintenance') throw conflict('QA sign-off is required before launch');
      }
      if (d.status === 'completed' && prev.status !== 'completed' && !d.actualEndDate && !prev.actualEndDate) d.actualEndDate = today();
      if (d.dueDate && d.startDate && d.dueDate < d.startDate) throw invalid('Validation failed', { dueDate: 'Due date is before start date' });
    },
    async afterCreate(c, row) {
      // The PM and tech lead are always members of the project.
      const people = [row.pmId, row.techLeadId].filter(Boolean) as string[];
      if (people.length) {
        await c.tx.insert(projectMembers).values(people.map((userId) => ({ projectId: row.id, userId, role: userId === row.pmId ? 'pm' : 'tech_lead' }))).onConflictDoNothing();
      }
    },
    async afterUpdate(c, row, prev) {
      for (const [k, role] of [['pmId', 'pm'], ['techLeadId', 'tech_lead']] as const) {
        if (row[k] && row[k] !== prev[k]) await c.tx.insert(projectMembers).values({ projectId: row.id, userId: row[k], role }).onConflictDoNothing();
      }
    },
  },
});

/** Child records of a project are visible to anyone who can see the project, and managed by its PM / tech lead. */
const projectChildScopes = (column: any) => ({ own: (a: any) => inMyProjects(column, a), team: (a: any) => inMyProjects(column, a) });

defineResource({
  key: 'project_members', table: projectMembers, label: 'Team member', plural: 'Team members', module: 'delivery', perm: 'projects',
  permissions: { create: 'projects.assign', edit: 'projects.assign', delete: 'projects.assign' },
  titleField: 'role', defaultSort: 'role',
  scopes: projectChildScopes(projectMembers.projectId),
  assignees: ['userId'],
  fields: {
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    userId: { type: 'ref', ref: 'users', label: 'Person', required: true, createOnly: true, list: true, filter: true },
    role: { type: 'enum', label: 'Role', options: ['pm', 'tech_lead', 'developer', 'designer', 'qa', 'seo', 'support', 'other'], required: true, list: true, default: 'developer' },
    allocationPct: { type: 'percent', label: 'Allocation %', list: true, default: 100 },
    startDate: { type: 'date', label: 'From', list: true },
    endDate: { type: 'date', label: 'Until', list: true },
  },
});

defineResource({
  key: 'milestones', table: milestones, label: 'Milestone', plural: 'Milestones', module: 'delivery', perm: 'projects',
  titleField: 'name', defaultSort: 'dueDate',
  scopes: projectChildScopes(milestones.projectId),
  eventFields: ['projectId', 'billingAmount'],
  status: { field: 'status', transitions: { planned: ['in_progress', 'completed', 'missed'], in_progress: ['completed', 'missed', 'planned'], completed: ['in_progress'], missed: ['in_progress', 'completed'] } },
  fields: {
    name: { type: 'text', label: 'Milestone', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    dueDate: { type: 'date', label: 'Due', list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['planned', 'in_progress', 'completed', 'missed'], list: true, filter: true, default: 'planned' },
    completedAt: { type: 'date', label: 'Completed on', readonly: true, list: true },
    billingAmount: { type: 'money', label: 'Billable on completion', min: 0, readPermission: FIN, writePermission: 'projects.edit' },
    sortOrder: { type: 'int', label: 'Order', default: 0 },
    description: { type: 'textarea', label: 'Description' },
  },
  children: [{ resource: 'tasks', field: 'milestoneId' }],
  hooks: {
    beforeUpdate(_c, d, prev) {
      if (d.status === 'completed' && prev.status !== 'completed') d.completedAt = today();
      if (d.status && d.status !== 'completed') d.completedAt = null;
    },
  },
});

// ── Tasks ──
async function assertDependenciesDone(c: HookCtx, taskId: string) {
  const open = await c.tx.select({ number: tasks.number, title: tasks.title }).from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnTaskId))
    .where(and(eq(taskDependencies.taskId, taskId), ne(tasks.status, 'done')));
  if (open.length) throw conflict(`Blocked by unfinished dependencies: ${open.map((t) => `${t.number} ${t.title}`).join(', ')}`);
}

defineResource({
  key: 'tasks', table: tasks, label: 'Task', plural: 'Tasks', module: 'delivery', perm: 'tasks',
  titleField: 'title', board: 'status', collab: { comments: true, files: true }, defaultSort: 'dueDate',
  numbering: { field: 'number', key: 'task', prefix: 'T-', pad: 5 },
  scopes: {
    own: (a) => sql`${tasks.id} in ${myTaskIds(a.userId)}`,
    team: (a) => or(sql`${tasks.id} in ${myTaskIds(a.userId)}`, inManagedProjects(tasks.projectId, a))!,
  },
  assignees: ['assigneeId'],
  eventFields: ['projectId', 'reporterId', 'assigneeId'],
  status: {
    field: 'status',
    transitions: {
      todo: ['in_progress', 'blocked', 'done'],
      in_progress: ['in_review', 'qa', 'blocked', 'todo', 'done'],
      in_review: ['in_progress', 'qa', 'done'],
      qa: ['in_progress', 'done'],
      blocked: ['todo', 'in_progress'],
      done: ['in_progress'],
    },
  },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['todo', 'in_progress', 'in_review', 'qa', 'done', 'blocked'], list: true, filter: true, default: 'todo' },
    priority: { type: 'enum', label: 'Priority', options: ['low', 'medium', 'high', 'critical'], list: true, filter: true, default: 'medium' },
    assigneeId: { type: 'ref', ref: 'users', label: 'Assignee', list: true, filter: true },
    dueDate: { type: 'date', label: 'Due', list: true, filter: true },
    type: { type: 'enum', label: 'Type', options: ['feature', 'task', 'design', 'content', 'research', 'devops', 'seo', 'support', 'onboarding'], filter: true, default: 'task' },
    milestoneId: { type: 'ref', ref: 'milestones', label: 'Milestone', filter: true },
    parentTaskId: { type: 'ref', ref: 'tasks', label: 'Parent task', filter: true },
    startDate: { type: 'date', label: 'Start' },
    estimateHours: { type: 'hours', label: 'Estimate (h)', min: 0, max: 1000 },
    reporterId: { type: 'ref', ref: 'users', label: 'Reporter', readonly: true },
    isRework: { type: 'bool', label: 'Rework', readonly: true, filter: true },
    qaRejections: { type: 'int', label: 'QA rejections', readonly: true },
    completedAt: { type: 'datetime', label: 'Completed', readonly: true },
    tags: { type: 'tags', label: 'Tags' },
    description: { type: 'markdown', label: 'Description / technical notes' },
  },
  children: [
    { resource: 'tasks', field: 'parentTaskId', label: 'Subtasks' },
    { resource: 'task_checklist_items', field: 'taskId', label: 'Checklist' },
    { resource: 'task_dependencies', field: 'taskId', label: 'Dependencies' },
    { resource: 'time_entries', field: 'taskId', label: 'Time' },
  ],
  hooks: {
    async beforeCreate(c, d) {
      d.reporterId = c.actor.userId;
      if (d.parentTaskId) {
        const [p] = await c.tx.select({ projectId: tasks.projectId, parent: tasks.parentTaskId }).from(tasks).where(eq(tasks.id, d.parentTaskId));
        if (p?.parent) throw invalid('Validation failed', { parentTaskId: 'Subtasks cannot have subtasks' });
        d.projectId = p?.projectId ?? d.projectId;
      }
      if (d.milestoneId && d.projectId) {
        const [m] = await c.tx.select({ projectId: milestones.projectId }).from(milestones).where(eq(milestones.id, d.milestoneId));
        if (m?.projectId !== d.projectId) throw invalid('Validation failed', { milestoneId: 'Milestone belongs to another project' });
      }
      if (d.status === 'done') d.completedAt = new Date();
    },
    async beforeUpdate(c, d, prev) {
      const to = d.status, from = prev.status;
      if (!to || to === from) return;
      if (to === 'in_progress' || to === 'done') await assertDependenciesDone(c, prev.id);
      if (to === 'done') d.completedAt = new Date();
      if (from === 'done') { d.completedAt = null; d.isRework = true; }
      if (from === 'qa' && to === 'in_progress') { d.qaRejections = (prev.qaRejections ?? 0) + 1; d.isRework = true; }
      if (to === 'done') {
        const openSubs = await c.tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.parentTaskId, prev.id), ne(tasks.status, 'done'))).limit(1);
        if (openSubs.length) throw conflict('Complete all subtasks first');
      }
    },
  },
});

defineResource({
  key: 'task_checklist_items', table: taskChecklistItems, label: 'Checklist item', plural: 'Checklist', module: 'delivery', perm: 'tasks',
  titleField: 'label', defaultSort: 'sortOrder', permissions: { export: null },
  scopes: { own: (a) => sql`${taskChecklistItems.taskId} in ${myTaskIds(a.userId)}` },
  fields: {
    taskId: { type: 'ref', ref: 'tasks', label: 'Task', required: true, createOnly: true },
    label: { type: 'text', label: 'Item', required: true, list: true },
    isDone: { type: 'bool', label: 'Done', list: true, default: false },
    doneById: { type: 'ref', ref: 'users', label: 'Done by', readonly: true, list: true },
    sortOrder: { type: 'int', label: 'Order', default: 0 },
  },
  hooks: {
    beforeUpdate(c, d, prev) {
      if (d.isDone === true && !prev.isDone) { d.doneById = c.actor.userId; d.doneAt = new Date(); }
      if (d.isDone === false) { d.doneById = null; d.doneAt = null; }
    },
  },
});

defineResource({
  key: 'task_dependencies', table: taskDependencies, label: 'Dependency', plural: 'Dependencies', module: 'delivery', perm: 'tasks',
  titleField: 'id', formatTitle: () => 'Dependency', permissions: { export: null },
  scopes: { own: (a) => sql`${taskDependencies.taskId} in ${myTaskIds(a.userId)}` },
  fields: {
    taskId: { type: 'ref', ref: 'tasks', label: 'Task', required: true, createOnly: true, list: true },
    dependsOnTaskId: { type: 'ref', ref: 'tasks', label: 'Depends on', required: true, createOnly: true, list: true },
  },
  hooks: {
    async beforeCreate(c, d) {
      if (d.taskId === d.dependsOnTaskId) throw invalid('Validation failed', { dependsOnTaskId: 'A task cannot depend on itself' });
      // Reject cycles: walk the dependency graph from the prerequisite.
      const res: any = await c.tx.execute(sql`
        with recursive chain(id) as (
          select depends_on_task_id from task_dependencies where task_id = ${d.dependsOnTaskId}
          union select td.depends_on_task_id from task_dependencies td join chain on td.task_id = chain.id
        ) select 1 from chain where id = ${d.taskId} limit 1`);
      if (res.rows.length) throw invalid('Validation failed', { dependsOnTaskId: 'This would create a circular dependency' });
    },
  },
});

defineResource({
  key: 'time_entries', table: timeEntries, label: 'Time entry', plural: 'Time entries', module: 'delivery', perm: 'time',
  titleField: 'workDate', formatTitle: (r) => `${(r.minutes / 60).toFixed(2)}h on ${r.workDate}`, defaultSort: '-workDate',
  scopes: {
    own: (a) => eq(timeEntries.userId, me(a)),
    team: (a) => or(eq(timeEntries.userId, me(a)), inManagedProjects(timeEntries.projectId, a))!,
  },
  fields: {
    workDate: { type: 'date', label: 'Date', required: true, list: true, filter: true, default: () => today() },
    userId: { type: 'ref', ref: 'users', label: 'Person', createOnly: true, list: true, filter: true, default: me },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    taskId: { type: 'ref', ref: 'tasks', label: 'Task', list: true, filter: true },
    ticketId: { type: 'ref', ref: 'tickets', label: 'Support ticket', filter: true },
    minutes: { type: 'int', label: 'Minutes', required: true, list: true, min: 1, max: 1440 },
    billable: { type: 'bool', label: 'Billable', list: true, filter: true, default: true },
    description: { type: 'text', label: 'What was done', list: true, max: 1000 },
    costAmount: { type: 'money', label: 'Cost', readonly: true, readPermission: FIN, readScope: (a) => inManagedProjects(timeEntries.projectId, a) },
  },
  hooks: {
    async beforeCreate(c, d) {
      if (d.userId !== c.actor.userId && c.actor.perms.get('time.create') !== 'all') throw forbidden('You can only log your own time');
      if (d.workDate > today()) throw invalid('Validation failed', { workDate: 'Cannot log time in the future' });
      if (d.taskId) {
        const [t] = await c.tx.select({ projectId: tasks.projectId }).from(tasks).where(eq(tasks.id, d.taskId));
        if (d.projectId && t?.projectId && d.projectId !== t.projectId) throw invalid('Validation failed', { taskId: 'Task belongs to another project' });
        d.projectId = d.projectId ?? t?.projectId ?? null;
      }
      d.costAmount = await labourCost(c.tx, d.userId, d.workDate, d.minutes);
    },
    async beforeUpdate(c, d, prev) {
      if (d.workDate && d.workDate > today()) throw invalid('Validation failed', { workDate: 'Cannot log time in the future' });
      if (d.minutes !== undefined || d.workDate !== undefined) {
        d.costAmount = await labourCost(c.tx, prev.userId, d.workDate ?? prev.workDate, d.minutes ?? prev.minutes);
      }
    },
  },
});

const RISK_FIELDS = {
  title: { type: 'text', label: 'Title', required: true, list: true, search: true },
  kind: { type: 'enum', label: 'Type', options: ['risk', 'issue'], list: true, filter: true, default: 'risk' },
  status: { type: 'enum', label: 'Status', options: ['open', 'mitigating', 'resolved', 'accepted', 'closed'], list: true, filter: true, default: 'open' },
  probability: { type: 'enum', label: 'Probability', options: ['low', 'medium', 'high'], list: true, default: 'medium' },
  impact: { type: 'enum', label: 'Impact', options: PRIORITY, list: true, filter: true, default: 'medium' },
  ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true },
  dueDate: { type: 'date', label: 'Review by', list: true },
  resolvedAt: { type: 'date', label: 'Resolved on', readonly: true },
  description: { type: 'textarea', label: 'Description' },
  mitigation: { type: 'textarea', label: 'Mitigation / resolution plan' },
} as const;
const riskHooks = {
  beforeUpdate(_c: HookCtx, d: Record<string, any>, prev: Record<string, any>) {
    if (['resolved', 'closed'].includes(d.status) && !['resolved', 'closed'].includes(prev.status)) d.resolvedAt = today();
  },
};

defineResource({
  key: 'project_risks', table: risks, label: 'Risk / issue', plural: 'Risks & issues', module: 'delivery', perm: 'projects',
  baseWhere: isNotNull(risks.projectId), titleField: 'title', defaultSort: '-createdAt',
  scopes: projectChildScopes(risks.projectId), assignees: ['ownerId'], eventFields: ['impact', 'kind'],
  fields: { projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true }, ...RISK_FIELDS } as any,
  hooks: riskHooks,
});

defineResource({
  key: 'company_risks', table: risks, label: 'Company risk', plural: 'Company risks', module: 'strategy', perm: 'goals',
  baseWhere: isNull(risks.projectId), titleField: 'title', defaultSort: '-createdAt', assignees: ['ownerId'],
  description: 'Strategic risk register (not tied to a single project).',
  fields: RISK_FIELDS as any,
  hooks: riskHooks,
});

defineResource({
  key: 'change_requests', table: changeRequests, label: 'Change request', plural: 'Change requests', module: 'delivery', perm: 'projects',
  titleField: 'title', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'change_request', prefix: 'CR-', pad: 4 },
  description: 'Scope changes. Submitting requests PM approval (CTO approval for major changes).',
  scopes: projectChildScopes(changeRequests.projectId),
  eventFields: ['projectId', 'isMajor'],
  status: { field: 'status', transitions: { draft: ['submitted', 'cancelled'], submitted: ['cancelled'], approved: ['implemented'], rejected: ['draft'], implemented: [], cancelled: [] } },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['draft', 'submitted', 'approved', 'rejected', 'implemented', 'cancelled'], list: true, filter: true, default: 'draft' },
    priority: { type: 'enum', label: 'Priority', options: PRIORITY, list: true, default: 'medium' },
    isMajor: { type: 'bool', label: 'Major change (needs CTO)', list: true, default: false },
    impactHours: { type: 'hours', label: 'Extra hours', list: true, min: 0 },
    impactCost: { type: 'money', label: 'Extra cost to client', min: 0, list: true },
    impactDays: { type: 'int', label: 'Schedule impact (days)', min: 0 },
    requestedByContactId: { type: 'ref', ref: 'contacts', label: 'Requested by (client)' },
    decidedAt: { type: 'datetime', label: 'Decided', readonly: true },
    description: { type: 'markdown', label: 'Description' },
  },
  hooks: {
    beforeCreate(c, d) { d.createdBy = c.actor.userId; },
    async afterUpdate(c, row, prev) {
      if (row.status === 'submitted' && prev.status !== 'submitted') {
        await requestApproval(c.tx, {
          kind: 'change_request', entityType: 'change_requests', entityId: row.id,
          title: `${row.number}: ${row.title}${row.isMajor ? ' (major)' : ''}`,
          details: [row.impactHours && `+${row.impactHours}h`, row.impactDays && `+${row.impactDays} days`, row.impactCost && `cost ${row.impactCost}`].filter(Boolean).join(' · ') || undefined,
          requestedBy: c.actor.userId, approverRoleKey: row.isMajor ? 'cto' : 'pm',
        });
      }
    },
  },
});

defineResource({
  key: 'meeting_notes', table: meetingNotes, label: 'Meeting note', plural: 'Meeting notes', module: 'delivery', perm: 'projects',
  titleField: 'title', defaultSort: '-meetingDate', collab: { comments: true, files: true },
  scopes: { own: (a) => or(inMyProjects(meetingNotes.projectId, a), eq(meetingNotes.createdBy, me(a)))! },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    kind: { type: 'enum', label: 'Type', options: ['internal', 'client'], list: true, filter: true, default: 'internal' },
    meetingDate: { type: 'date', label: 'Date', required: true, list: true, filter: true, default: () => today() },
    attendees: { type: 'text', label: 'Attendees', max: 1000 },
    notes: { type: 'markdown', label: 'Notes' },
    actionItems: { type: 'markdown', label: 'Action items' },
  },
  hooks: { beforeCreate(c, d) { d.createdBy = c.actor.userId; } },
});

defineResource({
  key: 'project_updates', table: projectUpdates, label: 'Project update', plural: 'Project updates', module: 'delivery', perm: 'projects',
  titleField: 'title', defaultSort: '-createdAt', collab: { comments: true },
  description: 'Daily updates, weekly reports, client updates and escalations.',
  scopes: projectChildScopes(projectUpdates.projectId),
  eventFields: ['kind', 'projectId', 'escalateToRole', 'health'],
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    kind: { type: 'enum', label: 'Type', options: ['daily', 'weekly', 'escalation', 'client_update'], list: true, filter: true, default: 'daily' },
    health: { type: 'enum', label: 'Health', options: ['on_track', 'at_risk', 'delayed'], list: true },
    escalateToRole: { type: 'enum', label: 'Escalate to', options: ['pm', 'cto', 'ceo'], help: 'Escalations only' },
    authorId: { type: 'ref', ref: 'users', label: 'Author', readonly: true, list: true },
    resolvedAt: { type: 'datetime', label: 'Resolved', readonly: true, list: true },
    createdAt: { type: 'datetime', label: 'Posted', readonly: true, list: true },
    body: { type: 'markdown', label: 'Update' },
  },
  hooks: {
    beforeCreate(c, d) {
      d.authorId = c.actor.userId;
      if (d.kind === 'escalation' && !d.escalateToRole) d.escalateToRole = 'cto';
      if (d.kind !== 'escalation') d.escalateToRole = null;
    },
  },
});

defineResource({
  key: 'client_feedback', table: clientFeedback, label: 'Client feedback', plural: 'Client feedback', module: 'delivery', perm: 'projects',
  titleField: 'title', defaultSort: '-createdAt', collab: { comments: true, files: true },
  description: 'Reviews and approvals requested from clients. Overdue requests count against client health and as client delays.',
  scopes: { own: (a) => inMyProjects(clientFeedback.projectId, a) },
  status: { field: 'status', transitions: { requested: ['received', 'overdue', 'closed'], overdue: ['received', 'closed'], received: ['closed'], closed: [] } },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client', required: true, list: true, filter: true },
    milestoneId: { type: 'ref', ref: 'milestones', label: 'Milestone' },
    kind: { type: 'enum', label: 'Type', options: ['review_request', 'feedback', 'testimonial', 'complaint'], list: true, filter: true, default: 'review_request' },
    status: { type: 'enum', label: 'Status', options: ['requested', 'received', 'overdue', 'closed'], list: true, filter: true, default: 'requested' },
    requestedAt: { type: 'date', label: 'Requested on', list: true, default: () => today() },
    dueDate: { type: 'date', label: 'Response due', list: true, filter: true },
    receivedAt: { type: 'date', label: 'Received on', readonly: true, list: true },
    rating: { type: 'int', label: 'Satisfaction (1–5)', min: 1, max: 5, list: true },
    comments: { type: 'textarea', label: 'Client comments' },
  },
  hooks: {
    async beforeCreate(c, d) {
      if (d.projectId) {
        const [p] = await c.tx.select({ clientId: projects.clientId }).from(projects).where(eq(projects.id, d.projectId));
        if (p?.clientId && d.companyId !== p.clientId) throw invalid('Validation failed', { companyId: 'Client does not match the project' });
      }
      if (d.kind !== 'review_request') { d.status = 'received'; d.receivedAt = today(); }
    },
    beforeUpdate(_c, d, prev) {
      if (d.status === 'received' && prev.status !== 'received') d.receivedAt = today();
    },
  },
});

defineResource({
  key: 'project_onboardings', table: projectOnboardings, label: 'Onboarding', plural: 'Project onboarding', module: 'delivery', perm: 'projects',
  permissions: { create: null, delete: null, edit: null },
  titleField: 'status', formatTitle: (r) => `Onboarding (${String(r.status).replace(/_/g, ' ')})`,
  scopes: { own: (a) => or(inMyProjects(projectOnboardings.projectId, a), eq(projectOnboardings.bdOwnerId, me(a)))! },
  fields: {
    projectId: { type: 'ref', ref: 'projects', label: 'Project', readonly: true, list: true },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Deal', readonly: true, list: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client', readonly: true, list: true },
    status: { type: 'enum', label: 'Step', options: ['bd_handover', 'pm_review', 'cto_review', 'development_kickoff', 'completed', 'cancelled'], readonly: true, list: true, filter: true },
    bdOwnerId: { type: 'ref', ref: 'users', label: 'BD owner', readonly: true, list: true },
    handoverNotes: { type: 'textarea', label: 'BD handover notes', readonly: true },
    pmNotes: { type: 'textarea', label: 'PM review notes', readonly: true },
    ctoNotes: { type: 'textarea', label: 'CTO notes', readonly: true },
    completedAt: { type: 'datetime', label: 'Completed', readonly: true },
  },
});

