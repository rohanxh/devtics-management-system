import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, lt, lte, ne, notInArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import {
  companies, employeeAdjustments, employeeCompensation, employees, expenses, invoiceItems, invoices, milestones,
  payments, payrollItems, payrollRuns, projects, recurringBilling,
} from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx, withActor } from '../core/context.ts';
import { conflict, forbidden, invalid } from '../core/errors.ts';
import { emit, registerAction } from '../core/events.ts';
import { nextNumber } from '../core/counters.ts';
import { notify } from '../core/notify.ts';
import { can } from '../rbac/actor.ts';
import { afterWrite, getOne, requireResource } from '../resources/engine.ts';
import type { Row } from '../resources/types.ts';
import { JOBS } from '../jobs.ts';
import { recalcTotals } from './sales.ts';
import { HEALTH_SIGNALS } from './clients.ts';
import { getSettings } from './settings.ts';
import { daysAgo, monthStart, registerDashboard, scopeOr, today } from './reports.ts';

const n = (v: unknown) => Number(v ?? 0);
const plusDays = (d: string, k: number) => new Date(new Date(d + 'T00:00:00Z').getTime() + k * 86400_000).toISOString().slice(0, 10);

/**
 * Recomputes an invoice's totals, amount paid, balance and payment-driven status.
 * Status transitions caused by money (partially paid / paid / overdue) are owned here, not by users.
 */
export async function recalcInvoice(db: DB, invoiceId: string, actor: any = null) {
  await recalcTotals(db, 'invoice', invoiceId);
  const [prev] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
  if (!prev) return;
  const [{ paid }] = await db.select({ paid: sql<string>`coalesce(sum(${payments.amount}), 0)` }).from(payments).where(eq(payments.invoiceId, invoiceId));
  const total = n(prev.total);
  const amountPaid = n(paid);
  let status = prev.status;
  if (!['draft', 'void'].includes(prev.status)) {
    if (total > 0 && amountPaid >= total) status = 'paid';
    else if (amountPaid > 0) status = prev.dueDate < today() ? 'overdue' : 'partially_paid';
    else status = prev.dueDate < today() ? 'overdue' : 'sent';
  }
  const patch = {
    amountPaid: amountPaid.toFixed(2), balanceDue: Math.max(total - amountPaid, 0).toFixed(2), status,
    paidAt: status === 'paid' ? (prev.paidAt ?? new Date()) : null,
  };
  const [next] = await db.update(invoices).set(patch).where(eq(invoices.id, invoiceId)).returning();
  if (next.status !== prev.status) await afterWrite(db, requireResource('invoices'), actor, next as Row, prev as Row);
  return next;
}

// ───────────── Client health: overdue invoices ─────────────

HEALTH_SIGNALS.push(async (db, ids) => {
  const m = new Map<string, { penalty: number; reason: string }[]>();
  const rows = await db.select({ companyId: invoices.companyId, cnt: sql<number>`count(*)::int`, bal: sql<string>`sum(${invoices.balanceDue})` })
    .from(invoices).where(and(inArray(invoices.companyId, ids), eq(invoices.status, 'overdue'))).groupBy(invoices.companyId);
  for (const r of rows) m.set(r.companyId, [{ penalty: Math.min(25 * r.cnt, 50), reason: `${r.cnt} overdue invoice(s), ${n(r.bal).toFixed(2)} outstanding` }]);
  return m;
});

// ───────────── Automation ─────────────

registerAction('finance.milestone_billable', {
  description: 'When a billable milestone completes, notify Finance (and the PM) that it can be invoiced.',
  async run({ db, event, rule }) {
    const [m] = await db.select().from(milestones).where(eq(milestones.id, event.entityId!));
    if (!m || !m.billingAmount || n(m.billingAmount) <= 0) return;
    const [p] = await db.select().from(projects).where(eq(projects.id, m.projectId));
    await notify(db, {
      roles: ['finance'], kind: 'status', title: `Billable milestone completed: ${p.code} — ${m.name} (${m.billingAmount})`,
      body: 'Create the invoice from the milestone.', entityType: 'milestones', entityId: m.id, dedupeKey: `${rule.key}:${m.id}`,
    });
  },
});

