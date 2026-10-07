import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ShieldAlert } from 'lucide-react';
import { api } from '../lib/api';
import { date, humanize, isOverdue, money } from '../lib/format';
import { useMeta } from '../lib/meta';
import { Badge, Card, ErrorState, PageHeader, Spinner, Stat, cx } from '../components/ui';
import { DASHBOARDS, greeting } from '../pages/Home';
import { ApprovalsList } from '../pages/Inbox';

function ITDashboard() {
  const { user, settings } = useMeta();
  const q = useQuery({ queryKey: ['dashboard', 'it'], queryFn: () => api.get<any>('/api/dashboard/it') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const s = d.byStatus;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Equipment, software, infrastructure and access." />
      {(d.leaverAccess.length > 0 || d.leaverDevices.length > 0) && (
        <div role="alert" className="mb-4 flex gap-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          <ShieldAlert className="mt-0.5 size-4 shrink-0" />
          <div>
            <b>Offboarding incomplete:</b> {d.leaverAccess.length} active access record(s) and {d.leaverDevices.length} device(s) still held by people who have left.
            <ul className="mt-1 list-disc pl-5">
              {d.leaverAccess.slice(0, 6).map((g: any) => <li key={g.id}><Link className="underline" to={`/r/access_grants/${g.id}`}>{g.name}: {g.systemName}{g.accountIdentifier ? ` (${g.accountIdentifier})` : ''}</Link></li>)}
              {d.leaverDevices.slice(0, 6).map((a: any) => <li key={a.id}><Link className="underline" to={`/r/assets/${a.id}`}>{a.name}: {a.tag}</Link></li>)}
            </ul>
          </div>
        </div>
      )}
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Assigned devices" value={s.assigned ?? 0} />
        <Stat label="In stock" value={s.in_stock ?? 0} />
        <Stat label="In repair" value={s.in_repair ?? 0} tone={s.in_repair ? 'amber' : undefined} />
        <Stat label="SaaS spend / month" value={money(d.monthlySpend, settings.baseCurrency, true)} />
        <Stat label="Renewals (45d)" value={d.renewals.length} />
        <Stat label="Expiring infra (45d)" value={d.expiring.length} tone={d.expiring.some((x: any) => isOverdue(x.expiresOn)) ? 'red' : d.expiring.length ? 'amber' : undefined} />
        <Stat label="Active access records" value={d.activeGrants} hint={`${d.pendingGrants} pending`} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Domains, SSL, hosting — expiring" className="xl:col-span-2">
          {!d.expiring.length ? <p className="text-sm text-slate-500">Nothing expiring in the next 45 days.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.expiring.map((r: any) => (
              <li key={r.id} className="flex items-center gap-3 py-1.5">
                <Link to={`/r/infra_resources/${r.id}`} className="flex-1 truncate hover:underline">{r.name}</Link>
                <Badge>{humanize(r.kind)}</Badge>
                <span className="text-xs text-slate-500">{r.provider}</span>
                <span className={cx('w-24 text-right text-xs', isOverdue(r.expiresOn) ? 'font-medium text-red-600' : 'text-amber-700')}>{date(r.expiresOn)}</span>
                {r.autoRenew ? <Badge tone="green">auto</Badge> : <Badge tone="amber">manual</Badge>}
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
        <Card title="Software renewals" className="xl:col-span-2">
          {!d.renewals.length ? <p className="text-sm text-slate-500">No renewals soon.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.renewals.map((r: any) => (
              <li key={r.id} className="flex items-center gap-3 py-1.5">
                <Link to={`/r/subscriptions/${r.id}`} className="flex-1 truncate hover:underline">{r.name}</Link>
                <span className="text-xs text-slate-500">{r.seatsUsed}/{r.seatsTotal ?? '∞'} seats</span>
                <span className="w-24 text-right tabular-nums">{r.cost ? money(r.cost, r.currency) : '—'}</span>
                <span className="w-24 text-right text-xs text-slate-500">{date(r.renewalDate)}</span>
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Unused seats">
          {!d.seatWaste.length ? <p className="text-sm text-slate-500">All seats in use.</p> : (
            <ul className="space-y-1 text-sm">{d.seatWaste.map((x: any) => <li key={x.id} className="flex justify-between"><Link to={`/r/subscriptions/${x.id}`} className="hover:underline">{x.name}</Link><span className="text-xs text-amber-700">{x.seatsTotal - x.seatsUsed} unused</span></li>)}</ul>
          )}
        </Card>
        <Card title="Devices by type">
          <ul className="space-y-1 text-sm">{d.byKind.map((k: any) => <li key={k.kind} className="flex justify-between"><span>{humanize(k.kind)}</span><span className="tabular-nums">{k.n}</span></li>)}</ul>
        </Card>
      </div>
    </>
  );
}
DASHBOARDS.it = ITDashboard;
