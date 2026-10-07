import { and, eq, isNull, or, sql } from 'drizzle-orm';
import { accessGrants, assetAssignments, assets, infraResources, licenseAssignments, subscriptions } from '../../db/schema/index.ts';
import { conflict, invalid } from '../../core/errors.ts';
import { defineResource } from '../registry.ts';
import { inMyProjects } from '../scopes.ts';
import type { HookCtx } from '../types.ts';

const today = () => new Date().toISOString().slice(0, 10);
const ownEmp = (column: any, a: { userId: string }) => sql`${column} in (select e.id from employees e where e.user_id = ${a.userId})`;
const VAULT = { type: 'text', label: 'Password-manager reference', vaultReference: true, max: 500, help: 'e.g. op://Devtics/GitHub admin — never the password itself' } as const;
const NOTES = { type: 'textarea', label: 'Notes', noSecrets: true } as const;
const COST = { type: 'money', label: 'Cost', min: 0, readPermission: 'expenses.view' } as const;

async function refreshSeats(c: HookCtx, subscriptionId: string) {
  await c.tx.execute(sql`update subscriptions set seats_used = (select count(*) from license_assignments where subscription_id = ${subscriptionId} and revoked_on is null) where id = ${subscriptionId}`);
}

defineResource({
  key: 'assets', table: assets, label: 'Asset', plural: 'IT assets', module: 'it', perm: 'assets',
  titleField: 'tag', formatTitle: (r) => `${r.tag} · ${[r.brand, r.model].filter(Boolean).join(' ')}`.trim(), defaultSort: 'tag', collab: { comments: true, files: true },
  scopes: { own: (a) => ownEmp(assets.assignedEmployeeId, a) },
  fields: {
    tag: { type: 'text', label: 'Asset tag', required: true, list: true, search: true, max: 40 },
    kind: { type: 'enum', label: 'Type', options: ['laptop', 'desktop', 'monitor', 'phone', 'tablet', 'accessory', 'network', 'other'], list: true, filter: true, default: 'laptop' },
    brand: { type: 'text', label: 'Brand', list: true, search: true },
    model: { type: 'text', label: 'Model', list: true, search: true },
    serialNumber: { type: 'text', label: 'Serial number', search: true },
    status: { type: 'enum', label: 'Status', options: ['in_stock', 'assigned', 'in_repair', 'retired', 'lost'], list: true, filter: true, default: 'in_stock' },
    assignedEmployeeId: { type: 'ref', ref: 'employees', label: 'Assigned to', list: true, filter: true },
    assignedOn: { type: 'date', label: 'Assigned on', readonly: true },
    condition: { type: 'text', label: 'Condition' },
    purchaseDate: { type: 'date', label: 'Purchased', group: 'Purchase' },
    purchaseCost: { ...COST, label: 'Purchase cost', group: 'Purchase' },
    vendor: { type: 'text', label: 'Vendor', group: 'Purchase' },
    warrantyUntil: { type: 'date', label: 'Warranty until', filter: true, group: 'Purchase' },
    notes: NOTES,
  },
  children: [{ resource: 'asset_assignments', field: 'assetId', label: 'Assignment history' }],
  hooks: {
    beforeCreate(_c, d) { if (d.assignedEmployeeId) { d.status = 'assigned'; d.assignedOn = today(); } },
    async afterCreate(c, row) {
      if (row.assignedEmployeeId) await c.tx.insert(assetAssignments).values({ assetId: row.id, employeeId: row.assignedEmployeeId, assignedOn: today(), conditionOut: row.condition, assignedById: c.actor.userId });
    },
    beforeUpdate(_c, d, prev) {
      if (!('assignedEmployeeId' in d) || d.assignedEmployeeId === prev.assignedEmployeeId) {
        if (d.status === 'assigned' && !prev.assignedEmployeeId) throw invalid('Validation failed', { assignedEmployeeId: 'Choose who the asset is assigned to' });
        return;
      }
      if (d.assignedEmployeeId) {
        if (['retired', 'lost'].includes(prev.status)) throw conflict('Retired or lost assets cannot be assigned');
        d.status = 'assigned'; d.assignedOn = today();
      } else {
        d.status = d.status && d.status !== 'assigned' ? d.status : 'in_stock'; d.assignedOn = null;
      }
    },
    async afterUpdate(c, row, prev) {
      if (row.assignedEmployeeId === prev.assignedEmployeeId) return;
      if (prev.assignedEmployeeId) {
        await c.tx.update(assetAssignments).set({ returnedOn: today(), conditionIn: row.condition })
          .where(and(eq(assetAssignments.assetId, row.id), eq(assetAssignments.employeeId, prev.assignedEmployeeId), isNull(assetAssignments.returnedOn)));
      }
      if (row.assignedEmployeeId) await c.tx.insert(assetAssignments).values({ assetId: row.id, employeeId: row.assignedEmployeeId, assignedOn: today(), conditionOut: row.condition, assignedById: c.actor.userId });
    },
  },
});

