import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { setup, type TestEnv } from './helpers.ts';
import { notifications } from '../src/server/db/schema/index.ts';
import { notify } from '../src/server/core/notify.ts';
import { sendDigests, setSender, type Mail } from '../src/server/core/mailer.ts';

let t: TestEnv;
beforeAll(async () => { t = await setup(); });
afterAll(async () => { setSender(undefined); await t.close(); });

describe('notifications', () => {
  it('deduplicates, skips the actor, and emails one digest per user for unread important items', async () => {
    const a = await t.createUser(['pm']);
    const b = await t.createUser(['developer']);
    expect(await notify(t.db, { userIds: [a.id, b.id], kind: 'approval_request', title: 'Approve X', dedupeKey: 'x', excludeUserId: b.id })).toBe(1);
    expect(await notify(t.db, { userIds: [a.id], kind: 'approval_request', title: 'Approve X again', dedupeKey: 'x' })).toBe(0);
    await notify(t.db, { userIds: [a.id], kind: 'status', title: 'FYI only', dedupeKey: 'y' });
    await notify(t.db, { userIds: [a.id], kind: 'deadline', title: 'Due soon', dedupeKey: 'z' });
    await t.db.update(notifications).set({ createdAt: new Date(Date.now() - 3600_000) }).where(eq(notifications.userId, a.id));
    const sent: Mail[] = [];
    setSender(async (m) => { sent.push(m); });
    expect(await sendDigests(t.db)).toBe(1);
    expect(sent).toHaveLength(1);
    expect(sent[0].to).toBe(a.email);
    expect(sent[0].text).toContain('Approve X');
    expect(sent[0].text).toContain('Due soon');
    expect(sent[0].text).not.toContain('FYI only');
    expect(await sendDigests(t.db)).toBe(0); // never emailed twice
  });

  it('skips recipients who cannot see the referenced record', async () => {
    const pm = await t.as(['pm']);
    const outsider = await t.createUser(['developer']);
    const { pipelineStages } = await import('../src/server/db/schema/index.ts');
    const [st] = await t.db.select().from(pipelineStages).where(eq(pipelineStages.key, 'scope'));
    const p = (await pm.api.post('/api/r/projects', { name: 'Secret', stageId: st.id, pmId: pm.user.id })).body;
    const n = await notify(t.db, { userIds: [pm.user.id, outsider.id], kind: 'status', title: 'Project update', entityType: 'projects', entityId: p.id, dedupeKey: 'p1' });
    expect(n).toBe(1);
  });
});
