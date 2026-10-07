import { and, asc, desc, eq, gte, isNotNull, lte, sql } from 'drizzle-orm';
import { campaigns, contentItems, leads, pipelineStages, seoKeywords } from '../db/schema/index.ts';
import { withActor } from '../core/context.ts';
import { notify } from '../core/notify.ts';
import { JOBS } from '../jobs.ts';
import { daysAgo, monthStart, registerDashboard, today } from './reports.ts';

registerDashboard({
  key: 'marketing', perm: 'marketing.view',
  async build(ctx) {
    const res: any = await ctx.db.execute(sql`
      with m as (select generate_series(date_trunc('month', current_date) - interval '5 months', date_trunc('month', current_date), '1 month') as m)
      select to_char(m.m, 'YYYY-MM') as month,
        (select count(*)::int from leads l where date_trunc('month', l.created_at) = m.m) as leads,
        (select coalesce(sum(sessions), 0)::int from traffic_snapshots t where t.channel = 'organic' and date_trunc('month', t.period_start) = m.m) as organic
      from m order by m.m`);
    const bySource = await ctx.db.select({ source: leads.source, n: sql<number>`count(*)::int` }).from(leads)
      .where(gte(leads.createdAt, new Date(daysAgo(90)))).groupBy(leads.source).orderBy(sql`count(*) desc`);
    const camp = await ctx.db.select({
      id: campaigns.id, name: campaigns.name, channel: campaigns.channel, status: campaigns.status, spend: campaigns.spend, budget: campaigns.budget,
      leads: sql<number>`(select count(*)::int from leads l where l.campaign_id = ${campaigns.id})`,
      converted: sql<number>`(select count(*)::int from leads l where l.campaign_id = ${campaigns.id} and l.status = 'converted')`,
    }).from(campaigns).where(sql`${campaigns.status} in ('active', 'planned') or ${campaigns.endDate} >= ${daysAgo(60)}`).orderBy(desc(campaigns.startDate));
    const pipeline = await ctx.db.select({ key: pipelineStages.key, name: pipelineStages.name, n: sql<number>`count(${contentItems.id})::int` })
      .from(pipelineStages).leftJoin(contentItems, eq(contentItems.stageId, pipelineStages.id))
      .where(eq(pipelineStages.pipeline, 'content')).groupBy(pipelineStages.id).orderBy(asc(pipelineStages.sortOrder));
    const movers = await ctx.db.select().from(seoKeywords).where(and(isNotNull(seoKeywords.currentPosition), isNotNull(seoKeywords.previousPosition)))
      .orderBy(sql`abs(${seoKeywords.previousPosition} - ${seoKeywords.currentPosition}) desc`).limit(8);
    const [month] = await ctx.db.select({ n: sql<number>`count(*)::int`, conv: sql<number>`count(*) filter (where ${leads.status} = 'converted')::int` }).from(leads).where(gte(leads.createdAt, new Date(monthStart())));
    const [conv90] = await ctx.db.select({ n: sql<number>`count(*)::int`, conv: sql<number>`count(*) filter (where ${leads.status} = 'converted')::int` }).from(leads).where(gte(leads.createdAt, new Date(daysAgo(90))));
    const dueContent = await ctx.db.select({ id: contentItems.id, title: contentItems.title, dueDate: contentItems.dueDate }).from(contentItems)
      .innerJoin(pipelineStages, eq(pipelineStages.id, contentItems.stageId)).where(and(lte(contentItems.dueDate, today()), sql`${pipelineStages.key} not in ('published', 'performance')`));
    const series = res.rows as { month: string; leads: number; organic: number }[];
    const last = series.at(-1)?.organic ?? 0, prev = series.at(-2)?.organic ?? 0;
    return {
      series, bySource, campaigns: camp, pipeline, movers, dueContent,
      leadsMonth: month.n, conversionPct: conv90.n ? Math.round((conv90.conv / conv90.n) * 100) : null,
      organicGrowthPct: prev ? Math.round(((last - prev) / prev) * 100) : null, activeCampaigns: camp.filter((c) => c.status === 'active').length,
      contentInProgress: pipeline.filter((p) => !['published', 'performance', 'idea'].includes(p.key)).reduce((a, p) => a + p.n, 0),
    };
  },
});

JOBS.push({
  name: 'seo.ranking_drops', everyMinutes: 720,
  run: (db) => withActor(db, null, 'job:seo.ranking_drops', async (t) => {
    // Alert when a tracked keyword falls 5+ positions (or out of the tracked range) since the previous check.
    const drops = await t.select().from(seoKeywords).where(and(isNotNull(seoKeywords.previousPosition),
      sql`(${seoKeywords.currentPosition} is null or ${seoKeywords.currentPosition} - ${seoKeywords.previousPosition} >= 5)`));
    for (const k of drops) {
      await notify(t, {
        roles: k.ownerId ? [] : ['marketing'], userIds: [k.ownerId], kind: 'alert',
        title: `Ranking drop: “${k.keyword}” ${k.previousPosition} → ${k.currentPosition ?? 'not ranking'} (${k.site})`,
        entityType: 'seo_keywords', entityId: k.id, dedupeKey: `rank-drop:${k.id}:${k.lastCheckedOn}`,
      });
    }
  }),
});
