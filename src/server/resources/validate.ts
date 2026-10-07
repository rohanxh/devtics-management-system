import { z } from 'zod';
import type { FieldDef } from './types.ts';

const DECIMAL = /^-?\d{1,12}(\.\d{1,4})?$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}(:\d{2})?$/;

/** Empty strings from forms mean "no value". */
const blankToNull = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? null : v);

function base(f: FieldDef): z.ZodType {
  switch (f.type) {
    case 'text': return z.string().trim().max(f.max ?? 300);
    case 'phone': return z.string().trim().max(40).regex(/^[+\d\s().-]+$/, 'Invalid phone number');
    case 'textarea': return z.string().max(f.max ?? 20000);
    case 'markdown': return z.string().max(f.max ?? 200000);
    case 'email': return z.string().trim().toLowerCase().pipe(z.email());
    // Only http(s) — blocks javascript:/data: URLs that could become XSS when rendered as links.
    case 'url': return z.url({ protocol: /^https?$/ }).max(2000);
    case 'int': {
      let s = z.coerce.number().int();
      if (f.min !== undefined) s = s.min(f.min);
      if (f.max !== undefined) s = s.max(f.max);
      return s;
    }
    case 'decimal': case 'money': case 'percent': case 'hours': {
      return z.union([z.string(), z.number()])
        .transform((v) => String(v).trim())
        .refine((v) => DECIMAL.test(v), 'Must be a number')
        .refine((v) => f.min === undefined || Number(v) >= f.min, `Must be ≥ ${f.min}`)
        .refine((v) => f.max === undefined || Number(v) <= f.max, `Must be ≤ ${f.max}`)
        .refine((v) => f.type !== 'percent' || (Number(v) >= 0 && Number(v) <= 100), 'Must be between 0 and 100');
    }
    case 'bool': return z.union([z.boolean(), z.enum(['true', 'false']).transform((v) => v === 'true')]);
    case 'date': return z.string().regex(DATE, 'Must be a date (YYYY-MM-DD)');
    case 'time': return z.string().regex(TIME, 'Must be a time (HH:MM)');
    case 'datetime': return z.coerce.date();
    case 'enum': return z.enum(f.options as [string, ...string[]]);
    case 'ref': case 'stage': return z.uuid();
    case 'tags': return z.array(z.string().trim().min(1).max(60)).max(50);
  }
}

export function fieldSchema(f: FieldDef, mode: 'create' | 'update'): z.ZodType {
  const s = base(f);
  if (f.required) {
    const req = z.preprocess(blankToNull, s);
    return mode === 'update' ? req.optional() : req;
  }
  return z.preprocess(blankToNull, s.nullable()).optional();
}

export function objectSchema(fields: Record<string, FieldDef>, mode: 'create' | 'update') {
  const shape: Record<string, z.ZodType> = {};
  for (const [k, f] of Object.entries(fields)) shape[k] = fieldSchema(f, mode);
  return z.object(shape);
}

export const isUuid = (v: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

export function formatZodError(err: z.ZodError) {
  const fields: Record<string, string> = {};
  for (const issue of err.issues) {
    const k = issue.path.join('.') || '_';
    if (!fields[k]) fields[k] = /received (undefined|null)/.test(issue.message) ? 'Required' : issue.message;
  }
  return fields;
}
