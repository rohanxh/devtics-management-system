import { eq, inArray, or, sql } from 'drizzle-orm';
import {
  commissions, communications, companies, contacts, contracts, followUps, leads, opportunities, pipelineStages,
  proposals, quoteItems, quotes, requirements, salesTargets,
} from '../../db/schema/index.ts';
import { conflict, invalid } from '../../core/errors.ts';
import { defineResource } from '../registry.ts';
import { myProjectIds } from '../scopes.ts';
import type { HookCtx } from '../types.ts';
import { recalcQuote } from '../../modules/sales.ts';

const PROJECT_TYPES = ['website', 'wordpress', 'woocommerce', 'web_app', 'mobile_app', 'seo', 'maintenance', 'design', 'other'] as const;
const SOURCES = ['website', 'referral', 'linkedin', 'upwork', 'cold_outreach', 'event', 'partner', 'ads', 'seo', 'other'] as const;
const me = (a: { userId: string }) => a.userId;

defineResource({
  key: 'companies', table: companies, label: 'Company', plural: 'Companies', module: 'crm', perm: 'companies',
  titleField: 'name', defaultSort: 'name', collab: { comments: true, files: true },
  description: 'Every organisation Devtics deals with — prospects, clients, partners and vendors.',
  scopes: { own: (a) => or(eq(companies.ownerId, me(a)), eq(companies.accountManagerId, me(a)))! },
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    lifecycle: { type: 'enum', label: 'Lifecycle', options: ['prospect', 'client', 'former_client', 'partner', 'vendor'], list: true, filter: true, default: 'prospect' },
    industry: { type: 'text', label: 'Industry', list: true, filter: true, search: true },
    size: { type: 'enum', label: 'Company size', options: ['1-10', '11-50', '51-200', '201-1000', '1000+'] },
    website: { type: 'url', label: 'Website' },
    phone: { type: 'phone', label: 'Phone' },
    country: { type: 'text', label: 'Country', list: true, filter: true },
    city: { type: 'text', label: 'City' },
    address: { type: 'textarea', label: 'Address' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true, default: me },
    notes: { type: 'textarea', label: 'Notes' },
  },
  assignees: ['ownerId'],
  children: [
    { resource: 'contacts', field: 'companyId' }, { resource: 'leads', field: 'companyId' },
    { resource: 'opportunities', field: 'companyId' }, { resource: 'communications', field: 'companyId' },
    { resource: 'quotes', field: 'companyId' }, { resource: 'contracts', field: 'companyId' },
  ],
});

defineResource({
  key: 'clients', table: companies, label: 'Client', plural: 'Clients', module: 'crm', perm: 'clients',
  baseWhere: inArray(companies.lifecycle, ['client', 'former_client']),
  titleField: 'name', defaultSort: 'name', collab: { comments: true, files: true },
  description: 'Client profiles: contacts, projects, contracts, invoices, support and health.',
  numbering: { field: 'clientCode', key: 'client', prefix: 'CL-', pad: 4 },
  scopes: {
    own: (a) => or(eq(companies.accountManagerId, me(a)), eq(companies.ownerId, me(a)),
      sql`${companies.id} in (select p.client_id from projects p where p.id in ${myProjectIds(a.userId)})`)!,
  },
  eventFields: ['health'],
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    lifecycle: { type: 'enum', label: 'Relationship', options: ['client', 'former_client'], list: true, filter: true, default: 'client' },
    health: { type: 'enum', label: 'Health', options: ['active', 'stable', 'attention_required', 'at_risk', 'inactive'], readonly: true, list: true, filter: true },
    healthScore: { type: 'int', label: 'Health score', readonly: true, list: true },
    healthReasons: { type: 'textarea', label: 'Health signals', readonly: true },
    accountManagerId: { type: 'ref', ref: 'users', label: 'Account manager', list: true, filter: true },
    clientSince: { type: 'date', label: 'Client since', list: true },
    industry: { type: 'text', label: 'Industry', filter: true },
    country: { type: 'text', label: 'Country', filter: true },
    website: { type: 'url', label: 'Website' },
    phone: { type: 'phone', label: 'Phone' },
    billingEmail: { type: 'email', label: 'Billing email', group: 'Billing' },
    paymentTermsDays: { type: 'int', label: 'Payment terms (days)', min: 0, max: 180, group: 'Billing' },
    currency: { type: 'text', label: 'Currency', max: 3, default: 'USD', group: 'Billing' },
    notes: { type: 'textarea', label: 'Notes' },
  },
  assignees: ['accountManagerId'],
  children: [
    { resource: 'contacts', field: 'companyId' }, { resource: 'projects', field: 'clientId' },
    { resource: 'contracts', field: 'companyId' }, { resource: 'client_feedback', field: 'companyId', label: 'Feedback' },
    { resource: 'communications', field: 'companyId' },
  ],
});

