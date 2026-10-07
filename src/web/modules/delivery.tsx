import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { AlertTriangle, CheckCircle2, Circle, Clock, Play, Send } from 'lucide-react';
import { api, ApiError } from '../lib/api';
import { date, humanize, isOverdue, today } from '../lib/format';
import { useCan, useMeta, useResource } from '../lib/meta';
import { EXTRA_ROUTES, registerActions, registerPanel } from '../lib/extensions';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, Progress, Spinner, Stat, StatusBadge, Tabs, cx } from '../components/ui';
import { RefSelect, StageBadge } from '../components/fields';
import { SimpleBars } from '../components/charts';
import { useToast } from '../components/toast';
import { DASHBOARDS, greeting } from '../pages/Home';
import { ApprovalsList } from '../pages/Inbox';
import { EngineeringSection } from './engineering';
import { MyAttendanceCard } from './hr';

// ───────────── Time logging ─────────────

export function LogTimeModal({ open, onClose, task, projectId }: { open: boolean; onClose: () => void; task?: any; projectId?: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [hours, setHours] = useState('1');
  const [workDate, setWorkDate] = useState(today());
  const [description, setDescription] = useState('');
  const [billable, setBillable] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save = useMutation({
    mutationFn: () => api.post('/api/r/time_entries', {
      taskId: task?.id, projectId: task?.projectId ?? projectId, workDate, minutes: Math.round(Number(hours) * 60), description, billable,
    }),
    onSuccess: () => { toast.success('Time logged'); qc.invalidateQueries({ queryKey: ['r', 'time_entries'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); onClose(); },
    onError: (e) => { if (e instanceof ApiError && e.details) setErrors(e.details); toast.error(e); },
  });
  return (
    <Modal open={open} onClose={onClose} title={task ? `Log time · ${task.number ?? ''}` : 'Log time'}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Log time</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label="Hours" htmlFor="lt-h" error={errors.minutes}><input id="lt-h" type="number" step="0.25" min="0.25" max="24" className="input" value={hours} onChange={(e) => setHours(e.target.value)} /></Field>
        <Field label="Date" htmlFor="lt-d" error={errors.workDate}><input id="lt-d" type="date" max={today()} className="input" value={workDate} onChange={(e) => setWorkDate(e.target.value)} /></Field>
        <div className="col-span-2"><Field label="What did you work on?" htmlFor="lt-desc"><input id="lt-desc" className="input" value={description} onChange={(e) => setDescription(e.target.value)} /></Field></div>
        <label className="col-span-2 inline-flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={billable} onChange={(e) => setBillable(e.target.checked)} /> Billable</label>
      </div>
    </Modal>
  );
}

// ───────────── Task quick actions ─────────────

const NEXT: Record<string, { to: string; label: string; icon: typeof Play }[]> = {
  todo: [{ to: 'in_progress', label: 'Start', icon: Play }],
  blocked: [{ to: 'in_progress', label: 'Unblock', icon: Play }],
  in_progress: [{ to: 'in_review', label: 'Request review', icon: Send }, { to: 'qa', label: 'Send to QA', icon: Send }, { to: 'done', label: 'Done', icon: CheckCircle2 }],
  in_review: [{ to: 'qa', label: 'Send to QA', icon: Send }, { to: 'done', label: 'Done', icon: CheckCircle2 }],
  qa: [{ to: 'done', label: 'Pass QA', icon: CheckCircle2 }, { to: 'in_progress', label: 'Reject', icon: AlertTriangle }],
  done: [{ to: 'in_progress', label: 'Reopen', icon: Play }],
};

function useTaskMove(onDone?: () => void) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/api/r/tasks/${id}`, { status }),
    onSuccess: (_r, v) => { toast.success(`Moved to ${humanize(v.status)}`); qc.invalidateQueries({ queryKey: ['r', 'tasks'] }); qc.invalidateQueries({ queryKey: ['dashboard'] }); onDone?.(); },
    onError: toast.error,
  });
}

function TaskActions({ record, reload }: { record: any; reload: () => void }) {
  const move = useTaskMove(reload);
  const [logging, setLogging] = useState(false);
  const canTime = 'time.create' in useMeta().user.permissions;
  if (!record._can?.edit) return canTime ? <><Button onClick={() => setLogging(true)}><Clock className="size-3.5" /> Log time</Button><LogTimeModal open={logging} onClose={() => setLogging(false)} task={record} /></> : null;
  return (
    <>
      {(NEXT[record.status] ?? []).map((n) => (
        <Button key={n.to} variant={n.to === 'done' ? 'primary' : 'secondary'} loading={move.isPending && move.variables?.status === n.to} onClick={() => move.mutate({ id: record.id, status: n.to })}>
          <n.icon className="size-3.5" /> {n.label}
        </Button>
      ))}
      {canTime && <Button onClick={() => setLogging(true)}><Clock className="size-3.5" /> Log time</Button>}
      <LogTimeModal open={logging} onClose={() => setLogging(false)} task={record} />
    </>
  );
}
registerActions('tasks', TaskActions);

// ───────────── Project onboarding & overview ─────────────

const STEPS = [
  { key: 'bd_handover', label: 'BD handover' }, { key: 'pm_review', label: 'PM review' }, { key: 'cto_review', label: 'CTO feasibility' },
  { key: 'development_kickoff', label: 'Kickoff' }, { key: 'completed', label: 'In delivery' },
];

function OnboardingPanel({ record, reload }: { record: any; reload: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['onboarding', record.id], queryFn: () => api.get<any>(`/api/projects/${record.id}/onboarding`) });
  const [notes, setNotes] = useState('');
  const [review, setReview] = useState<{ pmId: string | null; techLeadId: string | null; memberIds: string[]; dueDate: string; budgetHours: string; pmNotes: string }>({ pmId: null, techLeadId: null, memberIds: [], dueDate: '', budgetHours: '', pmNotes: '' });
  const [open, setOpen] = useState<null | 'handover' | 'review'>(null);
  const done = () => { qc.invalidateQueries({ queryKey: ['onboarding', record.id] }); qc.invalidateQueries({ queryKey: ['approvals'] }); reload(); setOpen(null); };
  const handover = useMutation({ mutationFn: () => api.post(`/api/onboarding/${q.data.id}/handover`, { handoverNotes: notes }), onSuccess: () => { toast.success('Handover submitted to PM review'); done(); }, onError: toast.error });
  const pmReview = useMutation({
    mutationFn: () => api.post(`/api/onboarding/${q.data.id}/pm-review`, { ...review, dueDate: review.dueDate || null, budgetHours: review.budgetHours || null }),
    onSuccess: () => { toast.success('Sent to CTO for technical feasibility'); done(); }, onError: toast.error,
  });
  const complete = useMutation({ mutationFn: () => api.post(`/api/onboarding/${q.data.id}/complete`), onSuccess: () => { toast.success('Project moved into delivery'); done(); }, onError: toast.error });
  if (!q.data || q.data.status === 'completed') return null;
  const o = q.data;
  const idx = STEPS.findIndex((s) => s.key === o.status);
  return (
    <Card title="Project onboarding" actions={
      <>
        {o.can.handover && <Button variant="primary" onClick={() => setOpen('handover')}>Submit handover</Button>}
        {o.can.pmReview && <Button variant="primary" onClick={() => setOpen('review')}>Complete PM review</Button>}
        {o.can.complete && <Button variant="primary" loading={complete.isPending} onClick={() => complete.mutate()}>Start delivery</Button>}
        {o.status === 'cto_review' && <Badge tone="amber">Waiting for CTO approval</Badge>}
      </>
    }>
      <ol className="flex flex-wrap items-center gap-2 text-sm">
        {STEPS.map((s, i) => (
          <li key={s.key} className="flex items-center gap-2">
            {i < idx ? <CheckCircle2 className="size-4 text-emerald-600" /> : i === idx ? <Circle className="size-4 fill-brand-100 text-brand-600" /> : <Circle className="size-4 text-slate-300" />}
            <span className={cx(i === idx ? 'font-medium text-slate-900' : 'text-slate-500')}>{s.label}</span>
            {i < STEPS.length - 1 && <span className="mx-1 h-px w-6 bg-slate-200" />}
          </li>
        ))}
      </ol>
      {(o.handoverNotes || o.pmNotes || o.ctoNotes) && (
        <div className="mt-3 grid grid-cols-1 gap-3 text-sm md:grid-cols-3">
          {o.handoverNotes && <div><div className="label">BD handover</div><p className="whitespace-pre-wrap text-slate-700">{o.handoverNotes}</p></div>}
          {o.pmNotes && <div><div className="label">PM notes</div><p className="whitespace-pre-wrap text-slate-700">{o.pmNotes}</p></div>}
          {o.ctoNotes && <div><div className="label">CTO notes</div><p className="whitespace-pre-wrap text-slate-700">{o.ctoNotes}</p></div>}
        </div>
      )}
      <Modal open={open === 'handover'} onClose={() => setOpen(null)} title="Client handover"
        footer={<><Button onClick={() => setOpen(null)}>Cancel</Button><Button variant="primary" loading={handover.isPending} onClick={() => handover.mutate()}>Submit to PM</Button></>}>
        <Field label="Scope, commitments, contacts, deadlines, risks" htmlFor="ho">
          <textarea id="ho" rows={10} className="input" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder="What was sold, what was promised, who the client contacts are, key dates and anything the delivery team must know." />
        </Field>
      </Modal>
      <Modal open={open === 'review'} onClose={() => setOpen(null)} title="PM review"
        footer={<><Button onClick={() => setOpen(null)}>Cancel</Button><Button variant="primary" loading={pmReview.isPending} disabled={!review.pmId} onClick={() => pmReview.mutate()}>Send to CTO</Button></>}>
        <div className="grid grid-cols-2 gap-3">
          <Field label="Project manager" required htmlFor="pr-pm"><RefSelect id="pr-pm" refKey="users" value={review.pmId} onChange={(v) => setReview({ ...review, pmId: v })} /></Field>
          <Field label="Tech lead" htmlFor="pr-tl"><RefSelect id="pr-tl" refKey="users" value={review.techLeadId} onChange={(v) => setReview({ ...review, techLeadId: v })} /></Field>
          <Field label="Target due date" htmlFor="pr-due"><input id="pr-due" type="date" className="input" value={review.dueDate} onChange={(e) => setReview({ ...review, dueDate: e.target.value })} /></Field>
          <Field label="Budget hours" htmlFor="pr-h"><input id="pr-h" type="number" className="input" value={review.budgetHours} onChange={(e) => setReview({ ...review, budgetHours: e.target.value })} /></Field>
          <div className="col-span-2">
            <Field label="Team members" htmlFor="pr-mem">
              <RefSelect id="pr-mem" refKey="users" value={null} placeholder="Add a team member…" onChange={(v) => v && !review.memberIds.includes(v) && setReview({ ...review, memberIds: [...review.memberIds, v] })} />
            </Field>
            <div className="mt-1 text-xs text-slate-500">{review.memberIds.length} member(s) selected</div>
          </div>
          <div className="col-span-2"><Field label="Review notes for the CTO" htmlFor="pr-n"><textarea id="pr-n" rows={4} className="input" value={review.pmNotes} onChange={(e) => setReview({ ...review, pmNotes: e.target.value })} /></Field></div>
        </div>
      </Modal>
    </Card>
  );
}
registerPanel('projects', { key: 'onboarding', label: 'Onboarding', component: OnboardingPanel, placement: 'top' });

function ProjectOverview({ record }: { record: any }) {
  const meta = useMeta();
  const statuses = ['todo', 'in_progress', 'in_review', 'qa', 'blocked', 'done'];
  const counts = useQuery({
    queryKey: ['r', 'tasks', 'counts', record.id],
    queryFn: async () => Object.fromEntries(await Promise.all(statuses.map(async (s) => [s, (await api.get(`/api/r/tasks?projectId=${record.id}&status=${s}&pageSize=1`)).total]))),
  });
  const milestones = useQuery({ queryKey: ['r', 'milestones', 'p', record.id], queryFn: () => api.get(`/api/r/milestones?projectId=${record.id}&sort=dueDate&pageSize=50`) });
  const time = useQuery({ queryKey: ['r', 'time_entries', 'p', record.id], queryFn: () => api.get(`/api/r/time_entries?projectId=${record.id}&pageSize=200`), enabled: 'time_entries' in meta.resources });
  const [logging, setLogging] = useState(false);
  if (!counts.data) return <Spinner />;
  const total = Object.values(counts.data as Record<string, number>).reduce((a, b) => a + b, 0);
  const done = (counts.data as any).done ?? 0;
  const hours = (time.data?.rows ?? []).reduce((a: number, r: any) => a + r.minutes / 60, 0);
  const budget = Number(record.budgetHours ?? 0);
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Task progress" value={`${total ? Math.round((done / total) * 100) : 0}%`} hint={`${done} of ${total} tasks done`} />
        <Stat label="Blocked" value={(counts.data as any).blocked} tone={(counts.data as any).blocked ? 'red' : undefined} />
        <Stat label="In QA" value={(counts.data as any).qa} />
        <Stat label="Hours logged" value={hours.toFixed(1)} hint={budget ? `of ${budget}h budget (${Math.round((hours / budget) * 100)}%)` : 'No hour budget set'} tone={budget && hours > budget ? 'red' : undefined} />
      </div>
      <div>
        <div className="mb-1 flex items-center justify-between text-xs text-slate-500"><span>Status: <StatusBadge value={record.status} /> · Stage: <StageBadge id={record.stageId} /></span><span>Due {date(record.dueDate)}</span></div>
        <Progress value={total ? (done / total) * 100 : 0} />
      </div>
      <div>
        <h3 className="mb-2 text-sm font-semibold">Milestones</h3>
        {!milestones.data?.rows.length ? <p className="text-sm text-slate-500">No milestones yet.</p> : (
          <ul className="divide-y divide-slate-100 rounded border border-slate-200">
            {milestones.data.rows.map((m: any) => (
              <li key={m.id} className="flex items-center gap-3 px-3 py-2 text-sm">
                <Link to={`/r/milestones/${m.id}`} className="flex-1 font-medium hover:underline">{m.name}</Link>
                <span className={cx('text-xs', m.status !== 'completed' && isOverdue(m.dueDate) ? 'text-red-600' : 'text-slate-500')}>{date(m.dueDate)}</span>
                <StatusBadge value={m.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
      {'time.create' in meta.user.permissions && <Button onClick={() => setLogging(true)}><Clock className="size-3.5" /> Log time on this project</Button>}
      <LogTimeModal open={logging} onClose={() => setLogging(false)} projectId={record.id} />
    </div>
  );
}
registerPanel('projects', { key: 'overview', label: 'Overview', component: ProjectOverview });

// ───────────── My work ─────────────

function TaskList({ rows, empty }: { rows: any[]; empty: string }) {
  const move = useTaskMove();
  if (!rows.length) return <p className="py-3 text-sm text-slate-500">{empty}</p>;
  return (
    <ul className="divide-y divide-slate-100">
      {rows.map((t) => (
        <li key={t.id} className="flex flex-wrap items-center gap-3 py-2">
          <div className="min-w-0 flex-1">
            <Link to={`/r/tasks/${t.id}`} className="text-sm font-medium text-slate-900 hover:underline"><span className="mr-1.5 font-mono text-xs text-slate-400">{t.number}</span>{t.title}</Link>
            <div className="text-xs text-slate-500">{t.projectCode ? `${t.projectCode} · ${t.projectName}` : 'Internal'}{t.dueDate && <> · <span className={cx(isOverdue(t.dueDate) && 'font-medium text-red-600')}>due {date(t.dueDate)}</span></>}</div>
          </div>
          <StatusBadge value={t.priority} />
          <StatusBadge value={t.status} />
          {(NEXT[t.status] ?? []).slice(0, 1).map((n) => (
            <Button key={n.to} size="sm" onClick={() => move.mutate({ id: t.id, status: n.to })}><n.icon className="size-3" /> {n.label}</Button>
          ))}
        </li>
      ))}
    </ul>
  );
}

export function MyWorkSections({ data }: { data: any }) {
  const [tab, setTab] = useState(data.overdue.length ? 'overdue' : 'today');
  return (
    <Card bodyClass="px-4 pb-2">
      <Tabs active={tab} onChange={setTab} tabs={[
        { key: 'overdue', label: <span className={data.overdue.length ? 'text-red-600' : ''}>Overdue ({data.overdue.length})</span> },
        { key: 'today', label: `Today (${data.today.length})` },
        { key: 'upcoming', label: `Upcoming (${data.upcoming.length})` },
      ]} />
      {tab === 'overdue' && <TaskList rows={data.overdue} empty="Nothing overdue. 🎉" />}
      {tab === 'today' && <TaskList rows={data.today} empty="Nothing due today." />}
      {tab === 'upcoming' && <TaskList rows={data.upcoming} empty="No upcoming tasks." />}
    </Card>
  );
}

function DeveloperDashboard() {
  const { user } = useMeta();
  const q = useQuery({ queryKey: ['dashboard', 'developer'], queryFn: () => api.get<any>('/api/dashboard/developer') });
  const [logging, setLogging] = useState(false);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Your work for today and what’s coming up." actions={<Button onClick={() => setLogging(true)}><Clock className="size-3.5" /> Log time</Button>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="Overdue" value={d.overdue.length} tone={d.overdue.length ? 'red' : undefined} />
        <Stat label="Due today" value={d.today.length} />
        <Stat label="Upcoming" value={d.upcoming.length} />
        <Stat label="Hours this week" value={d.week ? d.week.hours.toFixed(1) : '0'} hint={d.week ? `${d.week.utilizationPct}% of capacity` : undefined} />
        <Stat label="On-time (90 days)" value={d.performance?.onTimePct != null ? `${d.performance.onTimePct}%` : '—'} hint={d.performance ? `${d.performance.completed} tasks completed` : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-2">
          <MyWorkSections data={d} />
          <EngineeringSection data={d.engineering} />
        </div>
        <div className="space-y-4">
          <MyAttendanceCard />
          <Card title="My projects">
            {!d.projects.length ? <p className="text-sm text-slate-500">Not on any active project.</p> : (
              <ul className="space-y-2">{d.projects.map((p: any) => (
                <li key={p.id} className="flex items-center justify-between gap-2 text-sm">
                  <Link to={`/r/projects/${p.id}`} className="truncate hover:underline"><span className="font-mono text-xs text-slate-400">{p.code}</span> {p.name}</Link>
                  <StatusBadge value={p.status} />
                </li>
              ))}</ul>
            )}
          </Card>
          {d.performance && (
            <Card title="My delivery quality (90 days)">
              <dl className="grid grid-cols-2 gap-2 text-sm">
                <dt className="text-slate-500">Estimate accuracy</dt><dd className="text-right">{d.performance.estimateAccuracyPct != null ? `${d.performance.estimateAccuracyPct}%` : '—'}</dd>
                <dt className="text-slate-500">Estimated vs actual</dt><dd className="text-right">{d.performance.estimatedHours}h / {d.performance.actualHours}h</dd>
                <dt className="text-slate-500">Rework</dt><dd className="text-right">{d.performance.reworkPct}%</dd>
                <dt className="text-slate-500">QA rejection rate</dt><dd className="text-right">{d.performance.qaRejectionRatePct}%</dd>
                {d.engineering && <><dt className="text-slate-500">Bugs introduced</dt><dd className="text-right">{d.engineering.bugsIntroduced}</dd></>}
              </dl>
            </Card>
          )}
          <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
        </div>
      </div>
      <LogTimeModal open={logging} onClose={() => setLogging(false)} />
    </>
  );
}
DASHBOARDS.developer = DeveloperDashboard;

function MyWorkPage() {
  const q = useQuery({ queryKey: ['dashboard', 'developer'], queryFn: () => api.get<any>('/api/dashboard/developer') });
  return (
    <>
      <PageHeader title="My work" subtitle="Tasks assigned to you across all projects." />
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} /> : <MyWorkSections data={q.data} />}
    </>
  );
}
EXTRA_ROUTES.push({ path: 'my-work', component: MyWorkPage });

// ───────────── PM dashboard ─────────────

const PIPELINE = ['on_track', 'at_risk', 'delayed', 'awaiting_client', 'awaiting_design', 'awaiting_development', 'in_qa', 'ready_for_launch'];

function PMDashboard() {
  const { user } = useMeta();
  const can = useCan();
  const [scope, setScope] = useState<'mine' | 'all'>('mine');
  const q = useQuery({ queryKey: ['dashboard', 'pm', scope], queryFn: () => api.get<any>(`/api/dashboard/pm?scope=${scope}`) });
  const projectsMeta = useResource('projects');
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Delivery pipeline, risks and team load."
        actions={<>
          <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5 text-sm">
            {(['mine', 'all'] as const).map((s) => <button key={s} type="button" onClick={() => setScope(s)} className={cx('rounded px-2.5 py-1', scope === s && 'bg-slate-100 font-medium')}>{s === 'mine' ? 'My projects' : 'All projects'}</button>)}
          </div>
          {projectsMeta?.can.create && <Link to="/r/projects" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Projects</Link>}
        </>} />
      <div className="mb-4 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
        {PIPELINE.map((s) => (
          <Link key={s} to={`/r/projects?status=${s}`} className="card px-3 py-2.5 hover:border-brand-300">
            <div className="truncate text-[11px] font-medium text-slate-500">{humanize(s)}</div>
            <div className={cx('text-xl font-semibold tabular-nums', (s === 'delayed' || s === 'at_risk') && d.statusCounts[s] ? 'text-red-600' : 'text-slate-900')}>{d.statusCounts[s] ?? 0}</div>
          </Link>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2" title={`Active projects (${d.portfolio.length})`} bodyClass="p-0">
          {!d.portfolio.length ? <EmptyState title="No active projects" /> : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="px-4 py-2">Project</th><th className="px-2 py-2">Stage</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">Progress</th><th className="px-2 py-2">Hours</th><th className="px-4 py-2">Due</th></tr></thead>
                <tbody>
                  {d.portfolio.map((p: any) => (
                    <tr key={p.id} className="border-b border-slate-100 last:border-0">
                      <td className="px-4 py-2"><Link to={`/r/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link><div className="text-xs text-slate-500">{p.code} · {p.clientName ?? 'Internal'}{scope === 'all' && p.pmName ? ` · ${p.pmName}` : ''}</div></td>
                      <td className="px-2 py-2"><Badge stageColor={p.stageColor}>{p.stageName}</Badge></td>
                      <td className="px-2 py-2"><StatusBadge value={p.status} /></td>
                      <td className="w-32 px-2 py-2"><Progress value={p.progressPct} /><div className="mt-0.5 text-[11px] text-slate-500">{p.tasksDone}/{p.tasksTotal}{p.tasksOverdue > 0 && <span className="text-red-600"> · {p.tasksOverdue} overdue</span>}</div></td>
                      <td className="px-2 py-2 text-xs tabular-nums">{p.hoursLogged}h{p.hoursBudgetPct != null && <span className={cx(p.hoursBudgetPct > 100 ? 'text-red-600' : 'text-slate-500')}> ({p.hoursBudgetPct}%)</span>}</td>
                      <td className={cx('px-4 py-2 text-xs', isOverdue(p.dueDate) ? 'font-medium text-red-600' : 'text-slate-600')}>{date(p.dueDate)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
        <div className="space-y-4">
          <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
          <Card title="Open escalations">
            {!d.escalations.length ? <p className="text-sm text-slate-500">No open escalations.</p> : (
              <ul className="space-y-2 text-sm">{d.escalations.map((e: any) => (
                <li key={e.id}><Link to={`/r/project_updates/${e.id}`} className="font-medium hover:underline">{e.title}</Link><div className="text-xs text-slate-500">{e.projectCode} · to {String(e.escalateToRole).toUpperCase()}</div></li>
              ))}</ul>
            )}
          </Card>
        </div>
        <Card title="Overdue tasks" className="xl:col-span-2">
          {!d.overdueTasks.length ? <p className="text-sm text-slate-500">No overdue tasks.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.overdueTasks.map((t: any) => (
              <li key={t.id} className="flex items-center gap-3 py-1.5">
                <Link to={`/r/tasks/${t.id}`} className="flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{t.number}</span> {t.title}</Link>
                <span className="text-xs text-slate-500">{t.projectCode} · {t.assigneeName ?? 'Unassigned'}</span>
                <span className="text-xs font-medium text-red-600">{date(t.dueDate)}</span>
              </li>
            ))}</ul>
          )}
        </Card>
        {can('time.view') && (
          <Card title="Team hours, last 7 days">
            {!d.team.length ? <p className="text-sm text-slate-500">No team members.</p> : (
              <SimpleBars horizontal data={d.team.map((m: any) => ({ name: m.name, hours: Math.round(m.hours * 10) / 10 }))} x="name" y="hours"
                format={(v) => `${v}h`} height={Math.max(140, d.team.length * 28)} target={d.team[0]?.capacityHours} targetLabel="capacity" />
            )}
          </Card>
        )}
      </div>
    </>
  );
}
DASHBOARDS.pm = PMDashboard;
