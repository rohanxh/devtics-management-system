import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.ts';
import { invoices, invoiceItems, companies } from '../src/server/db/schema/index.ts';
import { recalcInvoice } from '../src/server/modules/finance.ts';

let t: TestEnv;

beforeAll(async () => {
  t = await setup();
  // A little data so aggregates are non-trivial.
  const [c] = await t.db.insert(companies).values({ name: 'Report Co', lifecycle: 'client' }).returning();
  const today = new Date().toISOString().slice(0, 10);
  const [inv] = await t.db.insert(invoices).values({ number: 'INV-T1', companyId: c.id, issueDate: today, dueDate: today, status: 'sent' }).returning();
  await t.db.insert(invoiceItems).values({ invoiceId: inv.id, description: 'Work', quantity: '1', unitPrice: '1234.50' });
  await recalcInvoice(t.db, inv.id);
});
afterAll(async () => { await t.close(); });

describe('executive reporting', () => {
  it('runs every report for the CEO', async () => {
    const ceo = await t.as(['ceo']);
    const list = (await ceo.api.get('/api/reports')).body;
    expect(list.map((r: any) => r.key)).toEqual(expect.arrayContaining(['financial', 'profitability', 'sales', 'projects', 'utilization', 'hr', 'technical', 'support', 'departments']));
    for (const r of list) {
      const res = await ceo.api.get(`/api/reports/${r.key}?from=2026-01-01&to=2026-12-31`);
      expect(res.status, r.key).toBe(200);
    }
    expect((await ceo.api.get('/api/dashboard/ceo')).status).toBe(200);
  });

  it('gates reports by role', async () => {
    const dev = await t.as(['developer']);
    expect((await dev.api.get('/api/reports')).body).toEqual([]);
    expect((await dev.api.get('/api/reports/financial')).status).toBe(403);
    expect((await dev.api.get('/api/dashboard/ceo')).status).toBe(403);
    const fin = await t.as(['finance']);
    const keys = (await fin.api.get('/api/reports')).body.map((r: any) => r.key);
    expect(keys).toEqual(expect.arrayContaining(['financial', 'profitability']));
    expect(keys).not.toContain('hr');
    expect((await fin.api.get('/api/reports/hr')).status).toBe(403);
  });

  it('reports the same revenue everywhere (single source of truth)', async () => {
    const ceo = await t.as(['ceo']);
    const fin = await t.as(['finance']);
    const year = new Date().getFullYear();
    const today = new Date().toISOString().slice(0, 10);
    const dash = (await ceo.api.get('/api/dashboard/ceo')).body;
    const report = (await fin.api.get(`/api/reports/financial?from=${year}-01-01&to=${today}`)).body.data.pnl;
    const finDash = (await fin.api.get('/api/dashboard/finance')).body;
    expect(dash.finance.ytd.revenue).toBe(1234.5);
    expect(report.revenue).toBe(dash.finance.ytd.revenue);
    expect(finDash.ytd.revenue).toBe(dash.finance.ytd.revenue);
  });
});
