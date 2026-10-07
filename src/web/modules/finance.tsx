import { useState } from 'react';
import { Link, useNavigate } from 'react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Banknote, CreditCard, FileText, Send } from 'lucide-react';
import { api } from '../lib/api';
import { date, isOverdue, money, today } from '../lib/format';
import { useCan, useMeta } from '../lib/meta';
import { registerActions } from '../lib/extensions';
import { Button, Card, EmptyState, ErrorState, Field, Modal, PageHeader, Spinner, Stat, StatusBadge, cx } from '../components/ui';
import { SimpleBars } from '../components/charts';
import { useToast } from '../components/toast';
import { DASHBOARDS, greeting } from '../pages/Home';
import { ApprovalsList } from '../pages/Inbox';

function RecordPaymentModal({ invoice, open, onClose, onDone }: { invoice: any; open: boolean; onClose: () => void; onDone: () => void }) {
  const toast = useToast();
  const [amount, setAmount] = useState(invoice.balanceDue);
  const [paidOn, setPaidOn] = useState(today());
  const [method, setMethod] = useState('bank_transfer');
  const [reference, setReference] = useState('');
  const save = useMutation({
    mutationFn: () => api.post('/api/r/payments', { invoiceId: invoice.id, amount, paidOn, method, reference }),
    onSuccess: () => { toast.success('Payment recorded'); onDone(); onClose(); },
    onError: toast.error,
  });
  return (
    <Modal open={open} onClose={onClose} title={`Record payment · ${invoice.number}`}
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Record</Button></>}>
      <div className="grid grid-cols-2 gap-3">
        <Field label={`Amount (balance ${invoice.balanceDue})`} htmlFor="pm-a"><input id="pm-a" type="number" step="0.01" className="input" value={amount} onChange={(e) => setAmount(e.target.value)} /></Field>
        <Field label="Received on" htmlFor="pm-d"><input id="pm-d" type="date" max={today()} className="input" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} /></Field>
        <Field label="Method" htmlFor="pm-m">
          <select id="pm-m" className="input" value={method} onChange={(e) => setMethod(e.target.value)}>
            {['bank_transfer', 'card', 'cash', 'cheque', 'paypal', 'wise', 'payoneer', 'other'].map((m) => <option key={m} value={m}>{m.replace('_', ' ')}</option>)}
          </select>
        </Field>
        <Field label="Reference" htmlFor="pm-r"><input id="pm-r" className="input" value={reference} onChange={(e) => setReference(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function InvoiceActions({ record, reload }: { record: any; reload: () => void }) {
  const can = useCan();
  const toast = useToast();
  const qc = useQueryClient();
  const [paying, setPaying] = useState(false);
  const send = useMutation({ mutationFn: () => api.patch(`/api/r/invoices/${record.id}`, { status: 'sent' }), onSuccess: () => { toast.success('Invoice marked as sent'); reload(); }, onError: toast.error });
  const done = () => { reload(); qc.invalidateQueries({ queryKey: ['r', 'payments'] }); };
  return (
    <>
      {record.status === 'draft' && record._can?.edit && <Button variant="primary" loading={send.isPending} onClick={() => send.mutate()}><Send className="size-3.5" /> Mark as sent</Button>}
      {['sent', 'partially_paid', 'overdue'].includes(record.status) && can('payments.create') && <Button variant="primary" onClick={() => setPaying(true)}><CreditCard className="size-3.5" /> Record payment</Button>}
      {paying && <RecordPaymentModal invoice={record} open onClose={() => setPaying(false)} onDone={done} />}
    </>
  );
}
registerActions('invoices', InvoiceActions);

function MilestoneActions({ record }: { record: any; reload: () => void }) {
  const can = useCan();
  const toast = useToast();
  const navigate = useNavigate();
  const create = useMutation({
    mutationFn: () => api.post<any>(`/api/finance/invoices/from-milestone/${record.id}`),
    onSuccess: (inv) => { toast.success(`${inv.number} drafted`); navigate(`/r/invoices/${inv.id}`); },
    onError: toast.error,
  });
  if (!can('invoices.create') || !record.billingAmount) return null;
  return <Button loading={create.isPending} onClick={() => create.mutate()}><FileText className="size-3.5" /> Create invoice</Button>;
}
registerActions('milestones', MilestoneActions);

function PayrollActions({ record, reload }: { record: any; reload: () => void }) {
  const can = useCan();
  const toast = useToast();
  const approve = useMutation({ mutationFn: () => api.post(`/api/finance/payroll-runs/${record.id}/approve`), onSuccess: () => { toast.success('Payroll approved'); reload(); }, onError: toast.error });
  const paid = useMutation({ mutationFn: () => api.post(`/api/finance/payroll-runs/${record.id}/paid`), onSuccess: () => { toast.success('Payroll marked as paid'); reload(); }, onError: toast.error });
  return (
    <>
      {record.status === 'draft' && can('payroll.approve') && <Button variant="primary" loading={approve.isPending} onClick={() => approve.mutate()}>Approve payroll</Button>}
      {record.status === 'approved' && can('payroll.edit') && <Button variant="primary" loading={paid.isPending} onClick={() => confirm('Confirm salaries have been paid?') && paid.mutate()}><Banknote className="size-3.5" /> Mark as paid</Button>}
    </>
  );
}
registerActions('payroll_runs', PayrollActions);

export function RunPayrollModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const toast = useToast();
  const navigate = useNavigate();
  const d = new Date();
  const first = new Date(Date.UTC(d.getFullYear(), d.getMonth(), 1)).toISOString().slice(0, 10);
  const last = new Date(Date.UTC(d.getFullYear(), d.getMonth() + 1, 0)).toISOString().slice(0, 10);
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(last);
  const run = useMutation({
    mutationFn: () => api.post<any>('/api/finance/payroll-runs', { periodStart: from, periodEnd: to }),
    onSuccess: (r) => { toast.success(`${r.number} prepared`); navigate(`/r/payroll_runs/${r.id}`); },
    onError: toast.error,
  });
  return (
    <Modal open={open} onClose={onClose} title="Prepare payroll"
      footer={<><Button onClick={onClose}>Cancel</Button><Button variant="primary" loading={run.isPending} onClick={() => run.mutate()}>Prepare</Button></>}>
      <p className="mb-3 text-sm text-slate-600">Creates payslips for active employees from their current salary and approved bonuses, deductions and advances. A second person must approve it.</p>
      <div className="grid grid-cols-2 gap-3">
        <Field label="From" htmlFor="pr-f"><input id="pr-f" type="date" className="input" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To" htmlFor="pr-t"><input id="pr-t" type="date" className="input" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>
    </Modal>
  );
}

function FinanceDashboard() {
  const { user, settings } = useMeta();
  const can = useCan();
  const cur = settings.baseCurrency;
  const [payroll, setPayroll] = useState(false);
  const q = useQuery({ queryKey: ['dashboard', 'finance'], queryFn: () => api.get<any>('/api/dashboard/finance') });
  if (q.isLoading) return <Spinner />;
  if (q.isError) return <ErrorState error={q.error} retry={() => q.refetch()} />;
  const d = q.data;
  const ar = d.receivables;
  const aging = [
    { bucket: 'Current', amount: ar.current }, { bucket: '1–30', amount: ar.d1_30 }, { bucket: '31–60', amount: ar.d31_60 },
    { bucket: '61–90', amount: ar.d61_90 }, { bucket: '90+', amount: ar.d90_plus },
  ];
  return (
    <>
      <PageHeader title={greeting(user.name)} subtitle="Cash, receivables, payables and profitability."
        actions={<>
          {can('payroll.create') && <Button onClick={() => setPayroll(true)}><Banknote className="size-3.5" /> Prepare payroll</Button>}
          {can('invoices.create') && <Link to="/r/invoices" className="rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-brand-700">Invoices</Link>}
        </>} />
      <div className="mb-4 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Revenue (month)" value={money(d.month.revenue, cur, true)} hint={`${money(d.ytd.revenue, cur, true)} YTD`} />
        <Stat label="Expenses (month)" value={money(d.month.expenses, cur, true)} hint={`+ ${money(d.month.payroll, cur, true)} payroll`} />
        <Stat label="Profit (month)" value={money(d.month.profit, cur, true)} tone={d.month.profit < 0 ? 'red' : 'green'} hint={d.month.marginPct != null ? `${d.month.marginPct}% margin` : undefined} />
        <Stat label="MRR" value={money(d.mrr, cur, true)} />
        <Stat label="Receivables" value={money(ar.total, cur, true)} hint={`${ar.open_count} open invoices`} />
        <Stat label="Overdue" value={ar.overdue_count} tone={ar.overdue_count ? 'red' : undefined} hint={money(ar.total - ar.current, cur, true)} />
        <Stat label="Payables" value={money(d.payables.amount, cur, true)} hint={`${d.payables.count} approved bills`} />
        <Stat label="Last payroll" value={d.lastPayroll ? money(d.lastPayroll.totalGross, cur, true) : '—'} hint={d.lastPayroll ? `${d.lastPayroll.number} · ${d.lastPayroll.status}` : undefined} />
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card title="Profit by month (revenue − expenses − payroll)" className="xl:col-span-2">
          <SimpleBars data={d.series.map((s: any) => ({ month: s.month.slice(2), profit: s.profit }))} x="month" y="profit" format={(v) => money(v, cur, true)} />
        </Card>
        <Card title="Receivables aging">
          <SimpleBars data={aging} x="bucket" y="amount" format={(v) => money(v, cur, true)} height={200} />
        </Card>
        <Card title="Invoices due in the next 14 days" className="xl:col-span-2">
          {!d.upcoming.length ? <EmptyState title="Nothing due" /> : (
            <ul className="divide-y divide-slate-100 text-sm">{d.upcoming.map((i: any) => (
              <li key={i.id} className="flex items-center gap-3 py-1.5">
                <Link to={`/r/invoices/${i.id}`} className="w-28 font-mono text-xs hover:underline">{i.number}</Link>
                <span className="flex-1 truncate">{i.client}</span>
                <span className={cx('text-xs', isOverdue(i.dueDate) ? 'font-medium text-red-600' : 'text-slate-500')}>{date(i.dueDate)}</span>
                <span className="w-28 text-right tabular-nums">{money(i.balanceDue, cur)}</span>
                <StatusBadge value={i.status} />
              </li>
            ))}</ul>
          )}
        </Card>
        <Card title="Waiting for your approval"><ApprovalsList compact /></Card>
        <Card title="Least profitable projects" className="xl:col-span-2" bodyClass="p-0">
          {!d.profitability.length ? <p className="p-4 text-sm text-slate-500">No project financials yet.</p> : (
            <table className="w-full text-sm">
              <thead><tr className="border-b border-slate-200 text-left text-xs text-slate-500"><th className="px-4 py-2">Project</th><th className="px-2 py-2 text-right">Revenue</th><th className="px-2 py-2 text-right">Employee cost</th><th className="px-2 py-2 text-right">Infra + other</th><th className="px-2 py-2 text-right">Profit</th><th className="px-4 py-2 text-right">Margin</th></tr></thead>
              <tbody>{d.profitability.map((p: any) => (
                <tr key={p.id} className="border-b border-slate-100 last:border-0">
                  <td className="px-4 py-1.5"><Link to={`/r/projects/${p.id}`} className="hover:underline">{p.name}</Link><div className="text-xs text-slate-500">{p.code} · {p.clientName}</div></td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{money(p.revenue, cur, true)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{money(p.employeeCost, cur, true)}</td>
                  <td className="px-2 py-1.5 text-right tabular-nums">{money(p.infrastructureCost + p.otherExpenses, cur, true)}</td>
                  <td className={cx('px-2 py-1.5 text-right tabular-nums', p.profit < 0 && 'text-red-600')}>{money(p.profit, cur, true)}</td>
                  <td className={cx('px-4 py-1.5 text-right tabular-nums', (p.marginPct ?? 0) < 20 && 'text-red-600')}>{p.marginPct != null ? `${p.marginPct}%` : '—'}</td>
                </tr>
              ))}</tbody>
            </table>
          )}
        </Card>
        <Card title="Bills to pay">
          {!d.payablesDue.length ? <p className="text-sm text-slate-500">No approved bills awaiting payment.</p> : (
            <ul className="space-y-1.5 text-sm">{d.payablesDue.map((e: any) => (
              <li key={e.id} className="flex justify-between gap-2">
                <Link to={`/r/expenses/${e.id}`} className="truncate hover:underline">{e.vendor ?? e.description}</Link>
                <span className="shrink-0 tabular-nums">{money(e.amount, cur)}{e.dueDate && <span className={cx('ml-2 text-xs', isOverdue(e.dueDate) ? 'text-red-600' : 'text-slate-500')}>{date(e.dueDate)}</span>}</span>
              </li>
            ))}</ul>
          )}
        </Card>
      </div>
      <RunPayrollModal open={payroll} onClose={() => setPayroll(false)} />
    </>
  );
}
DASHBOARDS.finance = FinanceDashboard;
