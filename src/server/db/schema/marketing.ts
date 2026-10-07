import { pgTable, pgEnum, text, integer, date, uuid, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { id, timestamps, money } from './_helpers.ts';
import { users, pipelineStages } from './core.ts';
import { companies } from './crm.ts';
import { projects, priority } from './projects.ts';

export const campaignChannel = pgEnum('campaign_channel', ['seo', 'ppc', 'social', 'email', 'content', 'event', 'referral', 'partnership', 'other']);
export const campaignStatus = pgEnum('campaign_status', ['planned', 'active', 'paused', 'completed']);

export const campaigns = pgTable('campaigns', {
  id: id(),
  name: text().notNull(),
  channel: campaignChannel().notNull().default('content'),
  status: campaignStatus().notNull().default('planned'),
  startDate: date(),
  endDate: date(),
  budget: money(),
  spend: money().notNull().default('0'),
  utmCampaign: text(),
  goal: text(),
  ownerId: uuid().references(() => users.id),
  ...timestamps,
});

export const trafficChannel = pgEnum('traffic_channel', ['organic', 'paid', 'social', 'referral', 'direct', 'email', 'other']);
export const dataSource = pgEnum('data_source', ['manual', 'ga4', 'search_console', 'import']);

/** Website traffic by channel and period (manual entry until an analytics integration is connected). */
export const trafficSnapshots = pgTable('traffic_snapshots', {
  id: id(),
  site: text().notNull(),
  periodStart: date().notNull(),
  periodEnd: date().notNull(),
  channel: trafficChannel().notNull(),
  sessions: integer().notNull().default(0),
  users: integer().notNull().default(0),
  conversions: integer().notNull().default(0),
  source: dataSource().notNull().default('manual'),
  ...timestamps,
}, (t) => [uniqueIndex('traffic_uq').on(t.site, t.periodStart, t.channel)]);

export const searchIntent = pgEnum('search_intent', ['informational', 'commercial', 'transactional', 'navigational']);

export const seoKeywords = pgTable('seo_keywords', {
  id: id(),
  keyword: text().notNull(),
  site: text().notNull(),
  projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
  companyId: uuid().references(() => companies.id),
  targetUrl: text(),
  searchVolume: integer(),
  difficulty: integer(),
  intent: searchIntent(),
  priority: priority().notNull().default('medium'),
  currentPosition: integer(),
  previousPosition: integer(),
  bestPosition: integer(),
  lastCheckedOn: date(),
  ownerId: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [uniqueIndex('keywords_uq').on(t.site, t.keyword)]);

export const keywordRankings = pgTable('keyword_rankings', {
  id: id(),
  keywordId: uuid().notNull().references(() => seoKeywords.id, { onDelete: 'cascade' }),
  checkedOn: date().notNull(),
  /** Null = not ranking in the tracked range. */
  position: integer(),
  url: text(),
  source: dataSource().notNull().default('manual'),
  ...timestamps,
}, (t) => [uniqueIndex('rankings_uq').on(t.keywordId, t.checkedOn)]);

export const backlinkStatus = pgEnum('backlink_status', ['prospect', 'outreach', 'live', 'lost', 'rejected']);

export const backlinks = pgTable('backlinks', {
  id: id(),
  site: text().notNull(),
  sourceUrl: text().notNull(),
  targetUrl: text(),
  anchorText: text(),
  domainAuthority: integer(),
  status: backlinkStatus().notNull().default('prospect'),
  acquiredOn: date(),
  lostOn: date(),
  cost: money(),
  ownerId: uuid().references(() => users.id),
  notes: text(),
  ...timestamps,
});

export const seoAudits = pgTable('seo_audits', {
  id: id(),
  site: text().notNull(),
  projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
  auditDate: date().notNull(),
  tool: text(),
  healthScore: integer(),
  issuesCritical: integer().notNull().default(0),
  issuesWarning: integer().notNull().default(0),
  pagesCrawled: integer(),
  summary: text(),
  auditorId: uuid().references(() => users.id),
  ...timestamps,
});

export const contentType = pgEnum('content_type', ['blog_post', 'landing_page', 'case_study', 'social_post', 'newsletter', 'video', 'other']);

/** Content pipeline: Idea → Research → Brief → Writing → Editing → SEO → Design → Published → Performance. */
export const contentItems = pgTable('content_items', {
  id: id(),
  title: text().notNull(),
  type: contentType().notNull().default('blog_post'),
  stageId: uuid().notNull().references(() => pipelineStages.id),
  assigneeId: uuid().references(() => users.id),
  keywordId: uuid().references(() => seoKeywords.id, { onDelete: 'set null' }),
  campaignId: uuid().references(() => campaigns.id, { onDelete: 'set null' }),
  dueDate: date(),
  brief: text(),
  wordCount: integer(),
  publishedUrl: text(),
  publishedOn: date(),
  sessions: integer(),
  conversions: integer(),
  notes: text(),
  ...timestamps,
}, (t) => [index('content_stage_idx').on(t.stageId)]);

