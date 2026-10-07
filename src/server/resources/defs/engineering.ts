import { eq, or, sql } from 'drizzle-orm';
import {
  bugs, deployments, environments, projectTechnologies, pullRequests, qaRunResults, qaRuns, qaTemplateItems, qaTemplates,
  repositories, techDebt, technologies, techReviews, testCases,
} from '../../db/schema/index.ts';
import { forbidden, invalid } from '../../core/errors.ts';
import { requestApproval } from '../../core/approvals.ts';
import { can } from '../../rbac/actor.ts';
import { defineResource } from '../registry.ts';
import { inMyProjects } from '../scopes.ts';
import { refreshRunCounts } from '../../modules/qa.ts';

const me = (a: { userId: string }) => a.userId;
const PRIORITY = ['low', 'medium', 'high', 'critical'] as const;
const projectScope = (column: any) => ({ own: (a: any) => inMyProjects(column, a) });

defineResource({
  key: 'repositories', table: repositories, label: 'Repository', plural: 'Repositories', module: 'engineering', perm: 'dev',
  titleField: 'name', defaultSort: 'name', scopes: projectScope(repositories.projectId),
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    provider: { type: 'enum', label: 'Provider', options: ['github', 'gitlab', 'bitbucket', 'other'], list: true, default: 'github' },
    url: { type: 'url', label: 'URL', list: true },
    defaultBranch: { type: 'text', label: 'Default branch', default: 'main', list: true },
    isPrivate: { type: 'bool', label: 'Private', default: true },
    branchingStrategy: { type: 'textarea', label: 'Branching strategy' },
    notes: { type: 'textarea', label: 'Notes' },
  },
  children: [{ resource: 'pull_requests', field: 'repositoryId' }, { resource: 'tech_debt', field: 'repositoryId' }],
});

defineResource({
  key: 'environments', table: environments, label: 'Environment', plural: 'Environments', module: 'engineering', perm: 'dev',
  titleField: 'name', defaultSort: 'name', scopes: projectScope(environments.projectId), eventFields: ['status', 'kind'],
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    kind: { type: 'enum', label: 'Type', options: ['development', 'staging', 'production'], list: true, filter: true, default: 'staging' },
    url: { type: 'url', label: 'URL', list: true },
    branch: { type: 'text', label: 'Deployed branch' },
    status: { type: 'enum', label: 'Health', options: ['healthy', 'degraded', 'down', 'unknown'], list: true, filter: true, default: 'unknown' },
    notes: { type: 'textarea', label: 'Notes (never store credentials here)' },
  },
  children: [{ resource: 'deployments', field: 'environmentId' }],
});

defineResource({
  key: 'pull_requests', table: pullRequests, label: 'Pull request', plural: 'Pull requests', module: 'engineering', perm: 'dev',
  titleField: 'title', defaultSort: '-openedAt', collab: { comments: true },
  description: 'Code reviews. Recorded manually until a Git provider integration is connected.',
  scopes: {
    own: (a) => or(eq(pullRequests.authorId, me(a)), eq(pullRequests.reviewerId, me(a)),
      sql`${pullRequests.repositoryId} in (select r.id from repositories r where ${inMyProjects(sql`r.project_id`, a)})`)!,
  },
  assignees: ['reviewerId'],
  status: { field: 'status', transitions: { open: ['changes_requested', 'approved', 'closed'], changes_requested: ['open', 'approved', 'closed'], approved: ['merged', 'changes_requested', 'closed'], merged: [], closed: ['open'] } },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    repositoryId: { type: 'ref', ref: 'repositories', label: 'Repository', required: true, createOnly: true, list: true, filter: true },
    number: { type: 'int', label: 'PR #', min: 1, list: true },
    status: { type: 'enum', label: 'Review status', options: ['open', 'changes_requested', 'approved', 'merged', 'closed'], list: true, filter: true, default: 'open' },
    authorId: { type: 'ref', ref: 'users', label: 'Author', list: true, filter: true, default: me },
    reviewerId: { type: 'ref', ref: 'users', label: 'Reviewer', list: true, filter: true },
    taskId: { type: 'ref', ref: 'tasks', label: 'Task' },
    branch: { type: 'text', label: 'Branch' },
    targetBranch: { type: 'text', label: 'Target branch', default: 'main' },
    url: { type: 'url', label: 'Link' },
    openedAt: { type: 'datetime', label: 'Opened', readonly: true, list: true },
    reviewedAt: { type: 'datetime', label: 'Reviewed', readonly: true },
    mergedAt: { type: 'datetime', label: 'Merged', readonly: true },
  },
  hooks: {
    beforeUpdate(c, d, prev) {
      if (d.status && d.status !== prev.status) {
        if (['approved', 'changes_requested'].includes(d.status)) {
          if (c.actor.userId === prev.authorId) throw forbidden('Authors cannot review their own pull request');
          d.reviewedAt = new Date();
        }
        if (d.status === 'merged') d.mergedAt = new Date();
      }
    },
  },
});

