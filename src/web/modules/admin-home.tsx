import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ago, datetime } from '../lib/format';
import { useMeta } from '../lib/meta';
import { Badge, Card, ErrorState, PageHeader, Spinner, Stat } from '../components/ui';
import { DASHBOARDS, greeting } from '../pages/Home';
import { ApprovalsList } from '../pages/Inbox';

function AdminDashboard() {
  const { user } = useMeta();
  const q = useQuery({ queryKey: ['dashboard', 'admin'], queryFn: () => api.get<any>('/api/dashboard/admin') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const a = d.accounts;
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Accounts, security events and automation health."
        actions={<><Link to="/admin/users" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Users</Link><Link to="/admin/roles" className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm hover:bg-slate-50">Roles</Link></>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        <Stat label="Active users" value={a.active} hint={`${a.disabled} disabled`} />
        <Stat label="Locked accounts" value={a.locked} tone={a.locked ? 'amber' : undefined} />
        <Stat label="Failed logins (24h)" value={d.failedLogins24h} tone={d.failedLogins24h > 20 ? 'red' : undefined} />
        <Stat label="Pending password change" value={a.pendingPassword} />
        <Stat label="Never signed in" value={a.neverLoggedIn} />
        <Stat label="Automation backlog" value={d.eventBacklog} tone={d.eventBacklog > 100 ? 'amber' : undefined} />
        <Stat label="Failing automations" value={d.failingEvents.length} tone={d.failingEvents.length ? 'red' : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Security events" className="xl:col-span-2">
          {!d.security.length ? <p className="text-sm text-slate-500">No recent security events (or no audit access).</p> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.security.map((e: any) => (
              <li key={e.id} className="flex flex-wrap items-center gap-3 py-1.5">
                <Badge tone={e.action === 'LOGIN_FAILED' ? 'red' : 'violet'}>{e.action}</Badge>
                <span className="flex-1 truncate">{e.actorName ?? e.newData?.email ?? 'Unknown'}{e.newData?.reason ? ` · ${e.newData.reason}` : ''}</span>
                <span className="text-xs text-slate-500" title={datetime(e.occurredAt)}>{ago(e.occurredAt)}{e.ip ? ` · ${e.ip}` : ''}</span>
              </li>
            ))}</ul>
          )}
          <Link to="/admin/audit" className="mt-2 inline-block text-xs text-brand-700 hover:underline">Open audit log</Link>
        </Card>
        <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
        <Card title="Automation failures" className="xl:col-span-3">
          {!d.failingEvents.length ? <p className="text-sm text-slate-500">All automations are running.</p> : (
            <ul className="space-y-1 text-sm">{d.failingEvents.map((e: any) => (
              <li key={e.id}><span className="font-mono text-xs">{e.type}</span> · {e.attempts} attempt(s) · <span className="text-red-700">{e.lastError}</span></li>
            ))}</ul>
          )}
        </Card>
      </div>
    </>
  );
}
DASHBOARDS.admin = AdminDashboard;
