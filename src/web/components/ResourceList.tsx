import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router';
import { keepPreviousData, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Bookmark, Download, Filter, KanbanSquare, Plus, Search, Table2, Trash2 } from 'lucide-react';
import { api, qs } from '../lib/api';
import { humanize } from '../lib/format';
import { useMeta, useResource, type ResourceMeta } from '../lib/meta';
import { Button, EmptyState, ErrorState, Spinner, cx } from './ui';
import { FieldValue, RefSelect, StageSelect } from './fields';
import { ResourceFormModal } from './ResourceForm';
import { Kanban } from './Kanban';
import { useToast } from './toast';

export interface ListResponse { rows: any[]; total: number; page: number; pageSize: number }

function useDebounced<T>(v: T, ms = 300) {
  const [d, setD] = useState(v);
  useEffect(() => { const t = setTimeout(() => setD(v), ms); return () => clearTimeout(t); }, [v, ms]);
  return d;
}

/**
 * Generic, metadata-driven list: search, filters, sorting, pagination, saved views, CSV export,
 * bulk actions and an optional Kanban board. `fixed` filters (e.g. parent id) are always applied.
 */
export function ResourceList({ resource, fixed, columns, compact, createDefaults, title, hideCreate, initialQuery, onQueryChange }: {
  resource: string; fixed?: Record<string, string>; columns?: string[]; compact?: boolean;
  createDefaults?: Record<string, any>; title?: string; hideCreate?: boolean;
  initialQuery?: Record<string, string>; onQueryChange?: (q: Record<string, string>) => void;
}) {
  const meta = useResource(resource);
  if (!meta) return <ErrorState error={{ status: 403, message: 'You do not have access to this list.' }} />;
  return <ListInner meta={meta} fixed={fixed} columns={columns} compact={compact} createDefaults={createDefaults}
    title={title} hideCreate={hideCreate} initialQuery={initialQuery} onQueryChange={onQueryChange} />;
}