defineResource({
  key: 'deployments', table: deployments, label: 'Deployment', plural: 'Deployments', module: 'engineering', perm: 'dev',
  titleField: 'version', formatTitle: (r) => `${r.number} · ${r.version}`, defaultSort: '-createdAt',
  numbering: { field: 'number', key: 'deployment', prefix: 'DEP-', pad: 5 },
  description: 'Deployment history. Production deployments require CTO approval.',
  scopes: projectScope(deployments.projectId), eventFields: ['projectId', 'environmentId'],
  status: {
    field: 'status',
    transitions: { pending_approval: [], approved: ['in_progress', 'succeeded', 'failed'], in_progress: ['succeeded', 'failed'], succeeded: ['rolled_back'], failed: [], rolled_back: [], rejected: [] },
  },
  fields: {
    version: { type: 'text', label: 'Version / release', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    environmentId: { type: 'ref', ref: 'environments', label: 'Environment', required: true, createOnly: true, list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['pending_approval', 'approved', 'rejected', 'in_progress', 'succeeded', 'failed', 'rolled_back'], list: true, filter: true },
    gitRef: { type: 'text', label: 'Commit / tag' },
    requestedById: { type: 'ref', ref: 'users', label: 'Requested by', readonly: true, list: true },
    deployedById: { type: 'ref', ref: 'users', label: 'Deployed by', readonly: true },
    deployedAt: { type: 'datetime', label: 'Deployed at', readonly: true, list: true },
    releaseNotes: { type: 'markdown', label: 'Release notes' },
  },
  hooks: {
    async beforeCreate(c, d) {
      const [env] = await c.tx.select().from(environments).where(eq(environments.id, d.environmentId));
      if (!env || env.projectId !== d.projectId) throw invalid('Validation failed', { environmentId: 'Environment belongs to another project' });
      d.requestedById = c.actor.userId;
      d.status = env.kind === 'production' ? 'pending_approval' : 'approved';
    },
    async afterCreate(c, row) {
      if (row.status === 'pending_approval') {
        await requestApproval(c.tx, {
          kind: 'production_deployment', entityType: 'deployments', entityId: row.id, title: `Production deployment ${row.number} (${row.version})`,
          details: row.releaseNotes?.slice(0, 500), requestedBy: c.actor.userId, approverRoleKey: 'cto',
        });
      }
    },
    beforeUpdate(c, d, prev) {
      if (d.status && d.status !== prev.status && ['succeeded', 'in_progress'].includes(d.status)) {
        d.deployedById = c.actor.userId;
        if (d.status === 'succeeded') d.deployedAt = new Date();
      }
    },
  },
});

/** Only QA may verify, reopen or close bugs; developers move them to fixed. */
const QA_ONLY = new Set(['verified', 'reopened', 'closed', 'ready_for_retest']);

defineResource({
  key: 'bugs', table: bugs, label: 'Bug', plural: 'Bugs', module: 'engineering', perm: 'bugs',
  titleField: 'title', board: 'status', collab: { comments: true, files: true }, defaultSort: '-createdAt',
  numbering: { field: 'number', key: 'bug', prefix: 'BUG-', pad: 5 },
  scopes: {
    own: (a) => or(eq(bugs.assigneeId, me(a)), eq(bugs.reportedById, me(a)), eq(bugs.introducedById, me(a)), inMyProjects(bugs.projectId, a))!,
  },
  assignees: ['assigneeId'], eventFields: ['severity', 'projectId', 'reportedById', 'assigneeId'],
  status: {
    field: 'status',
    transitions: {
      new: ['confirmed', 'in_progress', 'wont_fix', 'duplicate'],
      confirmed: ['in_progress', 'wont_fix', 'duplicate'],
      in_progress: ['fixed', 'confirmed'],
      fixed: ['ready_for_retest', 'in_progress'],
      ready_for_retest: ['verified', 'reopened'],
      reopened: ['in_progress', 'wont_fix'],
      verified: ['closed', 'reopened'],
      closed: ['reopened'],
      wont_fix: ['reopened'],
      duplicate: [],
    },
  },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, list: true, filter: true },
    severity: { type: 'enum', label: 'Severity', options: ['critical', 'high', 'medium', 'low'], list: true, filter: true, default: 'medium' },
    priority: { type: 'enum', label: 'Priority', options: PRIORITY, list: true, filter: true, default: 'medium' },
    status: { type: 'enum', label: 'Fix / QA status', options: ['new', 'confirmed', 'in_progress', 'fixed', 'ready_for_retest', 'verified', 'reopened', 'closed', 'wont_fix', 'duplicate'], list: true, filter: true, default: 'new' },
    assigneeId: { type: 'ref', ref: 'users', label: 'Assignee', list: true, filter: true },
    environment: { type: 'enum', label: 'Environment', options: ['development', 'staging', 'production'], filter: true },
    foundIn: { type: 'enum', label: 'Found in', options: ['qa', 'client', 'production', 'internal'], filter: true, default: 'qa' },
    taskId: { type: 'ref', ref: 'tasks', label: 'Related task' },
    introducedById: { type: 'ref', ref: 'users', label: 'Introduced by', filter: true, writePermission: 'bugs.assign' },
    reportedById: { type: 'ref', ref: 'users', label: 'Reported by', readonly: true, list: true },
    retestCount: { type: 'int', label: 'Reopened', readonly: true },
    resolvedAt: { type: 'datetime', label: 'Fixed at', readonly: true },
    stepsToReproduce: { type: 'markdown', label: 'Steps to reproduce' },
    expectedResult: { type: 'textarea', label: 'Expected result' },
    actualResult: { type: 'textarea', label: 'Actual result' },
    description: { type: 'markdown', label: 'Additional details' },
  },
  hooks: {
    beforeCreate(c, d) { d.reportedById = c.actor.userId; },
    beforeUpdate(c, d, prev) {
      if (!d.status || d.status === prev.status) return;
      if (QA_ONLY.has(d.status) && !can(c.actor, 'qa.edit')) throw forbidden('Only QA can retest, verify, reopen or close bugs');
      if (d.status === 'fixed') d.resolvedAt = new Date();
      if (d.status === 'reopened') { d.retestCount = (prev.retestCount ?? 0) + 1; d.resolvedAt = null; }
      if (d.status === 'closed') d.closedAt = new Date();
    },
  },
});

