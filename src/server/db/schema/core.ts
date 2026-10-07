import {
  pgTable, pgEnum, text, boolean, integer, date, jsonb, bigserial, uuid, time,
  primaryKey, uniqueIndex, index, smallint, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { id, timestamps, tstz } from './_helpers.ts';

// ───────────────────────── Identity & access ─────────────────────────

export const userStatus = pgEnum('user_status', ['active', 'disabled']);

export const users = pgTable('users', {
  id: id(),
  email: text().notNull(),
  name: text().notNull(),
  passwordHash: text(),
  status: userStatus().notNull().default('active'),
  mustChangePassword: boolean().notNull().default(false),
  failedLoginCount: integer().notNull().default(0),
  lockedUntil: tstz(),
  lastLoginAt: tstz(),
  ...timestamps,
}, (t) => [uniqueIndex('users_email_lower_uq').on(sql`lower(${t.email})`)]);

export const roles = pgTable('roles', {
  id: id(),
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  isSystem: boolean().notNull().default(false),
  /** Which home dashboard this role lands on. */
  homeDashboard: text().notNull().default('employee'),
  ...timestamps,
});

export const userRoles = pgTable('user_roles', {
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  roleId: uuid().notNull().references(() => roles.id, { onDelete: 'cascade' }),
  createdAt: tstz().defaultNow().notNull(),
}, (t) => [primaryKey({ columns: [t.userId, t.roleId] })]);

export const permissionScope = pgEnum('permission_scope', ['own', 'team', 'all']);

/** Permission keys are validated against the code catalog (src/server/rbac/catalog.ts). */
export const rolePermissions = pgTable('role_permissions', {
  roleId: uuid().notNull().references(() => roles.id, { onDelete: 'cascade' }),
  permission: text().notNull(),
  scope: permissionScope().notNull().default('all'),
}, (t) => [primaryKey({ columns: [t.roleId, t.permission] })]);

export const sessions = pgTable('sessions', {
  id: id(),
  tokenHash: text().notNull().unique(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  ip: text(),
  userAgent: text(),
  createdAt: tstz().defaultNow().notNull(),
  lastSeenAt: tstz().defaultNow().notNull(),
  expiresAt: tstz().notNull(),
  revokedAt: tstz(),
}, (t) => [index('sessions_user_idx').on(t.userId)]);

// ───────────────────────── Organisation ─────────────────────────

export const locations = pgTable('locations', {
  id: id(),
  name: text().notNull().unique(),
  address: text(),
  timezone: text().notNull().default('Asia/Karachi'),
  ...timestamps,
});

export const departments = pgTable('departments', {
  id: id(),
  name: text().notNull().unique(),
  code: text().notNull().unique(),
  description: text(),
  parentId: uuid().references((): AnyPgColumn => departments.id),
  headUserId: uuid().references(() => users.id),
  ...timestamps,
});

export const designations = pgTable('designations', {
  id: id(),
  title: text().notNull(),
  departmentId: uuid().references(() => departments.id),
  level: smallint(),
  ...timestamps,
}, (t) => [uniqueIndex('designations_title_dept_uq').on(t.title, t.departmentId)]);

export const workSchedules = pgTable('work_schedules', {
  id: id(),
  name: text().notNull().unique(),
  startTime: time().notNull(),
  endTime: time().notNull(),
  /** ISO weekdays 1 (Mon) – 7 (Sun) */
  workdays: smallint().array().notNull(),
  graceMinutes: integer().notNull().default(15),
  ...timestamps,
});

export const holidays = pgTable('holidays', {
  id: id(),
  date: date().notNull(),
  name: text().notNull(),
  locationId: uuid().references(() => locations.id),
  ...timestamps,
}, (t) => [uniqueIndex('holidays_date_loc_uq').on(t.date, t.locationId)]);

export const employmentType = pgEnum('employment_type', ['full_time', 'part_time', 'contract', 'intern']);
export const employmentStatus = pgEnum('employment_status', ['probation', 'active', 'notice', 'terminated', 'resigned']);

export const employees = pgTable('employees', {
  id: id(),
  userId: uuid().unique().references(() => users.id),
  employeeCode: text().notNull().unique(),
  firstName: text().notNull(),
  lastName: text().notNull(),
  workEmail: text(),
  phone: text(),
  departmentId: uuid().references(() => departments.id),
  designationId: uuid().references(() => designations.id),
  managerId: uuid().references((): AnyPgColumn => employees.id),
  locationId: uuid().references(() => locations.id),
  workScheduleId: uuid().references(() => workSchedules.id),
  employmentType: employmentType().notNull().default('full_time'),
  employmentStatus: employmentStatus().notNull().default('probation'),
  joinDate: date().notNull(),
  probationEndDate: date(),
  exitDate: date(),
  // HR-sensitive (field-level restricted)
  personalEmail: text(),
  dateOfBirth: date(),
  address: text(),
  nationalIdLast4: text(),
  ...timestamps,
}, (t) => [index('employees_dept_idx').on(t.departmentId), index('employees_manager_idx').on(t.managerId)]);

// ───────────────────────── Settings ─────────────────────────

export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: tstz().defaultNow().notNull(),
});

