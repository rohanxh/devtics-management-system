import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { api } from '../lib/api';
import { date, humanize, money } from '../lib/format';
import { useMeta } from '../lib/meta';
import { Card, ErrorState, PageHeader, Spinner, Stat, StatusBadge, cx } from '../components/ui';
import { SimpleBars } from '../components/charts';
import { DASHBOARDS, greeting } from '../pages/Home';

function MarketingDashboard() {
  const { user, settings } = useMeta();
  const q = useQuery({ queryKey: ['dashboard', 'marketing'], queryFn: () => api.get<any>('/api/dashboard/marketing') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Leads, campaigns, organic growth and the content pipeline." />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Leads (month)" value={d.leadsMonth} />
        <Stat label="Lead → client (90d)" value={d.conversionPct != null ? `${d.conversionPct}%` : '—'} />
        <Stat label="Active campaigns" value={d.activeCampaigns} />
        <Stat label="Organic growth (MoM)" value={d.organicGrowthPct != null ? `${d.organicGrowthPct > 0 ? '+' : ''}${d.organicGrowthPct}%` : '—'} tone={d.organicGrowthPct < 0 ? 'red' : d.organicGrowthPct > 0 ? 'green' : undefined} />
        <Stat label="Content in progress" value={d.contentInProgress} hint={d.dueContent.length ? `${d.dueContent.length} overdue` : undefined} tone={d.dueContent.length ? 'amber' : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Leads generated per month"><SimpleBars data={d.series} x="month" y="leads" height={200} /></Card>
        <Card title="Organic sessions per month"><SimpleBars data={d.series} x="month" y="organic" height={200} /></Card>
        <Card title="Lead sources (90 days)"><SimpleBars horizontal data={d.bySource.map((s: any) => ({ source: humanize(s.source), leads: s.n }))} x="source" y="leads" height={Math.max(150, d.bySource.length * 28)} /></Card>
        <Card title="Campaigns" className="xl:col-span-2" bodyClass="p-0">
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="px-4 py-2">Campaign</th><th className="px-2 py-2">Status</th><th className="px-2 py-2 text-right">Spend</th><th className="px-2 py-2 text-right">Leads</th><th className="px-2 py-2 text-right">Cost / lead</th><th className="px-4 py-2 text-right">Converted</th></tr></thead>
            <tbody>{d.campaigns.map((c: any) => (
              <tr key={c.id} className="border-b border-slate-100 last:border-0">
                <td className="px-4 py-1.5"><Link to={`/r/campaigns/${c.id}`} className="hover:underline">{c.name}</Link><div className="text-xs text-slate-500">{humanize(c.channel)}</div></td>
                <td className="px-2 py-1.5"><StatusBadge value={c.status} /></td>
                <td className="px-2 py-1.5 text-right tabular-nums">{money(c.spend, settings.baseCurrency, true)}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.leads}</td>
                <td className="px-2 py-1.5 text-right tabular-nums">{c.leads ? money(Number(c.spend) / c.leads, settings.baseCurrency) : '—'}</td>
                <td className="px-4 py-1.5 text-right tabular-nums">{c.converted}</td>
              </tr>
            ))}</tbody>
          </table>
          {!d.campaigns.length && <p className="p-4 text-sm text-slate-500">No campaigns.</p>}
        </Card>
        <Card title="Keyword movers">
          {!d.movers.length ? <p className="text-sm text-slate-500">Record ranking checks to see movement.</p> : (
            <ul className="space-y-1.5 text-sm">{d.movers.map((k: any) => {
              const up = (k.currentPosition ?? 999) < k.previousPosition;
              return (
                <li key={k.id} className="flex items-center gap-2">
                  <Link to={`/r/seo_keywords/${k.id}`} className="flex-1 truncate hover:underline">{k.keyword}</Link>
                  <span className={cx('inline-flex items-center gap-0.5 text-xs tabular-nums', up ? 'text-emerald-700' : 'text-red-600')}>
                    {up ? <ArrowUp className="size-3" /> : <ArrowDown className="size-3" />}{k.previousPosition} → {k.currentPosition ?? '—'}
                  </span>
                </li>
              );
            })}</ul>
          )}
        </Card>
        <Card title="Content pipeline" className="xl:col-span-2"><SimpleBars data={d.pipeline} x="name" y="n" height={200} /></Card>
        <Card title="Overdue content">
          {!d.dueContent.length ? <p className="text-sm text-slate-500">Nothing overdue.</p> : (
            <ul className="space-y-1 text-sm">{d.dueContent.map((c: any) => <li key={c.id} className="flex justify-between gap-2"><Link to={`/r/content_items/${c.id}`} className="truncate hover:underline">{c.title}</Link><span className="text-xs text-red-600">{date(c.dueDate)}</span></li>)}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
DASHBOARDS.marketing = MarketingDashboard;
