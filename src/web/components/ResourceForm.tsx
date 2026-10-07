import { useMemo, useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../lib/api';
import { useResource, type ResourceMeta } from '../lib/meta';
import { Button, Field, Modal } from './ui';
import { FieldInput } from './fields';
import { useToast } from './toast';

/** Which fields a generic form shows. */
export function formFields(meta: ResourceMeta, mode: 'create' | 'edit', only?: string[]) {
  return Object.entries(meta.fields).filter(([k, f]) => {
    if (only) return only.includes(k);
    if (f.hidden) return false;
    if (f.readonly && mode === 'create') return false;
    if (k === meta.numberField) return false;
    return true;
  });
}

export function ResourceFormModal({ resource, open, onClose, record, defaults, onSaved, only, title }: {
  resource: string; open: boolean; onClose: () => void; record?: Record<string, any>;
  defaults?: Record<string, any>; onSaved?: (row: any) => void; only?: string[]; title?: string;
}) {
  const meta = useResource(resource);
  if (!meta || !open) return null;
  return <FormInner meta={meta} onClose={onClose} record={record} defaults={defaults} onSaved={onSaved} only={only} title={title} />;
}

function FormInner({ meta, onClose, record, defaults, onSaved, only, title }: {
  meta: ResourceMeta; onClose: () => void; record?: Record<string, any>; defaults?: Record<string, any>;
  onSaved?: (row: any) => void; only?: string[]; title?: string;
}) {
  const mode = record ? 'edit' : 'create';
  const fields = useMemo(() => formFields(meta, mode, only), [meta, mode, only]);
  const [values, setValues] = useState<Record<string, any>>(() => {
    const v: Record<string, any> = { ...(defaults ?? {}) };
    if (record) for (const [k] of fields) v[k] = record[k];
    return v;
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const qc = useQueryClient();
  const toast = useToast();

  const save = useMutation({
    mutationFn: () => {
      const payload: Record<string, any> = {};
      for (const [k, f] of fields) {
        if (f.readonly) continue;
        if (mode === 'edit' && f.createOnly) continue;
        if (mode === 'edit' && values[k] === record?.[k]) continue;
        if (values[k] !== undefined) payload[k] = values[k];
      }
      // Pass through hidden defaults (e.g. parent IDs) on create.
      if (mode === 'create') for (const [k, v] of Object.entries(defaults ?? {})) if (!(k in payload)) payload[k] = v;
      return mode === 'edit' ? api.patch(`/api/r/${meta.key}/${record!.id}`, payload) : api.post(`/api/r/${meta.key}`, payload);
    },
    onSuccess: (row) => {
      toast.success(`${meta.label} ${mode === 'edit' ? 'updated' : 'created'}`);
      qc.invalidateQueries({ queryKey: ['r', meta.key] });
      qc.invalidateQueries({ queryKey: ['dashboard'] });
      onSaved?.(row);
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && e.details) setErrors(e.details);
      toast.error(e);
    },
  });

  const status = meta.status;
  const allowed = status && record ? [record[status.field], ...(status.transitions?.[record[status.field]] ?? meta.fields[status.field]?.options ?? [])] : undefined;

  const groups = new Map<string, typeof fields>();
  for (const f of fields) {
    const g = f[1].group ?? '';
    groups.set(g, [...(groups.get(g) ?? []), f]);
  }

  const submit = (e: FormEvent) => { e.preventDefault(); setErrors({}); save.mutate(); };

  return (
    <Modal
      open drawer onClose={onClose}
      title={title ?? (mode === 'edit' ? `Edit ${meta.label.toLowerCase()}` : `New ${meta.label.toLowerCase()}`)}
      footer={<>
        <Button onClick={onClose}>Cancel</Button>
        <Button variant="primary" type="submit" form="resource-form" loading={save.isPending}>{mode === 'edit' ? 'Save changes' : 'Create'}</Button>
      </>}
    >
      <form id="resource-form" onSubmit={submit} className="space-y-5" noValidate>
        {errors._ && <p role="alert" className="rounded bg-red-50 p-2 text-sm text-red-700">{errors._}</p>}
        {[...groups.entries()].map(([group, gf]) => (
          <fieldset key={group} className="space-y-3">
            {group && <legend className="mb-1 text-xs font-semibold uppercase tracking-wide text-slate-400">{group}</legend>}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {gf.map(([k, f]) => {
                const wide = ['textarea', 'markdown'].includes(f.type);
                const disabled = f.readonly || (mode === 'edit' && f.createOnly);
                return (
                  <div key={k} className={wide ? 'sm:col-span-2' : ''}>
                    {f.type === 'bool' ? (
                      <FieldInput name={k} field={{ ...f, readonly: disabled }} value={values[k]} onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} error={errors[k]} />
                    ) : (
                      <Field label={f.label} required={f.required} error={errors[k]} help={f.help} htmlFor={`f-${k}`}>
                        <FieldInput
                          name={k} field={{ ...f, readonly: disabled }} value={values[k]} labels={record?._labels}
                          allowedOptions={k === status?.field ? allowed : undefined}
                          onChange={(v) => setValues((s) => ({ ...s, [k]: v }))} error={errors[k]}
                        />
                      </Field>
                    )}
                  </div>
                );
              })}
            </div>
          </fieldset>
        ))}
      </form>
    </Modal>
  );
}
