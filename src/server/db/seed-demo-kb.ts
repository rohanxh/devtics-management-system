import { eq } from 'drizzle-orm';
import * as s from './schema/index.ts';
import { DEMO_SEEDERS, PEOPLE, daysFromNow, type SeedCtx } from './seed-demo.ts';

const DOCS: { title: string; category: (typeof s.kbCategory.enumValues)[number]; owner: string; required?: boolean; summary: string; body: string }[] = [
  {
    title: 'Information security policy', category: 'policy', owner: 'bilal', required: true, summary: 'How we protect client and company data.',
    body: `# Information security policy

## Credentials
- Never share passwords in chat, email, tickets or DMS notes. Use the company password manager and share **references** (e.g. \`op://Devtics/Client X/WP admin\`).
- Enable two-factor authentication on GitHub, Google Workspace, hosting panels and client admin accounts.

## Devices
- Lock your screen when you step away. Full-disk encryption must stay on.
- Report lost or stolen devices to IT within one hour.

## Client data
- Use staging data, not production data, for development unless the PM approves otherwise.
- Delete client exports from your device when the task is done.

## Incidents
Report suspected incidents to the CTO immediately. Do not try to investigate on your own.`,
  },
  {
    title: 'Code review standard', category: 'dev_standard', owner: 'bilal', required: true, summary: 'What every pull request needs before merge.',
    body: `# Code review standard

Every change reaches \`main\` through a pull request.

1. Keep PRs small (under ~400 changed lines where possible).
2. Link the task or bug in the PR description.
3. At least **one approval** from someone other than the author.
4. CI must pass; no skipped tests without a linked follow-up task.
5. Reviewers check: correctness, security (input validation, auth checks), readability, and tests.

> Reviews are about the code, not the person. Ask questions, suggest — don't command.`,
  },
  {
    title: 'QA standard: pre-launch checklist', category: 'qa_standard', owner: 'hamza', summary: 'Minimum QA before any production launch.',
    body: `# Pre-launch QA standard

- Run the **Pre-launch QA** template plus the platform template (WordPress / WooCommerce / Mobile).
- All critical and high bugs must be verified or closed before sign-off.
- Test on Chrome, Safari, Firefox and Edge, and on at least one iOS and one Android device.
- Record results in a DMS QA run — sign-off happens there, not in chat.`,
  },
  {
    title: 'Project onboarding procedure', category: 'pm_procedure', owner: 'hina', summary: 'From won deal to development kickoff.',
    body: `# Project onboarding

When a deal is won, DMS creates the project and starts onboarding automatically.

1. **BD handover** — the deal owner writes the handover: scope, commitments, contacts, deadlines, risks.
2. **PM review** — the PM assigns the team, sets the due date and hour budget.
3. **CTO feasibility** — the CTO approves the technical approach (or sends it back with notes).
4. **Kickoff** — internal and client kickoff meetings; repository and environments set up; milestones defined.

Keep all client communication logged on the project.`,
  },
  {
    title: 'Lead qualification procedure', category: 'sales_procedure', owner: 'usman', summary: 'How BD qualifies and converts leads.',
    body: `# Lead qualification

- Respond to new leads within **one business day**.
- Qualify on budget, authority, need and timeline before converting to an opportunity.
- Disqualify with a reason — it improves our marketing attribution.
- Every opportunity must have a value, an expected close date and a next follow-up.`,
  },
  {
    title: 'Leave policy', category: 'hr_policy', owner: 'rabia', required: true, summary: 'Leave types, approvals and notice periods.',
    body: `# Leave policy


- **Annual leave:** 18 days. Request at least 2 weeks ahead for 3+ days.
- **Sick leave:** 10 days. Inform your manager before your start time.
- **Casual leave:** 8 days.
- Requests are approved by your manager in DMS; HR approves when you have no manager.
- Unused annual leave carries forward up to 5 days.`,
  },
  {
    title: 'Client status report template', category: 'template', owner: 'hina', summary: 'Weekly client update structure.',
    body: `# Weekly status report — template

**Project:** …  **Week of:** …

## Done this week
- …

## Next week
- …

## Risks / blockers
- …

## Decisions needed from you
- …`,
  },
];

DEMO_SEEDERS.push({
  name: 'kb',
  async run({ tx, users: u }: SeedCtx) {
    for (const d of DOCS) {
      const slug = d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const [a] = await tx.insert(s.kbArticles).values({ slug, title: d.title, category: d.category, ownerId: u[d.owner], summary: d.summary, requiredReading: !!d.required, status: 'published', publishedAt: new Date(Date.now() - 20 * 86400_000), lastReviewedOn: daysFromNow(-20), reviewIntervalDays: 180 }).returning();
      const [v] = await tx.insert(s.kbArticleVersions).values({ articleId: a.id, versionNumber: 1, title: d.title, body: d.body, changeSummary: 'Initial version', createdById: u[d.owner], publishedAt: new Date(Date.now() - 20 * 86400_000), publishedById: u.imran }).returning();
      await tx.update(s.kbArticles).set({ currentVersionId: v.id }).where(eq(s.kbArticles.id, a.id));
      if (d.required) {
        let i = 0;
        for (const p of PEOPLE) {
          await tx.insert(s.kbReadingAssignments).values({ articleId: a.id, versionId: v.id, userId: u[p.h], dueDate: daysFromNow(-13 + (i % 3) * 10) });
          if (i++ % 3 !== 0) await tx.insert(s.kbAcknowledgements).values({ articleId: a.id, versionId: v.id, userId: u[p.h], acknowledgedAt: new Date(Date.now() - 15 * 86400_000) });
        }
      }
    }
  },
});