registerAction('notify_company_manager', {
  description: 'Notify the account manager of the client in the event payload (params: title, roles?[]).',
  async run({ db, event, params, rule }) {
    const [co] = await db.select().from(companies).where(eq(companies.id, String(event.payload.companyId ?? '')));
    if (!co) return;
    await notify(db, {
      userIds: [co.accountManagerId], roles: params.roles ?? [], kind: params.kind ?? 'alert',
      title: (params.title ?? '{title}').replace('{title}', String(event.payload.title ?? '')).replace('{client}', co.name),
      entityType: event.entityType ?? undefined, entityId: event.entityId ?? undefined, excludeUserId: event.actorUserId, dedupeKey: `${rule.key}:${event.id}`,
    });
  },
});

// ───────────── Jobs ─────────────

JOBS.push(
  {
    name: 'invoices.mark_overdue', everyMinutes: 60,
    run: (db) => withActor(db, null, 'job:invoices.mark_overdue', async (t) => {
      const due = await t.select({ id: invoices.id }).from(invoices).where(and(inArray(invoices.status, ['sent', 'partially_paid']), lt(invoices.dueDate, today())));
      for (const i of due) await recalcInvoice(t, i.id);
    }),
  },
  {
    name: 'billing.generate_recurring', everyMinutes: 60,
    run: (db) => withActor(db, null, 'job:billing.generate_recurring', async (t) => { await generateRecurringInvoices(t); }),
  },
);

const advance = (d: string, interval: 'monthly' | 'quarterly' | 'yearly') => {
  const x = new Date(d + 'T00:00:00Z');
  if (interval === 'monthly') x.setUTCMonth(x.getUTCMonth() + 1);
  else if (interval === 'quarterly') x.setUTCMonth(x.getUTCMonth() + 3);
  else x.setUTCFullYear(x.getUTCFullYear() + 1);
  return x.toISOString().slice(0, 10);
};

/** Drafts invoices for every active schedule whose next run date has arrived (catches up missed periods). */
export async function generateRecurringInvoices(db: DB) {
  const dueSchedules = await db.select().from(recurringBilling).where(and(eq(recurringBilling.active, true), lte(recurringBilling.nextRunDate, today())));
  let created = 0;
  for (const s of dueSchedules) {
    let runDate = s.nextRunDate;
    while (runDate <= today()) {
      const [inv] = await db.insert(invoices).values({
        number: await nextNumber(db, 'invoice', 'INV-', 5), companyId: s.companyId, projectId: s.projectId, maintenancePlanId: s.maintenancePlanId,
        recurringBillingId: s.id, issueDate: runDate, dueDate: plusDays(runDate, s.dueDays), currency: s.currency, status: 'draft',
        notes: `Recurring: ${s.description} (${runDate})`,
      }).returning();
      await db.insert(invoiceItems).values({ invoiceId: inv.id, description: `${s.description} — period starting ${runDate}`, quantity: '1', unitPrice: s.amount });
      await recalcInvoice(db, inv.id);
      await afterWrite(db, requireResource('invoices'), null, inv as Row, undefined);
      created++;
      runDate = advance(runDate, s.interval);
    }
    await db.update(recurringBilling).set({ nextRunDate: runDate, lastRunAt: new Date() }).where(eq(recurringBilling.id, s.id));
  }
  if (created) await notify(db, { roles: ['finance'], kind: 'status', title: `${created} recurring invoice draft(s) created`, link: '/r/invoices?status=draft', dedupeKey: `recurring:${today()}:${created}` });
  return created;
}

// ───────────── Metrics (single source of truth) ─────────────