defineResource({
  key: 'asset_assignments', table: assetAssignments, label: 'Assignment', plural: 'Asset assignments', module: 'it', perm: 'assets',
  titleField: 'assignedOn', formatTitle: (r) => `Assigned ${r.assignedOn}`, defaultSort: '-assignedOn', permissions: { create: null, edit: null, delete: null },
  scopes: { own: (a) => ownEmp(assetAssignments.employeeId, a) },
  fields: {
    assetId: { type: 'ref', ref: 'assets', label: 'Asset', readonly: true, list: true, filter: true },
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', readonly: true, list: true, filter: true },
    assignedOn: { type: 'date', label: 'Assigned', readonly: true, list: true },
    returnedOn: { type: 'date', label: 'Returned', readonly: true, list: true },
    conditionOut: { type: 'text', label: 'Condition out', readonly: true },
    conditionIn: { type: 'text', label: 'Condition in', readonly: true },
    assignedById: { type: 'ref', ref: 'users', label: 'By', readonly: true },
  },
});

defineResource({
  key: 'subscriptions', table: subscriptions, label: 'Subscription', plural: 'Software & licenses', module: 'it', perm: 'software',
  titleField: 'name', defaultSort: 'renewalDate', collab: { comments: true, files: true },
  description: 'SaaS subscriptions, licenses and seats with renewal tracking. Credentials live in the password manager.',
  scopes: { own: (a) => sql`${subscriptions.id} in (select la.subscription_id from license_assignments la where la.revoked_on is null and ${ownEmp(sql`la.employee_id`, a)})` },
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    vendor: { type: 'text', label: 'Vendor', list: true, search: true },
    category: { type: 'enum', label: 'Type', options: ['saas', 'license', 'api', 'other'], list: true, filter: true, default: 'saas' },
    plan: { type: 'text', label: 'Plan' },
    status: { type: 'enum', label: 'Status', options: ['active', 'trial', 'cancelled', 'expired'], list: true, filter: true, default: 'active' },
    seatsTotal: { type: 'int', label: 'Seats', min: 0, list: true },
    seatsUsed: { type: 'int', label: 'Seats used', readonly: true, list: true },
    billingCycle: { type: 'enum', label: 'Billing', options: ['monthly', 'quarterly', 'yearly', 'one_time'], default: 'monthly' },
    cost: { ...COST, list: true },
    currency: { type: 'text', label: 'Currency', max: 3, default: 'USD' },
    renewalDate: { type: 'date', label: 'Renews', list: true, filter: true },
    autoRenew: { type: 'bool', label: 'Auto-renews', default: true },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', filter: true },
    url: { type: 'url', label: 'Admin console' },
    vaultReference: VAULT,
    notes: NOTES,
  },
  children: [{ resource: 'license_assignments', field: 'subscriptionId', label: 'Seats' }, { resource: 'access_grants', field: 'subscriptionId', label: 'Access records' }],
});

defineResource({
  key: 'license_assignments', table: licenseAssignments, label: 'Seat', plural: 'License seats', module: 'it', perm: 'software',
  titleField: 'assignedOn', formatTitle: (r) => `Seat since ${r.assignedOn}`, defaultSort: '-assignedOn',
  scopes: { own: (a) => ownEmp(licenseAssignments.employeeId, a) },
  fields: {
    subscriptionId: { type: 'ref', ref: 'subscriptions', label: 'Subscription', required: true, createOnly: true, list: true, filter: true },
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    accountIdentifier: { type: 'text', label: 'Account (username/email)', list: true, noSecrets: true },
    assignedOn: { type: 'date', label: 'Assigned', required: true, list: true, default: () => today() },
    revokedOn: { type: 'date', label: 'Revoked', list: true },
  },
  hooks: {
    async beforeCreate(c, d) {
      const [s] = await c.tx.select().from(subscriptions).where(eq(subscriptions.id, d.subscriptionId));
      if (s.seatsTotal !== null && s.seatsUsed >= s.seatsTotal) throw conflict(`All ${s.seatsTotal} seats are in use`);
      const dupe = await c.tx.select({ id: licenseAssignments.id }).from(licenseAssignments)
        .where(and(eq(licenseAssignments.subscriptionId, d.subscriptionId), eq(licenseAssignments.employeeId, d.employeeId), isNull(licenseAssignments.revokedOn))).limit(1);
      if (dupe.length) throw conflict('This person already has a seat');
    },
    async afterCreate(c, row) { await refreshSeats(c, row.subscriptionId); },
    async afterUpdate(c, row) { await refreshSeats(c, row.subscriptionId); },
    async afterDelete(c, row) { await refreshSeats(c, row.subscriptionId); },
  },
});