/** Configurable stages for every pipeline in the system (project lifecycle, sales, content, recruitment…). */
export const pipelineStages = pgTable('pipeline_stages', {
  id: id(),
  pipeline: text().notNull(),
  key: text().notNull(),
  name: text().notNull(),
  sortOrder: integer().notNull(),
  color: text().notNull().default('slate'),
  isTerminal: boolean().notNull().default(false),
  /** Semantic outcome for terminal stages: 'won' | 'lost' | 'hired' | 'rejected' | 'done' */
  outcome: text(),
  ...timestamps,
}, (t) => [uniqueIndex('pipeline_stages_uq').on(t.pipeline, t.key)]);

// ───────────────────────── Audit, events, notifications ─────────────────────────

/** Append-only. Written by DB triggers (row changes) and by the app (auth/security events). */
export const auditLogs = pgTable('audit_logs', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  occurredAt: tstz().defaultNow().notNull(),
  actorUserId: uuid(),
  action: text().notNull(),
  tableName: text(),
  recordId: text(),
  oldData: jsonb(),
  newData: jsonb(),
  changedFields: text().array(),
  ip: text(),
  requestId: text(),
}, (t) => [
  index('audit_record_idx').on(t.tableName, t.recordId),
  index('audit_actor_idx').on(t.actorUserId),
  index('audit_time_idx').on(t.occurredAt),
]);

/** Transactional outbox: events are written in the same transaction as the change that caused them. */
export const domainEvents = pgTable('domain_events', {
  id: bigserial({ mode: 'number' }).primaryKey(),
  type: text().notNull(),
  entityType: text(),
  entityId: text(),
  payload: jsonb().notNull().default({}),
  actorUserId: uuid(),
  createdAt: tstz().defaultNow().notNull(),
  processedAt: tstz(),
  attempts: integer().notNull().default(0),
  lastError: text(),
}, (t) => [index('domain_events_pending_idx').on(t.processedAt, t.id)]);

/** Configurable automation: event type + condition → list of named actions. */
export const automationRules = pgTable('automation_rules', {
  id: id(),
  key: text().notNull().unique(),
  name: text().notNull(),
  description: text(),
  eventType: text().notNull(),
  /** Simple equality conditions on the event payload, e.g. {"to":"won"} */
  conditions: jsonb().notNull().default({}),
  /** [{ "action": "notify_roles", "params": { "roles": ["pm"] } }, …] */
  actions: jsonb().notNull(),
  enabled: boolean().notNull().default(true),
  isSystem: boolean().notNull().default(false),
  ...timestamps,
});