/** Project profitability: revenue − employee cost − infrastructure cost − other expenses. */
export async function projectProfitability(db: DB, projectIds?: string[]) {
  const res: any = await db.execute(sql`
    select p.id, p.code, p.name, p.status, p.budget_amount,
      (select c.name from companies c where c.id = p.client_id) as client_name,
      coalesce((select sum(i.total) from invoices i where i.project_id = p.id and i.status <> 'void' and i.status <> 'draft'), 0)::float as invoiced,
      coalesce((select sum(pay.amount) from payments pay join invoices i on i.id = pay.invoice_id where i.project_id = p.id), 0)::float as collected,
      coalesce((select sum(te.cost_amount) from time_entries te where te.project_id = p.id), 0)::float as employee_cost,
      coalesce((select sum(te.minutes) from time_entries te where te.project_id = p.id), 0)::float / 60 as hours,
      coalesce((select sum(e.amount) from expenses e where e.project_id = p.id and e.status in ('approved', 'paid') and e.category in ('infrastructure', 'software')), 0)::float as infrastructure_cost,
      coalesce((select sum(e.amount) from expenses e where e.project_id = p.id and e.status in ('approved', 'paid') and e.category not in ('infrastructure', 'software')), 0)::float as other_expenses
    from projects p
    where p.is_internal = false ${projectIds ? (projectIds.length ? sql`and p.id in ${projectIds}` : sql`and false`) : sql``}
    order by p.code`);
  return (res.rows as any[]).map((r) => {
    const cost = r.employee_cost + r.infrastructure_cost + r.other_expenses;
    const profit = r.invoiced - cost;
    return {
      id: r.id, code: r.code, name: r.name, status: r.status, clientName: r.client_name, budget: n(r.budget_amount),
      revenue: r.invoiced, collected: r.collected, employeeCost: r.employee_cost, infrastructureCost: r.infrastructure_cost,
      otherExpenses: r.other_expenses, totalCost: cost, profit, marginPct: r.invoiced ? Math.round((profit / r.invoiced) * 1000) / 10 : null,
      hours: Math.round(r.hours * 10) / 10, effectiveRate: r.hours ? Math.round((r.invoiced / r.hours) * 100) / 100 : null,
    };
  });
}

/** Company P&L for a period (accrual basis: invoices by issue date, expenses by expense date, payroll by period end). */
export async function profitAndLoss(db: DB, from: string, to: string) {
  const [rev] = await db.select({ v: sql<string>`coalesce(sum(${invoices.total}), 0)` }).from(invoices)
    .where(and(notInArray(invoices.status, ['draft', 'void']), gte(invoices.issueDate, from), lte(invoices.issueDate, to)));
  const [col] = await db.select({ v: sql<string>`coalesce(sum(${payments.amount}), 0)` }).from(payments).where(and(gte(payments.paidOn, from), lte(payments.paidOn, to)));
  const exp = await db.select({ category: expenses.category, v: sql<string>`coalesce(sum(${expenses.amount}), 0)` }).from(expenses)
    .where(and(inArray(expenses.status, ['approved', 'paid']), gte(expenses.expenseDate, from), lte(expenses.expenseDate, to))).groupBy(expenses.category);
  const [pay] = await db.select({ v: sql<string>`coalesce(sum(${payrollRuns.totalGross}), 0)` }).from(payrollRuns)
    .where(and(inArray(payrollRuns.status, ['approved', 'paid']), gte(payrollRuns.periodEnd, from), lte(payrollRuns.periodEnd, to)));
  const expensesTotal = exp.reduce((a, e) => a + n(e.v), 0);
  const revenue = n(rev.v), payroll = n(pay.v);
  const profit = revenue - expensesTotal - payroll;
  return {
    from, to, revenue, collected: n(col.v), payroll, expenses: expensesTotal, expensesByCategory: Object.fromEntries(exp.map((e) => [e.category, n(e.v)])),
    profit, marginPct: revenue ? Math.round((profit / revenue) * 1000) / 10 : null,
  };
}