defineResource({
  key: 'contacts', table: contacts, label: 'Contact', plural: 'Contacts', module: 'crm', perm: 'companies',
  titleField: 'firstName', titleSql: sql`trim(${contacts.firstName} || ' ' || coalesce(${contacts.lastName}, ''))`,
  formatTitle: (r) => `${r.firstName} ${r.lastName ?? ''}`.trim(), defaultSort: 'firstName',
  scopes: { own: (a) => or(eq(contacts.ownerId, me(a)), sql`${contacts.companyId} in (select c.id from companies c where c.owner_id = ${a.userId} or c.account_manager_id = ${a.userId})`)! },
  fields: {
    firstName: { type: 'text', label: 'First name', required: true, list: true, search: true },
    lastName: { type: 'text', label: 'Last name', list: true, search: true },
    companyId: { type: 'ref', ref: 'companies', label: 'Company', list: true, filter: true },
    jobTitle: { type: 'text', label: 'Job title', list: true },
    email: { type: 'email', label: 'Email', list: true, search: true },
    phone: { type: 'phone', label: 'Phone' },
    isPrimary: { type: 'bool', label: 'Primary contact', list: true, default: false },
    linkedinUrl: { type: 'url', label: 'LinkedIn' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', default: me },
    notes: { type: 'textarea', label: 'Notes' },
  },
  children: [{ resource: 'communications', field: 'contactId' }],
});

defineResource({
  key: 'leads', table: leads, label: 'Lead', plural: 'Leads', module: 'crm', perm: 'leads',
  titleField: 'title', board: 'status', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'lead', prefix: 'LD-', pad: 4 },
  description: 'Top of the funnel: new enquiries until they are qualified and converted into opportunities.',
  scopes: { own: (a) => eq(leads.ownerId, me(a)) },
  eventFields: ['source', 'status'],
  status: {
    field: 'status',
    transitions: {
      new: ['contacted', 'qualified', 'unqualified'],
      contacted: ['qualified', 'unqualified', 'new'],
      qualified: ['unqualified', 'contacted'],
      unqualified: ['new', 'contacted'],
      converted: [],
    },
  },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    status: { type: 'enum', label: 'Status', options: ['new', 'contacted', 'qualified', 'unqualified', 'converted'], list: true, filter: true, default: 'new' },
    companyName: { type: 'text', label: 'Company name', list: true, search: true, group: 'Prospect' },
    contactName: { type: 'text', label: 'Contact name', search: true, group: 'Prospect' },
    email: { type: 'email', label: 'Email', search: true, group: 'Prospect' },
    phone: { type: 'phone', label: 'Phone', group: 'Prospect' },
    companyId: { type: 'ref', ref: 'companies', label: 'Existing company', group: 'Prospect' },
    source: { type: 'enum', label: 'Source', options: SOURCES, list: true, filter: true, default: 'website' },
    campaignId: { type: 'ref', ref: 'campaigns', label: 'Campaign', filter: true },
    projectType: { type: 'enum', label: 'Project type', options: PROJECT_TYPES, filter: true },
    estimatedValue: { type: 'money', label: 'Estimated value', list: true, min: 0 },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true, default: me },
    nextFollowUpDate: { type: 'date', label: 'Next follow-up', list: true, filter: true },
    requirements: { type: 'textarea', label: 'Requirements' },
    disqualifyReason: { type: 'text', label: 'Disqualification reason' },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Opportunity', readonly: true },
    createdAt: { type: 'datetime', label: 'Created', readonly: true, filter: true },
  },
  assignees: ['ownerId'],
  children: [{ resource: 'follow_ups', field: 'leadId' }, { resource: 'communications', field: 'leadId' }],
  hooks: {
    beforeUpdate(_c, data, prev) {
      if (data.status === 'unqualified' && !(data.disqualifyReason ?? prev.disqualifyReason)) {
        throw invalid('Validation failed', { disqualifyReason: 'Give a reason when disqualifying a lead' });
      }
    },
  },
});

