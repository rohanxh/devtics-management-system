import { eq } from 'drizzle-orm';
import * as s from './schema/index.ts';
import { DEMO_SEEDERS, daysFromNow, type SeedCtx } from './seed-demo.ts';
import { nextNumber } from '../core/counters.ts';
import { recalcQuote } from '../modules/sales.ts';
import { labourCost } from '../modules/costing.ts';

/** Deterministic pseudo-random so demo data is stable between runs. */
let seed = 42;
export const rnd = () => ((seed = (seed * 16807) % 2147483647) - 1) / 2147483646;
export const pick = <T>(a: readonly T[]) => a[Math.floor(rnd() * a.length)];

const COMPANIES = [
  { name: 'Northwind Retail', industry: 'E-commerce', country: 'United Kingdom', lifecycle: 'client', size: '51-200' },
  { name: 'Bluepeak Health', industry: 'Healthcare', country: 'United States', lifecycle: 'client', size: '201-1000' },
  { name: 'Crescent Foods', industry: 'Food & Beverage', country: 'Pakistan', lifecycle: 'client', size: '11-50' },
  { name: 'Harbor Logistics', industry: 'Logistics', country: 'UAE', lifecycle: 'client', size: '51-200' },
  { name: 'Lumen Academy', industry: 'Education', country: 'Canada', lifecycle: 'client', size: '11-50' },
  { name: 'Orbit Fintech', industry: 'Financial services', country: 'Singapore', lifecycle: 'client', size: '51-200' },
  { name: 'Granite Builders', industry: 'Construction', country: 'Australia', lifecycle: 'prospect', size: '11-50' },
  { name: 'Velvet Studio', industry: 'Fashion', country: 'Italy', lifecycle: 'prospect', size: '1-10' },
  { name: 'Summit Travel', industry: 'Travel', country: 'Germany', lifecycle: 'prospect', size: '51-200' },
  { name: 'Pixel Forge', industry: 'Agency', country: 'Pakistan', lifecycle: 'partner', size: '11-50' },
] as const;

const FIRST = ['Emma', 'Liam', 'Olivia', 'Noah', 'Ava', 'Lucas', 'Mia', 'Ethan', 'Sofia', 'Daniel', 'Layla', 'Adam'];
const LAST = ['Carter', 'Nguyen', 'Rossi', 'Schmidt', 'Patel', 'Silva', 'Walker', 'Kim', 'Haddad', 'Novak'];

