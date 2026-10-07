import { pgTable, pgEnum, text, boolean, integer, date, uuid, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './_helpers.ts';
import { users } from './core.ts';
import { projects, tasks } from './projects.ts';
import { priority } from './enums.ts';
import { infraResources } from './it.ts';
import { tickets } from './support.ts';

export const gitProvider = pgEnum('git_provider', ['github', 'gitlab', 'bitbucket', 'other']);

export const repositories = pgTable('repositories', {
  id: id(),
  projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
  name: text().notNull(),
  provider: gitProvider().notNull().default('github'),
  url: text(),
  defaultBranch: text().notNull().default('main'),
  branchingStrategy: text(),
  isPrivate: boolean().notNull().default(true),
  notes: text(),
  ...timestamps,
}, (t) => [index('repos_project_idx').on(t.projectId)]);

export const envKind = pgEnum('environment_kind', ['development', 'staging', 'production']);
export const envStatus = pgEnum('environment_status', ['healthy', 'degraded', 'down', 'unknown']);

export const environments = pgTable('environments', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  kind: envKind().notNull().default('staging'),
  url: text(),
  branch: text(),
  /** Hosting / server record this environment runs on. */
  infraResourceId: uuid().references(() => infraResources.id),
  status: envStatus().notNull().default('unknown'),
  notes: text(),
  ...timestamps,
}, (t) => [index('envs_project_idx').on(t.projectId)]);

export const prStatus = pgEnum('pull_request_status', ['open', 'changes_requested', 'approved', 'merged', 'closed']);

/** Pull requests / code reviews (manual until a Git provider integration is configured). */
export const pullRequests = pgTable('pull_requests', {
  id: id(),
  repositoryId: uuid().notNull().references(() => repositories.id, { onDelete: 'cascade' }),
  taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  number: integer(),
  title: text().notNull(),
  branch: text(),
  targetBranch: text(),
  authorId: uuid().references(() => users.id),
  reviewerId: uuid().references(() => users.id),
  status: prStatus().notNull().default('open'),
  url: text(),
  openedAt: tstz().defaultNow().notNull(),
  reviewedAt: tstz(),
  mergedAt: tstz(),
  ...timestamps,
}, (t) => [index('prs_repo_idx').on(t.repositoryId), index('prs_reviewer_idx').on(t.reviewerId, t.status)]);

export const deploymentStatus = pgEnum('deployment_status', ['pending_approval', 'approved', 'rejected', 'in_progress', 'succeeded', 'failed', 'rolled_back']);

