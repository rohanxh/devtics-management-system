import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { pipelineStages } from '../src/server/db/schema/index.ts';

let t: TestEnv;
let mk: Awaited<ReturnType<TestEnv['as']>>;

beforeAll(async () => { t = await setup(); mk = await t.as(['marketing']); });
afterAll(async () => { await t.close(); });

describe('marketing & SEO', () => {
  it('tracks keyword positions from ranking checks', async () => {
    const k = (await mk.api.post('/api/r/seo_keywords', { keyword: 'wordpress agency', site: 'devtics.example' })).body;
    await mk.api.post('/api/r/keyword_rankings', { keywordId: k.id, checkedOn: '2026-01-01', position: 14 });
    await mk.api.post('/api/r/keyword_rankings', { keywordId: k.id, checkedOn: '2026-01-08', position: 9 });
    const cur = (await mk.api.get(`/api/r/seo_keywords/${k.id}`)).body;
    expect(cur).toMatchObject({ currentPosition: 9, previousPosition: 14, bestPosition: 9, lastCheckedOn: '2026-01-08' });
  });

  it('requires a URL to publish content and attributes leads to campaigns', async () => {
    const stages = Object.fromEntries((await t.db.select().from(pipelineStages).where(eq(pipelineStages.pipeline, 'content'))).map((s) => [s.key, s.id]));
    const c = (await mk.api.post('/api/r/content_items', { title: 'Guide', stageId: stages.seo })).body;
    expect((await mk.api.patch(`/api/r/content_items/${c.id}`, { stageId: stages.published })).status).toBe(422);
    const ok = await mk.api.patch(`/api/r/content_items/${c.id}`, { stageId: stages.published, publishedUrl: 'https://devtics.example/guide' });
    expect(ok.body.publishedOn).toBeTruthy();
    const camp = (await mk.api.post('/api/r/campaigns', { name: 'Spring push', spend: '300' })).body;
    expect((await mk.api.post('/api/r/leads', { title: 'Inbound', companyName: 'X Ltd', campaignId: camp.id })).status).toBe(201);
    const d = (await mk.api.get('/api/dashboard/marketing')).body;
    expect(d.campaigns.find((x: any) => x.id === camp.id).leads).toBe(1);
    expect(d.leadsMonth).toBeGreaterThanOrEqual(1);
  });

  it('is not available to roles without marketing access', async () => {
    const dev = await t.as(['developer']);
    expect((await dev.api.get('/api/dashboard/marketing')).status).toBe(403);
    expect((await dev.api.get('/api/r/campaigns')).status).toBe(403);
  });
});
