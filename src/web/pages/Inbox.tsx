import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { ago, datetime, humanize } from '../lib/format';
import { useCan } from '../lib/meta';
import { Badge, Button, Card, EmptyState, ErrorState, Modal, PageHeader, Spinner, StatusBadge, Tabs, cx } from '../components/ui';
import { useToast } from '../components/toast';

export function ApprovalsList({ compact }: { compact?: boolean }) {
  const can = useCan();
  const [tab, setTab] = useState('pending');
  const [deciding, setDeciding] = useState<{ a: any; decision: 'approved' | 'rejected' } | null>(null);
  const [note, setNote] = useState('');
  const qc = useQueryClient();
  const toast = useToast();
  const scope = tab === 'all' ? 'all' : 'mine';
  const status = tab === 'pending' ? 'pending' : tab === 'decided' ? undefined : undefined;
  const q = useQuery({
    queryKey: ['approvals', tab],
    queryFn: () => api.get<any[]>(`/api/approvals?scope=${scope}${status ? `&status=${status}` : ''}`),
  });
  const decide = useMutation({
    mutationFn: () => api.post(`/api/approvals/${deciding!.a.id}/decide`, { decision: deciding!.decision, note }),
    onSuccess: () => { toast.success(`Request ${deciding!.decision}`); setDeciding(null); setNote(''); qc.invalidateQueries(); },
    onError: toast.error,
  });
  const rows = (q.data ?? []).filter((a) => tab !== 'decided' || a.status !== 'pending');
  const list = compact ? rows.filter((a) => a.canDecide).slice(0, 6) : rows;

  return (
    <>
      {!compact && (
        <div className="mb-3">
          <Tabs active={tab} onChange={setTab} tabs={[
            { key: 'pending', label: 'Pending' }, { key: 'decided', label: 'History' },
            ...(can('approvals.view') ? [{ key: 'all', label: 'All requests' }] : []),
          ]} />
        </div>
      )}
      {q.isLoading ? <Spinner /> : q.isError ? <ErrorState error={q.error} /> : list.length === 0 ? (
        <EmptyState title={compact ? 'Nothing waiting for your approval' : 'No approval requests'} />
      ) : (
        <ul className="divide-y divide-slate-100">
          {list.map((a) => (
            <li key={a.id} className="flex flex-wrap items-center gap-3 py-2.5">
              <div className="min-w-0 flex-1">
                <Link to={a.link} className="text-sm font-medium text-slate-900 hover:underline">{a.title}</Link>
                <div className="mt-0.5 flex flex-wrap gap-2 text-xs text-slate-500">
                  <Badge>{humanize(a.kind)}</Badge>
                  <span>by {a.requestedByName ?? 'System'} · {ago(a.createdAt)}</span>
                  {a.approverRoleKey && <span>→ {a.approverRoleKey.toUpperCase()}</span>}
                  {a.decidedByName && <span>· decided by {a.decidedByName} {datetime(a.decidedAt)}</span>}
                </div>
                {a.details && !compact && <p className="mt-1 text-xs text-slate-600">{a.details}</p>}
                {a.decisionNote && <p className="mt-1 text-xs italic text-slate-600">“{a.decisionNote}”</p>}
              </div>
              <StatusBadge value={a.status} />
              {a.canDecide && (
                <div className="flex gap-1.5">
                  <Button size="sm" variant="primary" onClick={() => setDeciding({ a, decision: 'approved' })}>Approve</Button>
                  <Button size="sm" onClick={() => setDeciding({ a, decision: 'rejected' })}>Reject</Button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      <Modal open={!!deciding} onClose={() => setDeciding(null)} title={deciding?.decision === 'approved' ? 'Approve request' : 'Reject request'}
        footer={<><Button onClick={() => setDeciding(null)}>Cancel</Button>
          <Button variant={deciding?.decision === 'approved' ? 'primary' : 'danger'} loading={decide.isPending}
            disabled={deciding?.decision === 'rejected' && !note.trim()} onClick={() => decide.mutate()}>
            {deciding?.decision === 'approved' ? 'Approve' : 'Reject'}
          </Button></>}>
        <p className="mb-3 text-sm font-medium">{deciding?.a.title}</p>
        <label className="label" htmlFor="decision-note">{deciding?.decision === 'rejected' ? 'Reason (required)' : 'Note (optional)'}</label>
        <textarea id="decision-note" className="input" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
      </Modal>
    </>
  );
}

export function ApprovalsPage() {
  return (
    <>
      <PageHeader title="Approvals" subtitle="Requests waiting for your decision, and requests you’ve made." />
      <Card><ApprovalsList /></Card>
    </>
  );
}

export function NotificationsPage() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [unread, setUnread] = useState(false);
  const q = useQuery({ queryKey: ['notifications', 'page', unread], queryFn: () => api.get<{ rows: any[]; unread: number }>(`/api/notifications${unread ? '?unread=1' : ''}`) });
  const read = useMutation({ mutationFn: (id: string) => api.post(`/api/notifications/${id}/read`), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  const readAll = useMutation({ mutationFn: () => api.post('/api/notifications/read-all'), onSuccess: () => qc.invalidateQueries({ queryKey: ['notifications'] }) });
  return (
    <>
      <PageHeader title="Inbox" subtitle="Assignments, mentions, approvals and alerts."
        actions={<>
          <label className="inline-flex items-center gap-1.5 text-sm"><input type="checkbox" className="size-4" checked={unread} onChange={(e) => setUnread(e.target.checked)} /> Unread only</label>
          <Button onClick={() => readAll.mutate()}>Mark all read</Button>
        </>} />
      <Card bodyClass="p-0">
        {q.isLoading ? <Spinner /> : !q.data?.rows.length ? <EmptyState title="You’re all caught up" /> : (
          <ul>
            {q.data.rows.map((n) => (
              <li key={n.id}>
                <button type="button" onClick={() => { if (!n.readAt) read.mutate(n.id); if (n.link) navigate(n.link); }}
                  className={cx('flex w-full items-start gap-3 border-b border-slate-100 px-4 py-3 text-left hover:bg-slate-50', !n.readAt && 'bg-brand-50/40')}>
                  <span className={cx('mt-1.5 size-2 shrink-0 rounded-full', n.readAt ? 'bg-transparent' : 'bg-brand-600')} />
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-slate-900">{n.title}</div>
                    {n.body && <div className="text-xs text-slate-500">{n.body}</div>}
                  </div>
                  <Badge>{humanize(n.kind)}</Badge>
                  <span className="shrink-0 text-xs text-slate-400">{ago(n.createdAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}
