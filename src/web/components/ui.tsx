import { useEffect, useRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { AlertTriangle, Inbox, Loader2, X } from 'lucide-react';
import { humanize } from '../lib/format';

export const cx = (...c: (string | false | null | undefined)[]) => c.filter(Boolean).join(' ');

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'bg-brand-600 text-white hover:bg-brand-700 shadow-xs',
  secondary: 'bg-white text-slate-700 border border-slate-300 hover:bg-slate-50 shadow-xs',
  ghost: 'text-slate-600 hover:bg-slate-100',
  danger: 'bg-red-600 text-white hover:bg-red-700 shadow-xs',
};

export function Button({ variant = 'secondary', size = 'md', loading, className, children, disabled, ...rest }:
  ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; size?: 'sm' | 'md'; loading?: boolean }) {
  return (
    <button
      type="button"
      {...rest}
      disabled={disabled || loading}
      className={cx(
        'inline-flex items-center justify-center gap-1.5 rounded-md font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed whitespace-nowrap',
        size === 'sm' ? 'px-2 py-1 text-xs' : 'px-3 py-1.5 text-sm',
        VARIANTS[variant], className,
      )}
    >
      {loading && <Loader2 className="size-3.5 animate-spin" />}
      {children}
    </button>
  );
}

const TONES: Record<string, string> = {
  green: 'bg-emerald-50 text-emerald-700 ring-emerald-600/20',
  amber: 'bg-amber-50 text-amber-800 ring-amber-600/20',
  red: 'bg-red-50 text-red-700 ring-red-600/20',
  blue: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  violet: 'bg-violet-50 text-violet-700 ring-violet-600/20',
  slate: 'bg-slate-100 text-slate-700 ring-slate-500/20',
  orange: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  teal: 'bg-teal-50 text-teal-700 ring-teal-600/20',
};
const STAGE_TONE: Record<string, string> = {
  emerald: 'green', green: 'green', amber: 'amber', red: 'red', rose: 'red', blue: 'blue', indigo: 'violet',
  violet: 'violet', slate: 'slate', orange: 'orange', teal: 'teal', cyan: 'teal',
};

const STATUS_TONE: [RegExp, string][] = [
  [/^(active|done|paid|approved|won|resolved|verified|pass|passed|on_track|published|completed|hired|signed|fixed|present|accepted|merged|succeeded|healthy|stable|in_stock|ready_for_launch|ok|live|qualified|converted)$/, 'green'],
  [/^(overdue|delayed|rejected|failed|fail|lost|critical|blocked|breached|urgent|terminated|at_risk|reopened|absent|expired|void|disqualified|cancelled|rolled_back|changes_requested|high)$/, 'red'],
  [/^(pending|in_review|waiting.*|awaiting.*|partially_paid|probation|retest.*|ready_for_retest|attention_required|notice|on_hold|draft|medium|submitted|late|repair|pending_approval|negotiation)$/, 'amber'],
  [/^(in_progress|sent|open|new|in_qa|qa|development|in_development|assigned|triaged|scheduled|planned|contacted|remote|confirmed|running)$/, 'blue'],
];
export function toneFor(value: string | null | undefined) {
  if (!value) return 'slate';
  return STATUS_TONE.find(([re]) => re.test(value))?.[1] ?? 'slate';
}

export function Badge({ children, tone, stageColor, className }: { children: ReactNode; tone?: string; stageColor?: string; className?: string }) {
  const t = stageColor ? STAGE_TONE[stageColor] ?? 'slate' : tone ?? 'slate';
  return <span className={cx('inline-flex items-center rounded-md px-1.5 py-0.5 text-xs font-medium ring-1 ring-inset whitespace-nowrap', TONES[t], className)}>{children}</span>;
}

export const StatusBadge = ({ value }: { value: string | null | undefined }) =>
  value ? <Badge tone={toneFor(value)}>{humanize(value)}</Badge> : <span className="text-slate-400">—</span>;

export function Card({ title, actions, children, className, bodyClass }: { title?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string; bodyClass?: string }) {
  return (
    <section className={cx('card', className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-2 border-b border-slate-100 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-slate-800">{title}</h2>
          <div className="flex items-center gap-2">{actions}</div>
        </header>
      )}
      <div className={bodyClass ?? 'p-4'}>{children}</div>
    </section>
  );
}

export function Spinner({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
      <Loader2 className="size-4 animate-spin" /> {label}
    </div>
  );
}

export function EmptyState({ title, hint, action }: { title: string; hint?: string; action?: ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
      <Inbox className="size-8 text-slate-300" />
      <p className="text-sm font-medium text-slate-700">{title}</p>
      {hint && <p className="max-w-sm text-xs text-slate-500">{hint}</p>}
      {action}
    </div>
  );
}

