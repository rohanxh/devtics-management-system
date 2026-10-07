import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertTriangle, Bug, ListPlus } from 'lucide-react';
import { api } from '../lib/api';
import { ago, datetime } from '../lib/format';
import { useCan, useMeta } from '../lib/meta';
import { registerActions } from '../lib/extensions';
import { Button, Card, ErrorState, Field, Modal, PageHeader, Progress, Spinner, Stat, StatusBadge, cx } from '../components/ui';
import { RefSelect } from '../components/fields';
import { SimpleBars } from '../components/charts';
import { useToast } from '../components/toast';
import { DASHBOARDS, greeting } from '../pages/Home';
import { humanize } from '../lib/format';

function TicketActions({ record, reload }: { record: any; reload: () => void }) {
  const can = useCan();
  const toast = useToast();
  const [kind, setKind] = useState<null | 'task' | 'bug'>(null);
  const [assigneeId, setAssignee] = useState<string | null>(null);
  const esc = useMutation({
    mutationFn: () => api.post<any>(`/api/support/tickets/${record.id}/escalate`, { kind, assigneeId }),
    onSuccess: (w) => { toast.success(`${w.number} created and linked`); setKind(null); reload(); },
    onError: toast.error,
  });
  if (!record._can?.edit || record.taskId || record.bugId || ['resolved', 'closed'].includes(record.status)) return null;
  return (
    <>
      {can('tasks.create') && <Button onClick={() => setKind('task')}><ListPlus className="size-3.5" /> Send to development</Button>}
      {can('bugs.create') && <Button onClick={() => setKind('bug')}><Bug className="size-3.5" /> Log as bug</Button>}
      <Modal open={!!kind} onClose={() => setKind(null)} title={kind === 'bug' ? 'Log ticket as a bug' : 'Create development task'}
        footer={<><Button onClick={() => setKind(null)}>Cancel</Button><Button variant="primary" loading={esc.isPending} onClick={() => esc.mutate()}>Create & link</Button></>}>
        <p className="mb-3 text-sm text-slate-600">{record.projectId ? 'The work item is created in the ticket’s project; the ticket follows its progress automatically (development → QA → resolved).' : 'Link this ticket to a project first.'}</p>
        <Field label="Assign to" htmlFor="esc-a"><RefSelect id="esc-a" refKey="users" value={assigneeId} onChange={setAssignee} /></Field>
      </Modal>
    </>
  );
}
registerActions('tickets', TicketActions);

function SupportDashboard() {
  const { user } = useMeta();
  const q = useQuery({ queryKey: ['dashboard', 'support'], queryFn: () => api.get<any>('/api/dashboard/support') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const c = d.counts;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Ticket queue, SLAs and maintenance plan usage."
        actions={<Link to="/r/tickets" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Tickets</Link>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Open tickets" value={c.open} />
        <Stat label="Urgent" value={c.urgent} tone={c.urgent ? 'red' : undefined} />
        <Stat label="SLA breaches" value={c.breached} tone={c.breached ? 'red' : undefined} />
        <Stat label="Waiting for client" value={c.waiting} />
        <Stat label="Assigned to me" value={c.mine} />
        <Stat label="Unassigned" value={c.unassigned} tone={c.unassigned ? 'amber' : undefined} />
        <Stat label="Resolved (7d)" value={c.resolved7} hint={`avg ${d.avgResolutionHours}h to resolve`} tone="green" />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Queue (breaches first, then by resolution due)" className="xl:col-span-2" bodyClass="p-0">
          <ul className="divide-y divide-slate-100 text-sm">{d.queue.map((t: any) => (
            <li key={t.id} className="flex items-center gap-3 px-4 py-2">
              {t.slaBreached ? <AlertTriangle className="size-4 text-red-600" aria-label="SLA breached" /> : <span className="size-4" />}
              <Link to={`/r/tickets/${t.id}`} className="min-w-0 flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{t.number}</span> {t.title}<span className="ml-2 text-xs text-slate-500">{t.client}</span></Link>
              <StatusBadge value={t.priority} />
              <StatusBadge value={t.status} />
              <span className={cx('w-28 text-right text-xs', t.slaBreached ? 'font-medium text-red-600' : 'text-slate-500')} title={datetime(t.resolutionDueAt)}>
                {t.resolutionDueAt ? (new Date(t.resolutionDueAt) < new Date() ? `due ${ago(t.resolutionDueAt)}` : `due ${datetime(t.resolutionDueAt)}`) : '—'}
              </span>
            </li>
          ))}</ul>
          {!d.queue.length && <p className="p-4 text-sm text-slate-500">Queue is empty. 🎉</p>}
        </Card>
        <Card title="Open tickets by status"><SimpleBars horizontal data={d.byStatus.map((s: any) => ({ status: humanize(s.status), n: s.n }))} x="status" y="n" height={Math.max(150, d.byStatus.length * 30)} /></Card>
        <Card title="Maintenance plans — hours this month" className="xl:col-span-3">
          {!d.plans.length ? <p className="text-sm text-slate-500">No active plans.</p> : (
            <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">{d.plans.map((p: any) => {
              const pct = p.monthlyHours ? (p.used / p.monthlyHours) * 100 : 0;
              return (
                <li key={p.id} className="rounded border border-slate-200 p-3">
                  <Link to={`/r/maintenance_plans/${p.id}`} className="text-sm font-medium hover:underline">{p.name}</Link>
                  <div className="my-1.5"><Progress value={pct} tone={pct >= 100 ? 'red' : pct >= 80 ? 'amber' : undefined} /></div>
                  <div className="text-xs text-slate-500">{p.used}h of {p.monthlyHours}h used · {Math.max(0, Math.round((p.monthlyHours - p.used) * 10) / 10)}h remaining</div>
                </li>
              );
            })}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
DASHBOARDS.support = SupportDashboard;
