import {
  pgTable, pgEnum, text, boolean, integer, date, uuid, uniqueIndex, index, numeric, type AnyPgColumn,
} from 'drizzle-orm/pg-core';
import { id, timestamps, money, tstz } from './_helpers.ts';
import { users, pipelineStages } from './core.ts';
import { projectType } from './enums.ts';
// Cyclic import is safe: references are resolved lazily.
import { projects } from './projects.ts';
import { campaigns } from './marketing.ts';

export const companyLifecycle = pgEnum('company_lifecycle', ['prospect', 'client', 'former_client', 'partner', 'vendor']);
export const companySize = pgEnum('company_size', ['1-10', '11-50', '51-200', '201-1000', '1000+']);
export const clientHealth = pgEnum('client_health', ['active', 'stable', 'attention_required', 'at_risk', 'inactive']);

/**
 * Canonical organisation record. A "client" is a company whose lifecycle is client/former_client;
 * CRM, Projects, Finance and Support all reference this one table.
 */
export const companies = pgTable('companies', {
  id: id(),
  name: text().notNull(),
  lifecycle: companyLifecycle().notNull().default('prospect'),
  website: text(),
  industry: text(),
  size: companySize(),
  country: text(),
  city: text(),
  phone: text(),
  address: text(),
  ownerId: uuid().references(() => users.id),
  notes: text(),
  // Client relationship
  clientCode: text().unique(),
  clientSince: date(),
  accountManagerId: uuid().references(() => users.id),
  billingEmail: text(),
  paymentTermsDays: integer(),
  currency: text().notNull().default('USD'),
  health: clientHealth(),
  healthScore: integer(),
  healthReasons: text(),
  healthUpdatedAt: tstz(),
  ...timestamps,
}, (t) => [index('companies_lifecycle_idx').on(t.lifecycle), uniqueIndex('companies_name_uq').on(t.name)]);

export const contacts = pgTable('contacts', {
  id: id(),
  companyId: uuid().references(() => companies.id, { onDelete: 'set null' }),
  firstName: text().notNull(),
  lastName: text(),
  email: text(),
  phone: text(),
  jobTitle: text(),
  isPrimary: boolean().notNull().default(false),
  linkedinUrl: text(),
  ownerId: uuid().references(() => users.id),
  notes: text(),
  ...timestamps,
}, (t) => [index('contacts_company_idx').on(t.companyId)]);

export const leadSource = pgEnum('lead_source', ['website', 'referral', 'linkedin', 'upwork', 'cold_outreach', 'event', 'partner', 'ads', 'seo', 'other']);
export const leadStatus = pgEnum('lead_status', ['new', 'contacted', 'qualified', 'unqualified', 'converted']);

export const leads = pgTable('leads', {
  id: id(),
  number: text().notNull().unique(),
  title: text().notNull(),
  companyName: text(),
  contactName: text(),
  email: text(),
  phone: text(),
  companyId: uuid().references(() => companies.id),
  contactId: uuid().references(() => contacts.id),
  source: leadSource().notNull().default('website'),
  /** Marketing attribution. */
  campaignId: uuid().references((): AnyPgColumn => campaigns.id, { onDelete: 'set null' }),
  status: leadStatus().notNull().default('new'),
  ownerId: uuid().references(() => users.id),
  estimatedValue: money(),
  projectType: projectType(),
  requirements: text(),
  nextFollowUpDate: date(),
  disqualifyReason: text(),
  convertedAt: tstz(),
  opportunityId: uuid().references((): AnyPgColumn => opportunities.id),
  ...timestamps,
}, (t) => [index('leads_status_idx').on(t.status), index('leads_owner_idx').on(t.ownerId)]);

export const opportunities = pgTable('opportunities', {
  id: id(),
  number: text().notNull().unique(),
  name: text().notNull(),
  companyId: uuid().notNull().references(() => companies.id),
  primaryContactId: uuid().references(() => contacts.id),
  leadId: uuid().references(() => leads.id),
  stageId: uuid().notNull().references(() => pipelineStages.id),
  ownerId: uuid().references(() => users.id),
  value: money().notNull().default('0'),
  currency: text().notNull().default('USD'),
  probability: integer().notNull().default(10),
  expectedCloseDate: date(),
  source: leadSource(),
  projectType: projectType(),
  description: text(),
  lostReason: text(),
  wonAt: tstz(),
  lostAt: tstz(),
  /** Set by the onboarding workflow when a project is created from this deal. */
  projectId: uuid().references((): AnyPgColumn => projects.id),
  ...timestamps,
}, (t) => [index('opps_stage_idx').on(t.stageId), index('opps_company_idx').on(t.companyId), index('opps_owner_idx').on(t.ownerId)]);

export const requirementPriority = pgEnum('requirement_priority', ['must', 'should', 'could', 'wont']);

