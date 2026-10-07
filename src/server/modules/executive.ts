import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, inArray, notInArray, sql } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { companies, goals, initiatives, kpis, risks } from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import type { Ctx } from '../core/context.ts';
import { forbidden } from '../core/errors.ts';
import { can } from '../rbac/actor.ts';
import { mrr, monthlySeries, profitAndLoss, projectProfitability, receivables } from './finance.ts';
import { METRICS } from './kpi.ts';
import { daysAgo, developerPerformance, monthStart, projectPortfolio, registerDashboard, salesPipeline, salesSummary, today, utilization } from './reports.ts';

const yearStart = () => today().slice(0, 4) + '-01-01';
const lastYear = (d: string) => `${Number(d.slice(0, 4)) - 1}${d.slice(4)}`;
const rows = async (db: DB, q: ReturnType<typeof sql>) => ((await db.execute(q)) as any).rows as any[];

/** Client profitability over a period: invoiced revenue vs employee + direct costs on the client's projects. */
export async function clientProfitability(db: DB, from: string, to: string) {
  return rows(db, sql`
    select c.id, c.name, c.health,
      coalesce((select sum(i.total) from invoices i where i.company_id = c.id and i.status not in ('draft', 'void') and i.issue_date between ${from}::date and ${to}::date), 0)::float as revenue,
      coalesce((select sum(te.cost_amount) from time_entries te join projects p on p.id = te.project_id where p.client_id = c.id and te.work_date between ${from}::date and ${to}::date), 0)::float as employee_cost,
      coalesce((select sum(e.amount) from expenses e join projects p on p.id = e.project_id where p.client_id = c.id and e.status in ('approved', 'paid') and e.expense_date between ${from}::date and ${to}::date), 0)::float as direct_cost,
      coalesce((select sum(i.balance_due) from invoices i where i.company_id = c.id and i.status in ('sent', 'partially_paid', 'overdue')), 0)::float as outstanding
    from companies c where c.lifecycle in ('client', 'former_client')
    order by revenue desc`).then((r) => r.map((x) => ({ ...x, profit: x.revenue - x.employee_cost - x.direct_cost, marginPct: x.revenue ? Math.round(((x.revenue - x.employee_cost - x.direct_cost) / x.revenue) * 1000) / 10 : null })));
}

registerDashboard({
  key: 'ceo', perm: 'reports.executive',
  async build(ctx) {
    const db = ctx.db;
    const [month, ytd, ytdLastYear] = await Promise.all([
      profitAndLoss(db, monthStart(), today()), profitAndLoss(db, yearStart(), today()), profitAndLoss(db, lastYear(yearStart()), lastYear(today())),
    ]);
    const [clientCounts] = await rows(db, sql`select
      count(*) filter (where lifecycle = 'client')::int as active,
      count(*) filter (where lifecycle = 'client' and client_since >= date_trunc('quarter', current_date))::int as new_quarter,
      count(*) filter (where lifecycle = 'client' and client_since >= ${yearStart()}::date)::int as new_year,
      count(*) filter (where health in ('at_risk', 'attention_required'))::int as attention
      from companies`);
    const atRiskClients = await db.select({ id: companies.id, name: companies.name, health: companies.health, healthScore: companies.healthScore, healthReasons: companies.healthReasons })
      .from(companies).where(inArray(companies.health, ['at_risk', 'attention_required'])).orderBy(asc(companies.healthScore)).limit(6);
    const portfolio = await projectPortfolio(ctx);
    const profitability = can(ctx.actor, 'project_finance.view') ? await projectProfitability(db) : [];
    const keyClients = (await clientProfitability(db, daysAgo(365), today())).slice(0, 6);
    const [headcount] = await rows(db, sql`select count(*)::int as n from employees where employment_status not in ('terminated', 'resigned')`);
    const team = await utilization(ctx, daysAgo(29), today());
    const util = team.filter((t) => t.hours > 0);
    const pipeline = await salesPipeline(ctx);
    const open = pipeline.filter((s) => !['won', 'lost'].includes(s.key));
    const sales = await salesSummary(ctx, daysAgo(90), today());
    const companyGoals = await db.select().from(goals).where(and(eq(goals.level, 'company'), notInArray(goals.status, ['achieved', 'missed']))).orderBy(asc(goals.period)).limit(8);
    const strategic = await db.select().from(initiatives).where(inArray(initiatives.status, ['active', 'proposed'])).orderBy(desc(initiatives.progressPct)).limit(6);
    const companyRisks = await db.select().from(risks).where(and(sql`${risks.projectId} is null`, inArray(risks.status, ['open', 'mitigating']))).limit(6);
    const majorProjects = [...portfolio].sort((a, b) => (Number(b.budgetHours ?? 0) - Number(a.budgetHours ?? 0))).slice(0, 6);
    return {
      finance: { month, ytd, mrr: await mrr(db), receivables: await receivables(db), series: await monthlySeries(db, 12),
        growthPct: ytdLastYear.revenue ? Math.round(((ytd.revenue - ytdLastYear.revenue) / ytdLastYear.revenue) * 1000) / 10 : null },
      clients: { ...clientCounts, atRisk: atRiskClients, key: keyClients },
      projects: {
        active: portfolio.length, delayed: portfolio.filter((p) => p.status === 'delayed').length, atRisk: portfolio.filter((p) => p.status === 'at_risk').length,
        major: majorProjects, profitability: profitability.filter((p) => p.revenue > 0).sort((a, b) => b.profit - a.profit),
      },
      workforce: { headcount: headcount.n, utilizationPct: util.length ? Math.round(util.reduce((a, t) => a + t.utilizationPct, 0) / util.length) : 0, billablePct: util.length ? Math.round(util.reduce((a, t) => a + t.billablePct, 0) / util.length) : 0 },
      sales: { pipelineValue: open.reduce((a, s) => a + s.value, 0), weighted: open.reduce((a, s) => a + s.weighted, 0), openDeals: open.reduce((a, s) => a + s.count, 0), ...sales },
      strategy: { goals: companyGoals, initiatives: strategic, risks: companyRisks },
    };
  },
});

