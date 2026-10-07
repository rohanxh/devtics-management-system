import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Ban, Check, FlaskConical, MinusCircle, Rocket, X } from 'lucide-react';
import { api } from '../lib/api';
import { ago, date, humanize } from '../lib/format';
import { useCan, useMeta } from '../lib/meta';
import { registerActions, registerPanel } from '../lib/extensions';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, Progress, Spinner, Stat, StatusBadge, cx } from '../components/ui';
import { RefSelect } from '../components/fields';
import { SimpleBars } from '../components/charts';
import { useToast } from '../components/toast';
import { DASHBOARDS, greeting } from '../pages/Home';
import { ApprovalsList } from '../pages/Inbox';

// ───────────── Start a QA run (from a project) ─────────────

export function StartQaRunModal({ open, onClose, projectId }: { open: boolean; onClose: () => void; projectId: string }) {
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [name, setName] = useState('QA cycle');
  const [templateIds, setTemplateIds] = useState<string[]>([]);
  const [includeProjectCases, setInclude] = useState(true);
  const [assigneeId, setAssignee] = useState<string | null>(null);
  const tpls = useQuery({ queryKey: ['r', 'qa_templates', 'all'], queryFn: () => api.get('/api/r/qa_templates?isActive=true&pageSize=100&sort=name'), enabled: open });
  const create = useMutation({
    mutationFn: () => api.post<any>('/api/qa/runs', { projectId, name, templateIds, includeProjectCases, assigneeId }),
    onSuccess: (r) => { toast.success(`${r.number} created`); qc.invalidateQueries(); onClose(); navigate(`/r/qa_runs/${r.id}`); },
    onError: toast.error,
  });
  return (
    <Modal open={open} onClose={onClose} title="Start a QA run"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Create run</Button></>}>
      <div className="space-y-3">
        <Field label="Run name" htmlFor="qr-n"><input id="qr-n" className="input" value={name} onChange={(e) => setName(e.target.value)} /></Field>
        <div>
          <span className="label">Templates</span>
          {!tpls.data ? <Spinner /> : (
            <div className="grid grid-cols-2 gap-1.5">
              {tpls.data.rows.map((t: any) => (
                <label key={t.id} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4" checked={templateIds.includes(t.id)} onChange={(e) => setTemplateIds((s) => e.target.checked ? [...s, t.id] : s.filter((x) => x !== t.id))} />
                  {t.name}
                </label>
              ))}
            </div>
          )}
        </div>
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" className="size-4" checked={includeProjectCases} onChange={(e) => setInclude(e.target.checked)} /> Include all active test cases of this project (retest)</label>
        <Field label="Tester" htmlFor="qr-a"><RefSelect id="qr-a" refKey="users" value={assigneeId} onChange={setAssignee} placeholder="Me" /></Field>
      </div>
    </Modal>
  );
}

function ProjectActions({ record, reload }: { record: any; reload: () => void }) {
  const can = useCan();
  const toast = useToast();
  const [qaOpen, setQaOpen] = useState(false);
  const launch = useMutation({ mutationFn: () => api.post(`/api/projects/${record.id}/launch`), onSuccess: () => { toast.success('Project launched 🚀'); reload(); }, onError: toast.error });
  return (
    <>
      {can('qa.create') && <Button onClick={() => setQaOpen(true)}><FlaskConical className="size-3.5" /> Start QA run</Button>}
      {record._can?.edit && record.qaApprovedAt && !record.launchedAt && (
        <Button variant="primary" loading={launch.isPending} onClick={() => confirm('Mark this project as launched?') && launch.mutate()}><Rocket className="size-3.5" /> Launch</Button>
      )}
      <StartQaRunModal open={qaOpen} onClose={() => setQaOpen(false)} projectId={record.id} />
    </>
  );
}
registerActions('projects', ProjectActions);

// ───────────── QA run execution ─────────────

