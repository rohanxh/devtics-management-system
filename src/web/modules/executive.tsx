import { useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { Download } from 'lucide-react';
import { api, qs } from '../lib/api';
import { date, humanize, money, num, today } from '../lib/format';
import { useMeta } from '../lib/meta';
import { EXTRA_ROUTES } from '../lib/extensions';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Progress, Spinner, Stat, StatusBadge, Tabs, cx } from '../components/ui';
import { SimpleBars } from '../components/charts';
import { DASHBOARDS, greeting } from '../pages/Home';
import { ApprovalsList } from '../pages/Inbox';

function CEODashboard() {
  const { user, settings } = useMeta();
  const cur = settings.baseCurrency;
  const q = useQuery({ queryKey: ['dashboard', 'ceo'], queryFn: () => api.get<any>('/api/dashboard/ceo') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const { finance: f, clients: c, projects: p, workforce: w, sales: s, strategy } = q.data;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Company performance at a glance." actions={<Link to="/reports" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium hover:bg-slate-50">All reports</Link>} />
      <div className="mb-3 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Revenue YTD" value={money(f.ytd.revenue, cur, true)} hint={f.growthPct != null ? `${f.growthPct > 0 ? '+' : ''}${f.growthPct}% vs last year` : `${money(f.month.revenue, cur, true)} this month`} tone={f.growthPct != null ? (f.growthPct >= 0 ? 'green' : 'red') : undefined} />
        <Stat label="MRR" value={money(f.mrr, cur, true)} />
        <Stat label="Expenses YTD" value={money(f.ytd.expenses + f.ytd.payroll, cur, true)} hint={`incl. ${money(f.ytd.payroll, cur, true)} payroll`} />
        <Stat label="Profit YTD" value={money(f.ytd.profit, cur, true)} tone={f.ytd.profit < 0 ? 'red' : 'green'} hint={f.ytd.marginPct != null ? `${f.ytd.marginPct}% margin` : undefined} />
        <Stat label="Outstanding payments" value={money(f.receivables.total, cur, true)} hint={`${f.receivables.overdue_count} overdue`} tone={f.receivables.overdue_count ? 'amber' : undefined} />
        <Stat label="Pipeline" value={money(s.pipelineValue, cur, true)} hint={`${money(s.weighted, cur, true)} weighted · ${s.openDeals} deals`} />
        <Stat label="Win rate (90d)" value={s.winRatePct != null ? `${s.winRatePct}%` : '—'} />
      </div>
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Active clients" value={c.active} hint={`${c.new_quarter} new this quarter`} />
        <Stat label="Clients needing attention" value={c.attention} tone={c.attention ? 'amber' : undefined} />
        <Stat label="Active projects" value={p.active} />
        <Stat label="Delayed projects" value={p.delayed} tone={p.delayed ? 'red' : undefined} hint={`${p.atRisk} at risk`} />
        <Stat label="Employees" value={w.headcount} />
        <Stat label="Utilization (30d)" value={`${w.utilizationPct}%`} hint={`${w.billablePct}% billable`} />
        <Stat label="New clients YTD" value={c.new_year} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Profit by month" className="xl:col-span-2"><SimpleBars data={f.series.map((x: any) => ({ month: x.month.slice(2), profit: x.profit }))} x="month" y="profit" format={(v) => money(v, cur, true)} /></Card>
        <Card title="Decisions waiting for you"><ApprovalsList compact /></Card>
        <Card title="Company goals" className="xl:col-span-2">
          {!strategy.goals.length ? <p className="text-sm text-slate-500">No active company goals.</p> : (
            <ul className="space-y-3">{strategy.goals.map((g: any) => {
              const pct = g.targetValue ? Math.min(100, (Number(g.currentValue ?? 0) / Number(g.targetValue)) * 100) : 0;
              return (
                <li key={g.id}>
                  <div className="mb-1 flex items-center justify-between gap-2 text-sm"><Link to={`/r/goals/${g.id}`} className="font-medium hover:underline">{g.title}</Link><span className="shrink-0 text-xs text-slate-500">{g.period} · <StatusBadge value={g.status} /></span></div>
                  {g.targetValue && <><Progress value={pct} tone={g.status === 'at_risk' || g.status === 'behind' ? 'amber' : undefined} /><div className="mt-0.5 text-xs text-slate-500">{num(g.currentValue)} / {num(g.targetValue)} {g.unit}</div></>}
                </li>
              );
            })}</ul>
          )}
        </Card>
        <Card title="Clients needing attention">
          {!c.atRisk.length ? <p className="text-sm text-slate-500">All clients healthy.</p> : (
            <ul className="space-y-2 text-sm">{c.atRisk.map((x: any) => (
              <li key={x.id}><div className="flex justify-between gap-2"><Link to={`/r/clients/${x.id}`} className="font-medium hover:underline">{x.name}</Link><StatusBadge value={x.health} /></div>
                {x.healthReasons && <p className="whitespace-pre-line text-xs text-slate-500">{x.healthReasons}</p>}</li>
            ))}</ul>
          )}
        </Card>
        <Card title="Project profitability" className="xl:col-span-2" bodyClass="p-0">
          {!p.profitability.length ? <p className="p-4 text-sm text-slate-500">No invoiced projects yet.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="px-4 py-2">Project</th><th className="px-2 py-2 text-right">Revenue</th><th className="px-2 py-2 text-right">Cost</th><th className="px-2 py-2 text-right">Profit</th><th className="px-4 py-2 text-right">Margin</th></tr></thead>
              <tbody>{p.profitability.slice(0, 8).map((x: any) => (
                <tr key={x.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-1.5"><Link to={`/r/projects/${x.id}`} className="hover:underline">{x.name}</Link><div className="text-xs text-slate-500">{x.clientName}</div></td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{money(x.revenue, cur, true)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{money(x.totalCost, cur, true)}</td>
                  <td className={cx('px-2 py-1.5 text-right tabular-nums', x.profit < 0 && 'text-red-600')}>{money(x.profit, cur, true)}</td>
                  <td className="px-4 py-1.5 text-right tabular-nums">{x.marginPct != null ? `${x.marginPct}%` : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Key clients (12 months)">
          <ul className="space-y-1.5 text-sm">{c.key.map((x: any) => (
            <li key={x.id} className="flex justify-between gap-2"><Link to={`/r/clients/${x.id}`} className="truncate hover:underline">{x.name}</Link><span className="shrink-0 tabular-nums">{money(x.revenue, cur, true)}</span></li>
          ))}</ul>
        </Card>
        <Card title="Major projects">
          <ul className="space-y-1.5 text-sm">{p.major.map((x: any) => (
            <li key={x.id} className="flex items-center justify-between gap-2"><Link to={`/r/projects/${x.id}`} className="truncate hover:underline">{x.name}</Link><span className="flex shrink-0 items-center gap-2"><span className="w-12 text-right text-xs tabular-nums">{x.progressPct}%</span><StatusBadge value={x.status} /></span></li>
          ))}</ul>
        </Card>
        <Card title="Strategic initiatives">
          {!strategy.initiatives.length ? <p className="text-sm text-slate-500">None.</p> : (
            <ul className="space-y-2 text-sm">{strategy.initiatives.map((i: any) => (
              <li key={i.id}><div className="flex justify-between gap-2"><Link to={`/r/initiatives/${i.id}`} className="truncate hover:underline">{i.title}</Link><StatusBadge value={i.status} /></div><Progress value={i.progressPct} /></li>
            ))}</ul>
          )}
        </Card>
        <Card title="Risk overview">
          {!strategy.risks.length ? <p className="text-sm text-slate-500">No open company risks.</p> : (
            <ul className="space-y-1.5 text-sm">{strategy.risks.map((r: any) => (
              <li key={r.id} className="flex justify-between gap-2"><Link to={`/r/company_risks/${r.id}`} className="truncate hover:underline">{r.title}</Link><Badge tone={r.impact === 'critical' || r.impact === 'high' ? 'red' : 'amber'}>{r.impact}</Badge></li>
            ))}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
DASHBOARDS.ceo = CEODashboard;

// ───────────── Reports page ─────────────

const csvCell = (v: unknown) => {
  let s = v === null || v === undefined ? '' : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function downloadCsv(name: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]);
  const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\r\n');
  const url = URL.createObjectURL(new Blob(['﻿' + csv], { type: 'text/csv' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${name}-${today()}.csv` });
  a.click();
  URL.revokeObjectURL(url);
}

function Table({ rows, cols, name }: { rows: any[]; cols: [string, string, ((v: any, r: any) => ReactNode)?][]; name: string }) {
  if (!rows?.length) return <EmptyState title="No data for this period" />;
  return (
    <div>
      <div className="mb-2 flex justify-end"><Button size="sm" onClick={() => downloadCsv(name, rows)}><Download className="size-3.5" /> CSV</Button></div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500">{cols.map(([k, l]) => <th key={k} className="px-2 py-1.5">{l}</th>)}</tr></thead>
          <tbody>{rows.map((r, i) => <tr key={i} className="border-b border-slate-100 last:border-0">{cols.map(([k, , f]) => <td key={k} className="px-2 py-1.5 tabular-nums">{f ? f(r[k], r) : r[k] ?? '—'}</td>)}</tr>)}</tbody>
        </table>
      </div>
    </div>
  );
}

function ReportBody({ k, d }: { k: string; d: any }) {
  const { settings } = useMeta();
  const m = (v: any) => money(v, settings.baseCurrency);
  const pct = (v: any) => (v == null ? '—' : `${v}%`);
  switch (k) {
    case 'financial': return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Revenue" value={m(d.pnl.revenue)} /><Stat label="Collected" value={m(d.pnl.collected)} /><Stat label="Expenses" value={m(d.pnl.expenses)} />
          <Stat label="Payroll" value={m(d.pnl.payroll)} /><Stat label="Profit" value={m(d.pnl.profit)} tone={d.pnl.profit < 0 ? 'red' : 'green'} hint={pct(d.pnl.marginPct)} />
        </div>
        <Card title="Monthly revenue vs costs"><Table name="monthly" rows={d.series} cols={[['month', 'Month'], ['revenue', 'Revenue', m], ['costs', 'Costs', m], ['profit', 'Profit', m]]} /></Card>
        <Card title="Expenses by category"><Table name="expenses-by-category" rows={Object.entries(d.pnl.expensesByCategory).map(([category, amount]) => ({ category, amount }))} cols={[['category', 'Category', humanize], ['amount', 'Amount', m]]} /></Card>
      </div>
    );
    case 'profitability': return (
      <div className="space-y-4">
        <Card title="Project profitability (revenue − employee − infrastructure − other)"><Table name="project-profitability" rows={d.projects} cols={[['code', 'Code'], ['name', 'Project'], ['clientName', 'Client'], ['revenue', 'Revenue', m], ['employeeCost', 'Employee cost', m], ['infrastructureCost', 'Infrastructure', m], ['otherExpenses', 'Other', m], ['profit', 'Profit', m], ['marginPct', 'Margin', pct], ['hours', 'Hours'], ['effectiveRate', 'Rev / hour', m]]} /></Card>
        <Card title="Client profitability"><Table name="client-profitability" rows={d.clients} cols={[['name', 'Client'], ['health', 'Health', (v) => <StatusBadge value={v} />], ['revenue', 'Revenue', m], ['employee_cost', 'Employee cost', m], ['direct_cost', 'Direct cost', m], ['profit', 'Profit', m], ['marginPct', 'Margin', pct], ['outstanding', 'Outstanding', m]]} /></Card>
      </div>
    );
    case 'sales': return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="New leads" value={d.summary.newLeads} /><Stat label="Lead conversion" value={pct(d.summary.leadConversionPct)} /><Stat label="Won" value={d.summary.wonCount} hint={m(d.summary.wonValue)} />
          <Stat label="Lost" value={d.summary.lostCount} /><Stat label="Win rate" value={pct(d.summary.winRatePct)} />
        </div>
        <Card title="Pipeline by stage"><SimpleBars data={d.pipeline} x="name" y="value" format={(v) => money(v, settings.baseCurrency, true)} /></Card>
        <Card title="Leads & conversion by source"><Table name="leads-by-source" rows={d.bySource} cols={[['source', 'Source', humanize], ['leads', 'Leads'], ['converted', 'Converted'], ['won_value', 'Won value', m]]} /></Card>
        <Card title="Results by salesperson"><Table name="sales-by-owner" rows={d.byOwner} cols={[['name', 'Salesperson'], ['won', 'Won'], ['lost', 'Lost'], ['won_value', 'Won value', m]]} /></Card>
      </div>
    );
    case 'projects': return (
      <Card title="Delivery: timeline variance, completion, scope changes, delays and rework">
        <Table name="projects" rows={d.projects} cols={[['code', 'Code'], ['name', 'Project', (v, r) => <Link to={`/r/projects/${r.id}`} className="hover:underline">{v}</Link>], ['status', 'Status', (v) => <StatusBadge value={v} />], ['due_date', 'Due', date],
          ['variance_days', 'Variance (days)', (v) => (v == null ? '—' : <span className={v > 0 ? 'text-red-600' : 'text-emerald-700'}>{v > 0 ? `+${v}` : v}</span>)], ['done', 'Done', (v, r) => `${v}/${r.tasks}`],
          ['overdue_tasks', 'Internal delays (overdue tasks)'], ['client_delays', 'Client delays'], ['scope_changes', 'Scope changes'], ['scope_hours', '+Hours'], ['rework', 'Rework']]} />
      </Card>
    );
    case 'utilization': return (
      <Card title="Hours logged vs capacity"><Table name="utilization" rows={d.rows} cols={[['name', 'Person'], ['hours', 'Hours', (v) => num(v, 1)], ['billableHours', 'Billable', (v) => num(v, 1)], ['capacityHours', 'Capacity'], ['utilizationPct', 'Utilization', pct], ['billablePct', 'Billable %', pct]]} /></Card>
    );
    case 'hr': return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Attrition (12m)" value={pct(d.attritionPct)} /><Stat label="Present days" value={d.attendance.present} /><Stat label="Late arrivals" value={d.attendance.late} />
          <Stat label="Absences" value={d.attendance.absent} /><Stat label="Reviews completed" value={`${d.reviews.completed}/${d.reviews.total}`} hint={d.reviews.avg_rating ? `avg rating ${d.reviews.avg_rating}` : undefined} />
        </div>
        <Card title="Headcount by department"><SimpleBars horizontal data={d.byDepartment} x="department" y="headcount" height={Math.max(160, d.byDepartment.length * 28)} /></Card>
        <Card title="Hires and exits by month"><Table name="hires-exits" rows={d.movement} cols={[['month', 'Month'], ['hires', 'Hires'], ['exits', 'Exits']]} /></Card>
      </div>
    );
    case 'technical': return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
          <Stat label="QA runs" value={d.qa.runs} /><Stat label="QA pass rate" value={d.qa.total ? `${Math.round((d.qa.pass / d.qa.total) * 100)}%` : '—'} />
          <Stat label="Deployments" value={d.deployments.reduce((a: number, x: any) => a + x.n, 0)} /><Stat label="Failed deployments" value={d.deployments.filter((x: any) => ['failed', 'rolled_back'].includes(x.status)).reduce((a: number, x: any) => a + x.n, 0)} />
        </div>
        <Card title="Bugs by severity"><Table name="bugs" rows={d.bugsBySeverity} cols={[['severity', 'Severity', (v) => <StatusBadge value={v} />], ['open', 'Open'], ['reported', 'Reported in period']]} /></Card>
        <Card title="Developer quality (not raw task counts)"><Table name="developer-performance" rows={d.developers} cols={[['name', 'Developer'], ['completed', 'Tasks done'], ['estimatedHours', 'Estimated h'], ['actualHours', 'Actual h'], ['estimateAccuracyPct', 'Estimate accuracy', pct], ['onTimePct', 'On time', pct], ['reworkPct', 'Rework', pct], ['qaRejectionRatePct', 'QA rejection', pct]]} /></Card>
      </div>
    );
    case 'support': return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
          <Stat label="Tickets" value={d.summary.tickets} /><Stat label="Resolved" value={d.summary.resolved} /><Stat label="SLA compliance" value={d.summary.tickets ? `${Math.round(((d.summary.tickets - d.summary.breached) / d.summary.tickets) * 100)}%` : '—'} />
          <Stat label="Avg resolution" value={d.summary.avg_resolution_hours != null ? `${d.summary.avg_resolution_hours}h` : '—'} /><Stat label="Satisfaction" value={d.summary.satisfaction ?? '—'} />
        </div>
        <Card title="By priority"><Table name="tickets-by-priority" rows={d.byPriority} cols={[['priority', 'Priority', (v) => <StatusBadge value={v} />], ['n', 'Tickets'], ['breached', 'SLA breached']]} /></Card>
      </div>
    );
    case 'departments': return (
      <Card title="Department KPIs — latest value vs target">
        <Table name="kpis" rows={d.kpis} cols={[['department', 'Department'], ['name', 'KPI'], ['latest', 'Latest', (v, r) => (v == null ? '—' : `${num(v, 1)} ${r.unit ?? ''}`)], ['previous', 'Previous', (v) => (v == null ? '—' : num(v, 1))], ['target', 'Target', (v) => (v == null ? '—' : num(v, 1))],
          ['direction', 'Status', (_v, r) => r.latest == null || r.target == null ? '—' : (r.direction === 'lower_is_better' ? Number(r.latest) <= Number(r.target) : Number(r.latest) >= Number(r.target)) ? <Badge tone="green">On target</Badge> : <Badge tone="amber">Below target</Badge>]]} />
      </Card>
    );
    default: return null;
  }
}

function ReportsPage() {
  const list = useQuery({ queryKey: ['reports'], queryFn: () => api.get<{ key: string; label: string }[]>('/api/reports') });
  const [active, setActive] = useState<string | null>(null);
  const [from, setFrom] = useState(new Date(Date.now() - 89 * 86400_000).toISOString().slice(0, 10));
  const [to, setTo] = useState(today());
  const key = active ?? list.data?.[0]?.key;
  const rep = useQuery({ queryKey: ['report', key, from, to], queryFn: () => api.get<any>(`/api/reports/${key}${qs({ from, to })}`), enabled: !!key });
  if (list.isLoading) return <Spinner />;
  if (!list.data?.length) return <ErrorState error={{ status: 403, message: 'No reports are available for your role.' }} />;
  return (
    <>
      <PageHeader title="Reports" subtitle="Every figure comes from the same shared data and calculations used across the system."
        actions={<div className="flex items-center gap-1 text-sm"><input aria-label="From" type="date" className="input w-auto py-1" value={from} onChange={(e) => setFrom(e.target.value)} /><span>–</span><input aria-label="To" type="date" className="input w-auto py-1" value={to} onChange={(e) => setTo(e.target.value)} /></div>} />
      <div className="mb-4"><Tabs active={key!} onChange={setActive} tabs={list.data.map((r) => ({ key: r.key, label: r.label }))} /></div>
      {rep.isLoading ? <Spinner /> : rep.isError ? <ErrorState error={rep.error} /> : rep.data && <ReportBody k={rep.data.key} d={rep.data.data} />}
    </>
  );
}
EXTRA_ROUTES.push({ path: 'reports', component: ReportsPage });
