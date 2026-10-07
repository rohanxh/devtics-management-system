import { and, eq, isNotNull } from 'drizzle-orm';
import * as s from './schema/index.ts';
import { DEMO_SEEDERS, daysFromNow, type SeedCtx } from './seed-demo.ts';
import { nextNumber } from '../core/counters.ts';
import { recalcInvoice } from '../modules/finance.ts';
import { pick, rnd } from './seed-demo-crm.ts';

const monthBounds = (offset: number) => {
  const d = new Date();
  const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - offset, 1));
  const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - offset + 1, 0));
  return [start.toISOString().slice(0, 10), end.toISOString().slice(0, 10)];
};

DEMO_SEEDERS.push({
  name: 'finance',
  async run({ tx, users: u, employees: emp }: SeedCtx) {
    const projects = await tx.select().from(s.projects).where(isNotNull(s.projects.clientId));
    for (const p of projects) {
      const ms = await tx.select().from(s.milestones).where(and(eq(s.milestones.projectId, p.id), eq(s.milestones.status, 'completed')));
      for (const m of ms) {
        const issue = m.completedAt!;
        const due = new Date(new Date(issue + 'T00:00:00Z').getTime() + 15 * 86400_000).toISOString().slice(0, 10);
        const [inv] = await tx.insert(s.invoices).values({
          number: await nextNumber(tx, 'invoice', 'INV-', 5), companyId: p.clientId!, projectId: p.id, milestoneId: m.id, issueDate: issue, dueDate: due,
          status: 'sent', sentAt: new Date(issue), createdById: u.sara,
        }).returning();
        await tx.insert(s.invoiceItems).values({ invoiceId: inv.id, description: `${p.name} — ${m.name}`, quantity: '1', unitPrice: m.billingAmount ?? '1000' });
        await recalcInvoice(tx, inv.id);
        // Most clients pay; one per run stays overdue or part-paid.
        const r = rnd();
        if (due < daysFromNow(-5) && r < 0.7) {
          await tx.insert(s.payments).values({ number: await nextNumber(tx, 'payment', 'PMT-', 5), invoiceId: inv.id, companyId: p.clientId!, amount: m.billingAmount ?? '1000', paidOn: due, method: pick(['bank_transfer', 'wise', 'payoneer'] as const), reference: `TRX-${Math.floor(rnd() * 1e6)}`, recordedById: u.sara });
        } else if (r < 0.85) {
          await tx.insert(s.payments).values({ number: await nextNumber(tx, 'payment', 'PMT-', 5), invoiceId: inv.id, companyId: p.clientId!, amount: String(Math.round(Number(m.billingAmount ?? 1000) / 2)), paidOn: issue, method: 'bank_transfer', recordedById: u.sara });
        }
        await recalcInvoice(tx, inv.id);
      }
    }
    // Twelve months of historical billing (paid) so trends are meaningful.
    const clients = await tx.select().from(s.companies).where(eq(s.companies.lifecycle, 'client'));
    for (let mo = 11; mo >= 1; mo--) {
      const [start] = monthBounds(mo);
      for (let k = 0; k < 3; k++) {
        const c = clients[(mo + k) % clients.length];
        const issue = start.slice(0, 8) + String(5 + k * 7).padStart(2, '0');
        const amount = String(4000 + Math.round(rnd() * 9000));
        const [inv] = await tx.insert(s.invoices).values({ number: await nextNumber(tx, 'invoice', 'INV-', 5), companyId: c.id, issueDate: issue, dueDate: issue, status: 'sent', createdById: u.sara }).returning();
        await tx.insert(s.invoiceItems).values({ invoiceId: inv.id, description: 'Development services', quantity: '1', unitPrice: amount });
        await recalcInvoice(tx, inv.id);
        await tx.insert(s.payments).values({ number: await nextNumber(tx, 'payment', 'PMT-', 5), invoiceId: inv.id, companyId: c.id, amount, paidOn: issue, method: 'bank_transfer', recordedById: u.sara });
        await recalcInvoice(tx, inv.id);
      }
    }
    const [orbit] = await tx.select().from(s.companies).where(eq(s.companies.name, 'Orbit Fintech'));
    const [north] = await tx.select().from(s.companies).where(eq(s.companies.name, 'Northwind Retail'));
    await tx.insert(s.recurringBilling).values([
      { companyId: orbit.id, description: 'Website care plan', amount: '450', interval: 'monthly', nextRunDate: daysFromNow(12) },
      { companyId: north.id, description: 'Store hosting & monitoring', amount: '900', interval: 'quarterly', nextRunDate: daysFromNow(40) },
    ]);

    const expenseSeed = [
      ['infrastructure', 'AWS — production workloads', 'Amazon Web Services', 640], ['software', 'Figma team plan', 'Figma', 180], ['software', 'GitHub Team', 'GitHub', 120],
      ['office', 'Office rent', 'Example Properties', 1800], ['marketing', 'LinkedIn ads', 'LinkedIn', 500], ['equipment', 'Monitors x2', 'Tech Store', 420],
      ['infrastructure', 'Managed WordPress hosting', 'Hosting Co', 90], ['contractors', 'Copywriting', 'Freelance writer', 350], ['travel', 'Client workshop travel', 'Airline', 380],
    ] as const;
    for (let mo = 0; mo < 3; mo++) {
      for (const [category, description, vendor, amount] of expenseSeed) {
        if (mo > 0 && ['equipment', 'travel', 'contractors'].includes(category)) continue;
        const date = daysFromNow(-mo * 30 - Math.floor(rnd() * 10));
        const proj = category === 'infrastructure' ? pick(projects) : null;
        const status = mo === 0 && rnd() < 0.35 ? pick(['submitted', 'approved'] as const) : 'paid';
        await tx.insert(s.expenses).values({
          number: await nextNumber(tx, 'expense', 'EXP-', 5), category, description, vendor, amount: String(amount), expenseDate: date,
          dueDate: daysFromNow(-mo * 30 + 10), projectId: proj?.id, status, submittedById: pick([u.sara, u.danish, u.kamran]),
          approvedById: status === 'submitted' ? null : u.ayesha, paidAt: status === 'paid' ? date : null,
        });
      }
    }

    // Payroll: last three months approved/paid; adjustments for flavour.
    await tx.insert(s.employeeAdjustments).values([
      { employeeId: emp.ali, kind: 'bonus', amount: '400', effectiveDate: daysFromNow(-5), reason: 'Successful launch', status: 'approved', approvedById: u.ayesha },
      { employeeId: emp.fahad, kind: 'advance', amount: '300', effectiveDate: daysFromNow(-3), reason: 'Salary advance', status: 'pending' },
    ]);
    const comp = await tx.select().from(s.employeeCompensation);
    for (let mo = 3; mo >= 1; mo--) {
      const [start, end] = monthBounds(mo);
      let gross = 0;
      const [run] = await tx.insert(s.payrollRuns).values({ number: `PAY-${end.slice(0, 7)}-${await nextNumber(tx, 'payroll', '', 3)}`, periodStart: start, periodEnd: end, status: 'paid', createdById: u.sara, approvedById: u.ayesha, approvedAt: new Date(end), paidAt: end }).returning();
      for (const c of comp) {
        const g = Number(c.baseSalary) + Number(c.allowances);
        gross += g;
        await tx.insert(s.payrollItems).values({ runId: run.id, employeeId: c.employeeId, baseSalary: c.baseSalary, allowances: c.allowances, gross: g.toFixed(2), net: g.toFixed(2) });
      }
      await tx.update(s.payrollRuns).set({ totalGross: gross.toFixed(2), totalNet: gross.toFixed(2) }).where(eq(s.payrollRuns.id, run.id));
    }
  },
});
