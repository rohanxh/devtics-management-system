import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { companies, invoices, notifications, pipelineStages, recurringBilling } from '../src/server/db/schema/index.ts';
import { JOBS } from '../src/server/jobs.ts';
import { generateRecurringInvoices } from '../src/server/modules/finance.ts';
import { withActor } from '../src/server/core/context.ts';

let t: TestEnv;
let fin: Awaited<ReturnType<TestEnv['as']>>;
let fin2: Awaited<ReturnType<TestEnv['as']>>;
let pm: Awaited<ReturnType<TestEnv['as']>>;
let dev: Awaited<ReturnType<TestEnv['as']>>;
let clientId: string;
let projectId: string;

beforeAll(async () => {
  t = await setup();
  fin = await t.as(['finance']); fin2 = await t.as(['finance', 'ceo']); pm = await t.as(['pm']); dev = await t.as(['developer']);
  const bd = await t.as(['bd']);
  const c = await bd.api.post('/api/r/clients', { name: 'Globex Ltd', accountManagerId: pm.user.id, paymentTermsDays: 30 });
  expect(c.status).toBe(201);
  expect(c.body.clientCode).toMatch(/^CL-/);
  clientId = c.body.id;
  const [st] = await t.db.select().from(pipelineStages).where(eq(pipelineStages.key, 'development'));
  projectId = (await pm.api.post('/api/r/projects', { name: 'Globex portal', clientId, stageId: st.id, pmId: pm.user.id, techLeadId: dev.user.id, budgetAmount: '20000' })).body.id;
});
afterAll(async () => { await t.close(); });

async function newInvoice(extra: Record<string, unknown> = {}) {
  const inv = (await fin.api.post('/api/r/invoices', { companyId: clientId, projectId, taxRate: '0', ...extra })).body;
  await fin.api.post('/api/r/invoice_items', { invoiceId: inv.id, description: 'Development', quantity: '10', unitPrice: '100' });
  return inv;
}

describe('invoices and payments', () => {
  it('derives totals, balance and status from items and payments', async () => {
    const inv = await newInvoice();
    expect(inv.status).toBe('draft');
    expect(inv.number).toMatch(/^INV-\d{5}$/);
    expect((await fin.api.post('/api/r/payments', { invoiceId: inv.id, amount: '10' })).status).toBe(409); // draft
    expect((await fin.api.patch(`/api/r/invoices/${inv.id}`, { status: 'sent' })).status).toBe(200);
    let cur = (await fin.api.get(`/api/r/invoices/${inv.id}`)).body;
    expect(cur).toMatchObject({ total: '1000.00', balanceDue: '1000.00', status: 'sent' });
    // Amounts are locked once sent
    expect((await fin.api.patch(`/api/r/invoices/${inv.id}`, { discountAmount: '50' })).status).toBe(409);
    const items = (await fin.api.get(`/api/r/invoice_items?invoiceId=${inv.id}`)).body.rows;
    expect((await fin.api.patch(`/api/r/invoice_items/${items[0].id}`, { unitPrice: '1' })).status).toBe(409);

    expect((await fin.api.post('/api/r/payments', { invoiceId: inv.id, amount: '400' })).status).toBe(201);
    cur = (await fin.api.get(`/api/r/invoices/${inv.id}`)).body;
    expect(cur).toMatchObject({ status: 'partially_paid', amountPaid: '400.00', balanceDue: '600.00' });
    expect((await fin.api.post('/api/r/payments', { invoiceId: inv.id, amount: '600.01' })).status).toBe(422); // overpayment
    const p2 = await fin.api.post('/api/r/payments', { invoiceId: inv.id, amount: '600' });
    cur = (await fin.api.get(`/api/r/invoices/${inv.id}`)).body;
    expect(cur).toMatchObject({ status: 'paid', balanceDue: '0.00' });
    expect(cur.paidAt).toBeTruthy();
    // Deleting a payment reopens the balance
    expect((await fin.api.del(`/api/r/payments/${p2.body.id}`)).status).toBe(200);
    expect((await fin.api.get(`/api/r/invoices/${inv.id}`)).body.status).toBe('partially_paid');
    expect((await fin.api.patch(`/api/r/invoices/${inv.id}`, { status: 'void', voidReason: 'test' })).status).toBe(422);
  });

  it('flags overdue invoices, alerts finance + account manager and lowers client health', async () => {
    const inv = await newInvoice({ issueDate: '2024-01-01', dueDate: '2024-01-31' });
    await fin.api.patch(`/api/r/invoices/${inv.id}`, { status: 'sent' });
    // sending an already-past-due invoice recalculates straight to overdue
    expect((await fin.api.get(`/api/r/invoices/${inv.id}`)).body.status).toBe('overdue');
    for (const job of JOBS) await job.run(t.db);
    await t.events.processPending();
    const pmNotes = await t.db.select().from(notifications).where(eq(notifications.userId, pm.user.id));
    expect(pmNotes.some((x) => x.title.startsWith('Invoice overdue'))).toBe(true);
    const [co] = await t.db.select().from(companies).where(eq(companies.id, clientId));
    expect(co.healthScore).toBeLessThan(100);
    expect(co.healthReasons).toMatch(/overdue invoice/);
  });

  it('keeps finance data away from developers and scopes PMs to their projects', async () => {
    expect((await dev.api.get('/api/r/invoices')).status).toBe(403);
    expect((await dev.api.get('/api/r/payments')).status).toBe(403);
    const asPm = (await pm.api.get('/api/r/invoices')).body.rows;
    expect(asPm.length).toBeGreaterThan(0);
    expect(asPm.every((r: any) => r.projectId === projectId)).toBe(true);
    const otherPm = await t.as(['pm']);
    expect((await otherPm.api.get('/api/r/invoices')).body.rows).toHaveLength(0);
    expect((await pm.api.get('/api/dashboard/finance')).status).toBe(403);
  });

  it('generates recurring invoice drafts and catches up missed periods', async () => {
    await t.db.insert(recurringBilling).values({ companyId: clientId, description: 'Maintenance retainer', amount: '500', interval: 'monthly', nextRunDate: new Date(Date.now() - 40 * 86400_000).toISOString().slice(0, 10) });
    const created = await withActor(t.db, null, 'test', (tx) => generateRecurringInvoices(tx));
    expect(created).toBe(2);
    const drafts = await t.db.select().from(invoices);
    expect(drafts.filter((d) => d.recurringBillingId).every((d) => d.total === '500.00' && d.status === 'draft')).toBe(true);
  });
});

