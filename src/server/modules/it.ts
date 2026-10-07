import { and, asc, eq, gte, inArray, isNotNull, lte, ne, notInArray, sql } from 'drizzle-orm';
import { accessGrants, assets, employees, infraResources, subscriptions } from '../db/schema/index.ts';
import { withActor } from '../core/context.ts';
import { registerAction } from '../core/events.ts';
import { notify } from '../core/notify.ts';
import { afterWrite, requireResource } from '../resources/engine.ts';
import type { Row } from '../resources/types.ts';
import { JOBS } from '../jobs.ts';
import { registerDashboard, today } from './reports.ts';

const plus = (k: number) => new Date(Date.now() + k * 86400_000).toISOString().slice(0, 10);

/** Offboarding: when someone leaves, IT gets the list of access to revoke and equipment to recover. */
registerAction('it.offboarding', {
  description: 'Employee left: notify IT and HR with the active system access to revoke and the equipment to collect.',
  async run({ db, event, rule }) {
    const [e] = await db.select().from(employees).where(eq(employees.id, event.entityId!));
    if (!e) return;
    const grants = await db.select().from(accessGrants).where(and(eq(accessGrants.employeeId, e.id), ne(accessGrants.status, 'revoked')));
    const devices = await db.select().from(assets).where(eq(assets.assignedEmployeeId, e.id));
    await notify(db, {
      roles: ['it', 'hr'], kind: 'alert', title: `Offboard ${e.firstName} ${e.lastName}: revoke ${grants.length} access record(s), recover ${devices.length} device(s)`,
      body: [...grants.map((g) => `Access: ${g.systemName}${g.accountIdentifier ? ` (${g.accountIdentifier})` : ''}`), ...devices.map((d) => `Device: ${d.tag} ${d.brand ?? ''} ${d.model ?? ''}`)].join('\n').slice(0, 1900),
      entityType: 'employees', entityId: e.id, dedupeKey: `${rule.key}:${e.id}`,
    });
  },
});

JOBS.push({
  name: 'it.renewals', everyMinutes: 360,
  run: (db) => withActor(db, null, 'job:it.renewals', async (t) => {
    // Infrastructure expiry: mark expiring/expired and alert owners + IT.
    const infra = await t.select().from(infraResources).where(and(isNotNull(infraResources.expiresOn), notInArray(infraResources.status, ['decommissioned'])));
    for (const r of infra) {
      const status = r.expiresOn! < today() ? 'expired' : r.expiresOn! <= plus(30) ? 'expiring' : 'active';
      if (status !== r.status) {
        const [u] = await t.update(infraResources).set({ status }).where(eq(infraResources.id, r.id)).returning();
        await afterWrite(t, requireResource('infra_resources'), null, u as Row, r as Row);
      }
      if (status !== 'active') {
        await notify(t, {
          roles: ['it'], userIds: [r.ownerId], kind: 'deadline', title: `${r.kind.replace('_', ' ')} ${status === 'expired' ? 'EXPIRED' : 'expires'} ${r.expiresOn}: ${r.name}${r.autoRenew ? ' (auto-renew)' : ''}`,
          entityType: 'infra_resources', entityId: r.id, dedupeKey: `infra:${r.id}:${r.expiresOn}:${status}`,
        });
      }
    }
    const subs = await t.select().from(subscriptions).where(and(eq(subscriptions.status, 'active'), gte(subscriptions.renewalDate, today()), lte(subscriptions.renewalDate, plus(30))));
    for (const s of subs) {
      await notify(t, {
        roles: ['it', 'finance'], userIds: [s.ownerId], kind: 'deadline', title: `Renewal ${s.renewalDate}: ${s.name} (${s.seatsUsed}/${s.seatsTotal ?? '∞'} seats used)`,
        entityType: 'subscriptions', entityId: s.id, dedupeKey: `sub:${s.id}:${s.renewalDate}`,
      });
    }
    const warranty = await t.select().from(assets).where(and(gte(assets.warrantyUntil, today()), lte(assets.warrantyUntil, plus(30)), notInArray(assets.status, ['retired', 'lost'])));
    for (const a of warranty) {
      await notify(t, { roles: ['it'], kind: 'deadline', title: `Warranty ends ${a.warrantyUntil}: ${a.tag}`, entityType: 'assets', entityId: a.id, dedupeKey: `warranty:${a.id}:${a.warrantyUntil}` });
    }
  }),
});

registerDashboard({
  key: 'it', perm: 'assets.view',
  async build(ctx) {
    const byStatus = await ctx.db.select({ status: assets.status, n: sql<number>`count(*)::int` }).from(assets).groupBy(assets.status);
    const byKind = await ctx.db.select({ kind: assets.kind, n: sql<number>`count(*)::int` }).from(assets).where(notInArray(assets.status, ['retired', 'lost'])).groupBy(assets.kind);
    const renewals = await ctx.db.select().from(subscriptions).where(and(inArray(subscriptions.status, ['active', 'trial']), lte(subscriptions.renewalDate, plus(45)))).orderBy(asc(subscriptions.renewalDate));
    const expiring = await ctx.db.select().from(infraResources).where(and(isNotNull(infraResources.expiresOn), lte(infraResources.expiresOn, plus(45)), notInArray(infraResources.status, ['decommissioned']))).orderBy(asc(infraResources.expiresOn));
    const [spend] = await ctx.db.select({
      v: sql<string>`coalesce(sum(case ${subscriptions.billingCycle} when 'monthly' then ${subscriptions.cost} when 'quarterly' then ${subscriptions.cost} / 3 when 'yearly' then ${subscriptions.cost} / 12 else 0 end), 0)`,
    }).from(subscriptions).where(inArray(subscriptions.status, ['active', 'trial']));
    const seatWaste = await ctx.db.select({ id: subscriptions.id, name: subscriptions.name, seatsTotal: subscriptions.seatsTotal, seatsUsed: subscriptions.seatsUsed })
      .from(subscriptions).where(and(eq(subscriptions.status, 'active'), sql`${subscriptions.seatsTotal} > ${subscriptions.seatsUsed}`));
    // Security signal: active access held by people who have left.
    const leaverAccess = await ctx.db.select({ id: accessGrants.id, systemName: accessGrants.systemName, accountIdentifier: accessGrants.accountIdentifier, employeeId: employees.id, name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}` })
      .from(accessGrants).innerJoin(employees, eq(employees.id, accessGrants.employeeId))
      .where(and(ne(accessGrants.status, 'revoked'), inArray(employees.employmentStatus, ['terminated', 'resigned'])));
    const leaverDevices = await ctx.db.select({ id: assets.id, tag: assets.tag, name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}` })
      .from(assets).innerJoin(employees, eq(employees.id, assets.assignedEmployeeId)).where(inArray(employees.employmentStatus, ['terminated', 'resigned']));
    const [{ grants }] = await ctx.db.select({ grants: sql<number>`count(*)::int` }).from(accessGrants).where(eq(accessGrants.status, 'active'));
    return {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.status, r.n])), byKind, renewals, expiring, monthlySpend: Number(spend.v),
      seatWaste, leaverAccess, leaverDevices, activeGrants: grants, pendingGrants: (await ctx.db.select({ n: sql<number>`count(*)::int` }).from(accessGrants).where(eq(accessGrants.status, 'pending')))[0].n,
    };
  },
});