function QaRunPanel({ record, reload }: { record: any; reload: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const key = ['qa-results', record.id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<any>(`/api/qa/runs/${record.id}/results`) });
  const [failing, setFailing] = useState<any>(null);
  const [bug, setBug] = useState({ title: '', severity: 'medium', actualResult: '', assigneeId: null as string | null });
  const [decide, setDecide] = useState<null | 'approve' | 'reject'>(null);
  const [note, setNote] = useState('');
  const refresh = () => { qc.invalidateQueries({ queryKey: key }); reload(); };
  const setResult = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => api.patch(`/api/r/qa_run_results/${id}`, { status }),
    onSuccess: refresh, onError: toast.error,
  });
  const fail = useMutation({
    mutationFn: () => api.post(`/api/qa/results/${failing.id}/fail`, bug),
    onSuccess: (b: any) => { toast.success(`${b.number} raised`); setFailing(null); refresh(); },
    onError: toast.error,
  });
  const complete = useMutation({ mutationFn: () => api.post(`/api/qa/runs/${record.id}/complete`), onSuccess: () => { toast.success('Run completed'); refresh(); }, onError: toast.error });
  const decision = useMutation({
    mutationFn: () => api.post(`/api/qa/runs/${record.id}/${decide}`, { note }),
    onSuccess: () => { toast.success(decide === 'approve' ? 'QA signed off — launch enabled' : 'Run rejected'); setDecide(null); refresh(); },
    onError: toast.error,
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} />;
  const { rows, canEdit, canApprove } = q.data;
  const done = rows.filter((r: any) => r.status !== 'pending').length;
  const areas = [...new Set(rows.map((r: any) => r.area ?? 'General'))] as string[];
  return (
    <Card title={<>Test execution <span className="ml-2 text-xs font-normal text-slate-500">{done}/{rows.length} recorded</span></>}
      actions={<>
        {canEdit && <Button loading={complete.isPending} onClick={() => complete.mutate()}>Complete run</Button>}
        {canApprove && record.status === 'completed' && <><Button variant="primary" onClick={() => setDecide('approve')}>Sign off</Button><Button onClick={() => setDecide('reject')}>Reject</Button></>}
        {['approved', 'rejected'].includes(record.status) && <StatusBadge value={record.status} />}
      </>}>
      <div className="mb-3 flex items-center gap-3 text-xs">
        <div className="flex-1"><Progress value={rows.length ? (done / rows.length) * 100 : 0} /></div>
        <span className="text-emerald-700">{record.passCount} pass</span><span className="text-red-700">{record.failCount} fail</span><span className="text-amber-700">{record.blockedCount} blocked</span>
      </div>
      {areas.map((area) => (
        <div key={area} className="mb-3">
          <h3 className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{area}</h3>
          <ul className="divide-y divide-slate-100 rounded border border-slate-200">
            {rows.filter((r: any) => (r.area ?? 'General') === area).map((r: any) => (
              <li key={r.id} className={cx('flex flex-wrap items-center gap-2 px-3 py-2 text-sm', r.status === 'fail' && 'bg-red-50/50')}>
                <div className="min-w-0 flex-1">
                  <div className="font-medium text-slate-800">{r.title}</div>
                  {r.expectedResult && <div className="text-xs text-slate-500">Expected: {r.expectedResult}</div>}
                  {r.bugId && <Link to={`/r/bugs/${r.bugId}`} className="text-xs text-red-700 hover:underline">{r.bugNumber} · {humanize(r.bugStatus)}</Link>}
                </div>
                <Badge tone={r.priority === 'critical' ? 'red' : r.priority === 'high' ? 'amber' : 'slate'}>{r.priority}</Badge>
                {canEdit ? (
                  <div className="flex gap-1" role="group" aria-label={`Result for ${r.title}`}>
                    <button type="button" title="Pass" aria-pressed={r.status === 'pass'} onClick={() => setResult.mutate({ id: r.id, status: 'pass' })} className={cx('rounded p-1.5', r.status === 'pass' ? 'bg-emerald-600 text-white' : 'text-slate-400 hover:bg-emerald-50 hover:text-emerald-700')}><Check className="size-4" /></button>
                    <button type="button" title="Fail & raise bug" aria-pressed={r.status === 'fail'} onClick={() => { setFailing(r); setBug({ title: `${r.title} — failed`, severity: r.priority === 'critical' ? 'critical' : 'medium', actualResult: '', assigneeId: null }); }} className={cx('rounded p-1.5', r.status === 'fail' ? 'bg-red-600 text-white' : 'text-slate-400 hover:bg-red-50 hover:text-red-700')}><X className="size-4" /></button>
                    <button type="button" title="Blocked" aria-pressed={r.status === 'blocked'} onClick={() => setResult.mutate({ id: r.id, status: 'blocked' })} className={cx('rounded p-1.5', r.status === 'blocked' ? 'bg-amber-500 text-white' : 'text-slate-400 hover:bg-amber-50 hover:text-amber-700')}><Ban className="size-4" /></button>
                    <button type="button" title="Skip" aria-pressed={r.status === 'skipped'} onClick={() => setResult.mutate({ id: r.id, status: 'skipped' })} className={cx('rounded p-1.5', r.status === 'skipped' ? 'bg-slate-500 text-white' : 'text-slate-400 hover:bg-slate-100')}><MinusCircle className="size-4" /></button>
                  </div>
                ) : <StatusBadge value={r.status} />}
              </li>
            ))}
          </ul>
        </div>
      ))}
      <Modal open={!!failing} onClose={() => setFailing(null)} title="Fail test & raise bug"
        footer={<><Button onClick={() => setFailing(null)}>Cancel</Button><Button variant="danger" loading={fail.isPending} onClick={() => fail.mutate()}>Raise bug</Button></>}>
        <div className="space-y-3">
          <Field label="Bug title" htmlFor="fb-t"><input id="fb-t" className="input" value={bug.title} onChange={(e) => setBug({ ...bug, title: e.target.value })} /></Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Severity" htmlFor="fb-s"><select id="fb-s" className="input" value={bug.severity} onChange={(e) => setBug({ ...bug, severity: e.target.value })}>{['critical', 'high', 'medium', 'low'].map((s) => <option key={s}>{s}</option>)}</select></Field>
            <Field label="Assign to" htmlFor="fb-a"><RefSelect id="fb-a" refKey="users" value={bug.assigneeId} onChange={(v) => setBug({ ...bug, assigneeId: v })} /></Field>
          </div>
          <Field label="Actual result" htmlFor="fb-r"><textarea id="fb-r" rows={4} className="input" value={bug.actualResult} onChange={(e) => setBug({ ...bug, actualResult: e.target.value })} /></Field>
          <p className="text-xs text-slate-500">Steps and expected result are copied from the test case. Attach screenshots or videos on the bug after it’s created.</p>
        </div>
      </Modal>
      <Modal open={!!decide} onClose={() => setDecide(null)} title={decide === 'approve' ? 'QA sign-off' : 'Reject QA run'}
        footer={<><Button onClick={() => setDecide(null)}>Cancel</Button><Button variant={decide === 'approve' ? 'primary' : 'danger'} loading={decision.isPending} onClick={() => decision.mutate()}>{decide === 'approve' ? 'Sign off' : 'Reject'}</Button></>}>
        <p className="mb-2 text-sm text-slate-600">{decide === 'approve' ? 'Signing off marks the project Ready for Launch. Open critical/high bugs block sign-off.' : 'The project goes back to development and the PM is notified.'}</p>
        <Field label={decide === 'approve' ? 'Summary (optional)' : 'What must be fixed?'} htmlFor="qd-n"><textarea id="qd-n" rows={4} className="input" value={note} onChange={(e) => setNote(e.target.value)} /></Field>
      </Modal>
    </Card>
  );
}
registerPanel('qa_runs', { key: 'execution', label: 'Execution', component: QaRunPanel, placement: 'top' });

