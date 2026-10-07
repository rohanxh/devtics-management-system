import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BookOpenCheck, CheckCircle2, Pencil, Plus, Search, Send } from 'lucide-react';
import { api, qs } from '../lib/api';
import { ago, date, humanize } from '../lib/format';
import { useMeta } from '../lib/meta';
import { EXTRA_ROUTES } from '../lib/extensions';
import { Badge, Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, Progress, Spinner, Tabs, cx } from '../components/ui';
import { Markdown } from '../components/Markdown';
import { Comments } from '../components/Collab';
import { useToast } from '../components/toast';
import { HOME_WIDGETS } from '../pages/Home';

const CATEGORIES = ['sop', 'policy', 'dev_standard', 'qa_standard', 'pm_procedure', 'sales_procedure', 'hr_policy', 'template', 'training', 'architecture', 'other'];

function MyReadingCard() {
  const q = useQuery({ queryKey: ['kb-my-reading'], queryFn: () => api.get<any[]>('/api/kb/my-reading') });
  if (!q.data?.length) return null;
  return (
    <Card title={<span className="inline-flex items-center gap-1.5"><BookOpenCheck className="size-4 text-brand-600" /> Required reading</span>}>
      <ul className="space-y-1.5 text-sm">{q.data.map((r) => (
        <li key={r.articleId} className="flex justify-between gap-2">
          <Link to={`/kb/${r.slug}`} className="truncate font-medium text-brand-700 hover:underline">{r.title}</Link>
          <span className={cx('shrink-0 text-xs', r.dueDate < new Date().toISOString().slice(0, 10) ? 'font-medium text-red-600' : 'text-slate-500')}>by {date(r.dueDate)}</span>
        </li>
      ))}</ul>
    </Card>
  );
}
HOME_WIDGETS.push(MyReadingCard);

function Editor({ initial, onCancel, onSave, saving, isNew }: {
  initial: { title: string; body: string; summary?: string | null; category?: string; requiredReading?: boolean; acknowledgeWithinDays?: number };
  onCancel: () => void; onSave: (v: any) => void; saving: boolean; isNew?: boolean;
}) {
  const [v, setV] = useState({ category: 'sop', requiredReading: false, acknowledgeWithinDays: 7, summary: '', ...initial });
  const [tab, setTab] = useState('write');
  return (
    <Card title={isNew ? 'New article' : 'Edit draft'} actions={<><Button onClick={onCancel}>Cancel</Button><Button variant="primary" loading={saving} onClick={() => onSave(v)}>Save draft</Button></>}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-4">
        <div className="md:col-span-2"><Field label="Title" required htmlFor="kb-t"><input id="kb-t" className="input" value={v.title} onChange={(e) => setV({ ...v, title: e.target.value })} /></Field></div>
        <Field label="Category" htmlFor="kb-c"><select id="kb-c" className="input" value={v.category} onChange={(e) => setV({ ...v, category: e.target.value })}>{CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}</select></Field>
        <Field label="Acknowledge within (days)" htmlFor="kb-d"><input id="kb-d" type="number" min={1} max={90} className="input" value={v.acknowledgeWithinDays} onChange={(e) => setV({ ...v, acknowledgeWithinDays: Number(e.target.value) })} /></Field>
        <div className="md:col-span-3"><Field label="Summary" htmlFor="kb-s"><input id="kb-s" className="input" value={v.summary ?? ''} onChange={(e) => setV({ ...v, summary: e.target.value })} /></Field></div>
        <label className="flex items-end gap-2 pb-2 text-sm"><input type="checkbox" className="size-4" checked={v.requiredReading} onChange={(e) => setV({ ...v, requiredReading: e.target.checked })} /> Required reading</label>
      </div>
      <div className="mt-3"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'write', label: 'Write' }, { key: 'preview', label: 'Preview' }]} /></div>
      {tab === 'write'
        ? <textarea aria-label="Content (Markdown)" className="input mt-2 font-mono text-xs" rows={22} value={v.body} onChange={(e) => setV({ ...v, body: e.target.value })} placeholder="# Heading&#10;&#10;Write the procedure in Markdown…" />
        : <div className="mt-3 min-h-40 rounded border border-slate-200 p-4"><Markdown source={v.body || '_Nothing to preview_'} /></div>}
    </Card>
  );
}

