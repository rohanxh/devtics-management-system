import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import { humanize } from '../lib/format';
import type { ResourceMeta, Stage } from '../lib/meta';
import { Badge, cx, toneFor } from './ui';
import { FieldValue } from './fields';
import { useToast } from './toast';

/** Drag-and-drop board grouped by an enum or pipeline-stage field. Moves go through the same API (and state machine) as forms. */
export function Kanban({ meta, rows, pipeline }: { meta: ResourceMeta; rows: any[]; pipeline?: Stage[] }) {
  const field = meta.board!;
  const f = meta.fields[field];
  const columns = pipeline
    ? pipeline.map((s) => ({ key: s.id, label: s.name, color: s.color }))
    : (f.options ?? []).map((o) => ({ key: o, label: humanize(o), color: undefined as string | undefined }));
  const qc = useQueryClient();
  const toast = useToast();
  const navigate = useNavigate();
  const [dragOver, setDragOver] = useState<string | null>(null);
  const move = useMutation({
    mutationFn: ({ id, to }: { id: string; to: string }) => api.patch(`/api/r/${meta.key}/${id}`, { [field]: to }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['r', meta.key] }),
    onError: toast.error,
  });
  const secondary = Object.entries(meta.fields).filter(([k, x]) => x.list && k !== field && k !== meta.titleField).slice(0, 3);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map((c) => {
        const items = rows.filter((r) => r[field] === c.key);
        return (
          <div key={c.key}
            onDragOver={(e) => { if (meta.can.edit) { e.preventDefault(); setDragOver(c.key); } }}
            onDragLeave={() => setDragOver(null)}
            onDrop={(e) => { e.preventDefault(); setDragOver(null); const id = e.dataTransfer.getData('text/plain'); const row = rows.find((r) => r.id === id); if (row && row[field] !== c.key) move.mutate({ id, to: c.key }); }}
            className={cx('flex w-72 shrink-0 flex-col rounded-lg bg-slate-100/70 p-2', dragOver === c.key && 'ring-2 ring-brand-400')}>
            <div className="mb-2 flex items-center justify-between px-1">
              {c.color ? <Badge stageColor={c.color}>{c.label}</Badge> : <Badge tone={toneFor(c.key)}>{c.label}</Badge>}
              <span className="text-xs text-slate-500">{items.length}</span>
            </div>
            <div className="flex min-h-16 flex-col gap-2">
              {items.map((r) => (
                <div key={r.id} draggable={meta.can.edit} onDragStart={(e) => e.dataTransfer.setData('text/plain', r.id)}
                  onClick={() => navigate(`/r/${meta.key}/${r.id}`)}
                  onKeyDown={(e) => e.key === 'Enter' && navigate(`/r/${meta.key}/${r.id}`)} tabIndex={0} role="button"
                  className="cursor-pointer rounded-md border border-slate-200 bg-white p-2.5 text-sm shadow-xs hover:border-brand-300">
                  <div className="font-medium text-slate-900">{meta.numberField && <span className="mr-1 font-mono text-xs text-slate-400">{r[meta.numberField]}</span>}{r._title}</div>
                  <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-500">
                    {secondary.map(([k, x]) => r[k] != null && r[k] !== '' ? <span key={k}><FieldValue field={x} name={k} row={r} link={false} /></span> : null)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}
