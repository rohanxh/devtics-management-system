import { useState } from 'react';
import { Link } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { LogIn, LogOut, PlaneTakeoff } from 'lucide-react';
import { api } from '../lib/api';
import { date, today } from '../lib/format';
import { useCan, useMeta } from '../lib/meta';
import { EXTRA_ROUTES } from '../lib/extensions';
import { Badge, Button, Card, EmptyState, ErrorState, PageHeader, Progress, Spinner, Stat, StatusBadge, Tabs } from '../components/ui';
import { SimpleBars } from '../components/charts';
import { ResourceFormModal } from '../components/ResourceForm';
import { ResourceList } from '../components/ResourceList';
import { useToast } from '../components/toast';
import { DASHBOARDS, HOME_WIDGETS, greeting } from '../pages/Home';
import { ApprovalsList } from '../pages/Inbox';

const time = (v: string | null) => (v ? new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' }) : '—');

/** Clock in/out + today's status + leave balances for the signed-in employee. */
export function MyAttendanceCard() {
  const qc = useQueryClient();
  const toast = useToast();
  const [leaveOpen, setLeaveOpen] = useState(false);
  const q = useQuery({ queryKey: ['attendance-me'], queryFn: () => api.get<any>('/api/attendance/me'), retry: false });
  const act = useMutation({
    mutationFn: (kind: 'in' | 'out' | 'remote') => api.post(kind === 'out' ? '/api/attendance/clock-out' : '/api/attendance/clock-in', kind === 'remote' ? { remote: true } : {}),
    onSuccess: (_r, kind) => { toast.success(kind === 'out' ? 'Clocked out' : 'Clocked in'); qc.invalidateQueries({ queryKey: ['attendance-me'] }); },
    onError: toast.error,
  });
  if (q.isLoading) return <Card title="Attendance"><Spinner /></Card>;
  if (q.isError) return null; // login not linked to an employee
  const d = q.data;
  const t = d.today;
  return (
    <Card title="Today" actions={<Button size="sm" onClick={() => setLeaveOpen(true)}><PlaneTakeoff className="size-3.5" /> Request leave</Button>}>
      <div className="flex flex-wrap items-center gap-3">
        {t?.status === 'on_leave' ? <Badge tone="violet">On leave today</Badge> : !t?.clockIn ? (
          <>
            <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('in')}><LogIn className="size-3.5" /> Clock in</Button>
            <Button loading={act.isPending} onClick={() => act.mutate('remote')}>Clock in (remote)</Button>
          </>
        ) : !t.clockOut ? (
          <>
            <span className="text-sm">In since <b>{time(t.clockIn)}</b></span>
            <StatusBadge value={t.status} />
            <Button variant="primary" loading={act.isPending} onClick={() => act.mutate('out')}><LogOut className="size-3.5" /> Clock out</Button>
          </>
        ) : (
          <span className="text-sm">{time(t.clockIn)} – {time(t.clockOut)} · {(t.minutesWorked / 60).toFixed(1)}h <StatusBadge value={t.status} /></span>
        )}
      </div>
      <dl className="mt-3 grid grid-cols-3 gap-2 text-center text-xs sm:grid-cols-6">
        {[['Present', d.summary.present], ['Late', d.summary.late], ['Absent', d.summary.absent], ['Leave', d.summary.leave], ['Hours', d.summary.hours], ['Overtime h', d.summary.overtimeHours]].map(([l, v]) => (
          <div key={l as string} className="rounded bg-slate-50 py-1.5"><dt className="text-slate-500">{l}</dt><dd className="text-sm font-semibold tabular-nums">{v}</dd></div>
        ))}
      </dl>
      {d.balances.length > 0 && (
        <div className="mt-3 space-y-1.5">
          <div className="label">Leave balance {new Date().getFullYear()}</div>
          {d.balances.map((b: any) => (
            <div key={b.id} className="flex items-center gap-2 text-xs">
              <span className="w-28 truncate">{b.name}</span>
              <div className="flex-1"><Progress value={(Number(b.usedDays) / Math.max(1, Number(b.allocatedDays) + Number(b.carriedDays))) * 100} /></div>
              <span className="w-24 text-right tabular-nums">{b.remaining} left</span>
            </div>
          ))}
        </div>
      )}
      <ResourceFormModal resource="leave_requests" open={leaveOpen} onClose={() => setLeaveOpen(false)} title="Request leave"
        only={['leaveTypeId', 'startDate', 'endDate', 'halfDay', 'reason']} onSaved={() => qc.invalidateQueries({ queryKey: ['attendance-me'] })} />
    </Card>
  );
}

