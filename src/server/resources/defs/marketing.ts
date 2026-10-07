import { desc, eq, sql } from 'drizzle-orm';
import { backlinks, campaigns, contentItems, keywordRankings, seoAudits, seoKeywords, trafficSnapshots } from '../../db/schema/index.ts';
import { invalid } from '../../core/errors.ts';
import { defineResource } from '../registry.ts';
import type { HookCtx } from '../types.ts';

const today = () => new Date().toISOString().slice(0, 10);
const me = (a: { userId: string }) => a.userId;

defineResource({
  key: 'campaigns', table: campaigns, label: 'Campaign', plural: 'Campaigns', module: 'marketing', perm: 'marketing',
  titleField: 'name', defaultSort: '-startDate', collab: { comments: true, files: true }, assignees: ['ownerId'],
  description: 'Marketing campaigns. Leads are attributed to campaigns for cost-per-lead and conversion.',
  fields: {
    name: { type: 'text', label: 'Name', required: true, list: true, search: true },
    channel: { type: 'enum', label: 'Channel', options: ['seo', 'ppc', 'social', 'email', 'content', 'event', 'referral', 'partnership', 'other'], list: true, filter: true, default: 'content' },
    status: { type: 'enum', label: 'Status', options: ['planned', 'active', 'paused', 'completed'], list: true, filter: true, default: 'planned' },
    startDate: { type: 'date', label: 'Start', list: true },
    endDate: { type: 'date', label: 'End', list: true },
    budget: { type: 'money', label: 'Budget', min: 0, list: true },
    spend: { type: 'money', label: 'Spend to date', min: 0, list: true },
    utmCampaign: { type: 'text', label: 'UTM campaign' },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', list: true, filter: true },
    goal: { type: 'textarea', label: 'Goal' },
  },
  children: [{ resource: 'leads', field: 'campaignId', label: 'Leads generated' }, { resource: 'content_items', field: 'campaignId', label: 'Content' }],
});

defineResource({
  key: 'traffic_snapshots', table: trafficSnapshots, label: 'Traffic record', plural: 'Website traffic', module: 'marketing', perm: 'marketing',
  titleField: 'site', formatTitle: (r) => `${r.site} ${r.channel} ${r.periodStart}`, defaultSort: '-periodStart',
  description: 'Sessions, users and conversions by channel. Entered manually until an analytics integration (GA4) is connected.',
  fields: {
    site: { type: 'text', label: 'Site', required: true, list: true, filter: true },
    periodStart: { type: 'date', label: 'From', required: true, list: true, filter: true },
    periodEnd: { type: 'date', label: 'To', required: true, list: true },
    channel: { type: 'enum', label: 'Channel', options: ['organic', 'paid', 'social', 'referral', 'direct', 'email', 'other'], required: true, list: true, filter: true },
    sessions: { type: 'int', label: 'Sessions', min: 0, list: true },
    users: { type: 'int', label: 'Users', min: 0, list: true },
    conversions: { type: 'int', label: 'Conversions', min: 0, list: true },
    source: { type: 'enum', label: 'Source', options: ['manual', 'ga4', 'search_console', 'import'], readonly: true },
  },
});

