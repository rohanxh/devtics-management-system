import { isNotNull } from 'drizzle-orm';
import * as s from './schema/index.ts';
import { DEMO_SEEDERS, daysFromNow, type SeedCtx } from './seed-demo.ts';
import { nextNumber } from '../core/counters.ts';
import { pick, rnd } from './seed-demo-crm.ts';
import { slaDue } from '../modules/support.ts';

DEMO_SEEDERS.push({
  name: 'support',
  async run({ tx, users: u }: SeedCtx) {
    const projects = await tx.select().from(s.projects).where(isNotNull(s.projects.clientId));
    const plans: (typeof s.maintenancePlans.$inferSelect)[] = [];
    for (const name of ['Orbit Fintech marketing site', 'Crescent Foods website', 'Northwind WooCommerce store']) {
      const p = projects.find((x) => x.name === name);
      if (!p) continue;
      const fee = name.startsWith('Northwind') ? 1200 : 450;
      const [plan] = await tx.insert(s.maintenancePlans).values({
        name: `${name} — care plan`, companyId: p.clientId!, projectId: p.id, monthlyHours: name.startsWith('Northwind') ? '15' : '6', monthlyFee: String(fee),
        overageRate: '45', startDate: daysFromNow(-120), accountManagerId: p.pmId, includedServices: '- Plugin & core updates\n- Uptime monitoring\n- Monthly backups\n- Small content changes',
      }).returning();
      plans.push(plan);
      await tx.insert(s.recurringBilling).values({ companyId: p.clientId!, projectId: p.id, maintenancePlanId: plan.id, description: `Maintenance plan: ${plan.name}`, amount: String(fee), interval: 'monthly', nextRunDate: daysFromNow(10) });
    }
    const issues = [
      ['Contact form not sending emails', 'bug', 'high'], ['Please update homepage banner', 'maintenance', 'low'], ['Site down for some users', 'incident', 'urgent'],
      ['How do I add a new product category?', 'question', 'medium'], ['Add a new landing page', 'change_request', 'medium'], ['Checkout slow on mobile', 'bug', 'high'],
      ['SSL warning in Safari', 'incident', 'high'], ['Change footer phone number', 'maintenance', 'low'],
    ] as const;
    let i = 0;
    for (const [title, type, priority] of issues) {
      const plan = plans[i % plans.length];
      const created = new Date(Date.now() - (i * 19 + 3) * 3600_000);
      const due = await slaDue(tx, priority, plan.id, created);
      const status = pick(['new', 'assigned', 'in_development', 'waiting_for_client', 'resolved', 'closed'] as const);
      const breached = due.resolutionDueAt! < new Date() && !['resolved', 'closed'].includes(status);
      const [tk] = await tx.insert(s.tickets).values({
        number: await nextNumber(tx, 'ticket', 'TCK-', 5), companyId: plan.companyId, projectId: plan.projectId, maintenancePlanId: plan.id, title, type, priority, status,
        source: pick(['email', 'phone', 'chat'] as const), assigneeId: status === 'new' ? null : pick([u.sana, u.fahad, u.ali]), createdAt: created,
        ...due, firstRespondedAt: status === 'new' ? null : new Date(created.getTime() + 30 * 60_000),
        resolvedAt: ['resolved', 'closed'].includes(status) ? new Date(created.getTime() + 20 * 3600_000) : null, slaBreached: breached, breachedAt: breached ? due.resolutionDueAt : null,
        satisfaction: status === 'closed' ? 4 + Math.round(rnd()) : null, description: 'Reported by the client via the support channel.',
      }).returning();
      if (status !== 'new') {
        await tx.insert(s.timeEntries).values({ userId: tk.assigneeId!, projectId: plan.projectId, ticketId: tk.id, workDate: daysFromNow(-(i % 6)), minutes: 45 + Math.floor(rnd() * 120), description: `Support: ${title}`, billable: true });
      }
      i++;
    }
  },
});