const STAGE_PROBABILITY: Record<string, number> = { discovery: 10, requirement: 25, proposal: 50, negotiation: 75, won: 100, lost: 0 };

async function stageKey(c: HookCtx, id: string) {
  const [s] = await c.tx.select({ key: pipelineStages.key }).from(pipelineStages).where(eq(pipelineStages.id, id));
  return s?.key;
}

defineResource({
  key: 'opportunities', table: opportunities, label: 'Opportunity', plural: 'Opportunities', module: 'crm', perm: 'opportunities',
  titleField: 'name', board: 'stageId', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'opportunity', prefix: 'OP-', pad: 4 },
  description: 'Qualified deals moving through Discovery → Requirement → Proposal → Negotiation → Won.',
  scopes: { own: (a) => eq(opportunities.ownerId, me(a)) },
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    companyId: { type: 'ref', ref: 'companies', label: 'Company', required: true, list: true, filter: true },
    stageId: { type: 'stage', pipeline: 'sales', label: 'Stage', required: true, list: true, filter: true },
    value: { type: 'money', label: 'Value', required: true, list: true, min: 0 },
    currency: { type: 'text', label: 'Currency', max: 3, default: 'USD' },
    probability: { type: 'percent', label: 'Probability', list: true },
    expectedCloseDate: { type: 'date', label: 'Expected close', list: true, filter: true },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true, default: me },
    primaryContactId: { type: 'ref', ref: 'contacts', label: 'Primary contact' },
    projectType: { type: 'enum', label: 'Project type', options: PROJECT_TYPES, filter: true },
    source: { type: 'enum', label: 'Source', options: SOURCES, filter: true },
    description: { type: 'textarea', label: 'Description' },
    lostReason: { type: 'text', label: 'Lost reason' },
    leadId: { type: 'ref', ref: 'leads', label: 'Lead', readonly: true },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', readonly: true },
    wonAt: { type: 'datetime', label: 'Won at', readonly: true },
  },
  assignees: ['ownerId'],
  children: [
    { resource: 'requirements', field: 'opportunityId' }, { resource: 'quotes', field: 'opportunityId' },
    { resource: 'proposals', field: 'opportunityId' }, { resource: 'contracts', field: 'opportunityId' },
    { resource: 'follow_ups', field: 'opportunityId' }, { resource: 'communications', field: 'opportunityId' },
  ],
  hooks: {
    async beforeCreate(c, data) {
      const key = await stageKey(c, data.stageId);
      if (key === 'won' || key === 'lost') throw invalid('Validation failed', { stageId: 'Create the opportunity in an open stage, then move it' });
      if (data.probability === undefined || data.probability === null) data.probability = String(STAGE_PROBABILITY[key ?? ''] ?? 10);
    },
    async beforeUpdate(c, data, prev) {
      if (!data.stageId || data.stageId === prev.stageId) return;
      const [from, to] = await Promise.all([stageKey(c, prev.stageId), stageKey(c, data.stageId)]);
      if (from === 'won' && prev.projectId) throw conflict('This deal has been won and onboarded; it can no longer change stage');
      if (to === 'won') {
        if (Number(data.value ?? prev.value) <= 0) throw invalid('Validation failed', { value: 'A won deal needs a value' });
        data.wonAt = new Date(); data.lostAt = null; data.probability = '100';
      } else if (to === 'lost') {
        if (!(data.lostReason ?? prev.lostReason)) throw invalid('Validation failed', { lostReason: 'Give a reason when marking a deal lost' });
        data.lostAt = new Date(); data.wonAt = null; data.probability = '0';
      } else if (to && data.probability === undefined) {
        data.probability = String(STAGE_PROBABILITY[to] ?? prev.probability);
      }
    },
  },
});