export const requirements = pgTable('requirements', {
  id: id(),
  opportunityId: uuid().notNull().references(() => opportunities.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  description: text(),
  category: text(),
  priority: requirementPriority().notNull().default('must'),
  estimateHours: numeric({ precision: 8, scale: 2 }),
  ...timestamps,
});

export const commKind = pgEnum('communication_kind', ['call', 'email', 'meeting', 'message', 'note']);
export const commDirection = pgEnum('communication_direction', ['inbound', 'outbound', 'internal']);

/** Communication history across CRM and delivery (explicit FKs rather than polymorphic). */
export const communications = pgTable('communications', {
  id: id(),
  kind: commKind().notNull().default('note'),
  direction: commDirection().notNull().default('outbound'),
  subject: text().notNull(),
  body: text(),
  occurredAt: tstz().defaultNow().notNull(),
  companyId: uuid().references(() => companies.id),
  contactId: uuid().references(() => contacts.id),
  leadId: uuid().references(() => leads.id),
  opportunityId: uuid().references(() => opportunities.id),
  projectId: uuid().references((): AnyPgColumn => projects.id, { onDelete: 'cascade' }),
  loggedById: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('comms_company_idx').on(t.companyId), index('comms_opp_idx').on(t.opportunityId), index('comms_project_idx').on(t.projectId)]);

export const followUpStatus = pgEnum('follow_up_status', ['open', 'done', 'cancelled']);

export const followUps = pgTable('follow_ups', {
  id: id(),
  title: text().notNull(),
  dueDate: date().notNull(),
  ownerId: uuid().references(() => users.id),
  status: followUpStatus().notNull().default('open'),
  leadId: uuid().references(() => leads.id, { onDelete: 'cascade' }),
  opportunityId: uuid().references(() => opportunities.id, { onDelete: 'cascade' }),
  companyId: uuid().references(() => companies.id),
  notes: text(),
  completedAt: tstz(),
  ...timestamps,
}, (t) => [index('follow_ups_owner_idx').on(t.ownerId, t.status, t.dueDate)]);

export const quoteStatus = pgEnum('quote_status', ['draft', 'sent', 'accepted', 'rejected', 'expired']);

export const quotes = pgTable('quotes', {
  id: id(),
  number: text().notNull().unique(),
  title: text().notNull(),
  companyId: uuid().notNull().references(() => companies.id),
  opportunityId: uuid().references(() => opportunities.id),
  contactId: uuid().references(() => contacts.id),
  status: quoteStatus().notNull().default('draft'),
  issueDate: date().notNull(),
  validUntil: date(),
  currency: text().notNull().default('USD'),
  subtotal: money().notNull().default('0'),
  discountAmount: money().notNull().default('0'),
  taxRate: numeric({ precision: 5, scale: 2 }).notNull().default('0'),
  taxAmount: money().notNull().default('0'),
  total: money().notNull().default('0'),
  notes: text(),
  terms: text(),
  sentAt: tstz(),
  decidedAt: tstz(),
  ownerId: uuid().references(() => users.id),
  ...timestamps,
});

export const quoteItems = pgTable('quote_items', {
  id: id(),
  quoteId: uuid().notNull().references(() => quotes.id, { onDelete: 'cascade' }),
  description: text().notNull(),
  quantity: numeric({ precision: 10, scale: 2 }).notNull().default('1'),
  unitPrice: money().notNull(),
  amount: money().notNull().default('0'),
  sortOrder: integer().notNull().default(0),
  ...timestamps,
}, (t) => [index('quote_items_quote_idx').on(t.quoteId)]);

export const proposalStatus = pgEnum('proposal_status', ['draft', 'sent', 'accepted', 'rejected']);

export const proposals = pgTable('proposals', {
  id: id(),
  number: text().notNull().unique(),
  title: text().notNull(),
  opportunityId: uuid().notNull().references(() => opportunities.id),
  quoteId: uuid().references(() => quotes.id),
  status: proposalStatus().notNull().default('draft'),
  version: integer().notNull().default(1),
  summary: text(),
  scope: text(),
  timeline: text(),
  sentAt: tstz(),
  decidedAt: tstz(),
  ownerId: uuid().references(() => users.id),
  ...timestamps,
});

export const contractType = pgEnum('contract_type', ['msa', 'sow', 'nda', 'maintenance', 'change_order', 'other']);
export const contractStatus = pgEnum('contract_status', ['draft', 'sent', 'signed', 'active', 'expired', 'terminated']);

/** Contracts and SOWs (an SOW is a contract of type `sow`, optionally under a parent MSA). */
export const contracts = pgTable('contracts', {
  id: id(),
  number: text().notNull().unique(),
  title: text().notNull(),
  type: contractType().notNull().default('sow'),
  companyId: uuid().notNull().references(() => companies.id),
  opportunityId: uuid().references(() => opportunities.id),
  projectId: uuid().references((): AnyPgColumn => projects.id),
  parentContractId: uuid().references((): AnyPgColumn => contracts.id),
  status: contractStatus().notNull().default('draft'),
  value: money(),
  currency: text().notNull().default('USD'),
  startDate: date(),
  endDate: date(),
  signedAt: date(),
  renewalDate: date(),
  autoRenew: boolean().notNull().default(false),
  paymentTerms: text(),
  scope: text(),
  ownerId: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('contracts_company_idx').on(t.companyId)]);

export const salesTargets = pgTable('sales_targets', {
  id: id(),
  /** Null = whole team target. */
  userId: uuid().references(() => users.id),
  periodStart: date().notNull(),
  periodEnd: date().notNull(),
  targetAmount: money().notNull(),
  notes: text(),
  ...timestamps,
});

export const commissionStatus = pgEnum('commission_status', ['pending', 'approved', 'paid', 'cancelled']);

export const commissions = pgTable('commissions', {
  id: id(),
  opportunityId: uuid().notNull().references(() => opportunities.id),
  userId: uuid().notNull().references(() => users.id),
  ratePct: numeric({ precision: 5, scale: 2 }).notNull(),
  amount: money().notNull().default('0'),
  status: commissionStatus().notNull().default('pending'),
  paidAt: date(),
  notes: text(),
  ...timestamps,
}, (t) => [uniqueIndex('commissions_opp_user_uq').on(t.opportunityId, t.userId)]);
