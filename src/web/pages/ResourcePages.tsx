import { useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Pencil, Trash2 } from 'lucide-react';
import { api } from '../lib/api';
import { useCan, useResource, type ResourceMeta } from '../lib/meta';
import { actionsFor, panelsFor } from '../lib/extensions';
import { Button, Card, ErrorState, PageHeader, Spinner, Tabs } from '../components/ui';
import { FieldValue } from '../components/fields';
import { ResourceList } from '../components/ResourceList';
import { ResourceFormModal } from '../components/ResourceForm';
import { Activity, AuditTrail, Comments, Files } from '../components/Collab';
import { useToast } from '../components/toast';

export function ResourceListPage() {
  const { key = '' } = useParams();
  const meta = useResource(key);
  const [params, setParams] = useSearchParams();
  if (!meta) return <ErrorState error={{ status: 403, message: 'This section does not exist or you do not have access to it.' }} />;
  return (
    <>
      <PageHeader title={meta.plural} subtitle={meta.description} />
      <ResourceList key={key} resource={key} initialQuery={Object.fromEntries(params)}
        onQueryChange={(q) => setParams(Object.fromEntries(Object.entries(q).filter(([, v]) => v)), { replace: true })} />
    </>
  );
}

export function RecordPage() {
  const { key = '', id = '' } = useParams();
  const meta = useResource(key);
  if (!meta) return <ErrorState error={{ status: 403, message: 'You do not have access to this record type.' }} />;
  return <RecordInner key={`${key}/${id}`} meta={meta} id={id} />;
}

function RecordInner({ meta, id }: { meta: ResourceMeta; id: string }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const can = useCan();
  const [editing, setEditing] = useState(false);
  const q = useQuery({ queryKey: ['r', meta.key, 'one', id], queryFn: () => api.get(`/api/r/${meta.key}/${id}`) });
  const del = useMutation({
    mutationFn: () => api.del(`/api/r/${meta.key}/${id}`),
    onSuccess: () => { toast.success(`${meta.label} deleted`); qc.invalidateQueries({ queryKey: ['r', meta.key] }); navigate(`/r/${meta.key}`); },
    onError: toast.error,
  });
  const reload = () => { qc.invalidateQueries({ queryKey: ['r', meta.key, 'one', id] }); qc.invalidateQueries({ queryKey: ['activity', meta.key, id] }); };

  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const row = q.data;
  const panels = panelsFor(meta.key);
  const Actions = actionsFor(meta.key);

  const tabs = [
    ...panels.filter((p) => p.placement !== 'top').map((p) => ({ key: p.key, label: p.label })),
    ...(meta.children ?? []).map((c) => ({ key: `child:${c.resource}:${c.field}`, label: c.label ?? c.resource })),
    ...(meta.collab?.comments ? [{ key: 'comments', label: 'Comments' }] : []),
    ...(meta.collab?.files ? [{ key: 'files', label: 'Files' }] : []),
    { key: 'activity', label: 'Activity' },
    ...(can('audit.view') ? [{ key: 'audit', label: 'Audit trail' }] : []),
  ];

  const groups = new Map<string, [string, any][]>();
  for (const [k, f] of Object.entries(meta.fields)) {
    if (f.type === 'markdown') continue;
    const g = f.group ?? 'Details';
    groups.set(g, [...(groups.get(g) ?? []), [k, f]]);
  }
  const longText = Object.entries(meta.fields).filter(([k, f]) => f.type === 'markdown' && row[k]);

  return (
    <>
      <PageHeader
        breadcrumb={<Link to={`/r/${meta.key}`} className="hover:underline">{meta.plural}</Link>}
        title={<>{meta.numberField && row[meta.numberField] && <span className="mr-2 font-mono text-base text-slate-400">{row[meta.numberField]}</span>}{row._title}</>}
        actions={<>
          {Actions && <Actions record={row} reload={reload} />}
          {row._can?.edit && <Button onClick={() => setEditing(true)}><Pencil className="size-3.5" /> Edit</Button>}
          {row._can?.delete && <Button variant="ghost" aria-label="Delete" onClick={() => confirm(`Delete this ${meta.label.toLowerCase()}? This cannot be undone.`) && del.mutate()}><Trash2 className="size-3.5 text-red-600" /></Button>}
        </>}
      />
      {panels.filter((p) => p.placement === 'top').map((p) => <div key={p.key} className="mb-4"><p.component record={row} reload={reload} /></div>)}
      <div className="grid grid-cols-1 gap-5 xl:grid-cols-3">
        <div className="space-y-4 xl:col-span-1">
          {[...groups.entries()].map(([g, fields]) => (
            <Card key={g} title={g}>
              <dl className="grid grid-cols-1 gap-x-4 gap-y-2.5 text-sm sm:grid-cols-2 xl:grid-cols-1">
                {fields.map(([k, f]) => (
                  <div key={k} className="grid grid-cols-[minmax(0,10rem)_1fr] gap-2">
                    <dt className="text-slate-500">{f.label}</dt>
                    <dd className="min-w-0 break-words text-slate-900"><FieldValue field={f} name={k} row={row} /></dd>
                  </div>
                ))}
              </dl>
            </Card>
          ))}
        </div>
        <div className="space-y-4 xl:col-span-2">
          {longText.map(([k, f]) => (
            <Card key={k} title={f.label}><div className="whitespace-pre-wrap text-sm leading-relaxed text-slate-700">{row[k]}</div></Card>
          ))}
          <RecordTabs tabs={tabs} meta={meta} row={row} reload={reload} />
        </div>
      </div>
      <ResourceFormModal resource={meta.key} open={editing} onClose={() => setEditing(false)} record={row} onSaved={reload} />
    </>
  );
}

function RecordTabs({ tabs, meta, row, reload }: { tabs: { key: string; label: string }[]; meta: ResourceMeta; row: any; reload: () => void }) {
  const [active, setActive] = useState(tabs[0]?.key);
  const panel = panelsFor(meta.key).find((p) => p.key === active);
  return (
    <div className="card">
      <div className="px-2"><Tabs tabs={tabs.map((t) => ({ key: t.key, label: <TabLabel t={t} /> }))} active={active} onChange={setActive} /></div>
      <div className="p-4">
        {panel && <panel.component record={row} reload={reload} />}
        {active?.startsWith('child:') && (() => {
          const [, resource, field] = active.split(':');
          return <ResourceList key={active} resource={resource} fixed={{ [field]: row.id }} compact />;
        })()}
        {active === 'comments' && <Comments resource={meta.key} id={row.id} />}
        {active === 'files' && <Files resource={meta.key} id={row.id} canUpload={!!row._can?.edit} />}
        {active === 'activity' && <Activity resource={meta.key} id={row.id} />}
        {active === 'audit' && <AuditTrail resource={meta.key} id={row.id} />}
      </div>
    </div>
  );
}

function TabLabel({ t }: { t: { key: string; label: string } }) {
  const child = t.key.startsWith('child:') ? t.key.split(':')[1] : null;
  const meta = useResource(child ?? '');
  return <>{child ? (t.label !== child ? t.label : meta?.plural ?? child) : t.label}</>;
}