defineResource({
  key: 'requirements', table: requirements, label: 'Requirement', plural: 'Requirements', module: 'crm', perm: 'opportunities',
  titleField: 'title', defaultSort: 'priority',
  scopes: { own: (a) => sql`${requirements.opportunityId} in (select o.id from opportunities o where o.owner_id = ${a.userId})` },
  fields: {
    title: { type: 'text', label: 'Requirement', required: true, list: true, search: true },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Opportunity', required: true, list: true, filter: true },
    priority: { type: 'enum', label: 'Priority (MoSCoW)', options: ['must', 'should', 'could', 'wont'], list: true, filter: true, default: 'must' },
    category: { type: 'text', label: 'Category', list: true },
    estimateHours: { type: 'hours', label: 'Estimate (h)', list: true, min: 0 },
    description: { type: 'textarea', label: 'Details' },
  },
});

defineResource({
  key: 'communications', table: communications, label: 'Communication', plural: 'Communications', module: 'crm', perm: 'companies',
  titleField: 'subject', defaultSort: '-occurredAt',
  description: 'Calls, emails, meetings and notes with clients and prospects.',
  scopes: {
    own: (a) => or(eq(communications.loggedById, me(a)),
      sql`${communications.projectId} in ${myProjectIds(a.userId)}`,
      sql`${communications.opportunityId} in (select o.id from opportunities o where o.owner_id = ${a.userId})`)!,
  },
  fields: {
    subject: { type: 'text', label: 'Subject', required: true, list: true, search: true },
    kind: { type: 'enum', label: 'Type', options: ['call', 'email', 'meeting', 'message', 'note'], list: true, filter: true, default: 'note' },
    direction: { type: 'enum', label: 'Direction', options: ['inbound', 'outbound', 'internal'], list: true, filter: true, default: 'outbound' },
    occurredAt: { type: 'datetime', label: 'When', list: true, filter: true, default: () => new Date() },
    companyId: { type: 'ref', ref: 'companies', label: 'Company', list: true, filter: true },
    contactId: { type: 'ref', ref: 'contacts', label: 'Contact' },
    leadId: { type: 'ref', ref: 'leads', label: 'Lead' },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Opportunity' },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', filter: true },
    loggedById: { type: 'ref', ref: 'users', label: 'Logged by', readonly: true, list: true },
    body: { type: 'textarea', label: 'Notes' },
  },
  hooks: { beforeCreate(c, data) { data.loggedById = c.actor.userId; } },
});

defineResource({
  key: 'follow_ups', table: followUps, label: 'Follow-up', plural: 'Follow-ups', module: 'crm', perm: 'leads',
  titleField: 'title', defaultSort: 'dueDate',
  scopes: { own: (a) => eq(followUps.ownerId, me(a)) },
  status: { field: 'status', transitions: { open: ['done', 'cancelled'], done: ['open'], cancelled: ['open'] } },
  fields: {
    title: { type: 'text', label: 'Follow-up', required: true, list: true, search: true },
    dueDate: { type: 'date', label: 'Due', required: true, list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['open', 'done', 'cancelled'], list: true, filter: true, default: 'open' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true, default: me },
    leadId: { type: 'ref', ref: 'leads', label: 'Lead', list: true },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Opportunity', list: true },
    companyId: { type: 'ref', ref: 'companies', label: 'Company' },
    notes: { type: 'textarea', label: 'Notes' },
  },
  assignees: ['ownerId'],
  hooks: {
    beforeUpdate(_c, data, prev) {
      if (data.status === 'done' && prev.status !== 'done') data.completedAt = new Date();
      if (data.status === 'open') data.completedAt = null;
    },
  },
});

