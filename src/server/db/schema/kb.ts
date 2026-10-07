import { pgTable, pgEnum, text, boolean, integer, date, uuid, index, uniqueIndex, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './_helpers.ts';
import { users, roles, departments } from './core.ts';

export const kbCategory = pgEnum('kb_category', [
  'sop', 'policy', 'dev_standard', 'qa_standard', 'pm_procedure', 'sales_procedure', 'hr_policy', 'template', 'training', 'architecture', 'other',
]);
export const kbStatus = pgEnum('kb_status', ['draft', 'published', 'archived']);

/** Knowledge base documents. Content lives in versions; the article points at its published version. */
export const kbArticles = pgTable('kb_articles', {
  id: id(),
  slug: text().notNull().unique(),
  title: text().notNull(),
  category: kbCategory().notNull().default('sop'),
  summary: text(),
  ownerId: uuid().references(() => users.id),
  status: kbStatus().notNull().default('draft'),
  currentVersionId: uuid().references((): AnyPgColumn => kbArticleVersions.id),
  requiredReading: boolean().notNull().default(false),
  acknowledgeWithinDays: integer().notNull().default(7),
  reviewIntervalDays: integer(),
  lastReviewedOn: date(),
  publishedAt: tstz(),
  ...timestamps,
}, (t) => [index('kb_category_idx').on(t.category, t.status)]);

export const kbArticleVersions = pgTable('kb_article_versions', {
  id: id(),
  articleId: uuid().notNull().references((): AnyPgColumn => kbArticles.id, { onDelete: 'cascade' }),
  versionNumber: integer().notNull(),
  title: text().notNull(),
  body: text().notNull(),
  changeSummary: text(),
  createdById: uuid().references(() => users.id),
  publishedAt: tstz(),
  publishedById: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [uniqueIndex('kb_versions_uq').on(t.articleId, t.versionNumber)]);

/** Who a required-reading article applies to: roles and/or departments (none = everyone). */
export const kbArticleAudiences = pgTable('kb_article_audiences', {
  id: id(),
  articleId: uuid().notNull().references(() => kbArticles.id, { onDelete: 'cascade' }),
  roleId: uuid().references(() => roles.id, { onDelete: 'cascade' }),
  departmentId: uuid().references(() => departments.id, { onDelete: 'cascade' }),
  ...timestamps,
}, (t) => [index('kb_audience_article_idx').on(t.articleId)]);

/** A user must read a specific version (created when a required-reading version is published). */
export const kbReadingAssignments = pgTable('kb_reading_assignments', {
  id: id(),
  articleId: uuid().notNull().references(() => kbArticles.id, { onDelete: 'cascade' }),
  versionId: uuid().notNull().references(() => kbArticleVersions.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  dueDate: date().notNull(),
  ...timestamps,
}, (t) => [uniqueIndex('kb_assign_uq').on(t.versionId, t.userId), index('kb_assign_user_idx').on(t.userId)]);

export const kbAcknowledgements = pgTable('kb_acknowledgements', {
  id: id(),
  articleId: uuid().notNull().references(() => kbArticles.id, { onDelete: 'cascade' }),
  versionId: uuid().notNull().references(() => kbArticleVersions.id, { onDelete: 'cascade' }),
  userId: uuid().notNull().references(() => users.id, { onDelete: 'cascade' }),
  acknowledgedAt: tstz().defaultNow().notNull(),
}, (t) => [uniqueIndex('kb_ack_uq').on(t.versionId, t.userId)]);