function TeamToday() {
  const [day, setDay] = useState(today());
  const q = useQuery({ queryKey: ['attendance-day', day], queryFn: () => api.get<any>(`/api/attendance/day?date=${day}`) });
  return (
    <Card title="Team attendance" actions={<input aria-label="Date" type="date" className="input w-auto py-1" value={day} max={today()} onChange={(e) => setDay(e.target.value)} />} bodyClass="p-0">
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} /> : !q.data.rows.length ? <EmptyState title="No one in scope" /> : (
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="px-4 py-2">Employee</th><th className="px-2 py-2">Status</th><th className="px-2 py-2">In</th><th className="px-2 py-2">Out</th><th className="px-4 py-2 text-right">Hours</th></tr></thead>
          <tbody>{q.data.rows.map((r: any) => (
            <tr key={r.employeeId} className="border-b border-slate-100 last:border-0">
              <td className="px-4 py-1.5"><Link to={`/r/employees/${r.employeeId}`} className="hover:underline">{r.name}</Link></td>
              <td className="px-2 py-1.5">{r.status ? <StatusBadge value={r.status} /> : <span className="text-xs text-slate-400">Not recorded</span>}{r.lateMinutes > 0 && <span className="ml-1 text-xs text-amber-700">+{r.lateMinutes}m</span>}</td>
              <td className="px-2 py-1.5 text-xs">{time(r.clockIn)}</td>
              <td className="px-2 py-1.5 text-xs">{time(r.clockOut)}</td>
              <td className="px-4 py-1.5 text-right text-xs tabular-nums">{r.minutesWorked ? (r.minutesWorked / 60).toFixed(1) : '—'}</td>
            </tr>
          ))}</tbody>
        </table>
      )}
    </Card>
  );
}