defineResource({
  key: 'qa_templates', table: qaTemplates, label: 'QA template', plural: 'QA templates', module: 'engineering', perm: 'qa',
  titleField: 'name', defaultSort: 'name', directory: true,
  description: 'Reusable checklists: WordPress, Elementor, WooCommerce, mobile, SEO, performance, security, pre-launch.',
  scopes: { own: () => sql`true` },
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    category: { type: 'enum', label: 'Category', options: ['wordpress', 'elementor', 'woocommerce', 'mobile_app', 'seo', 'performance', 'security', 'pre_launch', 'general'], list: true, filter: true, default: 'general' },
    isActive: { type: 'bool', label: 'Active', list: true, default: true },
    description: { type: 'textarea', label: 'Description' },
  },
  children: [{ resource: 'qa_template_items', field: 'templateId', label: 'Checks' }],
});

defineResource({
  key: 'qa_template_items', table: qaTemplateItems, label: 'Check', plural: 'Template checks', module: 'engineering', perm: 'qa',
  titleField: 'title', defaultSort: 'sortOrder', scopes: { own: () => sql`true` },
  fields: {
    templateId: { type: 'ref', ref: 'qa_templates', label: 'Template', required: true, createOnly: true, filter: true },
    title: { type: 'text', label: 'Check', required: true, list: true, search: true },
    area: { type: 'text', label: 'Area', list: true },
    priority: { type: 'enum', label: 'Priority', options: PRIORITY, list: true, default: 'medium' },
    steps: { type: 'textarea', label: 'Steps' },
    expectedResult: { type: 'textarea', label: 'Expected result', list: true },
    sortOrder: { type: 'int', label: 'Order', default: 0 },
  },
});