export const deployments = pgTable('deployments', {
  id: id(),
  number: text().notNull().unique(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  environmentId: uuid().notNull().references(() => environments.id),
  version: text().notNull(),
  gitRef: text(),
  status: deploymentStatus().notNull().default('approved'),
  requestedById: uuid().references(() => users.id),
  deployedById: uuid().references(() => users.id),
  deployedAt: tstz(),
  releaseNotes: text(),
  ...timestamps,
}, (t) => [index('deploys_project_idx').on(t.projectId), index('deploys_env_idx').on(t.environmentId)]);

export const severity = pgEnum('severity', ['critical', 'high', 'medium', 'low']);
export const bugStatus = pgEnum('bug_status', ['new', 'confirmed', 'in_progress', 'fixed', 'ready_for_retest', 'verified', 'reopened', 'closed', 'wont_fix', 'duplicate']);
export const foundIn = pgEnum('found_in', ['qa', 'client', 'production', 'internal']);

export const bugs = pgTable('bugs', {
  id: id(),
  number: text().notNull().unique(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  title: text().notNull(),
  description: text(),
  stepsToReproduce: text(),
  expectedResult: text(),
  actualResult: text(),
  severity: severity().notNull().default('medium'),
  priority: priority().notNull().default('medium'),
  status: bugStatus().notNull().default('new'),
  environment: envKind(),
  foundIn: foundIn().notNull().default('qa'),
  reportedById: uuid().references(() => users.id),
  assigneeId: uuid().references(() => users.id),
  /** Developer whose change introduced the defect (for quality metrics, not blame). */
  introducedById: uuid().references(() => users.id),
  qaRunId: uuid().references((): AnyPgColumn => qaRuns.id, { onDelete: 'set null' }),
  testCaseId: uuid().references((): AnyPgColumn => testCases.id, { onDelete: 'set null' }),
  ticketId: uuid().references((): AnyPgColumn => tickets.id, { onDelete: 'set null' }),
  retestCount: integer().notNull().default(0),
  resolvedAt: tstz(),
  closedAt: tstz(),
  ...timestamps,
}, (t) => [index('bugs_project_idx').on(t.projectId, t.status), index('bugs_assignee_idx').on(t.assigneeId, t.status)]);

export const qaCategory = pgEnum('qa_category', ['wordpress', 'elementor', 'woocommerce', 'mobile_app', 'seo', 'performance', 'security', 'pre_launch', 'general']);

/** Reusable QA checklists (WordPress QA, WooCommerce QA, Pre-launch QA…). */
export const qaTemplates = pgTable('qa_templates', {
  id: id(),
  name: text().notNull().unique(),
  category: qaCategory().notNull().default('general'),
  description: text(),
  isActive: boolean().notNull().default(true),
  ...timestamps,
});

export const qaTemplateItems = pgTable('qa_template_items', {
  id: id(),
  templateId: uuid().notNull().references(() => qaTemplates.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  area: text(),
  steps: text(),
  expectedResult: text(),
  priority: priority().notNull().default('medium'),
  sortOrder: integer().notNull().default(0),
  ...timestamps,
}, (t) => [index('qa_tpl_items_tpl_idx').on(t.templateId)]);

export const testCases = pgTable('test_cases', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  templateItemId: uuid().references(() => qaTemplateItems.id, { onDelete: 'set null' }),
  title: text().notNull(),
  area: text(),
  steps: text(),
  expectedResult: text(),
  priority: priority().notNull().default('medium'),
  isActive: boolean().notNull().default(true),
  ...timestamps,
}, (t) => [index('test_cases_project_idx').on(t.projectId), uniqueIndex('test_cases_tpl_uq').on(t.projectId, t.templateItemId)]);

export const qaRunStatus = pgEnum('qa_run_status', ['planned', 'in_progress', 'completed', 'approved', 'rejected']);

export const qaRuns = pgTable('qa_runs', {
  id: id(),
  number: text().notNull().unique(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  environmentId: uuid().references(() => environments.id),
  status: qaRunStatus().notNull().default('planned'),
  assigneeId: uuid().references(() => users.id),
  startedAt: tstz(),
  completedAt: tstz(),
  decidedById: uuid().references(() => users.id),
  decidedAt: tstz(),
  summary: text(),
  totalCount: integer().notNull().default(0),
  passCount: integer().notNull().default(0),
  failCount: integer().notNull().default(0),
  blockedCount: integer().notNull().default(0),
  ...timestamps,
}, (t) => [index('qa_runs_project_idx').on(t.projectId)]);

export const resultStatus = pgEnum('test_result_status', ['pending', 'pass', 'fail', 'blocked', 'skipped']);

export const qaRunResults = pgTable('qa_run_results', {
  id: id(),
  runId: uuid().notNull().references(() => qaRuns.id, { onDelete: 'cascade' }),
  testCaseId: uuid().notNull().references(() => testCases.id, { onDelete: 'cascade' }),
  status: resultStatus().notNull().default('pending'),
  notes: text(),
  testedById: uuid().references(() => users.id),
  testedAt: tstz(),
  bugId: uuid().references(() => bugs.id, { onDelete: 'set null' }),
  sortOrder: integer().notNull().default(0),
  ...timestamps,
}, (t) => [uniqueIndex('qa_results_uq').on(t.runId, t.testCaseId)]);

export const reviewKind = pgEnum('tech_review_kind', ['feasibility', 'architecture', 'integration', 'infrastructure', 'security', 'other']);
export const reviewStatus = pgEnum('tech_review_status', ['draft', 'submitted', 'approved', 'rejected']);

/** CTO approval workflows: architecture, integrations, infrastructure, security… */
export const techReviews = pgTable('tech_reviews', {
  id: id(),
  number: text().notNull().unique(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  kind: reviewKind().notNull().default('architecture'),
  title: text().notNull(),
  summary: text(),
  decision: text(),
  status: reviewStatus().notNull().default('draft'),
  requestedById: uuid().references(() => users.id),
  decidedAt: tstz(),
  ...timestamps,
});

export const debtStatus = pgEnum('tech_debt_status', ['open', 'planned', 'in_progress', 'resolved', 'wont_fix']);
export const effort = pgEnum('effort', ['small', 'medium', 'large']);

export const techDebt = pgTable('tech_debt', {
  id: id(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  repositoryId: uuid().references(() => repositories.id, { onDelete: 'set null' }),
  title: text().notNull(),
  description: text(),
  impact: priority().notNull().default('medium'),
  effort: effort().notNull().default('medium'),
  status: debtStatus().notNull().default('open'),
  ownerId: uuid().references(() => users.id),
  dueDate: date(),
  ...timestamps,
});

export const techCategory = pgEnum('technology_category', ['language', 'framework', 'cms', 'database', 'hosting', 'service', 'tool']);

export const technologies = pgTable('technologies', {
  id: id(),
  name: text().notNull().unique(),
  category: techCategory().notNull().default('framework'),
  /** Approved for new projects (company technology standard). */
  isStandard: boolean().notNull().default(true),
  notes: text(),
  ...timestamps,
});

export const projectTechnologies = pgTable('project_technologies', {
  id: id(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  technologyId: uuid().notNull().references(() => technologies.id, { onDelete: 'cascade' }),
  version: text(),
  ...timestamps,
}, (t) => [uniqueIndex('project_tech_uq').on(t.projectId, t.technologyId)]);