// ── Sales documents ──
const quoteDraftOnly = async (c: HookCtx, quoteId: string) => {
  const [q] = await c.tx.select({ status: quotes.status }).from(quotes).where(eq(quotes.id, quoteId));
  if (q && q.status !== 'draft') throw conflict('Only draft quotes can be changed. Create a new revision instead.');
};

defineResource({
  key: 'quotes', table: quotes, label: 'Quote', plural: 'Quotes', module: 'sales', perm: 'sales_docs',
  titleField: 'title', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'quote', prefix: 'QT-', pad: 4 },
  scopes: { own: (a) => or(eq(quotes.ownerId, me(a)), sql`${quotes.opportunityId} in (select o.id from opportunities o where o.owner_id = ${a.userId})`)! },
  status: { field: 'status', transitions: { draft: ['sent'], sent: ['accepted', 'rejected', 'expired', 'draft'], accepted: [], rejected: ['draft'], expired: ['draft'] } },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    companyId: { type: 'ref', ref: 'companies', label: 'Company', required: true, list: true, filter: true },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Opportunity', filter: true },
    contactId: { type: 'ref', ref: 'contacts', label: 'Contact' },
    status: { type: 'enum', label: 'Status', options: ['draft', 'sent', 'accepted', 'rejected', 'expired'], list: true, filter: true, default: 'draft' },
    issueDate: { type: 'date', label: 'Issue date', required: true, list: true, default: () => new Date().toISOString().slice(0, 10) },
    validUntil: { type: 'date', label: 'Valid until', list: true },
    currency: { type: 'text', label: 'Currency', max: 3, default: 'USD', group: 'Amounts' },
    discountAmount: { type: 'money', label: 'Discount', min: 0, default: '0', group: 'Amounts' },
    taxRate: { type: 'percent', label: 'Tax rate', default: '0', group: 'Amounts' },
    subtotal: { type: 'money', label: 'Subtotal', readonly: true, group: 'Amounts' },
    taxAmount: { type: 'money', label: 'Tax', readonly: true, group: 'Amounts' },
    total: { type: 'money', label: 'Total', readonly: true, list: true, group: 'Amounts' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', default: me },
    notes: { type: 'textarea', label: 'Notes to client' },
    terms: { type: 'textarea', label: 'Terms' },
  },
  children: [{ resource: 'quote_items', field: 'quoteId', label: 'Line items' }],
  hooks: {
    async beforeUpdate(c, data, prev) {
      const editingAmounts = ['discountAmount', 'taxRate', 'currency'].some((k) => k in data && data[k] !== prev[k]);
      if (editingAmounts && prev.status !== 'draft') throw conflict('Only draft quotes can be changed');
      if (data.status === 'sent' && prev.status === 'draft') {
        const items = await c.tx.select({ id: quoteItems.id }).from(quoteItems).where(eq(quoteItems.quoteId, prev.id)).limit(1);
        if (!items.length) throw invalid('Add at least one line item before sending', { status: 'Quote has no line items' });
        data.sentAt = new Date();
      }
      if (['accepted', 'rejected'].includes(data.status)) data.decidedAt = new Date();
    },
    async afterUpdate(c, row, prev) {
      if (row.discountAmount !== prev.discountAmount || row.taxRate !== prev.taxRate) await recalcQuote(c.tx, row.id);
    },
  },
});