defineResource({
  key: 'seo_keywords', table: seoKeywords, label: 'Keyword', plural: 'Keywords', module: 'marketing', perm: 'marketing',
  titleField: 'keyword', defaultSort: 'keyword', assignees: ['ownerId'],
  description: 'Tracked keywords and their latest positions (record checks under Rankings).',
  fields: {
    keyword: { type: 'text', label: 'Keyword', required: true, list: true, search: true },
    site: { type: 'text', label: 'Site', required: true, list: true, filter: true },
    targetUrl: { type: 'url', label: 'Target URL' },
    currentPosition: { type: 'int', label: 'Position', readonly: true, list: true },
    previousPosition: { type: 'int', label: 'Previous', readonly: true, list: true },
    bestPosition: { type: 'int', label: 'Best', readonly: true },
    lastCheckedOn: { type: 'date', label: 'Checked', readonly: true, list: true },
    searchVolume: { type: 'int', label: 'Volume', min: 0, list: true },
    difficulty: { type: 'int', label: 'Difficulty (0–100)', min: 0, max: 100 },
    intent: { type: 'enum', label: 'Intent', options: ['informational', 'commercial', 'transactional', 'navigational'], filter: true },
    priority: { type: 'enum', label: 'Priority', options: ['low', 'medium', 'high', 'critical'], filter: true, default: 'medium' },
    projectId: { type: 'ref', ref: 'projects', label: 'Client project', filter: true },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', filter: true },
  },
  children: [{ resource: 'keyword_rankings', field: 'keywordId', label: 'Rankings' }, { resource: 'content_items', field: 'keywordId', label: 'Content' }],
});

async function refreshKeyword(c: HookCtx, keywordId: string) {
  const [latest, prev] = await c.tx.select().from(keywordRankings).where(eq(keywordRankings.keywordId, keywordId)).orderBy(desc(keywordRankings.checkedOn)).limit(2);
  const [best] = await c.tx.select({ v: sql<number>`min(${keywordRankings.position})` }).from(keywordRankings).where(eq(keywordRankings.keywordId, keywordId));
  await c.tx.update(seoKeywords).set({ currentPosition: latest?.position ?? null, previousPosition: prev?.position ?? null, bestPosition: best?.v ?? null, lastCheckedOn: latest?.checkedOn ?? null })
    .where(eq(seoKeywords.id, keywordId));
}

defineResource({
  key: 'keyword_rankings', table: keywordRankings, label: 'Ranking check', plural: 'Rankings', module: 'marketing', perm: 'marketing',
  titleField: 'checkedOn', formatTitle: (r) => `#${r.position ?? '—'} on ${r.checkedOn}`, defaultSort: '-checkedOn',
  fields: {
    keywordId: { type: 'ref', ref: 'seo_keywords', label: 'Keyword', required: true, createOnly: true, list: true, filter: true },
    checkedOn: { type: 'date', label: 'Checked on', required: true, list: true, default: () => today() },
    position: { type: 'int', label: 'Position (blank = not ranking)', min: 1, max: 200, list: true },
    url: { type: 'url', label: 'Ranking URL', list: true },
  },
  hooks: {
    beforeCreate(_c, d) { if (d.checkedOn > today()) throw invalid('Validation failed', { checkedOn: 'Cannot be in the future' }); },
    async afterCreate(c, row) { await refreshKeyword(c, row.keywordId); },
    async afterUpdate(c, row) { await refreshKeyword(c, row.keywordId); },
    async afterDelete(c, row) { await refreshKeyword(c, row.keywordId); },
  },
});

defineResource({
  key: 'backlinks', table: backlinks, label: 'Backlink', plural: 'Backlinks', module: 'marketing', perm: 'marketing',
  titleField: 'sourceUrl', defaultSort: '-createdAt', assignees: ['ownerId'],
  status: { field: 'status', transitions: { prospect: ['outreach', 'rejected'], outreach: ['live', 'rejected', 'prospect'], live: ['lost'], lost: ['outreach'], rejected: ['prospect'] } },
  fields: {
    sourceUrl: { type: 'url', label: 'Linking page', required: true, list: true, search: true },
    site: { type: 'text', label: 'Our site', required: true, list: true, filter: true },
    targetUrl: { type: 'url', label: 'Target page' },
    anchorText: { type: 'text', label: 'Anchor text', list: true },
    domainAuthority: { type: 'int', label: 'Domain authority', min: 0, max: 100, list: true },
    status: { type: 'enum', label: 'Status', options: ['prospect', 'outreach', 'live', 'lost', 'rejected'], list: true, filter: true, default: 'prospect' },
    acquiredOn: { type: 'date', label: 'Live since', readonly: true, list: true },
    lostOn: { type: 'date', label: 'Lost on', readonly: true },
    cost: { type: 'money', label: 'Cost', min: 0 },
    ownerId: { type: 'ref', ref: 'users', label: 'Owner', filter: true },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    beforeUpdate(_c, d, prev) {
      if (d.status === 'live' && prev.status !== 'live') d.acquiredOn = today();
      if (d.status === 'lost' && prev.status !== 'lost') d.lostOn = today();
    },
  },
});

