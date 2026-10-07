import { eq } from 'drizzle-orm';
import * as s from './schema/index.ts';
import { DEMO_SEEDERS, PEOPLE, daysFromNow, type SeedCtx } from './seed-demo.ts';
import { pick, rnd } from './seed-demo-crm.ts';
import { workingDays } from '../modules/hr.ts';

const at = (date: string, hh: number, mm: number) => new Date(`${date}T${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}:00`);

DEMO_SEEDERS.push({
  name: 'hr-strategy',
  async run({ tx, users: u, employees: emp, depts, stages }: SeedCtx) {
    const types = Object.fromEntries((await tx.select().from(s.leaveTypes)).map((t) => [t.code, t]));
    const year = new Date().getFullYear();

    // Attendance for the last 20 days (deterministic), skipping weekends/holidays.
    for (const p of PEOPLE) {
      const e = emp[p.h];
      const days = await workingDays(tx, e, daysFromNow(-28), daysFromNow(-1));
      for (const d of days) {
        const r = rnd();
        if (r < 0.04) { await tx.insert(s.attendanceRecords).values({ employeeId: e, date: d, status: 'absent', source: 'system' }); continue; }
        const lateBy = r < 0.15 ? 20 + Math.floor(rnd() * 40) : Math.floor(rnd() * 10);
        const inT = at(d, 9, lateBy), outT = at(d, 18, Math.floor(rnd() * 50));
        const worked = Math.round((outT.getTime() - inT.getTime()) / 60000);
        await tx.insert(s.attendanceRecords).values({
          employeeId: e, date: d, clockIn: inT, clockOut: outT, minutesWorked: worked, lateMinutes: Math.max(0, lateBy - 15),
          overtimeMinutes: Math.max(0, worked - 540), status: lateBy > 15 ? 'late' : r > 0.9 ? 'remote' : 'present', source: 'web',
        });
      }
      for (const code of ['AL', 'SL', 'CL']) await tx.insert(s.leaveBalances).values({ employeeId: e, leaveTypeId: types[code].id, year, allocatedDays: types[code].annualAllowanceDays });
    }
    // Leave: one approved upcoming, one pending, one past.
    const leave = async (h: string, code: string, from: number, to: number, status: 'approved' | 'pending', reason: string) => {
      const days = await workingDays(tx, emp[h], daysFromNow(from), daysFromNow(to));
      if (!days.length) return;
      const [req] = await tx.insert(s.leaveRequests).values({ employeeId: emp[h], leaveTypeId: types[code].id, startDate: daysFromNow(from), endDate: daysFromNow(to), days: String(days.length), reason, status, decidedById: status === 'approved' ? u.rabia : null, decidedAt: status === 'approved' ? new Date() : null }).returning();
      if (status === 'approved') {
        await tx.update(s.leaveBalances).set({ usedDays: String(days.length) }).where(eq(s.leaveBalances.employeeId, emp[h]));
        for (const d of days) await tx.insert(s.attendanceRecords).values({ employeeId: emp[h], date: d, status: 'on_leave', source: 'system' }).onConflictDoUpdate({ target: [s.attendanceRecords.employeeId, s.attendanceRecords.date], set: { status: 'on_leave' } });
      } else {
        const [mgrUser] = await tx.select({ userId: s.employees.userId }).from(s.employees).where(eq(s.employees.id, (await tx.select().from(s.employees).where(eq(s.employees.id, emp[h])))[0].managerId!));
        const [a] = await tx.insert(s.approvals).values({ kind: 'leave', entityType: 'leave_requests', entityId: req.id, title: `Leave: ${h} ${req.startDate} → ${req.endDate} (${days.length} day(s))`, requestedBy: u[h], approverUserId: mgrUser.userId }).returning();
        await tx.update(s.leaveRequests).set({ approvalId: a.id }).where(eq(s.leaveRequests.id, req.id));
      }
    };
    await leave('zainab', 'AL', 0, 2, 'approved', 'Family wedding');
    await leave('fahad', 'CL', 5, 5, 'pending', 'Personal errand');
    await leave('maryam', 'AL', 12, 16, 'pending', 'Vacation');

    // Emergency contacts, skills, certifications, career history
    for (const p of PEOPLE) await tx.insert(s.emergencyContacts).values({ employeeId: emp[p.h], name: `Relative of ${p.first}`, relationship: pick(['Spouse', 'Parent', 'Sibling']), phone: '+92 300 0000000' });
    const skillNames = ['React', 'Node.js', 'WordPress', 'PHP', 'Figma', 'Manual testing', 'Test automation', 'SEO', 'Project management', 'Negotiation'];
    const skill: Record<string, string> = {};
    for (const n of skillNames) skill[n] = (await tx.insert(s.skills).values({ name: n, category: ['Figma'].includes(n) ? 'Design' : ['SEO'].includes(n) ? 'Marketing' : 'Engineering' }).returning())[0].id;
    const sk: [string, string, 'intermediate' | 'advanced' | 'expert'][] = [
      ['ali', 'React', 'expert'], ['ali', 'Node.js', 'advanced'], ['zainab', 'React', 'advanced'], ['fahad', 'WordPress', 'advanced'], ['fahad', 'PHP', 'intermediate'],
      ['maryam', 'Figma', 'expert'], ['hamza', 'Manual testing', 'expert'], ['hamza', 'Test automation', 'advanced'], ['nida', 'Manual testing', 'intermediate'],
      ['kamran', 'SEO', 'expert'], ['hina', 'Project management', 'expert'], ['usman', 'Negotiation', 'advanced'],
    ];
    for (const [h, n, level] of sk) await tx.insert(s.employeeSkills).values({ employeeId: emp[h], skillId: skill[n], level });
    await tx.insert(s.certifications).values([
      { employeeId: emp.hina, name: 'PMP', issuer: 'PMI', issuedOn: daysFromNow(-700), expiresOn: daysFromNow(25) },
      { employeeId: emp.danish, name: 'AWS Solutions Architect – Associate', issuer: 'AWS', issuedOn: daysFromNow(-300), expiresOn: daysFromNow(800) },
      { employeeId: emp.hamza, name: 'ISTQB Foundation', issuer: 'ISTQB', issuedOn: daysFromNow(-900) },
    ]);
    for (const p of PEOPLE) {
      const [e] = await tx.select().from(s.employees).where(eq(s.employees.id, emp[p.h]));
      await tx.insert(s.employeeJobHistory).values({ employeeId: e.id, effectiveDate: e.joinDate, changeType: 'hire', departmentId: e.departmentId, designationId: e.designationId });
    }
    await tx.insert(s.employeeJobHistory).values({ employeeId: emp.ali, effectiveDate: daysFromNow(-120), changeType: 'promotion', departmentId: depts.ENG, notes: 'Promoted to Senior Software Engineer' });

    // Reviews & training
    const reviewees = [['ali', 'bilal', 'manager_review'], ['zainab', 'bilal', 'self_review'], ['fahad', 'bilal', 'scheduled'], ['nida', 'hamza', 'completed']] as const;
    for (const [h, r, status] of reviewees) {
      await tx.insert(s.performanceReviews).values({
        employeeId: emp[h], reviewerId: u[r], period: `${year} H2`, dueDate: daysFromNow(status === 'completed' ? -10 : 5 + Math.floor(rnd() * 20)), status,
        selfAssessment: status !== 'scheduled' ? 'Delivered my assigned work on time and helped the team with reviews.' : null,
        overallRating: status === 'completed' ? 4 : null, completedAt: status === 'completed' ? new Date() : null,
      });
    }
    await tx.insert(s.trainings).values([
      { employeeId: emp.fahad, title: 'Advanced WooCommerce development', provider: 'Online course', status: 'in_progress', startDate: daysFromNow(-20), cost: '120' },
      { employeeId: emp.nida, title: 'Playwright test automation', provider: 'Internal', status: 'planned', startDate: daysFromNow(14) },
    ]);

    // Recruitment
    const [op1] = await tx.insert(s.jobOpenings).values({ title: 'Senior React Developer', departmentId: depts.ENG, hiringManagerId: u.bilal, openings: 2, status: 'open', postedOn: daysFromNow(-25), location: 'Lahore / hybrid', description: 'Build modern web apps for international clients.' }).returning();
    const [op2] = await tx.insert(s.jobOpenings).values({ title: 'SEO Specialist', departmentId: depts.MKT, hiringManagerId: u.kamran, openings: 1, status: 'open', postedOn: daysFromNow(-10), location: 'Remote' }).returning();
    const cands = [['Hassan', 'Ali', op1, 'technical_test'], ['Mehwish', 'Khan', op1, 'interview'], ['Saad', 'Butt', op1, 'screening'], ['Ayesha', 'Noor', op1, 'applied'],
      ['Bilal', 'Akhtar', op1, 'offer'], ['Rida', 'Zafar', op2, 'screening'], ['Taha', 'Mirza', op2, 'applied'], ['Hira', 'Saeed', op1, 'rejected']] as const;
    for (const [f, l, op, st] of cands) {
      const [c] = await tx.insert(s.candidates).values({ firstName: f, lastName: l, email: `${f.toLowerCase()}.${l.toLowerCase()}@mail.example`, source: pick(['LinkedIn', 'Referral', 'Job board', 'Website']) }).returning();
      const [app] = await tx.insert(s.applications).values({ jobOpeningId: op.id, candidateId: c.id, stageId: stages.recruitment[st], status: st === 'rejected' ? 'rejected' : 'active', appliedOn: daysFromNow(-Math.floor(rnd() * 20)), rating: 3 + Math.floor(rnd() * 3), rejectionReason: st === 'rejected' ? 'Insufficient React experience' : null, expectedSalary: String(900 + Math.floor(rnd() * 900)) }).returning();
      if (['interview', 'technical_test', 'offer'].includes(st)) {
        await tx.insert(s.interviews).values({ applicationId: app.id, kind: 'screening', scheduledAt: new Date(Date.now() - 6 * 86400_000), interviewerId: u.rabia, outcome: 'pass', score: 7, feedback: 'Good communication.' });
        await tx.insert(s.interviews).values({ applicationId: app.id, kind: st === 'interview' ? 'interview' : 'technical_test', scheduledAt: new Date(Date.now() + 2 * 86400_000), interviewerId: u.ali, outcome: 'pending' });
      }
    }

    // Strategy: goals, KPIs, initiatives, company risks
    const q = `${year}-Q${Math.floor(new Date().getMonth() / 3) + 1}`;
    const [g1] = await tx.insert(s.goals).values({ title: `Grow revenue to $1.2M in ${year}`, level: 'company', kind: 'revenue_target', period: String(year), ownerId: u.ayesha, unit: 'USD', targetValue: '1200000', metricKey: 'revenue_ytd', status: 'on_track' }).returning();
    await tx.insert(s.goals).values([
      { title: 'Win 4 new clients this quarter', level: 'company', kind: 'key_result', period: q, ownerId: u.usman, parentGoalId: g1.id, unit: 'clients', targetValue: '4', metricKey: 'new_clients_quarter', status: 'on_track' },
      { title: 'Launch a maintenance-plan offering (MRR $5k)', level: 'company', kind: 'growth_target', period: q, ownerId: u.ayesha, parentGoalId: g1.id, unit: 'USD', targetValue: '5000', metricKey: 'mrr', status: 'at_risk' },
      { title: 'On-time delivery above 85%', level: 'department', kind: 'objective', period: q, ownerId: u.hina, departmentId: depts.PMO, unit: '%', targetValue: '85', metricKey: 'on_time_delivery_pct', status: 'on_track' },
      { title: 'Keep open bugs under 15', level: 'department', kind: 'objective', period: q, ownerId: u.bilal, departmentId: depts.ENG, unit: 'bugs', targetValue: '15', metricKey: 'open_bugs', status: 'on_track' },
      { title: 'Complete Playwright course', level: 'individual', kind: 'objective', period: q, ownerId: u.nida, employeeId: emp.nida, status: 'not_started' },
    ]);
    await tx.insert(s.kpis).values([
      { name: 'Monthly revenue', departmentId: depts.FIN, ownerId: u.sara, unit: 'USD', target: '100000', metricKey: 'revenue_month' },
      { name: 'Profit margin', departmentId: depts.FIN, ownerId: u.sara, unit: '%', target: '25', metricKey: 'profit_margin_month' },
      { name: 'Team utilization', departmentId: depts.PMO, ownerId: u.hina, unit: '%', target: '75', metricKey: 'utilization_pct' },
      { name: 'Win rate (90d)', departmentId: depts.BD, ownerId: u.usman, unit: '%', target: '35', metricKey: 'win_rate_pct' },
      { name: 'Open bugs', departmentId: depts.QA, ownerId: u.hamza, unit: 'bugs', target: '15', direction: 'lower_is_better', metricKey: 'open_bugs' },
      { name: 'Headcount', departmentId: depts.HR, ownerId: u.rabia, unit: 'people', target: '20', metricKey: 'headcount' },
      { name: 'New leads', departmentId: depts.MKT, ownerId: u.kamran, unit: 'leads', target: '20', metricKey: 'new_leads_month' },
    ]);
    await tx.insert(s.initiatives).values([
      { title: 'Productised WordPress care plans', ownerId: u.ayesha, goalId: g1.id, status: 'active', startDate: daysFromNow(-30), endDate: daysFromNow(60), progressPct: 40, budget: '3000' },
      { title: 'Internal design system', ownerId: u.maryam, status: 'proposed', startDate: daysFromNow(15) },
    ]);
    await tx.insert(s.risks).values([
      { title: 'Revenue concentration: top client > 30% of revenue', kind: 'risk', probability: 'medium', impact: 'high', status: 'open', ownerId: u.ayesha, mitigation: 'Diversify pipeline across 3 new verticals.' },
      { title: 'Key-person dependency on senior React developers', kind: 'risk', probability: 'high', impact: 'medium', status: 'mitigating', ownerId: u.bilal, mitigation: 'Hire 2 senior developers; document architecture.' },
    ]);
  },
});