DEMO_SEEDERS.push({
  name: 'crm-projects',
  async run(c: SeedCtx) {
    const { tx, users: u, employees: emp, stages } = c;

    // Salary history so time entries carry real cost (fictional figures).
    const salaries: Record<string, number> = {
      ayesha: 4500, bilal: 3800, sara: 1700, usman: 1800, hina: 2000, omar: 1500, ali: 1900, zainab: 1400, fahad: 800,
      maryam: 1200, hamza: 1300, nida: 850, kamran: 1300, rabia: 1500, imran: 950, danish: 1050, sana: 800,
    };
    for (const [h, sal] of Object.entries(salaries)) {
      await tx.insert(s.employeeCompensation).values({
        employeeId: emp[h], effectiveFrom: daysFromNow(-400), baseSalary: String(sal), hourlyCost: ((sal * 1.25) / (22 * 8)).toFixed(2), reason: 'hire', approvedById: u.sara,
      });
    }

    const companies: Record<string, string> = {};
    let ci = 0;
    for (const co of COMPANIES) {
      ci++;
      const isClient = co.lifecycle === 'client';
      const [row] = await tx.insert(s.companies).values({
        name: co.name, industry: co.industry, country: co.country, lifecycle: co.lifecycle, size: co.size,
        website: `https://www.${co.name.toLowerCase().replace(/\s+/g, '')}.example`, ownerId: u.usman,
        clientCode: isClient ? await nextNumber(tx, 'client', 'CL-', 4) : null, clientSince: isClient ? daysFromNow(-60 * ci) : null,
        accountManagerId: isClient ? pick([u.hina, u.omar, u.usman]) : null, paymentTermsDays: isClient ? 15 : null,
        billingEmail: isClient ? `accounts@${co.name.toLowerCase().replace(/\s+/g, '')}.example` : null,
      }).returning();
      companies[co.name] = row.id;
      for (let k = 0; k < 2; k++) {
        const fn = pick(FIRST), ln = pick(LAST);
        await tx.insert(s.contacts).values({
          companyId: row.id, firstName: fn, lastName: ln, email: `${fn.toLowerCase()}.${ln.toLowerCase()}@${co.name.toLowerCase().replace(/\s+/g, '')}.example`,
          jobTitle: k === 0 ? pick(['CEO', 'Founder', 'Marketing Director', 'CTO']) : pick(['Product Manager', 'Operations Lead', 'Marketing Manager']),
          isPrimary: k === 0, ownerId: u.usman, phone: `+1 555 01${String(ci).padStart(2, '0')}${k}`,
        });
      }
    }

    // Leads
    const leadSeed = [
      ['Shopify to WooCommerce migration', 'Velvet Studio', 'new', 'referral', 8000],
      ['Corporate website refresh', 'Granite Builders', 'contacted', 'website', 15000],
      ['Booking engine for tours', 'Summit Travel', 'qualified', 'linkedin', 42000],
      ['SEO retainer', 'Bright Dental Clinic', 'new', 'seo', 1500],
      ['Mobile app MVP', 'Kite Fitness', 'contacted', 'upwork', 30000],
      ['Landing pages for campaign', 'Nova Cosmetics', 'unqualified', 'ads', 2000],
      ['Elementor site rebuild', 'Riverbank Hotel', 'new', 'website', 6000],
      ['Partner white-label work', 'Pixel Forge', 'qualified', 'partner', 12000],
    ] as const;
    for (const [title, coName, status, source, value] of leadSeed) {
      await tx.insert(s.leads).values({
        number: await nextNumber(tx, 'lead', 'LD-', 4), title, companyName: coName, companyId: companies[coName] ?? null,
        contactName: `${pick(FIRST)} ${pick(LAST)}`, email: `hello@${coName.toLowerCase().replace(/\s+/g, '')}.example`,
        status, source, estimatedValue: String(value), ownerId: pick([u.usman, u.usman, u.kamran]),
        nextFollowUpDate: status === 'unqualified' ? null : daysFromNow(Math.floor(rnd() * 10) - 2),
        disqualifyReason: status === 'unqualified' ? 'Budget below minimum engagement' : null,
        projectType: pick(['website', 'wordpress', 'woocommerce', 'mobile_app', 'seo'] as const),
      });
    }

    // Open opportunities
    const openOpps = [
      ['Tour booking platform', 'Summit Travel', 'requirement', 42000, 20],
      ['Construction portfolio site', 'Granite Builders', 'proposal', 15000, 12],
      ['Fashion e-store redesign', 'Velvet Studio', 'discovery', 9000, 30],
      ['Patient portal phase 2', 'Bluepeak Health', 'negotiation', 56000, 8],
      ['Loyalty app', 'Northwind Retail', 'proposal', 38000, 25],
    ] as const;
    for (const [name, coName, stage, value, close] of openOpps) {
      const [o] = await tx.insert(s.opportunities).values({
        number: await nextNumber(tx, 'opportunity', 'OP-', 4), name, companyId: companies[coName], stageId: stages.sales[stage],
        value: String(value), probability: { discovery: 10, requirement: 25, proposal: 50, negotiation: 75 }[stage], expectedCloseDate: daysFromNow(close), ownerId: u.usman,
        projectType: 'web_app',
      }).returning();
      await tx.insert(s.requirements).values([
        { opportunityId: o.id, title: 'Responsive UI across devices', priority: 'must' },
        { opportunityId: o.id, title: 'Admin dashboard', priority: 'should', estimateHours: '40' },
      ]);
      if (stage === 'proposal' || stage === 'negotiation') {
        const [q] = await tx.insert(s.quotes).values({
          number: await nextNumber(tx, 'quote', 'QT-', 4), title: `${name} — estimate`, companyId: companies[coName], opportunityId: o.id,
          status: 'sent', issueDate: daysFromNow(-5), validUntil: daysFromNow(25), taxRate: '0', ownerId: u.usman, sentAt: new Date(),
        }).returning();
        await tx.insert(s.quoteItems).values([
          { quoteId: q.id, description: 'Discovery & UX design', quantity: '1', unitPrice: String(Math.round(value * 0.2)), sortOrder: 1 },
          { quoteId: q.id, description: 'Development', quantity: '1', unitPrice: String(Math.round(value * 0.65)), sortOrder: 2 },
          { quoteId: q.id, description: 'QA & launch', quantity: '1', unitPrice: String(Math.round(value * 0.15)), sortOrder: 3 },
        ]);
        await recalcQuote(tx, q.id);
      }
      await tx.insert(s.followUps).values({ title: `Follow up on ${name}`, dueDate: daysFromNow(Math.floor(rnd() * 6) - 1), ownerId: u.usman, opportunityId: o.id, companyId: companies[coName] });
    }
    const [lost] = await tx.insert(s.opportunities).values({
      number: await nextNumber(tx, 'opportunity', 'OP-', 4), name: 'Crescent mobile ordering app', companyId: companies['Crescent Foods'],
      stageId: stages.sales.lost, value: '25000', probability: 0, lostAt: new Date(Date.now() - 12 * 86400_000), lostReason: 'Chose a cheaper vendor', ownerId: u.usman,
    }).returning();
    void lost;

    // Projects (from won deals)
    const projectSeed = [
      { name: 'Northwind WooCommerce store', co: 'Northwind Retail', type: 'woocommerce', stage: 'development', status: 'on_track', pm: 'hina', lead: 'ali', team: ['zainab', 'fahad', 'maryam', 'hamza'], value: 28000, hours: 420, start: -50, due: 30 },
      { name: 'Bluepeak patient portal', co: 'Bluepeak Health', type: 'web_app', stage: 'qa', status: 'in_qa', pm: 'hina', lead: 'ali', team: ['zainab', 'hamza', 'nida'], value: 64000, hours: 900, start: -120, due: 10 },
      { name: 'Crescent Foods website', co: 'Crescent Foods', type: 'wordpress', stage: 'client_feedback', status: 'awaiting_client', pm: 'omar', lead: 'fahad', team: ['maryam', 'nida'], value: 9000, hours: 140, start: -45, due: -3 },
      { name: 'Harbor tracking dashboard', co: 'Harbor Logistics', type: 'web_app', stage: 'development', status: 'at_risk', pm: 'omar', lead: 'ali', team: ['zainab', 'fahad'], value: 36000, hours: 500, start: -70, due: 14 },
      { name: 'Lumen Academy LMS', co: 'Lumen Academy', type: 'web_app', stage: 'design', status: 'awaiting_design', pm: 'hina', lead: 'zainab', team: ['maryam'], value: 22000, hours: 320, start: -15, due: 75 },
      { name: 'Orbit Fintech marketing site', co: 'Orbit Fintech', type: 'website', stage: 'launch', status: 'ready_for_launch', pm: 'omar', lead: 'fahad', team: ['maryam', 'hamza'], value: 14000, hours: 200, start: -80, due: 4 },
      { name: 'Devtics website & SEO', co: null, type: 'seo', stage: 'maintenance', status: 'on_track', pm: 'hina', lead: 'kamran', team: ['fahad'], value: 0, hours: 120, start: -200, due: null },
    ] as const;

    const TASKS = ['Set up staging environment', 'Implement header & navigation', 'Product listing page', 'Checkout flow', 'Payment gateway integration',
      'Contact form & validation', 'Performance optimisation', 'Accessibility review', 'Content migration', 'Analytics & tracking', 'Admin reports', 'Email templates'];

    for (const p of projectSeed) {
      const [opp] = p.co ? await tx.insert(s.opportunities).values({
        number: await nextNumber(tx, 'opportunity', 'OP-', 4), name: p.name, companyId: companies[p.co], stageId: stages.sales.won,
        value: String(p.value), probability: 100, wonAt: new Date(Date.now() + (p.start - 5) * 86400_000), ownerId: u.usman, projectType: p.type,
      }).returning() : [null];
      const [proj] = await tx.insert(s.projects).values({
        code: await nextNumber(tx, 'project', 'PRJ-', 4), name: p.name, clientId: p.co ? companies[p.co] : null, opportunityId: opp?.id,
        type: p.type, stageId: stages.project[p.stage], status: p.status, pmId: u[p.pm], techLeadId: u[p.lead],
        startDate: daysFromNow(p.start), dueDate: p.due === null ? null : daysFromNow(p.due), billingType: p.co ? 'fixed' : 'internal',
        budgetAmount: p.co ? String(p.value) : null, budgetHours: String(p.hours), isInternal: !p.co, createdBy: u.usman,
        priority: p.status === 'at_risk' ? 'high' : 'medium',
      }).returning();
      if (opp) {
        await tx.update(s.opportunities).set({ projectId: proj.id }).where(eq(s.opportunities.id, opp.id));
        await tx.insert(s.projectOnboardings).values({ opportunityId: opp.id, projectId: proj.id, companyId: companies[p.co!], status: 'completed', bdOwnerId: u.usman, handoverNotes: 'Scope agreed as per SOW.', completedAt: new Date() });
        await tx.insert(s.contracts).values({
          number: await nextNumber(tx, 'contract', 'CT-', 4), title: `${p.name} — SOW`, type: 'sow', companyId: companies[p.co!], opportunityId: opp.id,
          projectId: proj.id, status: 'active', value: String(p.value), startDate: daysFromNow(p.start), endDate: p.due === null ? null : daysFromNow(p.due + 30),
          signedAt: daysFromNow(p.start - 3), ownerId: u.usman,
        });
      }
      const members = [[p.pm, 'pm'], [p.lead, 'tech_lead'], ...p.team.map((m) => [m, m === 'hamza' || m === 'nida' ? 'qa' : m === 'maryam' ? 'designer' : 'developer'])] as [string, string][];
      for (const [h, role] of members) await tx.insert(s.projectMembers).values({ projectId: proj.id, userId: u[h], role, allocationPct: role === 'pm' ? 30 : 60 }).onConflictDoNothing();

      const ms = ['Design sign-off', 'Feature complete', 'Launch'];
      for (let i = 0; i < ms.length; i++) {
        const due = p.due === null ? null : daysFromNow(p.start + Math.round(((p.due - p.start) * (i + 1)) / 3));
        const passed = due !== null && due < daysFromNow(0);
        await tx.insert(s.milestones).values({
          projectId: proj.id, name: ms[i], dueDate: due, sortOrder: i, status: passed ? 'completed' : i === 0 || passed ? 'in_progress' : 'planned',
          completedAt: passed ? due : null, billingAmount: p.co ? String(Math.round(p.value / 3)) : null,
        });
      }

      const workers = [p.lead, ...p.team.filter((m) => !['hamza', 'nida', 'maryam'].includes(m))];
      const n = 8 + Math.floor(rnd() * 4);
      for (let i = 0; i < n; i++) {
        const progress = i / n;
        const status = progress < 0.45 ? 'done' : progress < 0.6 ? 'qa' : progress < 0.8 ? 'in_progress' : pick(['todo', 'todo', 'blocked'] as const);
        const assignee = u[pick(workers)];
        const due = status === 'done' ? daysFromNow(p.start + i * 4 + 2) : daysFromNow(i === n - 1 && rnd() < 0.5 ? -2 : 1 + i);
        const est = String(4 + Math.floor(rnd() * 20));
        const [task] = await tx.insert(s.tasks).values({
          number: await nextNumber(tx, 'task', 'T-', 5), projectId: proj.id, title: TASKS[i % TASKS.length], status, priority: pick(['low', 'medium', 'medium', 'high'] as const),
          assigneeId: assignee, reporterId: u[p.pm], dueDate: due, estimateHours: est, type: 'feature',
          completedAt: status === 'done' ? new Date(Date.now() + (p.start + i * 4) * 86400_000) : null,
          isRework: status === 'done' && rnd() < 0.2, qaRejections: status === 'done' && rnd() < 0.2 ? 1 : 0,
        }).returning();
        if (status === 'done' || status === 'qa' || status === 'in_progress') {
          const entries = 1 + Math.floor(rnd() * 3);
          for (let e = 0; e < entries; e++) {
            const workDate = daysFromNow(-Math.floor(rnd() * 20));
            const minutes = 60 * (1 + Math.floor(rnd() * 5));
            await tx.insert(s.timeEntries).values({
              userId: assignee, projectId: proj.id, taskId: task.id, workDate, minutes, description: `Work on ${task.title.toLowerCase()}`,
              billable: !!p.co, costAmount: await labourCost(tx, assignee, workDate, minutes),
            });
          }
        }
      }
      // PM time
      for (let d = 0; d < 6; d++) {
        const workDate = daysFromNow(-d * 2);
        await tx.insert(s.timeEntries).values({ userId: u[p.pm], projectId: proj.id, workDate, minutes: 60, description: 'Coordination & client calls', billable: !!p.co, costAmount: await labourCost(tx, u[p.pm], workDate, 60) });
      }

      if (p.status === 'at_risk') {
        await tx.insert(s.risks).values({ projectId: proj.id, kind: 'risk', title: 'Third-party tracking API rate limits', probability: 'high', impact: 'high', status: 'mitigating', ownerId: u[p.lead], mitigation: 'Add caching layer and negotiate higher quota.' });
        await tx.insert(s.projectUpdates).values({ projectId: proj.id, kind: 'escalation', title: 'API vendor blocking integration', body: 'Vendor support unresponsive for 5 days; launch at risk.', authorId: u[p.pm], escalateToRole: 'cto', health: 'at_risk' });
      }
      if (p.status === 'awaiting_client' && p.co) {
        await tx.insert(s.clientFeedback).values({ projectId: proj.id, companyId: companies[p.co], kind: 'review_request', title: 'Review staging site', status: 'overdue', requestedAt: daysFromNow(-10), dueDate: daysFromNow(-3) });
      }
      if (p.co) {
        await tx.insert(s.clientFeedback).values({ projectId: proj.id, companyId: companies[p.co], kind: 'feedback', title: 'Sprint review feedback', status: 'received', requestedAt: daysFromNow(-20), receivedAt: daysFromNow(-18), rating: p.status === 'at_risk' ? 2 : 4 + Math.round(rnd()) });
        await tx.insert(s.communications).values({ kind: 'meeting', direction: 'outbound', subject: 'Weekly status call', companyId: companies[p.co], projectId: proj.id, loggedById: u[p.pm], occurredAt: new Date(Date.now() - 3 * 86400_000), body: 'Reviewed progress and next milestones.' });
      }
      await tx.insert(s.projectUpdates).values({ projectId: proj.id, kind: 'weekly', title: 'Weekly report', body: 'Progress on track against current milestone.', authorId: u[p.pm], health: p.status === 'at_risk' ? 'at_risk' : 'on_track' });
      if (p.name.startsWith('Northwind')) {
        await tx.insert(s.changeRequests).values({ number: await nextNumber(tx, 'change_request', 'CR-', 4), projectId: proj.id, title: 'Add gift cards', status: 'approved', impactHours: '24', impactCost: '1800', decidedAt: new Date(), createdBy: u[p.pm] });
      }
    }

    await tx.insert(s.salesTargets).values([
      { userId: null, periodStart: daysFromNow(0).slice(0, 8) + '01', periodEnd: daysFromNow(0).slice(0, 8) + '28', targetAmount: '80000' },
      { userId: u.usman, periodStart: daysFromNow(0).slice(0, 8) + '01', periodEnd: daysFromNow(0).slice(0, 8) + '28', targetAmount: '60000' },
    ]);
  },
});