// ───────────── QA dashboard ─────────────

function QADashboard() {
  const { user } = useMeta();
  const q = useQuery({ queryKey: ['dashboard', 'qa'], queryFn: () => api.get<any>('/api/dashboard/qa') });
  const [start, setStart] = useState<string | null>(null);
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Testing queue, retests and launch readiness." />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Awaiting QA" value={d.awaiting.length} />
        <Stat label="Active runs" value={d.runs.filter((r: any) => r.status !== 'completed').length} />
        <Stat label="Active test cases" value={d.activeCases} />
        <Stat label="Failed tests (open runs)" value={d.failedTests} tone={d.failedTests ? 'red' : undefined} />
        <Stat label="Open bugs" value={d.bugCounts.total} hint={`${d.bugCounts.critical} critical · ${d.bugCounts.high} high`} tone={d.bugCounts.critical ? 'red' : undefined} />
        <Stat label="To retest" value={d.retest.length} tone={d.retest.length ? 'amber' : undefined} />
        <Stat label="Pending sign-off" value={d.pendingApprovals} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Projects awaiting QA">
          {!d.awaiting.length ? <p className="text-sm text-slate-500">Nothing waiting.</p> : (
            <ul className="space-y-2">{d.awaiting.map((p: any) => (
              <li key={p.id} className="flex items-center gap-2 text-sm">
                <Link to={`/r/projects/${p.id}`} className="flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{p.code}</span> {p.name}</Link>
                <Button size="sm" onClick={() => setStart(p.id)}>Start run</Button>
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Active QA runs" className="xl:col-span-2">
          {!d.runs.length ? <EmptyState title="No active runs" /> : (
            <ul className="divide-y divide-slate-100">{d.runs.map((r: any) => (
              <li key={r.id} className="flex items-center gap-3 py-2 text-sm">
                <Link to={`/r/qa_runs/${r.id}`} className="flex-1 truncate font-medium hover:underline"><span className="font-mono text-xs text-slate-400">{r.number}</span> {r.name} <span className="text-xs font-normal text-slate-500">· {r.projectCode}</span></Link>
                <div className="w-32"><Progress value={r.totalCount ? ((r.passCount + r.failCount + r.blockedCount) / r.totalCount) * 100 : 0} tone={r.failCount ? 'red' : undefined} /></div>
                <span className="w-20 text-right text-xs"><span className="text-emerald-700">{r.passCount}</span>/<span className="text-red-700">{r.failCount}</span>/{r.totalCount}</span>
                <StatusBadge value={r.status} />
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Bugs to retest" className="xl:col-span-2">
          {!d.retest.length ? <p className="text-sm text-slate-500">Nothing to retest.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.retest.map((b: any) => (
              <li key={b.id} className="flex items-center gap-3 py-1.5">
                <Link to={`/r/bugs/${b.id}`} className="flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{b.number}</span> {b.title}</Link>
                <span className="text-xs text-slate-500">{b.projectCode}</span><StatusBadge value={b.severity} />
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Launch-ready projects">
          {!d.launchReady.length ? <p className="text-sm text-slate-500">None yet.</p> : (
            <ul className="space-y-1.5 text-sm">{d.launchReady.map((p: any) => (
              <li key={p.id}><Link to={`/r/projects/${p.id}`} className="hover:underline"><span className="font-mono text-xs text-slate-400">{p.code}</span> {p.name}</Link><div className="text-xs text-slate-500">QA approved {ago(p.qaApprovedAt)}</div></li>
            ))}</ul>
          )}
        </Card>
      </div>
      {start && <StartQaRunModal open onClose={() => setStart(null)} projectId={start} />}
    </>
  );
}
DASHBOARDS.qa = QADashboard;

// ───────────── CTO dashboard ─────────────

function CTODashboard() {
  const { user } = useMeta();
  const q = useQuery({ queryKey: ['dashboard', 'cto'], queryFn: () => api.get<any>('/api/dashboard/cto') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const debt = d.debt.reduce((a: number, x: any) => a + x.n, 0);
  const qaActive = d.qaStatus.reduce((a: number, x: any) => a + x.n, 0);
  const avgUtil = d.capacity.length ? Math.round(d.capacity.reduce((a: number, x: any) => a + x.utilizationPct, 0) / d.capacity.length) : 0;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Technical delivery, capacity, quality and infrastructure." />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Active technical projects" value={d.activeProjects} />
        <Stat label="At technical risk" value={d.atRisk.length} tone={d.atRisk.length ? 'red' : undefined} />
        <Stat label="Open bugs" value={d.bugCounts.total} hint={`${d.bugCounts.critical} critical`} tone={d.bugCounts.critical ? 'red' : undefined} />
        <Stat label="QA runs open" value={qaActive} />
        <Stat label="Open PRs / reviews" value={d.openPullRequests} />
        <Stat label="Tech debt items" value={debt} />
        <Stat label="Infra issues" value={d.envIssues.length} tone={d.envIssues.length ? 'red' : undefined} />
        <Stat label="Dev utilization (2 wks)" value={`${avgUtil}%`} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Projects at technical risk" className="xl:col-span-2" bodyClass="p-0">
          {!d.atRisk.length ? <p className="p-4 text-sm text-slate-500">No projects at risk. 👍</p> : (
            <table className="w-full text-sm">
              <tbody>{d.atRisk.map((p: any) => (
                <tr key={p.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2"><Link to={`/r/projects/${p.id}`} className="font-medium hover:underline">{p.name}</Link><div className="text-xs text-slate-500">{p.code} · PM {p.pmName ?? '—'}</div></td>
                  <td className="px-2 py-2"><StatusBadge value={p.status} /></td>
                  <td className="px-2 py-2 text-xs">{p.criticalBugs > 0 ? <span className="text-red-700">{p.criticalBugs} critical/high bugs</span> : '—'}</td>
                  <td className="px-4 py-2 text-xs text-slate-500">due {date(p.dueDate)}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
        <Card title="Developer capacity — hours logged, last 2 weeks" className="xl:col-span-2">
          {!d.capacity.length ? <p className="text-sm text-slate-500">No developers.</p> : (
            <SimpleBars horizontal data={d.capacity.map((c: any) => ({ name: c.name, hours: Math.round(c.hours * 10) / 10 }))} x="name" y="hours"
              format={(v) => `${v}h`} height={Math.max(160, d.capacity.length * 28)} target={d.capacity[0].capacityHours} targetLabel="capacity" />
          )}
        </Card>
        <Card title="Technical workload (open tasks)">
          <ul className="space-y-1.5 text-sm">{d.workload.map((w: any) => (
            <li key={w.id} className="flex justify-between gap-2"><span className="truncate">{w.name}</span><span className="tabular-nums text-slate-600">{w.open_tasks} tasks · {Math.round(w.open_estimate)}h</span></li>
          ))}</ul>
          {!d.workload.length && <p className="text-sm text-slate-500">No open work.</p>}
        </Card>
        <Card title="Deployments" className="xl:col-span-2">
          {!d.recentDeploys.length ? <p className="text-sm text-slate-500">No deployments recorded.</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.recentDeploys.map((x: any) => (
              <li key={x.id} className="flex items-center gap-3 py-1.5">
                <Link to={`/r/deployments/${x.id}`} className="flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{x.number}</span> {x.version}</Link>
                <span className="text-xs text-slate-500">{x.projectCode} → {x.envName}</span>
                <Badge tone={x.envKind === 'production' ? 'violet' : 'slate'}>{x.envKind}</Badge>
                <StatusBadge value={x.status} />
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Infrastructure & reviews">
          {d.envIssues.map((e: any) => <div key={e.id} className="mb-1 flex justify-between text-sm"><Link to={`/r/environments/${e.id}`} className="hover:underline">{e.projectCode} · {e.name}</Link><StatusBadge value={e.status} /></div>)}
          {!d.envIssues.length && <p className="mb-2 text-sm text-slate-500">All environments healthy or unknown.</p>}
          <div className="mt-3 border-t border-slate-100 pt-2">
            <div className="label">Technical reviews awaiting decision</div>
            {d.reviews.map((r: any) => <div key={r.id} className="text-sm"><Link to={`/r/tech_reviews/${r.id}`} className="hover:underline">{r.number} {r.title}</Link> <Badge>{humanize(r.kind)}</Badge></div>)}
            {!d.reviews.length && <p className="text-sm text-slate-500">None.</p>}
          </div>
        </Card>
      </div>
    </>
  );
}
DASHBOARDS.cto = CTODashboard;

// ───────────── Engineering section for the developer dashboard ─────────────

export function EngineeringSection({ data }: { data: any }) {
  if (!data) return null;
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
      <Card title={`Code reviews for me (${data.reviewsToDo.length})`}>
        {!data.reviewsToDo.length ? <p className="text-sm text-slate-500">No reviews requested.</p> : (
          <ul className="space-y-1 text-sm">{data.reviewsToDo.map((p: any) => <li key={p.id}><Link to={`/r/pull_requests/${p.id}`} className="hover:underline">{p.title}</Link></li>)}</ul>
        )}
        <p className="mt-2 text-xs text-slate-500">{data.myOpenPrs} of my PRs open</p>
      </Card>
      <Card title={`My bugs (${data.openBugsAssigned})`}>
        {!data.myBugs.length ? <p className="text-sm text-slate-500">No bugs assigned.</p> : (
          <ul className="space-y-1 text-sm">{data.myBugs.map((b: any) => (
            <li key={b.id} className="flex items-center gap-2"><Link to={`/r/bugs/${b.id}`} className="flex-1 truncate hover:underline"><span className="font-mono text-xs text-slate-400">{b.number}</span> {b.title}</Link><StatusBadge value={b.severity} /></li>
          ))}</ul>
        )}
      </Card>
      <Card title="My deployments">
        {!data.myDeploys.length ? <p className="text-sm text-slate-500">None recently.</p> : (
          <ul className="space-y-1 text-sm">{data.myDeploys.map((x: any) => (
            <li key={x.id} className="flex items-center gap-2"><Link to={`/r/deployments/${x.id}`} className="flex-1 truncate hover:underline">{x.version} → {x.envName}</Link><StatusBadge value={x.status} /></li>
          ))}</ul>
        )}
      </Card>
    </div>
  );
}

