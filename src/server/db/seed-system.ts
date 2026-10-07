import { count, eq, inArray } from 'drizzle-orm';
import type { DB } from './client.ts';
import { automationRules, leaveTypes, pipelineStages, rolePermissions, roles, settings, slaPolicies, slaTargets } from './schema/index.ts';
import { ROLE_SEEDS, expandGrants } from '../rbac/defaults.ts';
import { withActor } from '../core/context.ts';
import { seedQaTemplates } from './seed-qa-templates.ts';

/**
 * Bump when ROLE_SEEDS gains permissions. Grants are re-applied additively (never removed),
 * so admin customisations survive while new modules become reachable.
 */
export const ROLE_SEED_VERSION = 5;

export const STAGE_SEEDS: Record<string, { key: string; name: string; color: string; terminal?: boolean; outcome?: string }[]> = {
  project: [
    { key: 'scope', name: 'Scope', color: 'slate' },
    { key: 'design', name: 'Design', color: 'violet' },
    { key: 'development', name: 'Development', color: 'blue' },
    { key: 'qa', name: 'QA', color: 'amber' },
    { key: 'client_feedback', name: 'Client Feedback', color: 'orange' },
    { key: 'launch', name: 'Launch', color: 'emerald' },
    { key: 'maintenance', name: 'Maintenance', color: 'teal' },
    { key: 'closed', name: 'Closed', color: 'slate', terminal: true, outcome: 'done' },
  ],
  sales: [
    { key: 'discovery', name: 'Discovery', color: 'slate' },
    { key: 'requirement', name: 'Requirement', color: 'blue' },
    { key: 'proposal', name: 'Proposal', color: 'violet' },
    { key: 'negotiation', name: 'Negotiation', color: 'amber' },
    { key: 'won', name: 'Won', color: 'emerald', terminal: true, outcome: 'won' },
    { key: 'lost', name: 'Lost', color: 'red', terminal: true, outcome: 'lost' },
  ],
  content: [
    { key: 'idea', name: 'Idea', color: 'slate' },
    { key: 'research', name: 'Research', color: 'blue' },
    { key: 'brief', name: 'Brief', color: 'indigo' },
    { key: 'writing', name: 'Writing', color: 'violet' },
    { key: 'editing', name: 'Editing', color: 'amber' },
    { key: 'seo', name: 'SEO', color: 'orange' },
    { key: 'design', name: 'Design', color: 'rose' },
    { key: 'published', name: 'Published', color: 'emerald' },
    { key: 'performance', name: 'Performance', color: 'teal', terminal: true, outcome: 'done' },
  ],
  recruitment: [
    { key: 'applied', name: 'Applications', color: 'slate' },
    { key: 'screening', name: 'Screening', color: 'blue' },
    { key: 'interview', name: 'Interview', color: 'indigo' },
    { key: 'technical_test', name: 'Technical Test', color: 'violet' },
    { key: 'final_interview', name: 'Final Interview', color: 'amber' },
    { key: 'offer', name: 'Offer', color: 'orange' },
    { key: 'hired', name: 'Hired', color: 'emerald', terminal: true, outcome: 'hired' },
    { key: 'rejected', name: 'Rejected', color: 'red', terminal: true, outcome: 'rejected' },
  ],
};

export interface RuleSeed {
  key: string;
  name: string;
  description: string;
  eventType: string;
  conditions?: Record<string, unknown>;
  actions: { action: string; params?: Record<string, unknown> }[];
}

/** System automation rules. Modules append to this list; inserted once, then admin-editable. */
export const RULE_SEEDS: RuleSeed[] = [];

