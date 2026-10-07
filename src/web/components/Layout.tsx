import { useEffect, useRef, useState } from 'react';
import { Link, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Bell, ChevronDown, KeyRound, LogOut, Menu, Search, X } from 'lucide-react';
import { api, qs } from '../lib/api';
import { ago } from '../lib/format';
import { useMeta } from '../lib/meta';
import { NAV } from '../lib/nav';
import { cx } from './ui';

function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const meta = useMeta();
  const perms = meta.user.permissions;
  const groups = NAV.map((g) => ({
    ...g,
    items: g.items.filter((i) =>
      (!i.resource || meta.resources[i.resource]) && (!i.perm || i.perm in perms) && (!i.anyPerm || i.anyPerm.some((p) => p in perms))
      && !(i.teamOnly && meta.resources[i.resource!]?.viewScope === 'own')
      && !(i.ownOnly && meta.resources[i.resource!]?.viewScope !== 'own')),
  })).filter((g) => g.items.length);
  return (
    <nav aria-label="Main" className="flex h-full flex-col overflow-y-auto px-3 py-4">
      <Link to="/" className="mb-5 flex items-center gap-2 px-2" onClick={onNavigate}>
        <span className="flex size-7 items-center justify-center rounded-md bg-brand-600 text-sm font-bold text-white">D</span>
        <span className="text-sm font-semibold text-slate-900">{meta.settings.companyName}<span className="ml-1 font-normal text-slate-400">DMS</span></span>
      </Link>
      {groups.map((g) => (
        <div key={g.label || 'main'} className="mb-4">
          {g.label && <div className="mb-1 px-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.label}</div>}
          <ul className="space-y-0.5">
            {g.items.map((i) => (
              <li key={i.to}>
                <NavLink to={i.to} end={i.to === '/'} onClick={onNavigate}
                  className={({ isActive }) => cx('flex items-center gap-2 rounded-md px-2 py-1.5 text-sm', isActive ? 'bg-brand-50 font-medium text-brand-700' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900')}>
                  <i.icon className="size-4 shrink-0" /> {i.label}
                </NavLink>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function GlobalSearch() {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const box = useRef<HTMLDivElement>(null);
  const [debounced, setDebounced] = useState('');
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const res = useQuery({ queryKey: ['search', debounced], queryFn: () => api.get<any[]>(`/api/search${qs({ q: debounced })}`), enabled: debounced.length >= 2 });
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    const key = (e: KeyboardEvent) => { if ((e.ctrlKey || e.metaKey) && e.key === 'k') { e.preventDefault(); box.current?.querySelector('input')?.focus(); } };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', key); };
  }, []);
  const go = (to: string) => { setOpen(false); setQ(''); navigate(to); };
  return (
    <div ref={box} className="relative w-full max-w-md">
      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
      <input aria-label="Search everything" className="input pl-8 pr-14" placeholder="Search projects, clients, tasks…" value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} onFocus={() => setOpen(true)} onKeyDown={(e) => e.key === 'Escape' && setOpen(false)} />
      <kbd className="pointer-events-none absolute right-2 top-1/2 hidden -translate-y-1/2 rounded border border-slate-200 px-1 text-[10px] text-slate-400 sm:block">Ctrl K</kbd>
      {open && debounced.length >= 2 && (
        <div className="absolute z-50 mt-1 max-h-[70vh] w-full overflow-auto rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
          {res.isLoading && <div className="px-3 py-2 text-sm text-slate-400">Searching…</div>}
          {res.data?.length === 0 && <div className="px-3 py-2 text-sm text-slate-400">No results</div>}
          {res.data?.map((g) => (
            <div key={g.resource} className="py-1">
              <div className="px-3 py-1 text-[11px] font-semibold uppercase tracking-wider text-slate-400">{g.label}{g.total > g.rows.length && ` · ${g.total}`}</div>
              {g.rows.map((r: any) => (
                <button key={r.id} type="button" className="block w-full truncate px-3 py-1.5 text-left text-sm hover:bg-brand-50" onClick={() => go(`/r/${g.resource}/${r.id}`)}>
                  {r.number && <span className="mr-2 font-mono text-xs text-slate-400">{r.number}</span>}{r.title}
                </button>
              ))}
              {g.total > g.rows.length && <button type="button" className="px-3 py-1 text-xs text-brand-700 hover:underline" onClick={() => go(`/r/${g.resource}?q=${encodeURIComponent(debounced)}`)}>See all</button>}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NotificationsBell() {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const q = useQuery({ queryKey: ['notifications'], queryFn: () => api.get<{ rows: any[]; unread: number }>('/api/notifications'), refetchInterval: 60_000 });
  const read = useMutation({ mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const readAll = useMutation({ mutationFn: () => api.post('/api/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const navigate = useNavigate();
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);
  const unread = q.data?.unread ?? 0;
  return (
    <div ref={box} className="relative">
      <button type="button" aria-label={`Notifications${unread ? `, ${unread} unread` : ''}`} className="relative rounded-md p-2 text-slate-500 hover:bg-slate-100" onClick={() => setOpen((o) => !o)}>
        <Bell className="size-4" />
        {unread > 0 && <span className="absolute right-1 top-1 flex min-w-4 items-center justify-center rounded-full bg-red-500 px-1 text-[10px] font-semibold text-white">{unread > 99 ? '99+' : unread}</span>}
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-96 max-w-[calc(100vw-2rem)] rounded-lg border border-slate-200 bg-white shadow-xl">
          <div className="flex items-center justify-between border-b border-slate-100 px-3 py-2">
            <span className="text-sm font-semibold">Notifications</span>
            {unread > 0 && <button type="button" className="text-xs text-brand-700 hover:underline" onClick={() => readAll.mutate()}>Mark all read</button>}
          </div>
          <ul className="max-h-[60vh] overflow-auto">
            {q.data?.rows.length === 0 && <li className="px-3 py-6 text-center text-sm text-slate-400">You’re all caught up</li>}
            {q.data?.rows.slice(0, 15).map((n) => (
              <li key={n.id}>
                <button type="button" className={cx('block w-full border-b border-slate-50 px-3 py-2 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/50')}
                  onClick={() => { if (!n.readAt) read.mutate(n.id); setOpen(false); if (n.link) navigate(n.link); }}>
                  <div className="flex items-start gap-2">
                    {!n.readAt && <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-brand-600" />}
                    <div className="min-w-0">
                      <div className="text-sm text-slate-800">{n.title}</div>
                      {n.body && <div className="truncate text-xs text-slate-500">{n.body}</div>}
                      <div className="text-[11px] text-slate-400">{ago(n.createdAt)}</div>
                    </div>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <Link to="/notifications" onClick={() => setOpen(false)} className="block border-t border-slate-100 px-3 py-2 text-center text-xs text-brand-700 hover:bg-slate-50">View all</Link>
        </div>
      )}
    </div>
  );
}

function UserMenu() {
  const { user } = useMeta();
  const [open, setOpen] = useState(false);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const logout = useMutation({ mutationFn: () => api.post('/api/auth/logout'), onSettled: () => { qc.clear(); navigate('/login'); } });
  return (
    <div className="relative" onBlur={(e) => !e.currentTarget.contains(e.relatedTarget) && setOpen(false)}>
      <button type="button" className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-slate-100" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className="flex size-7 items-center justify-center rounded-full bg-slate-800 text-xs font-medium text-white">{user.name.split(' ').map((p) => p[0]).slice(0, 2).join('')}</span>
        <span className="hidden text-left sm:block">
          <span className="block text-sm font-medium leading-tight text-slate-800">{user.name}</span>
          <span className="block text-[11px] leading-tight text-slate-500">{user.roles.filter((r) => r !== 'employee').join(', ') || 'Employee'}</span>
        </span>
        <ChevronDown className="size-3.5 text-slate-400" />
      </button>
      {open && (
        <div className="absolute right-0 z-50 mt-1 w-52 rounded-lg border border-slate-200 bg-white py-1 shadow-xl">
          {user.employeeId && <Link to={`/r/employees/${user.employeeId}`} className="block px-3 py-1.5 text-sm hover:bg-slate-50" onClick={() => setOpen(false)}>My profile</Link>}
          <Link to="/change-password" className="flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-slate-50" onClick={() => setOpen(false)}><KeyRound className="size-3.5" /> Change password</Link>
          <button type="button" className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-red-600 hover:bg-red-50" onClick={() => logout.mutate()}><LogOut className="size-3.5" /> Sign out</button>
        </div>
      )}
    </div>
  );
}

export function Layout() {
  const [mobileOpen, setMobileOpen] = useState(false);
  const loc = useLocation();
  useEffect(() => setMobileOpen(false), [loc.pathname]);
  return (
    <div className="flex h-dvh">
      <aside className="hidden w-60 shrink-0 border-r border-slate-200 bg-white lg:block"><Sidebar /></aside>
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div className="absolute inset-0 bg-slate-900/30" onClick={() => setMobileOpen(false)} />
          <aside className="absolute inset-y-0 left-0 w-64 bg-white shadow-xl">
            <button type="button" aria-label="Close menu" className="absolute right-2 top-3 p-1" onClick={() => setMobileOpen(false)}><X className="size-4" /></button>
            <Sidebar onNavigate={() => setMobileOpen(false)} />
          </aside>
        </div>
      )}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 shrink-0 items-center gap-3 border-b border-slate-200 bg-white px-4">
          <button type="button" aria-label="Open menu" className="rounded p-1.5 hover:bg-slate-100 lg:hidden" onClick={() => setMobileOpen(true)}><Menu className="size-5" /></button>
          <GlobalSearch />
          <div className="ml-auto flex items-center gap-1">
            <NotificationsBell />
            <UserMenu />
          </div>
        </header>
        <main className="flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[1400px] px-4 py-6 lg:px-8"><Outlet /></div>
        </main>
      </div>
    </div>
  );
}
