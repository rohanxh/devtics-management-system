import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import type { DB } from '../db/client.ts';
import { companies, contacts, leads, opportunities, pipelineStages } from '../db/schema/index.ts';
import { ctxOf } from '../app.ts';
import { tx } from '../core/context.ts';
import { conflict, forbidden, invalid } from '../core/errors.ts';
import { nextNumber } from '../core/counters.ts';
import { can } from '../rbac/actor.ts';
import { afterWrite, getOne, requireResource } from '../resources/engine.ts';
import type { Row } from '../resources/types.ts';

/**
 * Recomputes line amounts and totals for a quote or invoice in SQL (exact numeric arithmetic):
 * subtotal = Σ round(qty × unit price, 2); tax = round(max(subtotal − discount, 0) × rate / 100, 2).
 */
export async function recalcTotals(db: DB, kind: 'quote' | 'invoice', id: string) {
  const doc = sql.raw(kind === 'quote' ? 'quotes' : 'invoices');
  const items = sql.raw(kind === 'quote' ? 'quote_items' : 'invoice_items');
  const fk = sql.raw(kind === 'quote' ? 'quote_id' : 'invoice_id');
  await db.execute(sql`update ${items} set amount = round(quantity * unit_price, 2) where ${fk} = ${id}`);
  await db.execute(sql`
    with s as (select coalesce(sum(amount), 0) as sub from ${items} where ${fk} = ${id})
    update ${doc} d set
      subtotal = s.sub,
      tax_amount = round(greatest(s.sub - d.discount_amount, 0) * d.tax_rate / 100, 2),
      total = greatest(s.sub - d.discount_amount, 0) + round(greatest(s.sub - d.discount_amount, 0) * d.tax_rate / 100, 2)
    from s where d.id = ${id}`);
}
export const recalcQuote = (db: DB, id: string) => recalcTotals(db, 'quote', id);

export async function stageId(db: DB, pipeline: string, key: string) {
  const [s] = await db.select({ id: pipelineStages.id }).from(pipelineStages)
    .where(and(eq(pipelineStages.pipeline, pipeline), eq(pipelineStages.key, key)));
  if (!s) throw new Error(`Stage ${pipeline}/${key} is missing`);
  return s.id;
}

export async function salesRoutes(app: FastifyInstance) {
  /** Lead → company + contact + opportunity (Discovery). */
  app.post<{ Params: { id: string } }>('/api/sales/leads/:id/convert', async (req, reply) => {
    const ctx = ctxOf(req);
    if (!can(ctx.actor, 'opportunities.create')) throw forbidden();
    const lead = await getOne(ctx, 'leads', req.params.id, 'edit');
    if (lead.status === 'converted') throw conflict('This lead has already been converted');
    if (lead.status !== 'qualified') throw invalid('Qualify the lead before converting it', { status: 'Lead must be qualified' });
    const body = z.object({
      opportunityName: z.string().trim().min(2).max(300).optional(),
      value: z.union([z.number(), z.string()]).optional(),
      expectedCloseDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }).parse(req.body ?? {});
    const companyName = (lead.companyName ?? '').trim();
    if (!lead.companyId && !companyName) throw invalid('The lead needs a company name or an existing company', { companyName: 'Required to convert' });

    const opp = await tx(ctx, async (t) => {
      let companyId = lead.companyId as string | null;
      if (!companyId) {
        const [existing] = await t.select().from(companies).where(sql`lower(${companies.name}) = ${companyName.toLowerCase()}`);
        if (existing) companyId = existing.id;
        else {
          const [c] = await t.insert(companies).values({ name: companyName, lifecycle: 'prospect', ownerId: lead.ownerId ?? ctx.actor.userId }).returning();
          await afterWrite(t, requireResource('companies'), ctx.actor, c as Row, undefined);
          companyId = c.id;
        }
      }
      let contactId = lead.contactId as string | null;
      if (!contactId && lead.contactName) {
        const [first, ...rest] = String(lead.contactName).trim().split(/\s+/);
        const [ct] = await t.insert(contacts).values({
          companyId, firstName: first, lastName: rest.join(' ') || null, email: lead.email, phone: lead.phone, isPrimary: true, ownerId: lead.ownerId,
        }).returning();
        contactId = ct.id;
      }
      const [o] = await t.insert(opportunities).values({
        number: await nextNumber(t, 'opportunity', 'OP-', 4),
        name: body.opportunityName ?? lead.title, companyId: companyId!, primaryContactId: contactId, leadId: lead.id,
        stageId: await stageId(t, 'sales', 'discovery'), ownerId: lead.ownerId ?? ctx.actor.userId,
        value: String(body.value ?? lead.estimatedValue ?? 0), probability: 10, expectedCloseDate: body.expectedCloseDate,
        source: lead.source, projectType: lead.projectType, description: lead.requirements,
      }).returning();
      await afterWrite(t, requireResource('opportunities'), ctx.actor, o as Row, undefined);
      const [updatedLead] = await t.update(leads).set({ status: 'converted', convertedAt: new Date(), opportunityId: o.id, companyId, contactId })
        .where(eq(leads.id, lead.id)).returning();
      await afterWrite(t, requireResource('leads'), ctx.actor, updatedLead as Row, lead);
      return o;
    });
    app.deps.events.kick();
    return reply.status(201).send(opp);
  });
}