function AttendancePage() {
  const { user } = useMeta();
  const scope = user.permissions['attendance.view'];
  const [tab, setTab] = useState('me');
  return (
    <>
      <PageHeader title="Attendance" subtitle="Clock in/out, working hours, late arrivals, overtime and leave." />
      {scope !== 'own' && <div className="mb-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'me', label: 'My attendance' }, { key: 'team', label: scope === 'all' ? 'Everyone' : 'My team' }, { key: 'records', label: 'All records' }]} /></div>}
      {tab === 'me' && <div className="grid grid-cols-1 gap-4 lg:grid-cols-2"><MyAttendanceCard /><Card title="My leave requests"><ResourceList resource="leave_requests" compact fixed={user.employeeId ? { employeeId: user.employeeId } : undefined} hideCreate /></Card></div>}
      {tab === 'team' && <TeamToday />}
      {tab === 'records' && <ResourceList resource="attendance" />}
    </>
  );
}
EXTRA_ROUTES.push({ path: 'attendance', component: AttendancePage });

function HRDashboard() {
  const { user } = useMeta();
  const can = useCan();
  const q = useQuery({ queryKey: ['dashboard', 'hr'], queryFn: () => api.get<any>('/api/dashboard/hr') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const a = d.attendanceToday;
  const present = (a.present ?? 0) + (a.late ?? 0) + (a.remote ?? 0) + (a.half_day ?? 0);
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="People, attendance, leave, reviews and hiring." />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Employees" value={d.total} hint={`${d.attritionPct}% attrition (12m)`} />
        <Stat label="New hires (30d)" value={d.newHires.length} />
        <Stat label="Present today" value={present} hint={`${a.late ?? 0} late · ${d.unmarkedToday} not in yet`} />
        <Stat label="On leave today" value={d.onLeave.length} />
        <Stat label="Leave to approve" value={d.pendingLeave} tone={d.pendingLeave ? 'amber' : undefined} />
        <Stat label="Reviews due (30d)" value={d.reviews.length} />
        <Stat label="Open positions" value={d.openings.reduce((x: number, o: any) => x + o.openings - o.hiredCount, 0)} />
        <Stat label="On probation" value={d.probation.length} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Recruitment funnel (active)" className="xl:col-span-2">
          <SimpleBars data={d.funnel.filter((f: any) => f.key !== 'rejected')} x="name" y="count" height={220} />
        </Card>
        <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
        <Card title="Who’s out today">
          {!d.onLeave.length ? <p className="text-sm text-slate-500">Everyone’s in.</p> : (
            <ul className="space-y-1 text-sm">{d.onLeave.map((l: any) => <li key={l.id} className="flex justify-between"><span>{l.name}</span><span className="text-xs text-slate-500">{l.type} until {date(l.endDate)}</span></li>)}</ul>
          )}
        </Card>
        <Card title="Upcoming reviews">
          {!d.reviews.length ? <p className="text-sm text-slate-500">None due.</p> : (
            <ul className="space-y-1 text-sm">{d.reviews.map((r: any) => <li key={r.id} className="flex justify-between gap-2"><Link to={`/r/performance_reviews/${r.id}`} className="truncate hover:underline">{r.name} · {r.period}</Link><span className="shrink-0 text-xs text-slate-500">{date(r.dueDate)}</span></li>)}</ul>
          )}
        </Card>
        <Card title="Probation ending">
          {!d.probation.length ? <p className="text-sm text-slate-500">No one on probation.</p> : (
            <ul className="space-y-1 text-sm">{d.probation.map((p: any) => <li key={p.id} className="flex justify-between gap-2"><Link to={`/r/employees/${p.id}`} className="hover:underline">{p.name}</Link><span className="text-xs text-slate-500">{date(p.probationEndDate)}</span></li>)}</ul>
          )}
        </Card>
        <Card title="Open positions">
          {!d.openings.length ? <p className="text-sm text-slate-500">No open roles.</p> : (
            <ul className="space-y-1 text-sm">{d.openings.map((o: any) => <li key={o.id} className="flex justify-between gap-2"><Link to={`/r/job_openings/${o.id}`} className="hover:underline">{o.title}</Link><span className="text-xs text-slate-500">{o.applicants} active candidates</span></li>)}</ul>
          )}
        </Card>
        <Card title="Expiring documents & certifications (60d)">
          {!d.expiring.length && !d.expiringDocs.length ? <p className="text-sm text-slate-500">Nothing expiring.</p> : (
            <ul className="space-y-1 text-sm">
              {d.expiring.map((c: any) => <li key={c.id} className="flex justify-between gap-2"><Link to={`/r/employees/${c.employeeId}`} className="truncate hover:underline">{c.who}: {c.name}</Link><span className="text-xs text-amber-700">{date(c.expiresOn)}</span></li>)}
              {d.expiringDocs.map((f: any) => <li key={f.id} className="flex justify-between gap-2"><Link to={`/r/employees/${f.employeeId}`} className="truncate hover:underline">{f.name}</Link><span className="text-xs text-amber-700">{date(f.expiresOn)}</span></li>)}
            </ul>
          )}
        </Card>
        <Card title="Most late arrivals (30d)">
          {!d.lateWeek.length ? <p className="text-sm text-slate-500">No late arrivals.</p> : (
            <ul className="space-y-1 text-sm">{d.lateWeek.map((l: any) => <li key={l.name} className="flex justify-between"><span>{l.name}</span><span className="tabular-nums">{l.late}×</span></li>)}</ul>
          )}
        </Card>
        {can('attendance.view') && <div className="xl:col-span-3"><TeamToday /></div>}
      </div>
    </>
  );
}
DASHBOARDS.hr = HRDashboard;

HOME_WIDGETS.push(MyAttendanceCard);

