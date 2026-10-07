import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowRightCircle } from 'lucide-react';
import { api } from '../lib/api';
import { date, humanize, isOverdue, money } from '../lib/format';
import { useMeta } from '../lib/meta';
import { registerActions } from '../lib/extensions';
import { Badge, Button, Card, ErrorState, Field, Modal, PageHeader, Progress, Spinner, Stat, StatusBadge, cx } from '../components/ui';
import { SimpleBars } from '../components/charts';
import { useToast } from '../components/toast';
import { DASHBOARDS, greeting } from '../pages/Home';

function LeadActions({ record }: { record: any; reload: () => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(record.title);
  const [value, setValue] = useState(record.estimatedValue ?? '');
  const [close, setClose] = useState('');
  const navigate = useNavigate();
  const toast = useToast();
  const qc = useQueryClient();
  const meta = useMeta();
  const convert = useMutation({
    mutationFn: () => api.post(`/api/sales/leads/${record.id}/convert`, { opportunityName: name, value: value || undefined, expectedCloseDate: close || undefined }),
    onSuccess: (opp: any) => { toast.success('Lead converted to an opportunity'); qc.invalidateQueries(); navigate(`/r/opportunities/${opp.id}`); },
    onError: toast.error,
  });
  if (record.status !== 'qualified' || !meta.resources.opportunities?.can.create || !record._can?.edit) return null;
  return (
    <>
      <Button variant="primary" onClick={() => setOpen(true)}><ArrowRightCircle className="size-3.5" /> Convert to opportunity</Button>
      <Modal open={open} onClose={() => setOpen(false)} title="Convert lead"
        footer={<><Button onClick={() => setOpen(false)}>Cancel</Button><Button variant="primary" loading={convert.isPending} onClick={() => convert.mutate()}>Convert</Button></>}>
        <p className="mb-3 text-sm text-slate-600">Creates (or reuses) the company <b>{record.companyName ?? record._labels?.companyId}</b>, a contact, and an opportunity in Discovery.</p>
        <div className="space-y-3">
          <Field label="Opportunity name" htmlFor="cv-n"><input id="cv-n" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Value" htmlFor="cv-v"><input id="cv-v" type="number" className="input" value={value} onChange={(e) => setValue(e.target.value)} /></Field>
            <Field label="Expected close" htmlFor="cv-c"><input id="cv-c" type="date" className="input" value={close} onChange={(e) => setClose(e.target.value)} /></Field>
          </div>
        </div>
      </Modal>
    </>
  );
}
registerActions('leads', LeadActions);

function BDDashboard() {
  const { user, settings } = useMeta();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const q = useQuery({ queryKey: ['dashboard', 'bd', scope], queryFn: () => api.get<any>(`/api/dashboard/bd?scope=${scope}`) });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const cur = settings.baseCurrency;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Pipeline, follow-ups and this month’s results."
        actions={<div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm">
          {(['mine', 'all'] as const).map((s) => <button key={s} type="button" onClick={() => setScope(s)} className={cx('rounded px-2.5 py-1', scope === s && 'bg-slate-100 font-medium')}>{s === 'mine' ? 'My pipeline' : 'Team pipeline'}</button>)}
        </div>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="New leads (month)" value={d.month.newLeads} />
        <Stat label="Follow-ups due" value={d.followUpsDue.length} tone={d.followUpsDue.some((f: any) => isOverdue(f.dueDate)) ? 'red' : undefined} />
        <Stat label="Active opportunities" value={d.openCount} />
        <Stat label="Proposals" value={d.proposals} />
        <Stat label="Negotiations" value={d.negotiations} />
        <Stat label="Won (month)" value={d.month.wonCount} hint={money(d.month.wonValue, cur, true)} tone="green" />
        <Stat label="Lost (month)" value={d.month.lostCount} hint={d.month.winRatePct != null ? `${d.month.winRatePct}% win rate` : undefined} />
        <Stat label="Pipeline value" value={money(d.pipelineValue, cur, true)} hint={`${money(d.weightedValue, cur, true)} weighted`} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title="Open pipeline value by stage">
          <SimpleBars data={d.pipeline.filter((s: any) => s.key !== 'lost')} x="name" y="value" format={(v) => money(v, cur, true)} />
        </Card>
        <Card title="Sales target">
          {!d.target ? <p className="text-sm text-slate-500">No active target for this period.</p> : (
            <div className="space-y-2">
              <div className="flex items-baseline justify-between"><span className="text-2xl font-semibold tabular-nums">{money(d.target.achieved, cur, true)}</span><span className="text-sm text-slate-500">of {money(d.target.targetAmount, cur, true)}</span></div>
              <Progress value={d.target.pct} tone={d.target.pct >= 100 ? 'green' : undefined} />
              <p className="text-xs text-slate-500">{d.target.pct}% · {date(d.target.periodStart)} – {date(d.target.periodEnd)}</p>
            </div>
          )}
        </Card>
        <Card title="Deals closing soon" className="xl:col-span-2">
          <ul className="divide-y divide-slate-100 text-sm">{d.hot.map((o: any) => (
            <li key={o.id} className="flex items-center gap-3 py-1.5">
              <Link to={`/r/opportunities/${o.id}`} className="flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{o.number}</span> {o.name}</Link>
              <Badge stageColor={o.stageColor}>{o.stageName}</Badge>
              <span className="w-24 text-right tabular-nums">{money(o.value, cur)}</span>
              <span className={cx('w-24 text-right text-xs', isOverdue(o.expectedCloseDate) ? 'text-red-600' : 'text-slate-500')}>{date(o.expectedCloseDate)}</span>
            </li>
          ))}</ul>
          {!d.hot.length && <p className="text-sm text-slate-500">No open deals.</p>}
        </Card>
        <Card title="My follow-ups (next 7 days)">
          {!d.followUpsDue.length ? <p className="text-sm text-slate-500">Nothing scheduled.</p> : (
            <ul className="space-y-1.5 text-sm">{d.followUpsDue.map((f: any) => (
              <li key={f.id} className="flex items-center justify-between gap-2">
                <Link to={`/r/follow_ups/${f.id}`} className="truncate hover:underline">{f.title}</Link>
                <span className={cx('shrink-0 text-xs', isOverdue(f.dueDate) ? 'font-medium text-red-600' : 'text-slate-500')}>{date(f.dueDate)}</span>
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="New leads to work" className="xl:col-span-3">
          <ul className="grid grid-cols-1 gap-x-6 gap-y-1.5 text-sm md:grid-cols-2">{d.newLeads.map((l: any) => (
            <li key={l.id} className="flex items-center gap-2">
              <Link to={`/r/leads/${l.id}`} className="flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{l.number}</span> {l.title}</Link>
              <Badge>{humanize(l.source)}</Badge><StatusBadge value={l.status} />
            </li>
          ))}</ul>
          {!d.newLeads.length && <p className="text-sm text-slate-500">No new leads.</p>}
        </Card>
      </div>
    </>
  );
}
DASHBOARDS.bd = BDDashboard;
