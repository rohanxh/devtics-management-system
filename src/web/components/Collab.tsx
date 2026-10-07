import { useRef, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { FileText, Paperclip, Trash2, Upload, X } from 'lucide-react';
import { api } from '../lib/api';
import { ago, datetime, humanize } from '../lib/format';
import { useMeta } from '../lib/meta';
import { Button, EmptyState, Spinner } from './ui';
import { RefSelect } from './fields';
import { useToast } from './toast';

export function Comments({ resource, id }: { resource: string; id: string }) {
  const { user } = useMeta();
  const qc = useQueryClient();
  const toast = useToast();
  const [body, setBody] = useState('');
  const [mentions, setMentions] = useState<{ id: string; label: string }[]>([]);
  const key = ['comments', resource, id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<any[]>(`/api/r/${resource}/${id}/comments`) });
  const add = useMutation({
    mutationFn: () => api.post(`/api/r/${resource}/${id}/comments`, { body, mentions: mentions.map((m) => m.id) }),
    onSuccess: () => { setBody(''); setMentions([]); qc.invalidateQueries({ queryKey: key }); qc.invalidateQueries({ queryKey: ['activity', resource, id] }); },
    onError: toast.error,
  });
  const del = useMutation({
    mutationFn: (cid: string) => api.del(`/api/comments/${cid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: toast.error,
  });
  return (
    <div className="space-y-4">
      {q.isLoading ? <Spinner /> : q.data?.length === 0 ? <p className="text-sm text-slate-500">No comments yet.</p> : (
        <ul className="space-y-3">
          {q.data?.map((c) => (
            <li key={c.id} className="group rounded-md border border-slate-100 bg-slate-50/50 p-3">
              <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
                <span className="font-medium text-slate-700">{c.authorName}</span>
                <span title={datetime(c.createdAt)}>{ago(c.createdAt)}</span>
                {c.authorId === user.id && (
                  <button type="button" aria-label="Delete comment" className="ml-auto hidden text-slate-400 hover:text-red-600 group-hover:block" onClick={() => confirm('Delete this comment?') && del.mutate(c.id)}>
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <p className="whitespace-pre-wrap text-sm text-slate-800">{c.body}</p>
            </li>
          ))}
        </ul>
      )}
      <form className="space-y-2" onSubmit={(e) => { e.preventDefault(); if (body.trim()) add.mutate(); }}>
        <label htmlFor="new-comment" className="sr-only">Add a comment</label>
        <textarea id="new-comment" className="input" rows={3} placeholder="Write a comment…" value={body} onChange={(e) => setBody(e.target.value)} maxLength={10000} />
        <div className="flex flex-wrap items-center gap-2">
          <div className="w-56"><RefSelect refKey="users" value={null} placeholder="Mention someone…" onChange={(v, label) => v && !mentions.some((m) => m.id === v) && setMentions((m) => [...m, { id: v, label: label ?? '' }])} /></div>
          {mentions.map((m) => (
            <span key={m.id} className="inline-flex items-center gap-1 rounded bg-brand-50 px-1.5 py-0.5 text-xs text-brand-700">
              @{m.label}<button type="button" aria-label={`Remove ${m.label}`} onClick={() => setMentions((x) => x.filter((y) => y.id !== m.id))}><X className="size-3" /></button>
            </span>
          ))}
          <Button className="ml-auto" variant="primary" type="submit" loading={add.isPending} disabled={!body.trim()}>Comment</Button>
        </div>
      </form>
    </div>
  );
}

const fmtSize = (b: number) => (b > 1e6 ? `${(b / 1e6).toFixed(1)} MB` : `${Math.ceil(b / 1e3)} KB`);

export function Files({ resource, id, canUpload }: { resource: string; id: string; canUpload: boolean }) {
  const qc = useQueryClient();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState('');
  const key = ['files', resource, id];
  const q = useQuery({ queryKey: key, queryFn: () => api.get<any[]>(`/api/r/${resource}/${id}/files`) });
  const upload = useMutation({
    mutationFn: (file: File) => {
      const fd = new FormData();
      fd.append('file', file);
      return api.post(`/api/r/${resource}/${id}/files${category ? `?category=${encodeURIComponent(category)}` : ''}`, fd);
    },
    onSuccess: () => { toast.success('File uploaded'); qc.invalidateQueries({ queryKey: key }); },
    onError: toast.error,
  });
  const del = useMutation({
    mutationFn: (fid: string) => api.del(`/api/files/${fid}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: key }),
    onError: toast.error,
  });
  return (
    <div className="space-y-3">
      {canUpload && (
        <div className="flex flex-wrap items-center gap-2">
          <input ref={input} type="file" className="hidden" onChange={(e) => { const f = e.target.files?.[0]; if (f) upload.mutate(f); e.target.value = ''; }} />
          <input aria-label="Category" className="input w-40" placeholder="Category (optional)" value={category} onChange={(e) => setCategory(e.target.value)} />
          <Button onClick={() => input.current?.click()} loading={upload.isPending}><Upload className="size-3.5" /> Upload file</Button>
          <span className="text-xs text-slate-400">Max 25 MB · PDF, images, Office, CSV, ZIP, video</span>
        </div>
      )}
      {q.isLoading ? <Spinner /> : !q.data?.length ? <EmptyState title="No attachments" /> : (
        <ul className="divide-y divide-slate-100 rounded-md border border-slate-200">
          {q.data.map((f) => (
            <li key={f.id} className="flex items-center gap-3 px-3 py-2 text-sm">
              {f.mimeType.startsWith('image/') ? <Paperclip className="size-4 text-slate-400" /> : <FileText className="size-4 text-slate-400" />}
              <a className="min-w-0 flex-1 truncate font-medium text-brand-700 hover:underline" href={`/api/files/${f.id}`} target="_blank" rel="noopener noreferrer">{f.originalName}</a>
              {f.category && <span className="text-xs text-slate-500">{f.category}</span>}
              <span className="text-xs text-slate-400">{fmtSize(f.sizeBytes)} · {f.uploadedByName} · {ago(f.createdAt)}</span>
              {canUpload && <button type="button" aria-label={`Delete ${f.originalName}`} className="text-slate-400 hover:text-red-600" onClick={() => confirm('Delete this file?') && del.mutate(f.id)}><Trash2 className="size-3.5" /></button>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function Activity({ resource, id }: { resource: string; id: string }) {
  const q = useQuery({ queryKey: ['activity', resource, id], queryFn: () => api.get<any[]>(`/api/r/${resource}/${id}/activity`) });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.length) return <p className="text-sm text-slate-500">No activity yet.</p>;
  return (
    <ol className="relative space-y-3 border-l border-slate-200 pl-4">
      {q.data.map((a) => (
        <li key={a.id} className="text-sm">
          <span className="absolute -left-[4.5px] mt-1.5 size-2 rounded-full bg-slate-300" />
          <span className="font-medium text-slate-800">{a.actorName ?? 'System'}</span> <span className="text-slate-600">{a.summary}</span>
          <div className="text-xs text-slate-400" title={datetime(a.createdAt)}>{ago(a.createdAt)}</div>
        </li>
      ))}
    </ol>
  );
}

export function AuditTrail({ resource, id }: { resource: string; id: string }) {
  const q = useQuery({ queryKey: ['audit', resource, id], queryFn: () => api.get<any[]>(`/api/r/${resource}/${id}/audit`) });
  if (q.isLoading) return <Spinner />;
  if (!q.data?.length) return <p className="text-sm text-slate-500">No audit entries.</p>;
  return (
    <ul className="space-y-2 text-sm">
      {q.data.map((a) => (
        <li key={a.id} className="rounded border border-slate-100 p-2">
          <div className="flex flex-wrap gap-2 text-xs text-slate-500">
            <span className="font-mono">{datetime(a.occurredAt)}</span>
            <span className="font-medium text-slate-700">{a.actorName ?? 'System'}</span>
            <span>{humanize(a.action.toLowerCase())}</span>
          </div>
          {a.changedFields?.length > 0 && (
            <table className="mt-1 w-full text-xs">
              <tbody>
                {a.changedFields.map((f: string) => (
                  <tr key={f}>
                    <td className="w-40 py-0.5 pr-2 font-mono text-slate-500">{f}</td>
                    <td className="py-0.5 text-red-700 line-through">{fmt(a.oldData?.[f])}</td>
                    <td className="py-0.5 text-emerald-700">{fmt(a.newData?.[f])}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </li>
      ))}
    </ul>
  );
}
const fmt = (v: unknown) => (v === null || v === undefined ? '∅' : typeof v === 'object' ? JSON.stringify(v) : String(v));
