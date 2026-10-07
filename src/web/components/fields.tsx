import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, X } from 'lucide-react';
import { api, qs } from '../lib/api';
import { date, datetime, humanize, money, num } from '../lib/format';
import { useMeta, useStage, type FieldMeta } from '../lib/meta';
import { Badge, StatusBadge, cx } from './ui';

export function StageBadge({ id, label }: { id: string | null | undefined; label?: string }) {
  const s = useStage(id);
  if (!id) return <span className="text-slate-400">—</span>;
  return <Badge stageColor={s?.color}>{s?.name ?? label ?? '—'}</Badge>;
}

/** Read-only rendering of a field value. */
export function FieldValue({ field, name, row, link = true }: { field: FieldMeta; name: string; row: Record<string, any>; link?: boolean }) {
  const { settings } = useMeta();
  const v = row[name];
  if (v === null || v === undefined || v === '') return <span className="text-slate-400">—</span>;
  switch (field.type) {
    case 'enum': return <StatusBadge value={v} />;
    case 'stage': return <StageBadge id={v} label={row._labels?.[name]} />;
    case 'ref': {
      const label = row._labels?.[name] ?? '—';
      return link && field.ref ? <Link className="text-brand-700 hover:underline" to={`/r/${field.ref}/${v}`} onClick={(e) => e.stopPropagation()}>{label}</Link> : <>{label}</>;
    }
    case 'money': return <span className="tabular-nums">{money(v, row.currency ?? settings.baseCurrency)}</span>;
    case 'decimal': case 'hours': return <span className="tabular-nums">{num(v, 2)}</span>;
    case 'percent': return <span className="tabular-nums">{num(v, 1)}%</span>;
    case 'int': return <span className="tabular-nums">{num(v)}</span>;
    case 'date': return <>{date(v)}</>;
    case 'datetime': return <>{datetime(v)}</>;
    case 'bool': return <>{v ? 'Yes' : 'No'}</>;
    case 'url': return <a className="text-brand-700 hover:underline break-all" href={v} target="_blank" rel="noopener noreferrer" onClick={(e) => e.stopPropagation()}>{v.replace(/^https?:\/\//, '')}</a>;
    case 'email': return <a className="text-brand-700 hover:underline" href={`mailto:${v}`} onClick={(e) => e.stopPropagation()}>{v}</a>;
    case 'tags': return <span className="flex flex-wrap gap-1">{(v as unknown[]).map((t) => <Badge key={String(t)}>{String(t)}</Badge>)}</span>;
    case 'textarea': case 'markdown': return <span className="whitespace-pre-wrap">{String(v)}</span>;
    default: return <>{String(v)}</>;
  }
}

/** Searchable picker for references (uses /api/r/:ref/options). */
export function RefSelect({ refKey, value, label, onChange, id, invalid, placeholder = 'Search…', params }: {
  refKey: string; value: string | null; label?: string; onChange: (v: string | null, label?: string) => void;
  id?: string; invalid?: boolean; placeholder?: string; params?: Record<string, string>;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [current, setCurrent] = useState<string | undefined>(label);
  const box = useRef<HTMLDivElement>(null);
  const listId = useId();
  const { data, isFetching } = useQuery({
    queryKey: ['options', refKey, q, params],
    queryFn: () => api.get<{ id: string; label: string }[]>(`/api/r/${refKey}/options${qs({ q, ...params })}`),
    enabled: open,
  });
  // Resolve the label for an initial value.
  useQuery({
    queryKey: ['option-label', refKey, value],
    queryFn: async () => {
      const r = await api.get<{ id: string; label: string }[]>(`/api/r/${refKey}/options${qs({ ids: value })}`);
      setCurrent(r[0]?.label);
      return r;
    },
    enabled: !!value && !label,
  });
  useEffect(() => { if (label) setCurrent(label); }, [label]);
  useEffect(() => {
    const close = (e: MouseEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, []);

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <input
          id={id} role="combobox" aria-expanded={open} aria-controls={listId} aria-invalid={invalid || undefined} autoComplete="off"
          className="input pr-12" placeholder={value ? current ?? '…' : placeholder}
          value={open ? q : value ? current ?? '' : ''}
          onFocus={() => { setOpen(true); setQ(''); }}
          onChange={(e) => { setQ(e.target.value); setOpen(true); }}
          onKeyDown={(e) => { if (e.key === 'Escape') setOpen(false); }}
        />
        <div className="absolute inset-y-0 right-1 flex items-center gap-0.5">
          {value && <button type="button" aria-label="Clear" className="rounded p-0.5 text-slate-400 hover:text-slate-600" onClick={() => { onChange(null); setCurrent(undefined); }}><X className="size-3.5" /></button>}
          <ChevronDown className="size-3.5 text-slate-400" />
        </div>
      </div>
      {open && (
        <ul id={listId} role="listbox" className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-md border border-slate-200 bg-white py-1 text-sm shadow-lg">
          {isFetching && !data && <li className="px-3 py-1.5 text-slate-400">Loading…</li>}
          {data?.length === 0 && <li className="px-3 py-1.5 text-slate-400">No matches</li>}
          {data?.map((o) => (
            <li key={o.id} role="option" aria-selected={o.id === value}
              className={cx('cursor-pointer px-3 py-1.5 hover:bg-brand-50', o.id === value && 'bg-brand-50 font-medium')}
              onMouseDown={(e) => { e.preventDefault(); onChange(o.id, o.label); setCurrent(o.label); setOpen(false); }}>
              {o.label}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export function StageSelect({ pipeline, value, onChange, id }: { pipeline: string; value: string | null; onChange: (v: string | null) => void; id?: string }) {
  const { pipelines } = useMeta();
  return (
    <select id={id} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
      <option value="">—</option>
      {(pipelines[pipeline] ?? []).map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
    </select>
  );
}

/** Editable input for a field, driven by metadata. */
export function FieldInput({ name, field, value, onChange, error, allowedOptions, labels }: {
  name: string; field: FieldMeta; value: any; onChange: (v: any) => void; error?: string; allowedOptions?: string[]; labels?: Record<string, string>;
}) {
  const id = `f-${name}`;
  const common = { id, 'aria-invalid': !!error || undefined, disabled: field.readonly };
  switch (field.type) {
    case 'enum':
      return (
        <select {...common} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value || null)}>
          {!field.required && <option value="">—</option>}
          {field.required && !value && <option value="">Select…</option>}
          {(field.options ?? []).filter((o) => !allowedOptions || allowedOptions.includes(o) || o === value).map((o) => <option key={o} value={o}>{humanize(o)}</option>)}
        </select>
      );
    case 'ref':
      return <RefSelect id={id} refKey={field.ref!} value={value ?? null} label={labels?.[name]} onChange={(v) => onChange(v)} invalid={!!error} />;
    case 'stage':
      return <StageSelect id={id} pipeline={field.pipeline!} value={value ?? null} onChange={onChange} />;
    case 'bool':
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input type="checkbox" {...common} className="size-4 rounded border-slate-300 text-brand-600" checked={!!value} onChange={(e) => onChange(e.target.checked)} />
          {field.label}
        </label>
      );
    case 'textarea': case 'markdown':
      return <textarea {...common} className={cx('input', field.type === 'markdown' && 'font-mono text-xs')} rows={field.type === 'markdown' ? 14 : 4} value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'date':
      return <input {...common} type="date" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'datetime':
      return <input {...common} type="datetime-local" className="input" value={value ? toLocalInput(value) : ''} onChange={(e) => onChange(e.target.value ? new Date(e.target.value).toISOString() : null)} />;
    case 'time':
      return <input {...common} type="time" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'int': case 'decimal': case 'money': case 'percent': case 'hours':
      return <input {...common} type="number" inputMode="decimal" step={field.type === 'int' ? 1 : 'any'} min={field.min} max={field.max} className="input tabular-nums" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'tags':
      return <input {...common} className="input" placeholder="Comma separated" value={Array.isArray(value) ? value.join(', ') : value ?? ''} onChange={(e) => onChange(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />;
    case 'email':
      return <input {...common} type="email" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    case 'url':
      return <input {...common} type="url" placeholder="https://" className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
    default:
      return <input {...common} type={field.type === 'phone' ? 'tel' : 'text'} maxLength={field.max} className="input" value={value ?? ''} onChange={(e) => onChange(e.target.value)} />;
  }
}

function toLocalInput(v: string) {
  const d = new Date(v);
  const off = d.getTimezoneOffset() * 60000;
  return new Date(d.getTime() - off).toISOString().slice(0, 16);
}