function ListInner({ meta, fixed, columns, compact, createDefaults, hideCreate, initialQuery, onQueryChange }: {
  meta: ResourceMeta; fixed?: Record<string, string>; columns?: string[]; compact?: boolean; createDefaults?: Record<string, any>;
  title?: string; hideCreate?: boolean; initialQuery?: Record<string, string>; onQueryChange?: (q: Record<string, string>) => void;
}) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const toast = useToast();
  const { pipelines } = useMeta();
  const [query, setQuery] = useState<Record<string, string>>(initialQuery ?? {});
  const [search, setSearch] = useState(query.q ?? '');
  const [showFilters, setShowFilters] = useState(Object.keys(query).some((k) => !['q', 'sort', 'page', 'view'].includes(k)));
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const view = query.view === 'board' && meta.board ? 'board' : 'table';
  const q = useDebounced(search);

  useEffect(() => { setQuery((s) => (s.q ?? '') === q ? s : { ...s, q, page: '1' }); }, [q]);
  useEffect(() => { onQueryChange?.(query); }, [query]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k: string, v: string | null | undefined) => setQuery((s) => {
    const n: Record<string, string> = { ...s, page: "1" };
    if (v === null || v === undefined || v === '') delete n[k]; else n[k] = v;
    return n;
  });

  const cols = useMemo(() => {
    const keys = columns ?? Object.entries(meta.fields).filter(([, f]) => f.list).map(([k]) => k);
    return keys.filter((k) => meta.fields[k] && !(fixed && k in fixed));
  }, [meta, columns, fixed]);
  const filterFields = Object.entries(meta.fields).filter(([k, f]) => f.filter && !(fixed && k in fixed));

  const params = { ...query, ...fixed, pageSize: view === 'board' ? '200' : compact ? '10' : '25' };
  delete (params as any).view;
  const listQ = useQuery({
    queryKey: ['r', meta.key, 'list', params],
    queryFn: () => api.get<ListResponse>(`/api/r/${meta.key}${qs(params)}`),
    placeholderData: keepPreviousData,
  });

  const views = useQuery({ queryKey: ['views', meta.key], queryFn: () => api.get<any[]>(`/api/views?resource=${meta.key}`), enabled: !compact });
  const saveView = useMutation({
    mutationFn: (name: string) => api.post('/api/views', { resource: meta.key, name, query: Object.fromEntries(Object.entries(query).filter(([k]) => k !== 'page')) }),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['views', meta.key] }); toast.success('View saved'); },
    onError: toast.error,
  });

  const bulk = useMutation({
    mutationFn: (body: { action: 'delete' | 'update'; data?: any }) => api.post<{ results: { ok: boolean; error?: string }[] }>(`/api/r/${meta.key}/bulk`, { ids: [...selected], ...body }),
    onSuccess: (r) => {
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast.error(`${failed.length} of ${r.results.length} failed: ${failed[0].error}`);
      else toast.success(`Updated ${r.results.length} record(s)`);
      setSelected(new Set());
      qc.invalidateQueries({ queryKey: ['r', meta.key] });
    },
    onError: toast.error,
  });

  const sort = query.sort ?? meta.defaultSort;
  const toggleSort = (k: string) => set('sort', sort === k ? `-${k}` : k);
  const data = listQ.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const statusField = meta.status?.field;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-48 flex-1 sm:max-w-xs">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
          <input aria-label={`Search ${meta.plural}`} className="input pl-8" placeholder={`Search ${meta.plural.toLowerCase()}…`} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {filterFields.length > 0 && (
          <Button variant={showFilters ? 'primary' : 'secondary'} onClick={() => setShowFilters((s) => !s)}><Filter className="size-3.5" /> Filters</Button>
        )}
        {meta.assignees?.length ? (
          <label className="inline-flex items-center gap-1.5 text-sm text-slate-600">
            <input type="checkbox" className="size-4 rounded border-slate-300" checked={query.mine === '1'} onChange={(e) => set('mine', e.target.checked ? '1' : null)} />
            Assigned to me
          </label>
        ) : null}
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {!compact && views.data && (
            <select aria-label="Saved views" className="input w-auto py-1" value="" onChange={(e) => {
              const v = views.data!.find((x) => x.id === e.target.value);
              if (v) { setQuery(v.query); setSearch(v.query.q ?? ''); setShowFilters(true); }
            }}>
              <option value="">Saved views…</option>
              {views.data.map((v) => <option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          )}
          {!compact && (
            <Button title="Save current filters as a view" onClick={() => { const n = prompt('Name this view'); if (n?.trim()) saveView.mutate(n.trim()); }}>
              <Bookmark className="size-3.5" /> <span className="hidden lg:inline">Save view</span>
            </Button>
          )}
          {meta.board && (
            <div className="inline-flex rounded-md border border-slate-300 bg-white p-0.5">
              <button type="button" aria-label="Table view" className={cx('rounded p-1', view === 'table' && 'bg-slate-100')} onClick={() => set('view', null)}><Table2 className="size-4" /></button>
              <button type="button" aria-label="Board view" className={cx('rounded p-1', view === 'board' && 'bg-slate-100')} onClick={() => set('view', 'board')}><KanbanSquare className="size-4" /></button>
            </div>
          )}
          {meta.can.export && !compact && (
            <a className="inline-flex items-center gap-1.5 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-xs hover:bg-slate-50"
              href={`/api/r/${meta.key}/export.csv${qs({ ...query, ...fixed, page: undefined, view: undefined })}`}>
              <Download className="size-3.5" /> CSV
            </a>
          )}
          {meta.can.create && !hideCreate && (
            <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-3.5" /> New {meta.label.toLowerCase()}</Button>
          )}
        </div>
      </div>

      {showFilters && filterFields.length > 0 && (
        <div className="card grid grid-cols-1 gap-3 p-3 sm:grid-cols-2 lg:grid-cols-4">
          {filterFields.map(([k, f]) => (
            <div key={k}>
              <label className="label" htmlFor={`flt-${k}`}>{f.label}</label>
              {f.type === 'enum' ? (
                <select id={`flt-${k}`} className="input" value={query[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
                  <option value="">Any</option>
                  {f.options?.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
                </select>
              ) : f.type === 'ref' ? (
                <RefSelect id={`flt-${k}`} refKey={f.ref!} value={query[k] ?? null} onChange={(v) => set(k, v)} placeholder="Any" />
              ) : f.type === 'stage' ? (
                <StageSelect id={`flt-${k}`} pipeline={f.pipeline!} value={query[k] ?? null} onChange={(v) => set(k, v)} />
              ) : f.type === 'bool' ? (
                <select id={`flt-${k}`} className="input" value={query[k] ?? ''} onChange={(e) => set(k, e.target.value)}>
                  <option value="">Any</option><option value="true">Yes</option><option value="false">No</option>
                </select>
              ) : f.type === 'date' || f.type === 'datetime' ? (
                <div className="flex gap-1">
                  <input id={`flt-${k}`} aria-label={`${f.label} from`} type="date" className="input" value={query[`${k}__gte`] ?? ''} onChange={(e) => set(`${k}__gte`, e.target.value)} />
                  <input aria-label={`${f.label} to`} type="date" className="input" value={query[`${k}__lte`] ?? ''} onChange={(e) => set(`${k}__lte`, e.target.value)} />
                </div>
              ) : (
                <input id={`flt-${k}`} className="input" value={query[k] ?? ''} onChange={(e) => set(k, e.target.value)} />
              )}
            </div>
          ))}
          <div className="flex items-end">
            <Button variant="ghost" onClick={() => { setQuery({}); setSearch(''); }}>Clear all</Button>
          </div>
        </div>
      )}

      {selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-brand-50 px-3 py-2 text-sm">
          <span className="font-medium text-brand-700">{selected.size} selected</span>
          {statusField && meta.can.edit && (
            <select aria-label="Set status" className="input w-auto py-1" value="" onChange={(e) => e.target.value && bulk.mutate({ action: 'update', data: { [statusField]: e.target.value } })}>
              <option value="">Set {meta.fields[statusField]?.label.toLowerCase()}…</option>
              {meta.fields[statusField]?.options?.map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
            </select>
          )}
          {meta.can.delete && (
            <Button size="sm" variant="danger" loading={bulk.isPending} onClick={() => confirm(`Delete ${selected.size} record(s)?`) && bulk.mutate({ action: 'delete' })}>
              <Trash2 className="size-3.5" /> Delete
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => setSelected(new Set())}>Clear</Button>
        </div>
      )}

      {listQ.isError ? <ErrorState error={listQ.error} retry={() => listQ.refetch()} /> : !data ? <Spinner /> : view === 'board' ? (
        <Kanban meta={meta} rows={data.rows} pipeline={meta.fields[meta.board!]?.pipeline ? pipelines[meta.fields[meta.board!].pipeline!] : undefined} />
      ) : data.rows.length === 0 ? (
        <div className="card"><EmptyState title={`No ${meta.plural.toLowerCase()} found`} hint={Object.keys(query).length ? 'Try clearing filters or search.' : meta.description}
          action={meta.can.create && !hideCreate ? <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-3.5" /> New {meta.label.toLowerCase()}</Button> : undefined} /></div>
      ) : (
        <div className="card overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 bg-slate-50/60 text-left text-xs font-medium text-slate-500">
                {(meta.can.edit || meta.can.delete) && !compact && (
                  <th className="w-8 px-3 py-2">
                    <input type="checkbox" aria-label="Select all" className="size-4 rounded border-slate-300"
                      checked={data.rows.length > 0 && data.rows.every((r) => selected.has(r.id))}
                      onChange={(e) => setSelected(e.target.checked ? new Set(data.rows.map((r) => r.id)) : new Set())} />
                  </th>
                )}
                {meta.numberField && <th className="px-3 py-2">#</th>}
                {cols.map((k) => (
                  <th key={k} className="px-3 py-2 whitespace-nowrap" aria-sort={sort === k ? 'ascending' : sort === `-${k}` ? 'descending' : undefined}>
                    <button type="button" className="inline-flex items-center gap-1 hover:text-slate-800" onClick={() => toggleSort(k)}>
                      {meta.fields[k].label}
                      {sort === k ? <ArrowUp className="size-3" /> : sort === `-${k}` ? <ArrowDown className="size-3" /> : null}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className={cx(listQ.isFetching && 'opacity-60')}>
              {data.rows.map((r) => (
                <tr key={r.id} className="cursor-pointer border-b border-slate-100 last:border-0 hover:bg-slate-50" onClick={() => navigate(`/r/${meta.key}/${r.id}`)}>
                  {(meta.can.edit || meta.can.delete) && !compact && (
                    <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" aria-label="Select row" className="size-4 rounded border-slate-300" checked={selected.has(r.id)}
                        onChange={(e) => setSelected((s) => { const n = new Set(s); if (e.target.checked) n.add(r.id); else n.delete(r.id); return n; })} />
                    </td>
                  )}
                  {meta.numberField && <td className="px-3 py-2 font-mono text-xs text-slate-500">{r[meta.numberField]}</td>}
                  {cols.map((k, i) => (
                    <td key={k} className={cx('px-3 py-2 max-w-xs truncate', i === 0 && 'font-medium text-slate-900')}>
                      <FieldValue field={meta.fields[k]} name={k} row={r} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
          {data.total > data.pageSize && (
            <div className="flex items-center justify-between border-t border-slate-100 px-3 py-2 text-xs text-slate-500">
              <span>{(data.page - 1) * data.pageSize + 1}–{Math.min(data.page * data.pageSize, data.total)} of {data.total}</span>
              <div className="flex gap-1">
                <Button size="sm" disabled={data.page <= 1} onClick={() => setQuery((s) => ({ ...s, page: String(data.page - 1) }))}>Previous</Button>
                <Button size="sm" disabled={data.page >= pages} onClick={() => setQuery((s) => ({ ...s, page: String(data.page + 1) }))}>Next</Button>
              </div>
            </div>
          )}
        </div>
      )}

      <ResourceFormModal resource={meta.key} open={creating} onClose={() => setCreating(false)} defaults={{ ...createDefaults, ...fixed }}
        onSaved={(row) => !compact && navigate(`/r/${meta.key}/${row.id}`)} />
    </div>
  );
}