export async function seedSystem(db: DB) {
  await withActor(db, null, 'seed:system', async (tx) => {
    // Roles & grants
    const [ver] = await tx.select().from(settings).where(eq(settings.key, '_roleSeedVersion'));
    const applied = Number(ver?.value ?? 0);
    for (const r of ROLE_SEEDS) {
      let [role] = await tx.select().from(roles).where(eq(roles.key, r.key));
      const isNew = !role;
      if (!role) {
        [role] = await tx.insert(roles).values({ key: r.key, name: r.name, description: r.description, homeDashboard: r.homeDashboard, isSystem: true }).returning();
      }
      if (isNew || applied < ROLE_SEED_VERSION) {
        const grants = [...expandGrants(r.grants)].map(([permission, scope]) => ({ roleId: role.id, permission, scope }));
        if (grants.length) await tx.insert(rolePermissions).values(grants).onConflictDoNothing();
      }
    }
    if (applied < ROLE_SEED_VERSION) {
      await tx.insert(settings).values({ key: '_roleSeedVersion', value: ROLE_SEED_VERSION })
        .onConflictDoUpdate({ target: settings.key, set: { value: ROLE_SEED_VERSION } });
    }

    // Pipeline stages (insert missing only; admins may rename/reorder)
    for (const [pipeline, stages] of Object.entries(STAGE_SEEDS)) {
      const existing = await tx.select({ key: pipelineStages.key }).from(pipelineStages).where(eq(pipelineStages.pipeline, pipeline));
      const have = new Set(existing.map((e) => e.key));
      const missing = stages.map((s, i) => ({ ...s, i })).filter((s) => !have.has(s.key));
      if (missing.length) {
        await tx.insert(pipelineStages).values(missing.map((s) => ({
          pipeline, key: s.key, name: s.name, color: s.color, sortOrder: (s.i + 1) * 10, isTerminal: !!s.terminal, outcome: s.outcome,
        })));
      }
    }

    // Automation rules (insert missing only)
    if (RULE_SEEDS.length) {
      const existing = await tx.select({ key: automationRules.key }).from(automationRules).where(inArray(automationRules.key, RULE_SEEDS.map((r) => r.key)));
      const have = new Set(existing.map((e) => e.key));
      const missing = RULE_SEEDS.filter((r) => !have.has(r.key));
      if (missing.length) {
        await tx.insert(automationRules).values(missing.map((r) => ({
          key: r.key, name: r.name, description: r.description, eventType: r.eventType,
          conditions: r.conditions ?? {}, actions: r.actions, isSystem: true,
        })));
      }
    }

    await seedQaTemplates(tx);

    // Default SLA policy (wall-clock minutes; editable in Support › SLA policies).
    const [{ sp }] = await tx.select({ sp: count() }).from(slaPolicies);
    if (Number(sp) === 0) {
      const [p] = await tx.insert(slaPolicies).values({ name: 'Standard', isDefault: true, description: 'Default response and resolution targets.' }).returning();
      await tx.insert(slaTargets).values([
        { policyId: p.id, priority: 'urgent', firstResponseMinutes: 60, resolutionMinutes: 8 * 60 },
        { policyId: p.id, priority: 'high', firstResponseMinutes: 4 * 60, resolutionMinutes: 24 * 60 },
        { policyId: p.id, priority: 'medium', firstResponseMinutes: 8 * 60, resolutionMinutes: 72 * 60 },
        { policyId: p.id, priority: 'low', firstResponseMinutes: 24 * 60, resolutionMinutes: 120 * 60 },
      ]);
    }

    // Default leave policy (editable in People › Leave types).
    const [{ lt }] = await tx.select({ lt: count() }).from(leaveTypes);
    if (Number(lt) === 0) {
      await tx.insert(leaveTypes).values([
        { name: 'Annual leave', code: 'AL', annualAllowanceDays: '18', carryForwardMaxDays: '5' },
        { name: 'Sick leave', code: 'SL', annualAllowanceDays: '10' },
        { name: 'Casual leave', code: 'CL', annualAllowanceDays: '8' },
        { name: 'Unpaid leave', code: 'UL', annualAllowanceDays: '0', isPaid: false },
      ]);
    }
  });
}