export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const msg = (error as Error)?.message ?? 'Something went wrong';
  const status = (error as any)?.status;
  return (
    <div role="alert" className="flex flex-col items-center gap-2 py-10 text-center">
      <AlertTriangle className="size-7 text-amber-500" />
      <p className="text-sm font-medium text-slate-700">{status === 403 ? 'You don’t have access to this' : status === 404 ? 'Not found' : 'Couldn’t load this'}</p>
      <p className="max-w-md text-xs text-slate-500">{msg}</p>
      {retry && status !== 403 && status !== 404 && <Button size="sm" onClick={retry}>Try again</Button>}
    </div>
  );
}

/** Accessible modal dialog / side drawer. */
export function Modal({ open, onClose, title, children, footer, wide, drawer }: {
  open: boolean; onClose: () => void; title: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; drawer?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);
  if (!open) return null;
  return (
    <dialog
      ref={ref}
      onCancel={(e) => { e.preventDefault(); onClose(); }}
      className={cx(
        'backdrop:bg-slate-900/30 bg-white shadow-xl p-0 text-slate-800',
        drawer ? 'ml-auto mr-0 my-0 h-dvh max-h-dvh w-full max-w-xl rounded-none' : cx('m-auto rounded-lg w-full', wide ? 'max-w-3xl' : 'max-w-lg'),
      )}
    >
      <div className={cx('flex flex-col', drawer ? 'h-full' : 'max-h-[85vh]')}>
        <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
          <h2 className="text-base font-semibold">{title}</h2>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"><X className="size-4" /></button>
        </header>
        <div className="flex-1 overflow-y-auto px-5 py-4">{children}</div>
        {footer && <footer className="flex justify-end gap-2 border-t border-slate-200 px-5 py-3">{footer}</footer>}
      </div>
    </dialog>
  );
}

export function Tabs({ tabs, active, onChange }: { tabs: { key: string; label: ReactNode }[]; active: string; onChange: (k: string) => void }) {
  return (
    <div role="tablist" className="flex gap-1 overflow-x-auto overflow-y-hidden border-b border-slate-200">
      {tabs.map((t) => (
        <button
          key={t.key} role="tab" type="button" aria-selected={active === t.key} onClick={() => onChange(t.key)}
          className={cx('-mb-px border-b-2 px-3 py-2 text-sm whitespace-nowrap', active === t.key ? 'border-brand-600 font-medium text-brand-700' : 'border-transparent text-slate-500 hover:text-slate-800')}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

export function Stat({ label, value, hint, tone, onClick }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'red' | 'amber' | 'green'; onClick?: () => void }) {
  const Comp = onClick ? 'button' : 'div';
  return (
    <Comp onClick={onClick} className={cx('card px-4 py-3 text-left', onClick && 'hover:border-brand-300 hover:shadow-sm transition')}>
      <div className="text-xs font-medium text-slate-500">{label}</div>
      <div className={cx('mt-1 text-2xl font-semibold tabular-nums', tone === 'red' ? 'text-red-600' : tone === 'amber' ? 'text-amber-600' : tone === 'green' ? 'text-emerald-600' : 'text-slate-900')}>{value}</div>
      {hint && <div className="mt-0.5 text-xs text-slate-500">{hint}</div>}
    </Comp>
  );
}

export function PageHeader({ title, subtitle, actions, breadcrumb }: { title: ReactNode; subtitle?: ReactNode; actions?: ReactNode; breadcrumb?: ReactNode }) {
  return (
    <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
      <div className="min-w-0">
        {breadcrumb && <div className="mb-1 text-xs text-slate-500">{breadcrumb}</div>}
        <h1 className="truncate text-xl font-semibold text-slate-900">{title}</h1>
        {subtitle && <p className="mt-0.5 text-sm text-slate-500">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
    </div>
  );
}

export function Field({ label, error, help, required, children, htmlFor }: { label: string; error?: string; help?: string; required?: boolean; children: ReactNode; htmlFor?: string }) {
  return (
    <div>
      <label className="label" htmlFor={htmlFor}>{label}{required && <span className="text-red-500"> *</span>}</label>
      {children}
      {error ? <p className="mt-1 text-xs text-red-600">{error}</p> : help ? <p className="mt-1 text-xs text-slate-500">{help}</p> : null}
    </div>
  );
}

export function Progress({ value, tone }: { value: number; tone?: 'red' | 'amber' | 'green' }) {
  const v = Math.max(0, Math.min(100, value));
  return (
    <div className="h-1.5 w-full rounded-full bg-slate-100" role="progressbar" aria-valuenow={Math.round(v)} aria-valuemin={0} aria-valuemax={100}>
      <div className={cx('h-1.5 rounded-full', tone === 'red' ? 'bg-red-500' : tone === 'amber' ? 'bg-amber-500' : tone === 'green' ? 'bg-emerald-500' : 'bg-brand-500')} style={{ width: `${v}%` }} />
    </div>
  );
}