defineResource({
  key: 'quote_items', table: quoteItems, label: 'Line item', plural: 'Line items', module: 'sales', perm: 'sales_docs',
  titleField: 'description', defaultSort: 'sortOrder',
  permissions: { export: null },
  scopes: { own: (a) => sql`${quoteItems.quoteId} in (select q.id from quotes q where q.owner_id = ${a.userId})` },
  fields: {
    quoteId: { type: 'ref', ref: 'quotes', label: 'Quote', required: true, createOnly: true },
    description: { type: 'text', label: 'Description', required: true, list: true, max: 500 },
    quantity: { type: 'decimal', label: 'Qty', required: true, list: true, min: 0, default: '1' },
    unitPrice: { type: 'money', label: 'Unit price', required: true, list: true, min: 0 },
    amount: { type: 'money', label: 'Amount', readonly: true, list: true },
    sortOrder: { type: 'int', label: 'Order', default: 0 },
  },
  hooks: {
    async beforeCreate(c, data) { await quoteDraftOnly(c, data.quoteId); },
    async beforeUpdate(c, _d, prev) { await quoteDraftOnly(c, prev.quoteId); },
    async beforeDelete(c, row) { await quoteDraftOnly(c, row.quoteId); },
    async afterCreate(c, row) { await recalcQuote(c.tx, row.quoteId); },
    async afterUpdate(c, row) { await recalcQuote(c.tx, row.quoteId); },
    async afterDelete(c, row) { await recalcQuote(c.tx, row.quoteId); },
  },
});

defineResource({
  key: 'proposals', table: proposals, label: 'Proposal', plural: 'Proposals', module: 'sales', perm: 'sales_docs',
  titleField: 'title', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'proposal', prefix: 'PR-', pad: 4 },
  scopes: { own: (a) => or(eq(proposals.ownerId, me(a)), sql`${proposals.opportunityId} in (select o.id from opportunities o where o.owner_id = ${a.userId})`)! },
  status: { field: 'status', transitions: { draft: ['sent'], sent: ['accepted', 'rejected', 'draft'], accepted: [], rejected: ['draft'] } },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Opportunity', required: true, list: true, filter: true },
    quoteId: { type: 'ref', ref: 'quotes', label: 'Quote' },
    status: { type: 'enum', label: 'Status', options: ['draft', 'sent', 'accepted', 'rejected'], list: true, filter: true, default: 'draft' },
    version: { type: 'int', label: 'Version', min: 1, default: 1, list: true },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', default: me },
    summary: { type: 'textarea', label: 'Executive summary' },
    scope: { type: 'markdown', label: 'Scope of work' },
    timeline: { type: 'textarea', label: 'Timeline' },
    sentAt: { type: 'datetime', label: 'Sent', readonly: true, list: true },
  },
  hooks: {
    beforeUpdate(_c, data, prev) {
      if (data.status === 'sent' && prev.status !== 'sent') data.sentAt = new Date();
      if (['accepted', 'rejected'].includes(data.status)) data.decidedAt = new Date();
    },
  },
});

defineResource({
  key: 'contracts', table: contracts, label: 'Contract', plural: 'Contracts & SOWs', module: 'sales', perm: 'sales_docs',
  titleField: 'title', collab: { comments: true, files: true },
  numbering: { field: 'number', key: 'contract', prefix: 'CT-', pad: 4 },
  description: 'MSAs, SOWs, NDAs and maintenance agreements. SOWs can sit under a parent MSA.',
  scopes: {
    own: (a) => or(eq(contracts.ownerId, me(a)), sql`${contracts.projectId} in ${myProjectIds(a.userId)}`,
      sql`${contracts.opportunityId} in (select o.id from opportunities o where o.owner_id = ${a.userId})`)!,
  },
  status: {
    field: 'status',
    transitions: { draft: ['sent'], sent: ['signed', 'draft'], signed: ['active', 'terminated'], active: ['expired', 'terminated'], expired: ['active'], terminated: [] },
  },
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    type: { type: 'enum', label: 'Type', options: ['msa', 'sow', 'nda', 'maintenance', 'change_order', 'other'], list: true, filter: true, default: 'sow' },
    companyId: { type: 'ref', ref: 'companies', label: 'Company', required: true, list: true, filter: true },
    status: { type: 'enum', label: 'Status', options: ['draft', 'sent', 'signed', 'active', 'expired', 'terminated'], list: true, filter: true, default: 'draft' },
    value: { type: 'money', label: 'Value', list: true, min: 0 },
    currency: { type: 'text', label: 'Currency', max: 3, default: 'USD' },
    startDate: { type: 'date', label: 'Start', list: true },
    endDate: { type: 'date', label: 'End', list: true, filter: true },
    signedAt: { type: 'date', label: 'Signed on' },
    renewalDate: { type: 'date', label: 'Renewal date', filter: true },
    autoRenew: { type: 'bool', label: 'Auto-renews', default: false },
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Opportunity' },
    projectId: { type: 'ref', ref: 'projects', label: 'Project', filter: true },
    parentContractId: { type: 'ref', ref: 'contracts', label: 'Parent agreement (MSA)' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', default: me },
    paymentTerms: { type: 'textarea', label: 'Payment terms' },
    scope: { type: 'markdown', label: 'Scope (SOW)' },
  },
  children: [{ resource: 'contracts', field: 'parentContractId', label: 'SOWs under this agreement' }],
  hooks: {
    beforeUpdate(_c, data, prev) {
      if (data.status === 'signed' && !(data.signedAt ?? prev.signedAt)) data.signedAt = new Date().toISOString().slice(0, 10);
    },
  },
});

