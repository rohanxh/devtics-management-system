import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound, Plus, ShieldCheck } from 'lucide-react';
import { api, qs } from '../lib/api';
import { datetime, humanize } from '../lib/format';
import { useCan, useMeta } from '../lib/meta';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, Spinner, cx } from '../components/ui';
import { ResourceList } from '../components/ResourceList';
import { RefSelect } from '../components/fields';
import { useToast } from '../components/toast';

function TempPasswordModal({ password, onClose }: { password: string | null; onClose: () => void }) {
  return (
    <Modal open={!!password} onClose={onClose} title="Temporary password" footer={<Button variant="primary" onClick={onClose}>Done</Button>}>
      <p className="mb-3 text-sm text-slate-600">Share this password with the user through a secure channel. It is shown only once and must be changed at first sign-in.</p>
      <div className="flex items-center gap-2 rounded-md bg-slate-100 p-3 font-mono text-sm">
        <span className="flex-1 select-all">{password}</span>
        <Button size="sm" onClick={() => navigator.clipboard.writeText(password ?? '')}><Copy className="size-3.5" /> Copy</Button>
      </div>
    </Modal>
  );
}

function RolesEditor({ userId, onClose }: { userId: string; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => api.get<any[]>('/api/admin/roles') });
  const current = useQuery({ queryKey: ['user-roles', userId], queryFn: () => api.get<string[]>(`/api/admin/users/${userId}/roles`) });
  const [sel, setSel] = useState<string[] | null>(null);
  useEffect(() => { if (current.data && !sel) setSel(current.data); }, [current.data, sel]);
  const save = useMutation({
    mutationFn: () => api.put(`/api/admin/users/${userId}/roles`, { roleKeys: sel }),
    onSuccess: () => { toast.success('Roles updated'); qc.invalidateQueries({ queryKey: ['user-roles', userId] }); onClose(); },
    onError: toast.error,
  });
  return (
    <Modal open onClose={onClose} title="Roles" footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      {!roles.data || !sel ? <Spinner /> : (
        <ul className="space-y-2">
          {roles.data.map((r) => (
            <li key={r.key}>
              <label className="flex items-start gap-2 text-sm">
                <input type="checkbox" className="mt-0.5 size-4" disabled={r.key === 'employee'} checked={r.key === 'employee' || sel.includes(r.key)}
                  onChange={(e) => setSel((s) => e.target.checked ? [...(s ?? []), r.key] : (s ?? []).filter((x) => x !== r.key))} />
                <span><span className="font-medium">{r.name}</span><span className="block text-xs text-slate-500">{r.description}</span></span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </Modal>
  );
}

export function UsersAdminPage() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', email: '', roleKeys: [] as string[], employeeId: null as string | null });
  const [errors, setErrors] = useState<Record<string, any>>({});
  const [temp, setTemp] = useState<string | null>(null);
  const [rolesFor, setRolesFor] = useState<string | null>(null);
  const [userId, setUserId] = useState<string | null>(null);
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => api.get<any[]>('/api/admin/roles'), enabled: can('roles.view') });
  const create = useMutation({
    mutationFn: () => api.post<{ id: string; temporaryPassword: string }>('/api/admin/users', { ...form, employeeId: form.employeeId ?? undefined }),
    onSuccess: (r) => { setCreating(false); setTemp(r.temporaryPassword); setForm({ name: '', email: '', roleKeys: [], employeeId: null }); qc.invalidateQueries({ queryKey: ['r', 'users'] }); },
    onError: (e: any) => { setErrors(e.details ?? {}); toast.error(e); },
  });
  const reset = useMutation({
    mutationFn: (id: string) => api.post<{ temporaryPassword: string }>(`/api/admin/users/${id}/reset-password`),
    onSuccess: (r) => setTemp(r.temporaryPassword),
    onError: toast.error,
  });
  const err = (k: string) => (Array.isArray(errors[k]) ? errors[k][0] : errors[k]);
  return (
    <>
      <PageHeader title="Users" subtitle="Login accounts and their roles. Passwords are never visible — only reset."
        actions={can('users.create') && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-3.5" /> Invite user</Button>} />
      <Card className="mb-4" title="Manage a user">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-72"><label className="label" htmlFor="pick-user">User</label><RefSelect id="pick-user" refKey="users" value={userId} onChange={(v) => setUserId(v)} /></div>
          {can('roles.manage') && <Button disabled={!userId} onClick={() => setRolesFor(userId)}><ShieldCheck className="size-3.5" /> Edit roles</Button>}
          {can('users.edit') && <Button disabled={!userId} loading={reset.isPending} onClick={() => userId && confirm('Reset this user’s password? They will be signed out everywhere.') && reset.mutate(userId)}><KeyRound className="size-3.5" /> Reset password</Button>}
        </div>
      </Card>
      <ResourceList resource="users" hideCreate />
      <Modal open={creating} onClose={() => setCreating(false)} title="Invite user"
        footer={<><Button onClick={() => setCreating(false)}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Create user</Button></>}>
        <div className="space-y-3">
          <Field label="Full name" required error={err('name')} htmlFor="u-name"><input id="u-name" className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="Work email" required error={err('email')} htmlFor="u-email"><input id="u-email" type="email" className="input" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Link to employee record (optional)" htmlFor="u-emp" error={err('employeeId')}><RefSelect id="u-emp" refKey="employees" value={form.employeeId} onChange={(v) => setForm({ ...form, employeeId: v })} /></Field>
          <div>
            <span className="label">Roles</span>
            <div className="grid grid-cols-2 gap-1.5">
              {roles.data?.filter((r) => r.key !== 'employee').map((r) => (
                <label key={r.key} className="flex items-center gap-2 text-sm">
                  <input type="checkbox" className="size-4" checked={form.roleKeys.includes(r.key)}
                    onChange={(e) => setForm({ ...form, roleKeys: e.target.checked ? [...form.roleKeys, r.key] : form.roleKeys.filter((k) => k !== r.key) })} />
                  {r.name}
                </label>
              ))}
            </div>
          </div>
        </div>
      </Modal>
      <TempPasswordModal password={temp} onClose={() => setTemp(null)} />
      {rolesFor && <RolesEditor userId={rolesFor} onClose={() => setRolesFor(null)} />}
    </>
  );
}

const SCOPES = ['', 'own', 'team', 'all'] as const;

export function RolesAdminPage() {
  const can = useCan();
  const { user } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const roles = useQuery({ queryKey: ['admin-roles'], queryFn: () => api.get<any[]>('/api/admin/roles') });
  const catalog = useQuery({ queryKey: ['admin-perms'], queryFn: () => api.get<any[]>('/api/admin/permissions') });
  const [roleId, setRoleId] = useState<string | null>(null);
  const [grants, setGrants] = useState<Record<string, string>>({});
  const [newRole, setNewRole] = useState<{ key: string; name: string; description: string } | null>(null);
  const role = roles.data?.find((r) => r.id === roleId) ?? roles.data?.[0];
  useEffect(() => { if (role) setGrants(Object.fromEntries(role.grants.map((g: any) => [g.permission, g.scope]))); }, [role?.id, roles.data]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = useMutation({
    mutationFn: () => api.put(`/api/admin/roles/${role.id}/permissions`, { grants: Object.entries(grants).filter(([, s]) => s).map(([permission, scope]) => ({ permission, scope })) }),
    onSuccess: () => { toast.success('Permissions saved'); qc.invalidateQueries({ queryKey: ['admin-roles'] }); },
    onError: toast.error,
  });
  const create = useMutation({
    mutationFn: () => api.post('/api/admin/roles', newRole),
    onSuccess: (r: any) => { setNewRole(null); setRoleId(r.id); qc.invalidateQueries({ queryKey: ['admin-roles'] }); },
    onError: toast.error,
  });
  if (roles.isLoading || catalog.isLoading) return <Spinner />;
  if (roles.isError) return <ErrorState error={roles.error} />;
  const editable = can('roles.manage') && role && !user.roles.includes(role.key);
  return (
    <>
      <PageHeader title="Roles & permissions" subtitle="Permissions are enforced on the server. Scope: own = the user’s own/assigned records, team = their team/projects, all = everything."
        actions={can('roles.manage') && <Button onClick={() => setNewRole({ key: '', name: '', description: '' })}><Plus className="size-3.5" /> New role</Button>} />
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-[16rem_1fr]">
        <Card bodyClass="p-1">
          <ul>
            {roles.data!.map((r) => (
              <li key={r.id}>
                <button type="button" onClick={() => setRoleId(r.id)} className={cx('flex w-full items-center justify-between rounded px-3 py-2 text-left text-sm', role?.id === r.id ? 'bg-brand-50 font-medium text-brand-700' : 'hover:bg-slate-50')}>
                  <span>{r.name}</span><span className="text-xs text-slate-400">{r.userCount}</span>
                </button>
              </li>
            ))}
          </ul>
        </Card>
        {role && (
          <Card title={<>{role.name} {role.isSystem && <Badge className="ml-1">System</Badge>}</>}
            actions={editable ? <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save permissions</Button> : <span className="text-xs text-slate-500">{user.roles.includes(role.key) ? 'You hold this role and cannot edit it' : 'Read only'}</span>}>
            <p className="mb-3 text-sm text-slate-600">{role.description}</p>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <tbody>
                  {catalog.data!.map((g) => (
                    <tr key={g.key} className="border-b border-slate-100 align-top">
                      <td className="w-64 py-2 pr-4 font-medium text-slate-700">{g.label}<div className="font-mono text-[11px] font-normal text-slate-400">{g.key}</div></td>
                      <td className="py-2">
                        <div className="flex flex-wrap gap-2">
                          {g.actions.map((a: string) => {
                            const p = `${g.key}.${a}`;
                            return (
                              <label key={a} className={cx('inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-xs', grants[p] ? 'border-brand-300 bg-brand-50' : 'border-slate-200')}>
                                {humanize(a)}
                                <select aria-label={`${p} scope`} disabled={!editable} className="bg-transparent text-xs" value={grants[p] ?? ''} onChange={(e) => setGrants((s) => ({ ...s, [p]: e.target.value }))}>
                                  {SCOPES.map((s) => <option key={s} value={s}>{s || '—'}</option>)}
                                </select>
                              </label>
                            );
                          })}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        )}
      </div>
      <Modal open={!!newRole} onClose={() => setNewRole(null)} title="New role"
        footer={<><Button onClick={() => setNewRole(null)}>Cancel</Button><Button variant="primary" loading={create.isPending} onClick={() => create.mutate()}>Create</Button></>}>
        {newRole && (
          <div className="space-y-3">
            <Field label="Key" required help="lowercase, e.g. account_manager" htmlFor="r-key"><input id="r-key" className="input" value={newRole.key} onChange={(e) => setNewRole({ ...newRole, key: e.target.value })} /></Field>
            <Field label="Name" required htmlFor="r-name"><input id="r-name" className="input" value={newRole.name} onChange={(e) => setNewRole({ ...newRole, name: e.target.value })} /></Field>
            <Field label="Description" htmlFor="r-desc"><textarea id="r-desc" className="input" value={newRole.description} onChange={(e) => setNewRole({ ...newRole, description: e.target.value })} /></Field>
          </div>
        )}
      </Modal>
    </>
  );
}

export function AutomationAdminPage() {
  const can = useCan();
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['automation'], queryFn: () => api.get<{ rules: any[]; actions: any[] }>('/api/admin/automation') });
  const toggle = useMutation({
    mutationFn: (r: any) => api.patch(`/api/admin/automation/${r.id}`, { enabled: !r.enabled }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['automation'] }),
    onError: toast.error,
  });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} />;
  return (
    <>
      <PageHeader title="Automation" subtitle="Event-driven rules: when something happens, run these actions. All automated changes are audited as “System”." />
      <Card bodyClass="p-0">
        <table className="w-full text-sm">
          <thead><tr className="border-b border-slate-200 bg-slate-50 text-left text-xs text-slate-500"><th className="px-4 py-2">Rule</th><th className="px-4 py-2">When</th><th className="px-4 py-2">Then</th><th className="px-4 py-2">Enabled</th></tr></thead>
          <tbody>
            {q.data!.rules.map((r) => (
              <tr key={r.id} className="border-b border-slate-100 align-top">
                <td className="px-4 py-2.5"><div className="font-medium">{r.name}</div><div className="text-xs text-slate-500">{r.description}</div></td>
                <td className="px-4 py-2.5 font-mono text-xs">{r.eventType}{Object.keys(r.conditions).length > 0 && <div className="text-slate-500">{JSON.stringify(r.conditions)}</div>}</td>
                <td className="px-4 py-2.5 text-xs">{r.actions.map((a: any, i: number) => <div key={i}><span className="font-mono">{a.action}</span>{a.params?.roles && <span className="text-slate-500"> → {a.params.roles.join(', ')}</span>}</div>)}</td>
                <td className="px-4 py-2.5">
                  <input type="checkbox" aria-label={`Enable ${r.name}`} className="size-4" disabled={!can('automation.manage')} checked={r.enabled} onChange={() => toggle.mutate(r)} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {q.data!.rules.length === 0 && <EmptyState title="No automation rules" />}
      </Card>
      <Card className="mt-4" title="Available actions">
        <ul className="space-y-1 text-sm">{q.data!.actions.map((a) => <li key={a.name}><span className="font-mono text-xs">{a.name}</span> — <span className="text-slate-600">{a.description}</span></li>)}</ul>
      </Card>
    </>
  );
}

export function AuditPage() {
  const [f, setF] = useState<Record<string, string>>({});
  const [page, setPage] = useState(1);
  const [open, setOpen] = useState<any>(null);
  const q = useQuery({ queryKey: ['audit', f, page], queryFn: () => api.get<any>(`/api/admin/audit${qs({ ...f, page })}`) });
  const set = (k: string, v: string) => { setPage(1); setF((s) => ({ ...s, [k]: v })); };
  return (
    <>
      <PageHeader title="Audit log" subtitle="Immutable record of logins, permission changes and every data change (captured by the database)." />
      <div className="card mb-3 grid grid-cols-2 gap-2 p-3 md:grid-cols-5">
        <input aria-label="Table" className="input" placeholder="Table (e.g. invoices)" value={f.table ?? ''} onChange={(e) => set('table', e.target.value)} />
        <select aria-label="Action" className="input" value={f.action ?? ''} onChange={(e) => set('action', e.target.value)}>
          <option value="">Any action</option>
          {['INSERT', 'UPDATE', 'DELETE', 'LOGIN', 'LOGIN_FAILED', 'LOGOUT', 'PASSWORD_CHANGED', 'PASSWORD_RESET', 'PERMISSIONS_CHANGED', 'ROLES_CHANGED', 'USER_CREATED'].map((a) => <option key={a}>{a}</option>)}
        </select>
        <input aria-label="Record id" className="input" placeholder="Record ID" value={f.record ?? ''} onChange={(e) => set('record', e.target.value)} />
        <input aria-label="From" type="date" className="input" value={f.from ?? ''} onChange={(e) => set('from', e.target.value)} />
        <input aria-label="To" type="date" className="input" value={f.to ?? ''} onChange={(e) => set('to', e.target.value)} />
      </div>
      <Card bodyClass="p-0">
        {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} /> : (
          <>
            <table className="w-full text-sm">
              <thead><tr className="border-b bg-slate-50 text-left text-xs text-slate-500"><th className="px-3 py-2">When</th><th className="px-3 py-2">Who</th><th className="px-3 py-2">Action</th><th className="px-3 py-2">Record</th><th className="px-3 py-2">Changed</th></tr></thead>
              <tbody>
                {q.data.rows.map((r: any) => (
                  <tr key={r.id} className="cursor-pointer border-b border-slate-100 hover:bg-slate-50" onClick={() => setOpen(r)}>
                    <td className="px-3 py-1.5 font-mono text-xs">{datetime(r.occurredAt)}</td>
                    <td className="px-3 py-1.5">{r.actorName ?? <span className="text-slate-400">System</span>}</td>
                    <td className="px-3 py-1.5"><Badge tone={r.action === 'DELETE' || r.action === 'LOGIN_FAILED' ? 'red' : r.action === 'INSERT' ? 'green' : 'slate'}>{r.action}</Badge></td>
                    <td className="px-3 py-1.5 font-mono text-xs">{r.tableName}{r.recordId && <span className="text-slate-400"> · {String(r.recordId).slice(0, 8)}</span>}</td>
                    <td className="max-w-xs truncate px-3 py-1.5 text-xs text-slate-500">{r.changedFields?.join(', ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="flex items-center justify-between px-3 py-2 text-xs text-slate-500">
              <span>{q.data.total} entries</span>
              <div className="flex gap-1">
                <Button size="sm" disabled={page <= 1} onClick={() => setPage(page - 1)}>Previous</Button>
                <Button size="sm" disabled={page * q.data.pageSize >= q.data.total} onClick={() => setPage(page + 1)}>Next</Button>
              </div>
            </div>
          </>
        )}
      </Card>
      <Modal open={!!open} onClose={() => setOpen(null)} title={`${open?.action} · ${open?.tableName ?? ''}`} wide>
        {open && (
          <div className="grid grid-cols-1 gap-3 text-xs md:grid-cols-2">
            <div><div className="label">Before</div><pre className="max-h-96 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(open.oldData, null, 2)}</pre></div>
            <div><div className="label">After</div><pre className="max-h-96 overflow-auto rounded bg-slate-50 p-2">{JSON.stringify(open.newData, null, 2)}</pre></div>
            <div className="text-slate-500 md:col-span-2">Request {open.requestId ?? '—'} · IP {open.ip ?? '—'}</div>
          </div>
        )}
      </Modal>
    </>
  );
}

export function SettingsPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const q = useQuery({ queryKey: ['settings'], queryFn: () => api.get<Record<string, any>>('/api/admin/settings') });
  const [v, setV] = useState<Record<string, any> | null>(null);
  useEffect(() => { if (q.data && !v) setV(q.data); }, [q.data, v]);
  const save = useMutation({
    mutationFn: () => {
      const { _roleSeedVersion, ...rest } = v!;
      void _roleSeedVersion;
      return api.put('/api/admin/settings', rest);
    },
    onSuccess: () => { toast.success('Settings saved'); qc.invalidateQueries(); },
    onError: toast.error,
  });
  if (!v) return <Spinner />;
  const numF = (k: string, label: string, help?: string) => (
    <Field label={label} help={help} htmlFor={`s-${k}`}><input id={`s-${k}`} type="number" className="input" value={v[k]} onChange={(e) => setV({ ...v, [k]: Number(e.target.value) })} /></Field>
  );
  return (
    <>
      <PageHeader title="System settings" actions={<Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save</Button>} />
      <Card>
        <div className="grid max-w-3xl grid-cols-1 gap-4 sm:grid-cols-2">
          <Field label="Company name" htmlFor="s-companyName"><input id="s-companyName" className="input" value={v.companyName} onChange={(e) => setV({ ...v, companyName: e.target.value })} /></Field>
          <Field label="Base currency (ISO code)" htmlFor="s-cur"><input id="s-cur" className="input uppercase" maxLength={3} value={v.baseCurrency} onChange={(e) => setV({ ...v, baseCurrency: e.target.value.toUpperCase() })} /></Field>
          {numF('fiscalYearStartMonth', 'Fiscal year starts (month 1–12)')}
          {numF('defaultTaxRate', 'Default tax rate (%)')}
          {numF('invoiceDueDays', 'Invoice due after (days)')}
          {numF('workdayHours', 'Standard workday (hours)', 'Used for capacity and utilization')}
          {numF('utilizationTargetPct', 'Utilization target (%)')}
          {numF('emailDigestMinutes', 'Email unread notifications after (minutes)')}
        </div>
      </Card>
    </>
  );
}