export const notifications = pgTable('notifications', {
  id: id(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  kind: text().notNull(),
  title: text().notNull(),
  body: text(),
  entityType: text(),
  entityId: text(),
  link: text(),
  /** Prevents duplicate notifications for the same underlying fact. */
  dedupeKey: text(),
  readAt: tstz(),
  emailedAt: tstz(),
  createdAt: tstz().defaultNow().notNull(),
}, (t) => [
  index('notifications_user_idx').on(t.userId, t.readAt),
  uniqueIndex('notifications_dedupe_uq').on(t.userId, t.dedupeKey),
]);

// ───────────────────────── Collaboration (polymorphic, auth via parent) ─────────────────────────

export const comments = pgTable('comments', {
  id: id(),
  entityType: text().notNull(),
  entityId: uuid().notNull(),
  authorId: uuid().notNull().references(() => users.id),
  body: text().notNull(),
  /** Internal comments are hidden from client-facing exports in future portal use. */
  isInternal: boolean().notNull().default(true),
  editedAt: tstz(),
  deletedAt: tstz(),
  createdAt: tstz().defaultNow().notNull(),
}, (t) => [index('comments_entity_idx').on(t.entityType, t.entityId)]);

export const activities = pgTable('activities', {
  id: id(),
  entityType: text().notNull(),
  entityId: uuid().notNull(),
  actorUserId: uuid().references(() => users.id),
  verb: text().notNull(),
  summary: text().notNull(),
  createdAt: tstz().defaultNow().notNull(),
}, (t) => [index('activities_entity_idx').on(t.entityType, t.entityId, t.createdAt)]);

export const files = pgTable('files', {
  id: id(),
  storageKey: text().notNull().unique(),
  originalName: text().notNull(),
  mimeType: text().notNull(),
  sizeBytes: integer().notNull(),
  sha256: text().notNull(),
  entityType: text().notNull(),
  entityId: uuid().notNull(),
  category: text(),
  expiresOn: date(),
  uploadedBy: uuid().notNull().references(() => users.id),
  deletedAt: tstz(),
  createdAt: tstz().defaultNow().notNull(),
}, (t) => [index('files_entity_idx').on(t.entityType, t.entityId)]);

export const approvalStatus = pgEnum('approval_status', ['pending', 'approved', 'rejected', 'cancelled']);

/** Generic approval requests. `kind` selects the handler that runs when a decision is made. */
export const approvals = pgTable('approvals', {
  id: id(),
  kind: text().notNull(),
  entityType: text().notNull(),
  entityId: uuid().notNull(),
  title: text().notNull(),
  details: text(),
  requestedBy: uuid().references(() => users.id),
  approverRoleKey: text(),
  approverUserId: uuid().references(() => users.id),
  status: approvalStatus().notNull().default('pending'),
  decidedBy: uuid().references(() => users.id),
  decidedAt: tstz(),
  decisionNote: text(),
  dueDate: date(),
  ...timestamps,
}, (t) => [index('approvals_status_idx').on(t.status, t.approverRoleKey), index('approvals_entity_idx').on(t.entityType, t.entityId)]);

export const savedViews = pgTable('saved_views', {
  id: id(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  resource: text().notNull(),
  name: text().notNull(),
  /** Query-string state of the list view (search, filters, sort). */
  query: jsonb().notNull(),
  ...timestamps,
});


/** Atomic counters for human-readable document numbers (INV-00012, PRJ-0042…). */
export const counters = pgTable('counters', {
  key: text().primaryKey(),
  value: integer().notNull().default(0),
});

/** Personal API tokens for integrations (Bearer auth). Only a SHA-256 hash is stored; the token is shown once. */
export const apiTokens = pgTable('api_tokens', {
  id: id(),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  name: text().notNull(),
  tokenHash: text().notNull().unique(),
  prefix: text().notNull(),
  expiresAt: tstz().notNull(),
  lastUsedAt: tstz(),
  revokedAt: tstz(),
  createdAt: tstz().defaultNow().notNull(),
}, (t) => [index('api_tokens_user_idx').on(t.userId)]);
