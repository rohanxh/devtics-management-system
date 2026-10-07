import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { setup, type TestEnv } from './helpers.ts';

let t: TestEnv;
let admin: Awaited<ReturnType<TestEnv['as']>>;
let pm: Awaited<ReturnType<TestEnv['as']>>;
let dev: Awaited<ReturnType<TestEnv['as']>>;
let id: string;

beforeAll(async () => {
  t = await setup();
  admin = await t.as(['admin']); pm = await t.as(['pm']); dev = await t.as(['developer']);
});
afterAll(async () => { await t.close(); });

describe('knowledge base', () => {
  it('keeps drafts private to editors', async () => {
    const r = await admin.api.post('/api/kb', { title: 'Code review standard', category: 'dev_standard', body: '# Code review\n\nEvery PR needs one approval.', requiredReading: true });
    expect(r.status).toBe(201);
    id = r.body.id;
    expect((await dev.api.get(`/api/kb/${id}`)).status).toBe(404);
    expect((await dev.api.get('/api/kb')).body.rows).toHaveLength(0);
    expect((await dev.api.post('/api/kb', { title: 'Nope', body: 'x' })).status).toBe(403);
  });

  it('publishing assigns required reading to the audience', async () => {
    expect((await pm.api.post(`/api/kb/${id}/publish`)).status).toBe(403); // no publish permission
    const pub = await admin.api.post(`/api/kb/${id}/publish`, { changeSummary: 'First version' });
    expect(pub.status).toBe(200);
    expect(pub.body.assigned).toBeGreaterThanOrEqual(3);
    const mine = (await dev.api.get('/api/kb/my-reading')).body;
    expect(mine.map((m: any) => m.articleId)).toContain(id);
    const art = (await dev.api.get(`/api/kb/${id}`)).body;
    expect(art.version.body).toContain('one approval');
    expect(art.can.acknowledge).toBe(true);
  });

  it('tracks acknowledgement per version and requires re-acknowledgement after an update', async () => {
    expect((await dev.api.post(`/api/kb/${id}/acknowledge`)).status).toBe(200);
    expect((await dev.api.get('/api/kb/my-reading')).body).toHaveLength(0);
    let comp = (await admin.api.get(`/api/kb/${id}/compliance`)).body;
    expect(comp.acknowledged).toBe(1);
    expect((await dev.api.get(`/api/kb/${id}/compliance`)).status).toBe(403);

    expect((await pm.api.put(`/api/kb/${id}/draft`, { title: 'Code review standard', body: 'changed' })).status).toBe(403); // not owner
    expect((await admin.api.put(`/api/kb/${id}/draft`, { title: 'Code review standard', body: '# Code review\n\nEvery PR needs **two** approvals.' })).status).toBe(200);
    // readers still see the published v1 while v2 is a draft
    expect((await dev.api.get(`/api/kb/${id}`)).body.version.versionNumber).toBe(1);
    await admin.api.post(`/api/kb/${id}/publish`, { changeSummary: 'Two approvals' });
    const art = (await dev.api.get(`/api/kb/${id}`)).body;
    expect(art.version.versionNumber).toBe(2);
    expect(art.acknowledgedAt).toBeNull();
    expect((await dev.api.get('/api/kb/my-reading')).body).toHaveLength(1);
    comp = (await admin.api.get(`/api/kb/${id}/compliance`)).body;
    expect(comp.acknowledged).toBe(0);
    expect(art.versions.map((v: any) => v.versionNumber)).toEqual([2, 1]);
  });

  it('limits required reading to the configured audience', async () => {
    const a = (await admin.api.post('/api/kb', { title: 'Sales procedure', category: 'sales_procedure', body: 'Qualify leads within 24h.', requiredReading: true })).body;
    await admin.api.put(`/api/kb/${a.id}/audience`, { roleKeys: ['bd'] });
    const bd = await t.as(['bd']);
    const pub = (await admin.api.post(`/api/kb/${a.id}/publish`)).body;
    expect(pub.assigned).toBe(1);
    expect((await bd.api.get('/api/kb/my-reading')).body.map((m: any) => m.articleId)).toContain(a.id);
    expect((await dev.api.get('/api/kb/my-reading')).body.map((m: any) => m.articleId)).not.toContain(a.id);
  });
});