// ───────────── Reports ─────────────

type Q = { from: string; to: string };
interface ReportDef { label: string; perms: string[]; build: (ctx: Ctx, q: Q) => Promise<unknown> }
export const REPORTS: Record<string, ReportDef> = {
  financial: {
    label: 'Financial', perms: ['reports.finance', 'reports.executive'],
    build: async (ctx, q) => ({ pnl: await profitAndLoss(ctx.db, q.from, q.to), series: await monthlySeries(ctx.db, 12), receivables: await receivables(ctx.db), mrr: await mrr(ctx.db) }),
  },
  profitability: {
    label: 'Project & client profitability', perms: ['reports.finance', 'reports.executive'],
    build: async (ctx, q) => ({ projects: await projectProfitability(ctx.db), clients: await clientProfitability(ctx.db, q.from, q.to) }),
  },
  sales: {
    label: 'Sales', perms: ['reports.sales', 'reports.executive'],
    build: async (ctx, q) => ({
      summary: await salesSummary(ctx, q.from, q.to), pipeline: await salesPipeline(ctx),
      bySource: await rows(ctx.db, sql`select l.source, count(*)::int as leads, count(*) filter (where l.status = 'converted')::int as converted,
        coalesce((select sum(o.value) from opportunities o where o.lead_id in (select id from leads l2 where l2.source = l.source and l2.created_at between ${q.from}::date and ${q.to}::date + 1) and o.won_at is not null), 0)::float as won_value
        from leads l where l.created_at between ${q.from}::date and ${q.to}::date + 1 group by l.source order by leads desc`),
      byOwner: await rows(ctx.db, sql`select u.name, count(*) filter (where o.won_at is not null)::int as won, count(*) filter (where o.lost_at is not null)::int as lost,
        coalesce(sum(o.value) filter (where o.won_at is not null), 0)::float as won_value
        from opportunities o join users u on u.id = o.owner_id where coalesce(o.won_at, o.lost_at) between ${q.from}::date and ${q.to}::date + 1 group by u.name order by won_value desc`),
    }),
  },
  projects: {
    label: 'Projects & delivery', perms: ['reports.projects', 'reports.executive'],
    build: async (ctx) => ({
      projects: await rows(ctx.db, sql`
        select p.id, p.code, p.name, p.status, p.due_date, p.actual_end_date,
          (coalesce(p.actual_end_date, greatest(current_date, p.due_date)) - p.due_date) as variance_days,
          (select count(*)::int from tasks t where t.project_id = p.id) as tasks,
          (select count(*)::int from tasks t where t.project_id = p.id and t.status = 'done') as done,
          (select count(*)::int from tasks t where t.project_id = p.id and t.is_rework) as rework,
          (select count(*)::int from tasks t where t.project_id = p.id and t.status <> 'done' and t.due_date < current_date) as overdue_tasks,
          (select count(*)::int from change_requests c where c.project_id = p.id and c.status in ('approved', 'implemented')) as scope_changes,
          (select coalesce(sum(c.impact_hours), 0)::float from change_requests c where c.project_id = p.id and c.status in ('approved', 'implemented')) as scope_hours,
          (select count(*)::int from client_feedback f where f.project_id = p.id and f.status = 'overdue') as client_delays
        from projects p where p.status not in ('cancelled') order by p.code`),
    }),
  },
  utilization: {
    label: 'Team utilization', perms: ['reports.projects', 'reports.hr', 'reports.executive'],
    build: async (ctx, q) => ({ rows: await utilization(ctx, q.from, q.to) }),
  },
  hr: {
    label: 'People', perms: ['reports.hr', 'reports.executive'],
    build: async (ctx, q) => ({
      byDepartment: await rows(ctx.db, sql`select coalesce(d.name, 'Unassigned') as department, count(*)::int as headcount from employees e left join departments d on d.id = e.department_id
        where e.employment_status not in ('terminated', 'resigned') group by d.name order by headcount desc`),
      movement: await rows(ctx.db, sql`with m as (select generate_series(date_trunc('month', current_date) - interval '11 months', date_trunc('month', current_date), '1 month') m)
        select to_char(m.m, 'YYYY-MM') as month, (select count(*)::int from employees e where date_trunc('month', e.join_date) = m.m) as hires,
        (select count(*)::int from employees e where date_trunc('month', e.exit_date) = m.m) as exits from m order by m.m`),
      attendance: (await rows(ctx.db, sql`select count(*) filter (where status in ('present', 'remote', 'half_day'))::int as present, count(*) filter (where status = 'late')::int as late,
        count(*) filter (where status = 'absent')::int as absent, count(*) filter (where status = 'on_leave')::int as on_leave, coalesce(sum(overtime_minutes), 0)::int as overtime_minutes
        from attendance_records where date between ${q.from}::date and ${q.to}::date`))[0],
      reviews: (await rows(ctx.db, sql`select count(*) filter (where status = 'completed')::int as completed, count(*)::int as total, round(avg(overall_rating), 2)::float as avg_rating
        from performance_reviews where coalesce(due_date, created_at::date) between ${q.from}::date and ${q.to}::date`))[0],
      attritionPct: await METRICS.attrition_pct(ctx.db),
    }),
  },
  technical: {
    label: 'Engineering & QA', perms: ['reports.technical', 'reports.executive'],
    build: async (ctx, q) => ({
      bugsBySeverity: await rows(ctx.db, sql`select severity, count(*) filter (where status not in ('verified', 'closed', 'wont_fix', 'duplicate'))::int as open,
        count(*) filter (where created_at between ${q.from}::date and ${q.to}::date + 1)::int as reported from bugs group by severity order by severity`),
      qa: (await rows(ctx.db, sql`select coalesce(sum(pass_count), 0)::int as pass, coalesce(sum(fail_count), 0)::int as fail, coalesce(sum(total_count), 0)::int as total, count(*)::int as runs
        from qa_runs where created_at between ${q.from}::date and ${q.to}::date + 1`))[0],
      deployments: await rows(ctx.db, sql`select d.status, count(*)::int as n from deployments d where d.created_at between ${q.from}::date and ${q.to}::date + 1 group by d.status`),
      developers: await developerPerformance(ctx, q.from, q.to),
    }),
  },
  support: {
    label: 'Support', perms: ['reports.support', 'reports.executive'],
    build: async (ctx, q) => ({
      summary: (await rows(ctx.db, sql`select count(*)::int as tickets, count(*) filter (where sla_breached)::int as breached,
        count(*) filter (where status in ('resolved', 'closed'))::int as resolved,
        round(avg(extract(epoch from (resolved_at - created_at)) / 3600)::numeric, 1)::float as avg_resolution_hours, round(avg(satisfaction)::numeric, 2)::float as satisfaction
        from tickets where created_at between ${q.from}::date and ${q.to}::date + 1`))[0],
      byPriority: await rows(ctx.db, sql`select priority, count(*)::int as n, count(*) filter (where sla_breached)::int as breached from tickets where created_at between ${q.from}::date and ${q.to}::date + 1 group by priority`),
    }),
  },
  departments: {
    label: 'Department performance (KPIs)', perms: ['reports.executive', 'reports.hr'],
    build: async (ctx) => ({
      kpis: await ctx.db.select({
        id: kpis.id, name: kpis.name, unit: kpis.unit, target: kpis.target, direction: kpis.direction, department: sql<string>`(select d.name from departments d where d.id = kpis.department_id)`,
        latest: sql<string>`(select v.value from kpi_values v where v.kpi_id = kpis.id order by v.period_start desc limit 1)`,
        previous: sql<string>`(select v.value from kpi_values v where v.kpi_id = kpis.id order by v.period_start desc offset 1 limit 1)`,
      }).from(kpis).orderBy(asc(kpis.name)),
    }),
  },
};

export async function executiveRoutes(app: FastifyInstance) {
  app.get('/api/reports', async (req) => {
    const ctx = ctxOf(req);
    return Object.entries(REPORTS).filter(([, r]) => r.perms.some((p) => can(ctx.actor, p))).map(([key, r]) => ({ key, label: r.label }));
  });
  app.get<{ Params: { key: string }; Querystring: { from?: string; to?: string } }>('/api/reports/:key', async (req) => {
    const ctx = ctxOf(req);
    const r = REPORTS[req.params.key];
    if (!r || !r.perms.some((p) => can(ctx.actor, p))) throw forbidden();
    const valid = (d?: string) => (d && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : undefined);
    const from = valid(req.query.from) ?? daysAgo(89);
    const to = valid(req.query.to) ?? today();
    return { key: req.params.key, label: r.label, from, to, data: await r.build(ctx, { from, to }) };
  });
}