defineResource({
  key: 'sales_targets', table: salesTargets, label: 'Sales target', plural: 'Sales targets', module: 'sales', perm: 'sales_targets',
  permissions: { view: 'sales_targets.view', create: 'sales_targets.manage', edit: 'sales_targets.manage', delete: 'sales_targets.manage', export: 'sales_targets.view' },
  titleField: 'periodStart', formatTitle: (r) => `${r.periodStart} → ${r.periodEnd}`, defaultSort: '-periodStart',
  scopes: { own: (a) => or(eq(salesTargets.userId, me(a)), sql`${salesTargets.userId} is null`)! },
  fields: {
    userId: { type: 'ref', ref: 'users', label: 'Salesperson (blank = team)', list: true, filter: true },
    periodStart: { type: 'date', label: 'From', required: true, list: true },
    periodEnd: { type: 'date', label: 'To', required: true, list: true },
    targetAmount: { type: 'money', label: 'Target', required: true, list: true, min: 0 },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    beforeCreate(_c, d) { if (d.periodEnd < d.periodStart) throw invalid('Validation failed', { periodEnd: 'Must be after the start' }); },
  },
});

defineResource({
  key: 'commissions', table: commissions, label: 'Commission', plural: 'Commissions', module: 'sales', perm: 'sales_targets',
  permissions: { view: 'sales_targets.view', create: 'sales_targets.manage', edit: 'sales_targets.manage', delete: 'sales_targets.manage', export: 'sales_targets.view' },
  titleField: 'id', formatTitle: (r) => `Commission ${String(r.amount)}`,
  scopes: { own: (a) => eq(commissions.userId, me(a)) },
  status: { field: 'status', transitions: { pending: ['approved', 'cancelled'], approved: ['paid', 'cancelled'], paid: [], cancelled: [] } },
  fields: {
    opportunityId: { type: 'ref', ref: 'opportunities', label: 'Deal', required: true, list: true },
    userId: { type: 'ref', ref: 'users', label: 'Salesperson', required: true, list: true, filter: true },
    ratePct: { type: 'percent', label: 'Rate', required: true, list: true },
    amount: { type: 'money', label: 'Amount', readonly: true, list: true },
    status: { type: 'enum', label: 'Status', options: ['pending', 'approved', 'paid', 'cancelled'], list: true, filter: true, default: 'pending' },
    paidAt: { type: 'date', label: 'Paid on' },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    async beforeCreate(c, d) {
      const [o] = await c.tx.select({ value: opportunities.value }).from(opportunities).where(eq(opportunities.id, d.opportunityId));
      d.amount = ((Number(o?.value ?? 0) * Number(d.ratePct)) / 100).toFixed(2);
    },
    async beforeUpdate(c, d, prev) {
      if (d.ratePct === undefined) return;
      const [o] = await c.tx.select({ value: opportunities.value }).from(opportunities).where(eq(opportunities.id, prev.opportunityId));
      d.amount = ((Number(o?.value ?? 0) * Number(d.ratePct)) / 100).toFixed(2);
    },
  },
});

