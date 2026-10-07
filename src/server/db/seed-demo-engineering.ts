import { eq } from 'drizzle-orm';
import * as s from './schema/index.ts';
import { DEMO_SEEDERS, type SeedCtx } from './seed-demo.ts';
import { nextNumber } from '../core/counters.ts';
import { refreshRunCounts } from '../modules/qa.ts';
import { pick, rnd } from './seed-demo-crm.ts';

DEMO_SEEDERS.push({
  name: 'engineering-qa',
  async run({ tx, users: u }: SeedCtx) {
    const techs = [
      ['WordPress', 'cms'], ['WooCommerce', 'cms'], ['Elementor', 'cms'], ['React', 'framework'], ['Next.js', 'framework'],
      ['Node.js', 'language'], ['TypeScript', 'language'], ['PHP', 'language'], ['PostgreSQL', 'database'], ['MySQL', 'database'],
      ['Flutter', 'framework'], ['AWS', 'hosting'], ['Cloudflare', 'service'], ['Stripe', 'service'],
    ] as const;
    const tech: Record<string, string> = {};
    for (const [name, category] of techs) tech[name] = (await tx.insert(s.technologies).values({ name, category }).returning())[0].id;

    const all = await tx.select().from(s.projects);
    const stackFor: Record<string, string[]> = {
      woocommerce: ['WordPress', 'WooCommerce', 'PHP', 'MySQL', 'Stripe'], wordpress: ['WordPress', 'Elementor', 'PHP', 'MySQL'],
      web_app: ['React', 'Node.js', 'TypeScript', 'PostgreSQL', 'AWS'], website: ['Next.js', 'TypeScript', 'Cloudflare'], seo: ['WordPress'],
    };
    const templates = await tx.select().from(s.qaTemplates);
    for (const p of all) {
      for (const t of stackFor[p.type] ?? []) await tx.insert(s.projectTechnologies).values({ projectId: p.id, technologyId: tech[t] });
      const slug = p.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30);
      const [repo] = await tx.insert(s.repositories).values({ projectId: p.id, name: slug, url: `https://github.example/devtics/${slug}`, defaultBranch: 'main', branchingStrategy: 'Trunk-based with short-lived feature branches; PR review required.' }).returning();
      const [stg] = await tx.insert(s.environments).values({ projectId: p.id, name: 'Staging', kind: 'staging', url: `https://staging.${slug}.example`, branch: 'main', status: 'healthy' }).returning();
      const [prd] = await tx.insert(s.environments).values({ projectId: p.id, name: 'Production', kind: 'production', url: `https://${slug}.example`, status: p.status === 'at_risk' ? 'degraded' : 'healthy' }).returning();
      const devs = (await tx.select().from(s.projectMembers).where(eq(s.projectMembers.projectId, p.id))).filter((m) => ['developer', 'tech_lead'].includes(m.role)).map((m) => m.userId);
      if (!devs.length) continue;
      for (let i = 0; i < 3; i++) {
        const author = pick(devs);
        const reviewer = devs.find((d) => d !== author) ?? p.techLeadId ?? u.bilal;
        await tx.insert(s.pullRequests).values({
          repositoryId: repo.id, number: 10 + i, title: pick(['Add product filters', 'Fix checkout validation', 'Refactor API client', 'Improve image loading', 'Add audit logging']),
          branch: `feature/${i}-${slug.slice(0, 10)}`, targetBranch: 'main', authorId: author, reviewerId: reviewer,
          status: (['merged', 'open', 'changes_requested'] as const)[i], mergedAt: i === 0 ? new Date() : null,
        });
      }
      for (let i = 0; i < 3; i++) {
        await tx.insert(s.deployments).values({
          number: await nextNumber(tx, 'deployment', 'DEP-', 5), projectId: p.id, environmentId: i < 2 ? stg.id : prd.id, version: `0.${i + 1}.0`,
          status: i < 2 ? 'succeeded' : p.launchedAt || p.status === 'ready_for_launch' ? 'succeeded' : 'pending_approval',
          requestedById: pick(devs), deployedById: pick(devs), deployedAt: new Date(Date.now() - (10 - i * 3) * 86400_000),
        });
      }
      const bugTitles = ['Cart total not updating on quantity change', 'Mobile menu overlaps logo', 'Form accepts invalid email', 'Slow product page on 3G', 'Broken link in footer', 'Session expires during checkout'];
      for (let i = 0; i < 4; i++) {
        const st = pick(['new', 'confirmed', 'in_progress', 'fixed', 'ready_for_retest', 'verified', 'closed'] as const);
        await tx.insert(s.bugs).values({
          number: await nextNumber(tx, 'bug', 'BUG-', 5), projectId: p.id, title: bugTitles[(i + all.indexOf(p)) % bugTitles.length],
          severity: pick(['low', 'medium', 'medium', 'high', p.status === 'at_risk' ? 'critical' : 'medium'] as const), status: st,
          environment: 'staging', foundIn: 'qa', reportedById: pick([u.hamza, u.nida]), assigneeId: pick(devs), introducedById: rnd() < 0.6 ? pick(devs) : null,
          stepsToReproduce: '1. Open the page\n2. Perform the action\n3. Observe the result', expectedResult: 'Works as specified', actualResult: 'Does not work as specified',
        });
      }
      if (p.status === 'in_qa' || p.status === 'ready_for_launch') {
        const tplItems = await tx.select().from(s.qaTemplateItems).where(eq(s.qaTemplateItems.templateId, templates.find((t) => t.name === 'Pre-launch QA')!.id));
        const [run] = await tx.insert(s.qaRuns).values({
          number: await nextNumber(tx, 'qa_run', 'QA-', 4), projectId: p.id, name: 'Pre-launch cycle', environmentId: stg.id, assigneeId: u.hamza,
          status: p.status === 'ready_for_launch' ? 'approved' : 'in_progress', startedAt: new Date(),
        }).returning();
        let i = 0;
        for (const it of tplItems) {
          const [tc] = await tx.insert(s.testCases).values({ projectId: p.id, templateItemId: it.id, title: it.title, area: it.area, expectedResult: it.expectedResult, priority: it.priority }).returning();
          const status = p.status === 'ready_for_launch' ? 'pass' : i < 4 ? 'pass' : i === 4 ? 'fail' : 'pending';
          await tx.insert(s.qaRunResults).values({ runId: run.id, testCaseId: tc.id, status, testedById: status === 'pending' ? null : u.hamza, sortOrder: i++ });
        }
        await refreshRunCounts(tx, run.id);
      }
    }
    await tx.insert(s.techDebt).values([
      { projectId: all[0].id, title: 'Upgrade legacy jQuery plugins', impact: 'medium', effort: 'medium', ownerId: u.ali },
      { projectId: all[1].id, title: 'Add integration tests for billing API', impact: 'high', effort: 'large', ownerId: u.zainab, status: 'planned' },
      { title: 'Standardise CI pipeline across repositories', impact: 'medium', effort: 'medium', ownerId: u.bilal },
    ]);
    await tx.insert(s.techReviews).values({ number: await nextNumber(tx, 'tech_review', 'TR-', 4), projectId: all[3].id, kind: 'integration', title: 'Carrier tracking API integration', summary: 'Proposal to integrate the carrier REST API via a queue-backed worker.', status: 'draft', requestedById: u.ali });
  },
});
