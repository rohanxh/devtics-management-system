import { eq } from 'drizzle-orm';
import * as s from './schema/index.ts';
import { DEMO_SEEDERS, daysFromNow, type SeedCtx } from './seed-demo.ts';
import { nextNumber } from '../core/counters.ts';
import { pick, rnd } from './seed-demo-crm.ts';

DEMO_SEEDERS.push({
  name: 'marketing',
  async run({ tx, users: u, stages }: SeedCtx) {
    const site = 'devtics.example';
    const [c1] = await tx.insert(s.campaigns).values({ name: 'WooCommerce migration guide', channel: 'content', status: 'active', startDate: daysFromNow(-45), budget: '1500', spend: '900', ownerId: u.kamran, utmCampaign: 'woo-guide' }).returning();
    const [c2] = await tx.insert(s.campaigns).values({ name: 'LinkedIn — agency services', channel: 'social', status: 'active', startDate: daysFromNow(-30), budget: '2000', spend: '1250', ownerId: u.kamran, utmCampaign: 'li-agency' }).returning();
    const [c3] = await tx.insert(s.campaigns).values({ name: 'Q3 webinar', channel: 'event', status: 'completed', startDate: daysFromNow(-90), endDate: daysFromNow(-60), budget: '600', spend: '580', ownerId: u.kamran }).returning();
    // Attribute existing leads and add a stream of historical leads.
    const existing = await tx.select().from(s.leads);
    for (const l of existing.slice(0, 4)) await tx.update(s.leads).set({ campaignId: pick([c1.id, c2.id]) }).where(eq(s.leads.id, l.id));
    for (let i = 0; i < 26; i++) {
      const created = new Date(Date.now() - Math.floor(rnd() * 170) * 86400_000);
      await tx.insert(s.leads).values({
        number: await nextNumber(tx, 'lead', 'LD-', 4), title: pick(['Website redesign', 'Online store', 'SEO help', 'App idea', 'Maintenance support']) + ` (${i + 1})`,
        companyName: `Prospect ${i + 1} Ltd`, source: pick(['website', 'seo', 'linkedin', 'referral', 'ads', 'event'] as const), campaignId: pick([c1.id, c2.id, c3.id, null]),
        status: pick(['new', 'contacted', 'unqualified', 'qualified', 'converted'] as const), ownerId: pick([u.usman, u.kamran]), estimatedValue: String(2000 + Math.floor(rnd() * 20000)),
        createdAt: created, disqualifyReason: 'Budget', convertedAt: created,
      });
    }
    // Traffic: six months, three channels
    for (let m = 5; m >= 0; m--) {
      const d = new Date(); const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m, 1)); const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() - m + 1, 0));
      for (const [channel, baseSessions] of [['organic', 2400], ['direct', 900], ['social', 600]] as const) {
        const sessions = Math.round(baseSessions * (1 + (5 - m) * 0.08) * (0.9 + rnd() * 0.2));
        await tx.insert(s.trafficSnapshots).values({ site, periodStart: start.toISOString().slice(0, 10), periodEnd: end.toISOString().slice(0, 10), channel, sessions, users: Math.round(sessions * 0.7), conversions: Math.round(sessions * 0.012) });
      }
    }
    const kws = [['woocommerce development agency', 210, 35], ['wordpress maintenance plans', 480, 28], ['elementor expert', 320, 22], ['react development company', 880, 55], ['website redesign cost', 1300, 40], ['shopify to woocommerce', 260, 30]] as const;
    for (const [keyword, vol, diff] of kws) {
      const [k] = await tx.insert(s.seoKeywords).values({ keyword, site, searchVolume: vol, difficulty: diff, intent: 'commercial', ownerId: u.kamran, targetUrl: `https://${site}/${keyword.replace(/\s+/g, '-')}` }).returning();
      let pos = 8 + Math.floor(rnd() * 30);
      for (let w = 6; w >= 0; w--) {
        pos = Math.max(1, pos + Math.round((rnd() - 0.6) * 5));
        await tx.insert(s.keywordRankings).values({ keywordId: k.id, checkedOn: daysFromNow(-w * 7), position: pos });
      }
      const rows = await tx.select().from(s.keywordRankings).where(eq(s.keywordRankings.keywordId, k.id));
      rows.sort((a, b) => (a.checkedOn < b.checkedOn ? 1 : -1));
      await tx.update(s.seoKeywords).set({ currentPosition: rows[0].position, previousPosition: rows[1].position, bestPosition: Math.min(...rows.map((r) => r.position ?? 999)), lastCheckedOn: rows[0].checkedOn }).where(eq(s.seoKeywords.id, k.id));
    }
    await tx.insert(s.backlinks).values([
      { site, sourceUrl: 'https://blog.partner.example/agencies-we-trust', anchorText: 'Devtics', domainAuthority: 48, status: 'live', acquiredOn: daysFromNow(-40), ownerId: u.kamran },
      { site, sourceUrl: 'https://directory.example/web-agencies', anchorText: 'web development agency', domainAuthority: 35, status: 'outreach', ownerId: u.kamran },
      { site, sourceUrl: 'https://news.example/old-mention', anchorText: 'Devtics', domainAuthority: 60, status: 'lost', acquiredOn: daysFromNow(-200), lostOn: daysFromNow(-10), ownerId: u.kamran },
    ]);
    await tx.insert(s.seoAudits).values({ site, auditDate: daysFromNow(-14), tool: 'Site crawler', healthScore: 82, issuesCritical: 3, issuesWarning: 27, pagesCrawled: 140, auditorId: u.kamran, summary: '- 3 pages with missing meta descriptions\n- Large hero images on service pages\n- 2 redirect chains' });
    const content = [
      ['How much does a website redesign cost in 2026?', 'published'], ['WooCommerce vs Shopify for growing brands', 'editing'], ['Case study: Bluepeak patient portal', 'brief'],
      ['10-point WordPress maintenance checklist', 'writing'], ['Elementor performance tips', 'idea'], ['Agency services landing page', 'design'], ['LinkedIn carousel: launch checklist', 'seo'],
    ] as const;
    const keywords = await tx.select().from(s.seoKeywords);
    for (const [title, st] of content) {
      await tx.insert(s.contentItems).values({
        title, type: title.startsWith('Case') ? 'case_study' : title.includes('landing') ? 'landing_page' : title.startsWith('LinkedIn') ? 'social_post' : 'blog_post',
        stageId: stages.content[st], assigneeId: pick([u.kamran, u.maryam]), keywordId: pick(keywords).id, campaignId: c1.id,
        dueDate: daysFromNow(st === 'writing' ? -2 : 5 + Math.floor(rnd() * 20)), publishedUrl: st === 'published' ? `https://${site}/blog/website-redesign-cost` : null,
        publishedOn: st === 'published' ? daysFromNow(-20) : null, sessions: st === 'published' ? 840 : null, conversions: st === 'published' ? 9 : null,
      });
    }
  },
});