export async function receivables(db: DB) {
  const res: any = await db.execute(sql`
    select
      coalesce(sum(balance_due), 0)::float as total,
      coalesce(sum(balance_due) filter (where due_date >= current_date), 0)::float as current,
      coalesce(sum(balance_due) filter (where due_date < current_date and due_date >= current_date - 30), 0)::float as d1_30,
      coalesce(sum(balance_due) filter (where due_date < current_date - 30 and due_date >= current_date - 60), 0)::float as d31_60,
      coalesce(sum(balance_due) filter (where due_date < current_date - 60 and due_date >= current_date - 90), 0)::float as d61_90,
      coalesce(sum(balance_due) filter (where due_date < current_date - 90), 0)::float as d90_plus,
      count(*)::int as open_count,
      count(*) filter (where status = 'overdue')::int as overdue_count
    from invoices where status in ('sent', 'partially_paid', 'overdue')`);
  return res.rows[0];
}

/** Monthly recurring revenue: active recurring schedules normalised to a month (maintenance plans add theirs). */
export async function mrr(db: DB) {
  const [r] = await db.select({
    v: sql<string>`coalesce(sum(case ${recurringBilling.interval} when 'monthly' then ${recurringBilling.amount} when 'quarterly' then ${recurringBilling.amount} / 3 else ${recurringBilling.amount} / 12 end), 0)`,
  }).from(recurringBilling).where(eq(recurringBilling.active, true));
  return Math.round(n(r.v) * 100) / 100;
}

export async function monthlySeries(db: DB, months = 12) {
  const res: any = await db.execute(sql`
    with m as (select generate_series(date_trunc('month', current_date) - (${months - 1} || ' months')::interval, date_trunc('month', current_date), '1 month') as m)
    select to_char(m.m, 'YYYY-MM') as month,
      coalesce((select sum(total) from invoices i where i.status not in ('draft', 'void') and date_trunc('month', i.issue_date) = m.m), 0)::float as revenue,
      coalesce((select sum(amount) from expenses e where e.status in ('approved', 'paid') and date_trunc('month', e.expense_date) = m.m), 0)::float
        + coalesce((select sum(total_gross) from payroll_runs r where r.status in ('approved', 'paid') and date_trunc('month', r.period_end) = m.m), 0)::float as costs
    from m order by m.m`);
  return (res.rows as any[]).map((r) => ({ ...r, profit: Math.round((r.revenue - r.costs) * 100) / 100 }));
}

registerDashboard({
  key: 'finance', perm: 'invoices.view',
  async build(ctx) {
    if (ctx.actor.perms.get('invoices.view') !== 'all') throw forbidden();
    const month = await profitAndLoss(ctx.db, monthStart(), today());
    const ytd = await profitAndLoss(ctx.db, today().slice(0, 4) + '-01-01', today());
    const ar = await receivables(ctx.db);
    const [payables] = await ctx.db.select({ v: sql<string>`coalesce(sum(${expenses.amount}), 0)`, c: sql<number>`count(*)::int` }).from(expenses).where(eq(expenses.status, 'approved'));
    const upcoming = await ctx.db.select({ id: invoices.id, number: invoices.number, dueDate: invoices.dueDate, balanceDue: invoices.balanceDue, status: invoices.status, client: companies.name })
      .from(invoices).innerJoin(companies, eq(companies.id, invoices.companyId))
      .where(and(inArray(invoices.status, ['sent', 'partially_paid', 'overdue']), lte(invoices.dueDate, plusDays(today(), 14)))).orderBy(asc(invoices.dueDate)).limit(15);
    const payablesDue = await ctx.db.select({ id: expenses.id, number: expenses.number, description: expenses.description, vendor: expenses.vendor, amount: expenses.amount, dueDate: expenses.dueDate })
      .from(expenses).where(eq(expenses.status, 'approved')).orderBy(sql`${expenses.dueDate} asc nulls last`).limit(10);
    const [lastPayroll] = await ctx.db.select().from(payrollRuns).orderBy(desc(payrollRuns.periodEnd)).limit(1);
    const profitability = can(ctx.actor, 'project_finance.view') ? await projectProfitability(ctx.db) : [];
    return {
      month, ytd, receivables: ar, payables: { amount: n(payables.v), count: payables.c }, upcoming, payablesDue, lastPayroll: lastPayroll ?? null,
      mrr: await mrr(ctx.db), series: await monthlySeries(ctx.db, 12),
      profitability: profitability.filter((p) => p.revenue > 0 || p.totalCost > 0).sort((a, b) => (a.marginPct ?? 0) - (b.marginPct ?? 0)).slice(0, 10),
    };
  },
});

