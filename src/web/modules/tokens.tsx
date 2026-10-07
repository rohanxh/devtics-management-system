import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Copy, KeyRound } from 'lucide-react';
import { api } from '../lib/api';
import { ago, date } from '../lib/format';
import { EXTRA_ROUTES } from '../lib/extensions';
import { Badge, Button, Card, EmptyState, Field, Modal, PageHeader, Spinner } from '../components/ui';
import { useToast } from '../components/toast';

function ApiTokensPage() {
  const qc = useQueryClient();
  const toast = useToast();
  const [name, setName] = useState('');
  const [days, setDays] = useState(90);
  const [created, setCreated] = useState<string | null>(null);
  const q = useQuery({ queryKey: ['api-tokens'], queryFn: () => api.get<any[]>('/api/auth/tokens') });
  const create = useMutation({
    mutationFn: () => api.post<any>('/api/auth/tokens', { name, expiresInDays: days }),
    onSuccess: (r) => { setCreated(r.token); setName(''); qc.invalidateQueries({ queryKey: ['api-tokens'] }); },
    onError: toast.error,
  });
  const revoke = useMutation({ mutationFn: (id: string) => api.del(`/api/auth/tokens/${id}`), onSuccess: () => { toast.success('Token revoked'); qc.invalidateQueries({ queryKey: ['api-tokens'] }); }, onError: toast.error });
  return (
    <>
      <PageHeader title="API tokens" subtitle="For integrations and scripts. A token acts with exactly your permissions — send it as “Authorization: Bearer …”." />
      <Card className="mb-4" title="Create a token">
        <div className="flex flex-wrap items-end gap-2">
          <div className="w-64"><Field label="Name" htmlFor="tk-n"><input id="tk-n" className="input" placeholder="e.g. GitHub webhook bridge" value={name} onChange={(e) => setName(e.target.value)} /></Field></div>
          <div className="w-40"><Field label="Expires in (days)" htmlFor="tk-d"><input id="tk-d" type="number" min={1} max={365} className="input" value={days} onChange={(e) => setDays(Number(e.target.value))} /></Field></div>
          <Button variant="primary" loading={create.isPending} disabled={name.trim().length < 2} onClick={() => create.mutate()}><KeyRound className="size-3.5" /> Create</Button>
        </div>
      </Card>
      <Card bodyClass="p-0">
        {q.isLoading ? <Spinner /> : !q.data?.length ? <EmptyState title="No tokens yet" /> : (
          <table className="w-full text-sm">
            <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="px-4 py-2">Name</th><th className="px-2 py-2">Token</th><th className="px-2 py-2">Last used</th><th className="px-2 py-2">Expires</th><th className="px-4 py-2" /></tr></thead>
            <tbody>{q.data.map((t) => {
              const dead = t.revokedAt || new Date(t.expiresAt) < new Date();
              return (
                <tr key={t.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-2">{t.name}</td>
                  <td className="px-2 py-2 font-mono text-xs">{t.prefix}…</td>
                  <td className="px-2 py-2 text-xs">{t.lastUsedAt ? ago(t.lastUsedAt) : 'never'}</td>
                  <td className="px-2 py-2 text-xs">{date(t.expiresAt)}</td>
                  <td className="px-4 py-2 text-right">{dead ? <Badge>{t.revokedAt ? 'revoked' : 'expired'}</Badge> : <Button size="sm" variant="danger" onClick={() => confirm('Revoke this token? Integrations using it will stop working.') && revoke.mutate(t.id)}>Revoke</Button>}</td>
                </tr>
              );
            })}</tbody>
          </table>
        )}
      </Card>
      <Modal open={!!created} onClose={() => setCreated(null)} title="Your new token" footer={<Button variant="primary" onClick={() => setCreated(null)}>Done</Button>}>
        <p className="mb-3 text-sm text-slate-600">Copy it now and store it in your password manager — it will not be shown again.</p>
        <div className="flex items-center gap-2 rounded-md bg-slate-100 p-3 font-mono text-xs"><span className="flex-1 select-all break-all">{created}</span><Button size="sm" onClick={() => navigator.clipboard.writeText(created ?? '')}><Copy className="size-3.5" /></Button></div>
      </Modal>
    </>
  );
}
EXTRA_ROUTES.push({ path: 'settings/tokens', component: ApiTokensPage });
