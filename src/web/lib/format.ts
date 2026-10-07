const nf = new Map<string, Intl.NumberFormat>();

export function money(v: string | number | null | undefined, currency = 'USD', compact = false) {
  if (v === null || v === undefined || v === '') return '—';
  const key = currency + compact;
  if (!nf.has(key)) nf.set(key, new Intl.NumberFormat(undefined, { style: 'currency', currency, maximumFractionDigits: compact ? 1 : 2, notation: compact ? 'compact' : 'standard' }));
  return nf.get(key)!.format(Number(v));
}

export const num = (v: string | number | null | undefined, digits = 0) =>
  v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString(undefined, { maximumFractionDigits: digits });

export function date(v: string | Date | null | undefined) {
  if (!v) return '—';
  const d = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v) ? new Date(v + 'T00:00:00') : new Date(v);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function datetime(v: string | Date | null | undefined) {
  if (!v) return '—';
  return new Date(v).toLocaleString(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

export function ago(v: string | Date | null | undefined) {
  if (!v) return '—';
  const s = (Date.now() - new Date(v).getTime()) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 86400 * 7) return `${Math.floor(s / 86400)}d ago`;
  return date(v);
}

/** snake_case / enum value → "Title case" */
export const humanize = (s: string | null | undefined) =>
  !s ? '—' : s.replace(/_/g, ' ').replace(/^\w/, (c) => c.toUpperCase());

export const today = () => new Date().toISOString().slice(0, 10);

export function isOverdue(due: string | null | undefined) {
  return !!due && due < today();
}