defineResource({
  key: 'test_cases', table: testCases, label: 'Test case', plural: 'Test cases', module: 'engineering', perm: 'qa',
  titleField: 'title', defaultSort: 'area', scopes: projectScope(testCases.projectId),
  fields: {
    title: { type: 'text', label: 'Test case', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    area: { type: 'text', label: 'Area', list: true, filter: true },
    priority: { type: 'enum', label: 'Priority', options: PRIORITY, list: true, filter: true, default: 'medium' },
    isActive: { type: 'bool', label: 'Active', list: true, default: true },
    steps: { type: 'textarea', label: 'Steps' },
    expectedResult: { type: 'textarea', label: 'Expected result' },
    templateItemId: { type: 'ref', ref: 'qa_template_items', label: 'From template check', readonly: true },
  },
});

defineResource({
  key: 'qa_runs', table: qaRuns, label: 'QA run', plural: 'QA runs', module: 'engineering', perm: 'qa',
  titleField: 'name', defaultSort: '-createdAt', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'qa_run', prefix: 'QA-', pad: 4 },
  description: 'Test cycles. Start from QA templates; failures raise bugs; sign-off enables launch.',
  // Runs are created and decided through /api/qa endpoints so the workflow stays consistent.
  permissions: { create: null },
  scopes: { own: (a) => or(inMyProjects(qaRuns.projectId, a), eq(qaRuns.assigneeId, me(a)))! },
  assignees: ['assigneeId'], eventFields: ['projectId'],
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', readonly: true, list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['planned', 'in_progress', 'completed', 'approved', 'rejected'], readonly: true, list: true, filter: true },
    assigneeId: { type: 'ref', ref: 'users', label: 'Tester', list: true, filter: true },
    environmentId: { type: 'ref', ref: 'environments', label: 'Environment' },
    totalCount: { type: 'int', label: 'Cases', readonly: true, list: true },
    passCount: { type: 'int', label: 'Passed', readonly: true, list: true },
    failCount: { type: 'int', label: 'Failed', readonly: true, list: true },
    blockedCount: { type: 'int', label: 'Blocked', readonly: true },
    startedAt: { type: 'datetime', label: 'Started', readonly: true },
    completedAt: { type: 'datetime', label: 'Completed', readonly: true },
    decidedAt: { type: 'datetime', label: 'Signed off / rejected', readonly: true },
    summary: { type: 'textarea', label: 'Summary' },
  },
});

defineResource({
  key: 'qa_run_results', table: qaRunResults, label: 'Test result', plural: 'Test results', module: 'engineering', perm: 'qa',
  titleField: 'status', formatTitle: (r) => `Result: ${r.status}`, defaultSort: 'sortOrder', permissions: { create: null, delete: null },
  scopes: { own: (a) => sql`${qaRunResults.runId} in (select r.id from qa_runs r where ${inMyProjects(sql`r.project_id`, a)})` },
  fields: {
    runId: { type: 'ref', ref: 'qa_runs', label: 'Run', readonly: true, filter: true },
    testCaseId: { type: 'ref', ref: 'test_cases', label: 'Test case', readonly: true, list: true },
    status: { type: 'enum', label: 'Result', options: ['pending', 'pass', 'fail', 'blocked', 'skipped'], list: true, filter: true },
    notes: { type: 'text', label: 'Notes', list: true, max: 2000 },
    bugId: { type: 'ref', ref: 'bugs', label: 'Bug', list: true },
    testedById: { type: 'ref', ref: 'users', label: 'Tested by', readonly: true, list: true },
  },
  hooks: {
    async beforeUpdate(c, d, prev) {
      const [run] = await c.tx.select({ status: qaRuns.status }).from(qaRuns).where(eq(qaRuns.id, prev.runId));
      if (!['planned', 'in_progress'].includes(run.status)) throw invalid('This QA run is closed', { status: 'Run is no longer open' });
      if (d.status && d.status !== prev.status) { d.testedById = c.actor.userId; d.testedAt = new Date(); }
    },
    async afterUpdate(c, row) { await refreshRunCounts(c.tx, row.runId, true); },
  },
});