defineResource({
  key: 'infra_resources', table: infraResources, label: 'Infrastructure item', plural: 'Infrastructure', module: 'it', perm: 'infrastructure',
  titleField: 'name', defaultSort: 'expiresOn', collab: { comments: true, files: true },
  description: 'Domains, hosting, servers, cloud accounts, SSL certificates, APIs and DNS — with expiry tracking.',
  scopes: { own: (a) => or(eq(infraResources.ownerId, a.userId), inMyProjects(infraResources.projectId, a))! },
  eventFields: ['kind'],
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true, help: 'e.g. devtics.com, prod-db-1, AWS main account' },
    kind: { type: 'enum', label: 'Type', options: ['domain', 'hosting', 'server', 'cloud_account', 'ssl_certificate', 'api', 'dns_zone', 'email', 'other'], required: true, list: true, filter: true },
    provider: { type: 'text', label: 'Provider', list: true, search: true },
    status: { type: 'enum', label: 'Status', options: ['active', 'expiring', 'expired', 'decommissioned'], list: true, filter: true, default: 'active' },
    expiresOn: { type: 'date', label: 'Expires / renews', list: true, filter: true },
    autoRenew: { type: 'bool', label: 'Auto-renews', default: true },
    identifier: { type: 'text', label: 'Identifier (IP, account ID, hostname)', noSecrets: true },
    region: { type: 'text', label: 'Region' },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', filter: true },
    companyId: { type: 'ref', ref: 'clients', label: 'Client', filter: true },
    cost: COST,
    billingCycle: { type: 'enum', label: 'Billing', options: ['monthly', 'quarterly', 'yearly', 'one_time'] },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true },
    vaultReference: VAULT,
    notes: NOTES,
  },
  children: [{ resource: 'access_grants', field: 'infraResourceId', label: 'Access records' }],
});

defineResource({
  key: 'access_grants', table: accessGrants, label: 'Access record', plural: 'System access', module: 'it', perm: 'access',
  titleField: 'systemName', defaultSort: 'systemName',
  description: 'Who can access which company system (email, GitHub, hosting, PM, CRM…). Drives onboarding and offboarding. No credentials are stored.',
  scopes: { own: (a) => ownEmp(accessGrants.employeeId, a) },
  status: { field: 'status', transitions: { pending: ['active', 'revoked'], active: ['revoked'], revoked: ['active'] } },
  fields: {
    employeeId: { type: 'ref', ref: 'employees', label: 'Employee', required: true, createOnly: true, list: true, filter: true },
    system: { type: 'enum', label: 'System', options: ['email', 'github', 'hosting', 'project_management', 'crm', 'cloud', 'design', 'communication', 'dms', 'other'], required: true, list: true, filter: true },
    systemName: { type: 'text', label: 'System name', required: true, list: true, search: true },
    accountIdentifier: { type: 'text', label: 'Account', list: true, noSecrets: true },
    accessLevel: { type: 'text', label: 'Access level', list: true },
    status: { type: 'enum', label: 'Status', options: ['pending', 'active', 'revoked'], list: true, filter: true, default: 'active' },
    subscriptionId: { type: 'ref', ref: 'subscriptions', label: 'Subscription' },
    infraResourceId: { type: 'ref', ref: 'infra_resources', label: 'Infrastructure item' },
    grantedOn: { type: 'date', label: 'Granted', list: true, default: () => today() },
    revokedOn: { type: 'date', label: 'Revoked', readonly: true, list: true },
    vaultReference: VAULT,
    notes: NOTES,
  },
  hooks: {
    beforeCreate(c, d) { d.grantedById = c.actor.userId; },
    beforeUpdate(c, d, prev) {
      if (d.status === 'revoked' && prev.status !== 'revoked') { d.revokedOn = today(); d.revokedById = c.actor.userId; }
      if (d.status === 'active' && prev.status === 'revoked') { d.revokedOn = null; d.grantedOn = today(); }
    },
  },
});