function KbListPage() {
  const [q, setQ] = useState('');
  const [debounced, setDebounced] = useState('');
  const [cat, setCat] = useState('');
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const toast = useToast();
  useEffect(() => { const t = setTimeout(() => setDebounced(q), 250); return () => clearTimeout(t); }, [q]);
  const list = useQuery({ queryKey: ['kb', debounced, cat], queryFn: () => api.get<any>(`/api/kb${qs({ q: debounced, category: cat })}`) });
  const create = useMutation({ mutationFn: (v: any) => api.post<any>('/api/kb', v), onSuccess: (a) => { toast.success('Draft created'); navigate(`/kb/${a.slug}?draft=1`); }, onError: toast.error });
  if (creating) return <Editor isNew initial={{ title: '', body: '' }} onCancel={() => setCreating(false)} onSave={(v) => create.mutate(v)} saving={create.isPending} />;
  const rows = list.data?.rows ?? [];
  const groups = CATEGORIES.map((c) => ({ c, items: rows.filter((r: any) => r.category === c) })).filter((g) => g.items.length);
  return (
    <>
      <PageHeader title="Knowledge base" subtitle="SOPs, policies, standards, templates and training — versioned, with required reading."
        actions={list.data?.canCreate && <Button variant="primary" onClick={() => setCreating(true)}><Plus className="size-3.5" /> New article</Button>} />
      <div className="mb-4 flex flex-wrap gap-2">
        <div className="relative w-full max-w-sm"><Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-400" />
          <input aria-label="Search the knowledge base" className="input pl-8" placeholder="Search titles and content…" value={q} onChange={(e) => setQ(e.target.value)} /></div>
        <select aria-label="Category" className="input w-auto" value={cat} onChange={(e) => setCat(e.target.value)}>
          <option value="">All categories</option>{CATEGORIES.map((c) => <option key={c} value={c}>{humanize(c)}</option>)}
        </select>
      </div>
      <div className="mb-4 max-w-xl"><MyReadingCard /></div>
      {list.isLoading ? <Spinner /> : list.isError ? <ErrorState error={list.error} /> : !rows.length ? <div className="card"><EmptyState title="No articles found" /></div> : (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          {groups.map((g) => (
            <Card key={g.c} title={humanize(g.c)} bodyClass="p-0">
              <ul className="divide-y divide-slate-100">{g.items.map((a: any) => (
                <li key={a.id}>
                  <Link to={`/kb/${a.slug}`} className="flex items-start gap-3 px-4 py-2.5 hover:bg-slate-50">
                    <div className="min-w-0 flex-1">
                      <div className="text-sm font-medium text-slate-900">{a.title}</div>
                      {a.summary && <div className="truncate text-xs text-slate-500">{a.summary}</div>}
                      <div className="mt-0.5 text-[11px] text-slate-400">{a.ownerName ?? '—'} · {a.version ? `v${a.version}` : 'unpublished'} · updated {ago(a.updatedAt)}</div>
                    </div>
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {a.status !== 'published' && <Badge tone="amber">{a.status}</Badge>}
                      {a.requiredReading && (a.acknowledged ? <Badge tone="green">Acknowledged</Badge> : a.mustRead ? <Badge tone="red">To read</Badge> : <Badge>Required</Badge>)}
                    </div>
                  </Link>
                </li>
              ))}</ul>
            </Card>
          ))}
        </div>
      )}
    </>
  );
}

