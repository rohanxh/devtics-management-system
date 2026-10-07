import { pgTable, pgEnum, text, boolean, integer, date, uuid, index } from 'drizzle-orm/pg-core';
import { id, timestamps, money } from './_helpers.ts';
import { users, employees } from './core.ts';
import { companies } from './crm.ts';
import { projects } from './projects.ts';

export const assetKind = pgEnum('asset_kind', ['laptop', 'desktop', 'monitor', 'phone', 'tablet', 'accessory', 'network', 'other']);
export const assetStatus = pgEnum('asset_status', ['in_stock', 'assigned', 'in_repair', 'retired', 'lost']);

export const assets = pgTable('assets', {
  id: id(),
  tag: text().notNull().unique(),
  kind: assetKind().notNull().default('laptop'),
  brand: text(),
  model: text(),
  serialNumber: text(),
  purchaseDate: date(),
  purchaseCost: money(),
  vendor: text(),
  warrantyUntil: date(),
  status: assetStatus().notNull().default('in_stock'),
  assignedEmployeeId: uuid().references(() => employees.id),
  assignedOn: date(),
  condition: text(),
  notes: text(),
  ...timestamps,
}, (t) => [index('assets_employee_idx').on(t.assignedEmployeeId)]);

/** Assignment history (who had which device, when, in what condition). */
export const assetAssignments = pgTable('asset_assignments', {
  id: id(),
  assetId: uuid().notNull().references(() => assets.id, { onDelete: 'cascade' }),
  employeeId: uuid().notNull().references(() => employees.id),
  assignedOn: date().notNull(),
  returnedOn: date(),
  conditionOut: text(),
  conditionIn: text(),
  assignedById: uuid().references(() => users.id),
  ...timestamps,
}, (t) => [index('asset_assign_asset_idx').on(t.assetId)]);

export const subscriptionCategory = pgEnum('subscription_category', ['saas', 'license', 'api', 'other']);
export const billingCycle = pgEnum('billing_cycle', ['monthly', 'quarterly', 'yearly', 'one_time']);
export const subscriptionStatus = pgEnum('subscription_status', ['active', 'trial', 'cancelled', 'expired']);

/** SaaS subscriptions & licenses. Credentials are never stored — only a reference to the password-manager entry. */
export const subscriptions = pgTable('subscriptions', {
  id: id(),
  name: text().notNull(),
  vendor: text(),
  category: subscriptionCategory().notNull().default('saas'),
  plan: text(),
  billingCycle: billingCycle().notNull().default('monthly'),
  cost: money(),
  currency: text().notNull().default('USD'),
  seatsTotal: integer(),
  seatsUsed: integer().notNull().default(0),
  renewalDate: date(),
  autoRenew: boolean().notNull().default(true),
  status: subscriptionStatus().notNull().default('active'),
  ownerId: uuid().references(() => users.id),
  vaultReference: text(),
  url: text(),
  notes: text(),
  ...timestamps,
});

export const licenseAssignments = pgTable('license_assignments', {
  id: id(),
  subscriptionId: uuid().notNull().references(() => subscriptions.id, { onDelete: 'cascade' }),
  employeeId: uuid().notNull().references(() => employees.id),
  accountIdentifier: text(),
  assignedOn: date().notNull(),
  revokedOn: date(),
  ...timestamps,
}, (t) => [index('license_assign_sub_idx').on(t.subscriptionId)]);

export const infraKind = pgEnum('infra_kind', ['domain', 'hosting', 'server', 'cloud_account', 'ssl_certificate', 'api', 'dns_zone', 'email', 'other']);
export const infraStatus = pgEnum('infra_status', ['active', 'expiring', 'expired', 'decommissioned']);

/** Domains, hosting, servers, cloud accounts, SSL, APIs and DNS — for Devtics and for clients. */
export const infraResources = pgTable('infra_resources', {
  id: id(),
  kind: infraKind().notNull(),
  name: text().notNull(),
  provider: text(),
  identifier: text(),
  region: text(),
  projectId: uuid().references(() => projects.id, { onDelete: 'set null' }),
  companyId: uuid().references(() => companies.id),
  expiresOn: date(),
  autoRenew: boolean().notNull().default(true),
  cost: money(),
  billingCycle: billingCycle(),
  status: infraStatus().notNull().default('active'),
  ownerId: uuid().references(() => users.id),
  vaultReference: text(),
  notes: text(),
  ...timestamps,
}, (t) => [index('infra_kind_idx').on(t.kind), index('infra_expires_idx').on(t.expiresOn)]);

export const accessSystem = pgEnum('access_system', ['email', 'github', 'hosting', 'project_management', 'crm', 'cloud', 'design', 'communication', 'dms', 'other']);
export const accessStatus = pgEnum('access_status', ['pending', 'active', 'revoked']);

/** Who has access to which company system (no credentials stored). Drives onboarding/offboarding. */
export const accessGrants = pgTable('access_grants', {
  id: id(),
  employeeId: uuid().notNull().references(() => employees.id),
  system: accessSystem().notNull(),
  systemName: text().notNull(),
  subscriptionId: uuid().references(() => subscriptions.id),
  infraResourceId: uuid().references(() => infraResources.id),
  accountIdentifier: text(),
  accessLevel: text(),
  status: accessStatus().notNull().default('active'),
  grantedOn: date(),
  revokedOn: date(),
  grantedById: uuid().references(() => users.id),
  revokedById: uuid().references(() => users.id),
  vaultReference: text(),
  notes: text(),
  ...timestamps,
}, (t) => [index('access_emp_idx').on(t.employeeId, t.status)]);