defineResource({
  key: 'seo_audits', table: seoAudits, label: 'SEO audit', plural: 'SEO audits', module: 'marketing', perm: 'marketing',
  titleField: 'site', formatTitle: (r) => `${r.site} audit ${r.auditDate}`, defaultSort: '-auditDate', collab: { comments: true, files: true },
  fields: {
    site: { type: 'text', label: 'Site', required: true, list: true, filter: true },
    auditDate: { type: 'date', label: 'Date', required: true, list: true, default: () => today() },
    tool: { type: 'text', label: 'Tool', list: true },
    healthScore: { type: 'int', label: 'Health score', min: 0, max: 100, list: true },
    issuesCritical: { type: 'int', label: 'Critical issues', min: 0, list: true },
    issuesWarning: { type: 'int', label: 'Warnings', min: 0, list: true },
    pagesCrawled: { type: 'int', label: 'Pages crawled', min: 0 },
    projectId: { type: 'ref', ref: 'projects', label: 'Client project', filter: true },
    auditorId: { type: 'ref', ref: 'users', label: 'Auditor', default: me },
    summary: { type: 'markdown', label: 'Findings & recommendations' },
  },
});

defineResource({
  key: 'content_items', table: contentItems, label: 'Content', plural: 'Content pipeline', module: 'marketing', perm: 'marketing',
  titleField: 'title', board: 'stageId', defaultSort: 'dueDate', collab: { comments: true, files: true }, assignees: ['assigneeId'],
  description: 'Idea → Research → Brief → Writing → Editing → SEO → Design → Published → Performance.',
  fields: {
    title: { type: 'text', label: 'Title', required: true, list: true, search: true },
    type: { type: 'enum', label: 'Type', options: ['blog_post', 'landing_page', 'case_study', 'social_post', 'newsletter', 'video', 'other'], list: true, filter: true, default: 'blog_post' },
    stageId: { type: 'stage', pipeline: 'content', label: 'Stage', required: true, list: true, filter: true },
    assigneeId: { type: 'ref', ref: 'users', label: 'Assignee', list: true, filter: true },
    dueDate: { type: 'date', label: 'Due', list: true, filter: true },
    keywordId: { type: 'ref', ref: 'seo_keywords', label: 'Target keyword' },
    campaignId: { type: 'ref', ref: 'campaigns', label: 'Campaign', filter: true },
    wordCount: { type: 'int', label: 'Words', min: 0 },
    publishedUrl: { type: 'url', label: 'Published URL' },
    publishedOn: { type: 'date', label: 'Published on', readonly: true, list: true },
    sessions: { type: 'int', label: 'Sessions (performance)', min: 0 },
    conversions: { type: 'int', label: 'Conversions', min: 0 },
    brief: { type: 'markdown', label: 'Brief' },
    notes: { type: 'textarea', label: 'Notes' },
  },
  hooks: {
    async beforeUpdate(c, d, prev) {
      if (!d.stageId || d.stageId === prev.stageId) return;
      const res: any = await c.tx.execute(sql`select key from pipeline_stages where id = ${d.stageId}`);
      if (res.rows[0]?.key === 'published') {
        if (!(d.publishedUrl ?? prev.publishedUrl)) throw invalid('Validation failed', { publishedUrl: 'Add the published URL' });
        d.publishedOn = d.publishedOn ?? today();
      }
    },
  },
});