defineResource({
  key: 'tech_reviews', table: techReviews, label: 'Technical review', plural: 'Technical reviews', module: 'engineering', perm: 'tech',
  titleField: 'title', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'tech_review', prefix: 'TR-', pad: 4 },
  description: 'Architecture, integration, infrastructure and security decisions that need CTO approval.',
  scopes: { own: (a) => or(eq(techReviews.requestedById, me(a)), inMyProjects(techReviews.projectId, a))! },
  status: { field: 'status', transitions: { draft: ['submitted'], submitted: [], approved: [], rejected: ['draft'] } },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    kind: { type: 'enum', label: 'Type', options: ['feasibility', 'architecture', 'integration', 'infrastructure', 'security', 'other'], list: true, filter: true, default: 'architecture' },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['draft', 'submitted', 'approved', 'rejected'], list: true, filter: true, default: 'draft' },
    requestedById: { type: 'ref', ref: 'users', label: 'Requested by', readonly: true, list: true },
    decidedAt: { type: 'datetime', label: 'Decided', readonly: true },
    summary: { type: 'markdown', label: 'Proposal' },
    decision: { type: 'textarea', label: 'Decision record', readonly: true },
  },
  hooks: {
    beforeCreate(c, d) { d.requestedById = c.actor.userId; },
    async afterUpdate(c, row, prev) {
      if (row.status === 'submitted' && prev.status !== 'submitted') {
        await requestApproval(c.tx, {
          kind: 'tech_review', entityType: 'tech_reviews', entityId: row.id, title: `${row.number} ${row.kind} review: ${row.title}`,
          requestedBy: c.actor.userId, approverRoleKey: 'cto',
        });
      }
    },
  },
});

defineResource({
  key: 'tech_debt', table: techDebt, label: 'Tech debt item', plural: 'Tech debt', module: 'engineering', perm: 'tech',
  titleField: 'title', defaultSort: '-createdAt', scopes: { own: (a) => or(eq(techDebt.ownerId, me(a)), inMyProjects(techDebt.projectId, a))! },
  assignees: ['ownerId'],
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', list: true, filter: true },
    repositoryId: { type: 'ref', ref: 'repositories', label: 'Repository' },
    impact: { type: 'enum', label: 'Impact', options: PRIORITY, list: true, filter: true, default: 'medium' },
    effort: { type: 'enum', label: 'Effort', options: ['small', 'medium', 'large'], list: true, default: 'medium' },
    status: { type: 'enum', label: 'Status', options: ['open', 'planned', 'in_progress', 'resolved', 'wont_fix'], list: true, filter: true, default: 'open' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true },
    dueDate: { type: 'date', label: 'Target date' },
    description: { type: 'textarea', label: 'Description' },
  },
});

defineResource({
  key: 'technologies', table: technologies, label: 'Technology', plural: 'Technology stack', module: 'engineering', perm: 'tech',
  titleField: 'name', defaultSort: 'name', directory: true, scopes: { own: () => sql`true` },
  description: 'Company technology standards and what each project uses.',
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    category: { type: 'enum', label: 'Category', options: ['language', 'framework', 'cms', 'database', 'hosting', 'service', 'tool'], list: true, filter: true, default: 'framework' },
    isStandard: { type: 'bool', label: 'Approved standard', list: true, filter: true, default: true },
    notes: { type: 'textarea', label: 'Notes' },
  },
  children: [{ resource: 'project_technologies', field: 'technologyId', label: 'Used by projects' }],
});

defineResource({
  key: 'project_technologies', table: projectTechnologies, label: 'Project technology', plural: 'Tech stack', module: 'engineering', perm: 'tech',
  titleField: 'version', formatTitle: (r) => `Stack item ${r.version ?? ''}`.trim(), scopes: projectScope(projectTechnologies.projectId),
  permissions: { export: null },
  fields: {
    projectId: { type: 'ref', ref: 'projects', label: 'Project', required: true, createOnly: true, list: true, filter: true },
    technologyId: { type: 'ref', ref: 'technologies', label: 'Technology', required: true, createOnly: true, list: true, filter: true },
    version: { type: 'text', label: 'Version', list: true },
  },
});