describe('expenses and profitability', () => {
  it('requires a different approver and counts project infrastructure cost', async () => {
    const e = await dev.api.post('/api/r/expenses', { description: 'Staging server', category: 'infrastructure', amount: '120', projectId });
    expect(e.status).toBe(201);
    expect((await dev.api.patch(`/api/r/expenses/${e.body.id}`, { status: 'approved' })).status).toBe(403);
    const own = await fin.api.post('/api/r/expenses', { description: 'Own', amount: '10' });
    expect((await fin.api.patch(`/api/r/expenses/${own.body.id}`, { status: 'approved' })).status).toBe(403); // self-approval
    expect((await fin.api.patch(`/api/r/expenses/${e.body.id}`, { status: 'approved' })).status).toBe(200);
    const prof = (await fin.api.get('/api/finance/profitability')).body.find((p: any) => p.id === projectId);
    expect(prof.infrastructureCost).toBe(120);
    expect(prof.revenue).toBeGreaterThan(0);
    expect(prof.profit).toBeCloseTo(prof.revenue - prof.employeeCost - prof.infrastructureCost - prof.otherExpenses, 2);
    // developers only see their own expenses
    expect((await dev.api.get('/api/r/expenses')).body.rows.every((r: any) => r.submittedById === dev.user.id)).toBe(true);
  });
});

describe('payroll', () => {
  it('builds payroll from salary history and approved adjustments with four-eyes approval', async () => {
    const c = await fin.api.post('/api/r/compensation', { employeeId: dev.user.employeeId, effectiveFrom: '2024-01-01', baseSalary: '3000', allowances: '200' });
    expect(c.status).toBe(201);
    expect(Number(c.body.hourlyCost)).toBeGreaterThan(0);
    const bonus = (await fin.api.post('/api/r/employee_adjustments', { employeeId: dev.user.employeeId, kind: 'bonus', amount: '500', reason: 'Launch', effectiveDate: '2026-01-15' })).body;
    expect((await fin.api.patch(`/api/r/employee_adjustments/${bonus.id}`, { status: 'approved' })).status).toBe(200);
    const run = await fin.api.post('/api/finance/payroll-runs', { periodStart: '2026-01-01', periodEnd: '2026-01-31' });
    expect(run.status).toBe(201);
    expect((await fin.api.post('/api/finance/payroll-runs', { periodStart: '2026-01-01', periodEnd: '2026-01-31' })).status).toBe(409);
    expect((await fin.api.post(`/api/finance/payroll-runs/${run.body.id}/approve`)).status).toBe(403); // preparer
    expect((await fin2.api.post(`/api/finance/payroll-runs/${run.body.id}/approve`)).status).toBe(200);
    // The developer sees only their own payslip, not company totals or others' pay
    const runs = (await dev.api.get('/api/r/payroll_runs')).body.rows;
    expect(runs).toHaveLength(1);
    expect(runs[0]).not.toHaveProperty('totalGross');
    const slips = (await dev.api.get('/api/r/payroll_items')).body.rows;
    expect(slips).toHaveLength(1);
    expect(slips[0]).toMatchObject({ gross: '3700.00', net: '3700.00', bonuses: '500.00' });
    expect((await dev.api.get('/api/r/compensation')).body.rows).toHaveLength(1);
    expect((await dev.api.patch(`/api/r/employee_adjustments/${bonus.id}`, { amount: '1' })).status).toBe(403);
  });

  it('keeps salary data from HR-free admin roles', async () => {
    const admin = await t.as(['admin']);
    expect((await admin.api.get('/api/r/compensation')).body.rows ?? []).toHaveLength(0);
  });
});
