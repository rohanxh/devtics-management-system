import nodemailer from 'nodemailer';
import { and, asc, eq, inArray, isNull, lt } from 'drizzle-orm';
import type { DB } from '../db/client.ts';
import { notifications, users } from '../db/schema/index.ts';
import { loadConfig } from '../config.ts';
import { JOBS } from '../jobs.ts';
import { getSettings } from '../modules/settings.ts';

export interface Mail { to: string; subject: string; text: string }
export type Sender = (m: Mail) => Promise<void>;

let sender: Sender | undefined;
/** SMTP when SMTP_URL is configured; otherwise mail is logged (development). Tests can inject a sender. */
export function getSender(): Sender {
  if (sender) return sender;
  const cfg = loadConfig();
  if (cfg.SMTP_URL) {
    const transport = nodemailer.createTransport(cfg.SMTP_URL);
    sender = async (m) => { await transport.sendMail({ from: cfg.MAIL_FROM, ...m }); };
  } else {
    sender = async (m) => { if (cfg.NODE_ENV !== 'test') console.log(`[mail:dev] to=${m.to} subject="${m.subject}"`); };
  }
  return sender;
}
export const setSender = (s: Sender | undefined) => { sender = s; };

/** Notification kinds worth an email if left unread. Others stay in-app only (avoids spam). */
const EMAIL_KINDS = ['approval_request', 'escalation', 'alert', 'deadline', 'mention', 'assignment'];

/**
 * Email digest: one email per user with their important notifications that stayed unread for
 * `emailDigestMinutes`. Each notification is emailed at most once.
 */
export async function sendDigests(db: DB) {
  const s = await getSettings(db);
  const cutoff = new Date(Date.now() - s.emailDigestMinutes * 60_000);
  const pending = await db.select({ n: notifications, email: users.email, name: users.name }).from(notifications)
    .innerJoin(users, eq(users.id, notifications.userId))
    .where(and(isNull(notifications.readAt), isNull(notifications.emailedAt), lt(notifications.createdAt, cutoff), inArray(notifications.kind, EMAIL_KINDS), eq(users.status, 'active')))
    .orderBy(asc(notifications.createdAt)).limit(1000);
  const byUser = new Map<string, typeof pending>();
  for (const p of pending) byUser.set(p.email, [...(byUser.get(p.email) ?? []), p]);
  const origin = loadConfig().APP_ORIGIN;
  let sent = 0;
  for (const [email, items] of byUser) {
    const lines = items.map((i) => `• ${i.n.title}${i.n.link ? `\n  ${origin}${i.n.link}` : ''}`);
    await getSender()({
      to: email, subject: `${s.companyName} DMS: ${items.length} item(s) need your attention`,
      text: `Hi ${items[0].name.split(' ')[0]},\n\nThese are waiting for you in ${s.companyName} DMS:\n\n${lines.join('\n')}\n\nYou receive this because they were unread for ${s.emailDigestMinutes} minutes.`,
    });
    await db.update(notifications).set({ emailedAt: new Date() }).where(inArray(notifications.id, items.map((i) => i.n.id)));
    sent++;
  }
  return sent;
}

JOBS.push({ name: 'notifications.email_digest', everyMinutes: 10, run: async (db) => { await sendDigests(db); } });