function KbArticlePage() {
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const { resources } = useMeta();
  const [search] = useSearchParams();
  const draftParam = search.get('draft') === '1';
  const versionParam = search.get('version');
  const [mode, setMode] = useState<'read' | 'edit' | 'draft'>(draftParam ? 'draft' : 'read');
  const [publishing, setPublishing] = useState(false);
  const [summary, setSummary] = useState('');
  const [tab, setTab] = useState('history');
  const key = ['kb-article', id, mode, versionParam];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<any>(`/api/kb/${id}${qs({ draft: mode === 'draft' || mode === 'edit' ? '1' : undefined, version: mode === 'read' ? versionParam : undefined })}`) });
  const refresh = () => { qc.invalidateQueries({ queryKey: ['kb-article', id] }); qc.invalidateQueries({ queryKey: ['kb'] }); qc.invalidateQueries({ queryKey: ['kb-my-reading'] }); };
  const ack = useMutation({ mutationFn: () => api.post(`/api/kb/${q.data.article.id}/acknowledge`), onSuccess: () => { toast.success('Thanks — acknowledged'); refresh(); }, onError: toast.error });
  const save = useMutation({ mutationFn: (v: any) => api.put(`/api/kb/${q.data.article.id}/draft`, v), onSuccess: () => { toast.success('Draft saved'); setMode('draft'); refresh(); }, onError: toast.error });
  const publish = useMutation({
    mutationFn: () => api.post<any>(`/api/kb/${q.data.article.id}/publish`, { changeSummary: summary }),
    onSuccess: (r) => { toast.success(`Published v${r.version}${r.assigned ? ` · ${r.assigned} reader(s) assigned` : ''}`); setPublishing(false); setMode('read'); refresh(); },
    onError: toast.error,
  });
  const compliance = useQuery({ queryKey: ['kb-compliance', id], queryFn: () => api.get<any>(`/api/kb/${q.data.article.id}/compliance`), enabled: !!q.data?.can.edit && q.data.article.requiredReading });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} />;
  const d = q.data;
  const a = d.article;
  if (mode === 'edit') {
    return <Editor initial={{ title: d.version?.title ?? a.title, body: d.version?.body ?? '', summary: a.summary, category: a.category, requiredReading: a.requiredReading, acknowledgeWithinDays: a.acknowledgeWithinDays }}
      onCancel={() => setMode(d.hasDraft ? 'draft' : 'read')} onSave={(v) => save.mutate(v)} saving={save.isPending} />;
  }
  return (
    <>
      <PageHeader breadcrumb={<Link to="/kb" className="hover:underline">Knowledge base</Link>} title={d.version?.title ?? a.title}
        subtitle={<>{humanize(a.category)} · owner {a.ownerName ?? '—'} · {d.version ? `v${d.version.versionNumber}${d.version.publishedAt ? ` published ${date(d.version.publishedAt)}` : ' (draft)'}` : 'no content'}</>}
        actions={<>
          {d.can.acknowledge && d.isCurrent && <Button variant="primary" loading={ack.isPending} onClick={() => ack.mutate()}><CheckCircle2 className="size-3.5" /> I have read and understood this</Button>}
          {d.acknowledgedAt && <Badge tone="green">Acknowledged {ago(d.acknowledgedAt)}</Badge>}
          {d.can.edit && <Button onClick={() => setMode('edit')}><Pencil className="size-3.5" /> Edit</Button>}
          {d.can.edit && d.hasDraft && mode !== 'draft' && <Button onClick={() => setMode('draft')}>View draft</Button>}
          {d.can.edit && mode === 'draft' && a.currentVersionId && <Button onClick={() => setMode('read')}>View published</Button>}
          {d.can.publish && d.hasDraft && <Button variant="primary" onClick={() => setPublishing(true)}><Send className="size-3.5" /> Publish</Button>}
          {resources.kb_articles && <Link to={`/r/kb_articles/${a.id}`} className="text-xs text-brand-700 hover:underline">Settings</Link>}
        </>} />
      {mode === 'draft' && <div className="mb-3 rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">You’re viewing an unpublished draft. Readers still see the published version.</div>}
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-2"><article>{d.version ? <Markdown source={d.version.body} /> : <EmptyState title="No content yet" />}</article></Card>
        <div className="space-y-4">
          {a.requiredReading && compliance.data && (
            <Card title="Acknowledgements">
              <div className="mb-2 flex items-center gap-2 text-sm"><div className="flex-1"><Progress value={compliance.data.total ? (compliance.data.acknowledged / compliance.data.total) * 100 : 0} /></div><span className="tabular-nums">{compliance.data.acknowledged}/{compliance.data.total}</span></div>
              <ul className="max-h-64 space-y-1 overflow-auto text-xs">{compliance.data.rows.map((r: any) => (
                <li key={r.userId} className="flex justify-between"><span>{r.name}</span>{r.acknowledgedAt ? <span className="text-emerald-700">✓ {date(r.acknowledgedAt)}</span> : <span className={r.dueDate < new Date().toISOString().slice(0, 10) ? 'text-red-600' : 'text-slate-500'}>due {date(r.dueDate)}</span>}</li>
              ))}</ul>
            </Card>
          )}
          <Card bodyClass="p-0">
            <div className="px-2"><Tabs active={tab} onChange={setTab} tabs={[{ key: 'history', label: 'Version history' }, ...(resources.kb_articles ? [{ key: 'comments', label: 'Comments' }] : [])]} /></div>
            <div className="p-4">
              {tab === 'history' && (
                <ol className="space-y-2 text-sm">{d.versions.map((v: any) => (
                  <li key={v.id}>
                    <button type="button" className={cx('text-left hover:underline', d.version?.id === v.id && 'text-brand-700')} onClick={() => { setMode(v.publishedAt ? 'read' : 'draft'); navigate(v.publishedAt ? `/kb/${a.slug}?version=${v.id}` : `/kb/${a.slug}?draft=1`); }}><b>v{v.versionNumber}</b> {v.publishedAt ? `· ${date(v.publishedAt)}` : <Badge tone="amber">draft</Badge>}</button>
                    <div className="text-xs text-slate-500">{v.changeSummary ?? '—'} · {v.author ?? '—'}</div>
                  </li>
                ))}</ol>
              )}
              {tab === 'comments' && <Comments resource="kb_articles" id={a.id} />}
            </div>
          </Card>
        </div>
      </div>
      <Modal open={publishing} onClose={() => setPublishing(false)} title="Publish new version"
        footer={<><Button onClick={() => setPublishing(false)}>Cancel</Button><Button variant="primary" loading={publish.isPending} onClick={() => publish.mutate()}>Publish</Button></>}>
        <Field label="What changed?" htmlFor="kb-cs"><input id="kb-cs" className="input" value={summary} onChange={(e) => setSummary(e.target.value)} /></Field>
        {a.requiredReading && <p className="mt-2 text-sm text-slate-600">This is required reading: everyone in its audience will be asked to acknowledge the new version.</p>}
      </Modal>
    </>
  );
}

EXTRA_ROUTES.push({ path: 'kb', component: KbListPage }, { path: 'kb/:id', component: KbArticlePage });