// ───────────── Routes ─────────────

export async function financeRoutes(app: FastifyInstance) {
  const kick = () => app.deps.events.kick();

  app.post<{ Params: { id: string } }>('/api/finance/invoices/from-milestone/:id', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'invoices.create')) throw forbidden();
    const m = await getOne(ctx, 'milestones', req.params.id);
    if (!m.billingAmount || n(m.billingAmount) <= 0) throw invalid('This milestone has no billing amount', { billingAmount: 'Set a billing amount first' });
    const [existing] = await ctx.db.select({ id: invoices.id }).from(invoices).where(and(eq(invoices.milestoneId, m.id), ne(invoices.status, 'void')));
    if (existing) throw conflict('An invoice already exists for this milestone');
    const [p] = await ctx.db.select().from(projects).where(eq(projects.id, m.projectId));
    if (!p.clientId) throw invalid('Internal projects cannot be invoiced', {});
    const [client] = await ctx.db.select().from(companies).where(eq(companies.id, p.clientId));
    const s = await getSettings(ctx.db);
    const inv = await tx(ctx, async (t) => {
      const [i] = await t.insert(invoices).values({
        number: await nextNumber(t, 'invoice', 'INV-', 5), companyId: p.clientId!, projectId: p.id, contractId: p.contractId, milestoneId: m.id,
        issueDate: today(), dueDate: plusDays(today(), client.paymentTermsDays ?? s.invoiceDueDays), currency: p.currency, taxRate: String(s.defaultTaxRate),
        createdById: ctx.actor.userId,
      }).returning();
      await t.insert(invoiceItems).values({ invoiceId: i.id, description: `${p.name} — milestone: ${m.name}`, quantity: '1', unitPrice: m.billingAmount });
      const next = await recalcInvoice(t, i.id, ctx.actor);
      await afterWrite(t, requireResource('invoices'), ctx.actor, next as Row, undefined);
      return next;
    });
    kick();
    return reply.status(201).send(inv);
  });

  // ── Payroll ──
  app.post('/api/finance/payroll-runs', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'payroll.create')) throw forbidden();
    const body = z.object({ periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).safeParse(req.body);
    if (!body.success || body.data.periodEnd < body.data.periodStart) throw invalid('Validation failed', { periodEnd: 'Give a valid period' });
    const { periodStart, periodEnd } = body.data;
    const [dupe] = await ctx.db.select({ id: payrollRuns.id }).from(payrollRuns).where(and(eq(payrollRuns.periodStart, periodStart), eq(payrollRuns.periodEnd, periodEnd)));
    if (dupe) throw conflict('A payroll run already exists for this period');
    const run = await tx(ctx, async (t) => {
      const [r] = await t.insert(payrollRuns).values({ number: `PAY-${periodEnd.slice(0, 7)}-${await nextNumber(t, 'payroll', '', 3)}`, periodStart, periodEnd, createdById: ctx.actor.userId }).returning();
      const staff = await t.select().from(employees).where(and(inArray(employees.employmentStatus, ['probation', 'active', 'notice']), lte(employees.joinDate, periodEnd)));
      let gross = 0, net = 0;
      for (const e of staff) {
        const [comp] = await t.select().from(employeeCompensation).where(and(eq(employeeCompensation.employeeId, e.id), lte(employeeCompensation.effectiveFrom, periodEnd)))
          .orderBy(desc(employeeCompensation.effectiveFrom)).limit(1);
        if (!comp) continue;
        const adj = await t.select().from(employeeAdjustments).where(and(eq(employeeAdjustments.employeeId, e.id), eq(employeeAdjustments.status, 'approved'), lte(employeeAdjustments.effectiveDate, periodEnd)));
        const sum = (k: string) => adj.filter((a) => a.kind === k).reduce((x, a) => x + n(a.amount), 0);
        const g = n(comp.baseSalary) + n(comp.allowances) + sum('bonus');
        const nt = g - sum('deduction') + sum('advance') - sum('advance_recovery');
        const [item] = await t.insert(payrollItems).values({
          runId: r.id, employeeId: e.id, baseSalary: comp.baseSalary, allowances: comp.allowances, bonuses: sum('bonus').toFixed(2), deductions: sum('deduction').toFixed(2),
          advances: sum('advance').toFixed(2), advanceRecovery: sum('advance_recovery').toFixed(2), gross: g.toFixed(2), net: nt.toFixed(2), currency: comp.currency,
        }).returning();
        if (adj.length) await t.update(employeeAdjustments).set({ payrollItemId: item.id }).where(inArray(employeeAdjustments.id, adj.map((a) => a.id)));
        gross += g; net += nt;
      }
      const [u] = await t.update(payrollRuns).set({ totalGross: gross.toFixed(2), totalNet: net.toFixed(2) }).where(eq(payrollRuns.id, r.id)).returning();
      await afterWrite(t, requireResource('payroll_runs'), ctx.actor, u as Row, undefined);
      return u;
    });
    kick();
    return reply.status(201).send(run);
  });

  app.post<{ Params: { id: string } }>('/api/finance/payroll-runs/:id/approve', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'payroll.approve')) throw forbidden();
    const run = await getOne(ctx, 'payroll_runs', req.params.id);
    if (run.status !== 'draft') throw conflict('Only draft payroll runs can be approved');
    if (run.createdById === ctx.actor.userId) throw forbidden('Payroll must be approved by someone other than its preparer');
    await tx(ctx, async (t) => {
      const [u] = await t.update(payrollRuns).set({ status: 'approved', approvedById: ctx.actor.userId, approvedAt: new Date() }).where(eq(payrollRuns.id, run.id)).returning();
      await t.execute(sql`update employee_adjustments set status = 'applied' where payroll_item_id in (select id from payroll_items where run_id = ${run.id})`);
      await afterWrite(t, requireResource('payroll_runs'), ctx.actor, u as Row, run);
    });
    kick();
    return { ok: true };
  });

  app.post<{ Params: { id: string } }>('/api/finance/payroll-runs/:id/paid', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'payroll.edit')) throw forbidden();
    const run = await getOne(ctx, 'payroll_runs', req.params.id);
    if (run.status !== 'approved') throw conflict('Approve the payroll run first');
    await tx(ctx, async (t) => {
      const [u] = await t.update(payrollRuns).set({ status: 'paid', paidAt: today() }).where(eq(payrollRuns.id, run.id)).returning();
      await afterWrite(t, requireResource('payroll_runs'), ctx.actor, u as Row, run);
      await emit(t, { type: 'payroll.paid', entityType: 'payroll_runs', entityId: run.id, actorUserId: ctx.actor.userId, payload: { title: run.number } });
    });
    kick();
    return { ok: true };
  });

  app.get('/api/finance/profitability', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'project_finance.view')) throw forbidden();
    const where = scopeOr(ctx, 'projects');
    const scope = ctx.actor.perms.get('project_finance.view');
    const ids = scope === 'all' ? undefined : (await ctx.db.select({ id: projects.id }).from(projects)
      .where(and(where, sql`(${projects.pmId} = ${ctx.actor.userId} or ${projects.techLeadId} = ${ctx.actor.userId})`))).map((r) => r.id);
    return projectProfitability(ctx.db, ids);
  });

  app.get<{ Querystring: { from?: string; to?: string } }>('/api/finance/pnl', async (req) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'reports.finance') && !can(ctx.actor, 'reports.executive')) throw forbidden();
    const from = /^\d{4}-\d{2}-\d{2}$/.test(req.query.from ?? '') ? req.query.from! : daysAgo(365);
    const to = /^\d{4}-\d{2}-\d{2}$/.test(req.query.to ?? '') ? req.query.to! : today();
    return { pnl: await profitAndLoss(ctx.db, from, to), series: await monthlySeries(ctx.db, 12), receivables: await receivables(ctx.db), mrr: await mrr(ctx.db) };
  });
}

