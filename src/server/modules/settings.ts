import { z } from 'zod';
import type { DB } from '../db/client.ts';
import { settings } from '../db/schema/index.ts';

export const SETTINGS_SCHEMA = z.object({
  companyName: z.string().trim().min(1).max(120),
  baseCurrency: z.string().regex(/^[A-Z]{3}$/),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
  defaultTaxRate: z.number().min(0).max(100),
  invoiceDueDays: z.number().int().min(0).max(180),
  /** Standard working hours per day, used for capacity and utilization. */
  workdayHours: z.number().min(1).max(24),
  utilizationTargetPct: z.number().min(1).max(100),
  /** Overhead added to salary when deriving the loaded hourly cost (benefits, equipment, office). */
  costOverheadPct: z.number().min(0).max(300),
  /** Notifications left unread this long are included in an email digest. */
  emailDigestMinutes: z.number().int().min(5).max(1440),
});

export type Settings = z.infer<typeof SETTINGS_SCHEMA>;

export const DEFAULT_SETTINGS: Settings = {
  companyName: 'Devtics',
  baseCurrency: 'USD',
  fiscalYearStartMonth: 1,
  defaultTaxRate: 0,
  invoiceDueDays: 15,
  workdayHours: 8,
  utilizationTargetPct: 80,
  costOverheadPct: 25,
  emailDigestMinutes: 30,
};

export async function getSettings(db: DB): Promise<Settings> {
  const rows = await db.select().from(settings);
  return { ...DEFAULT_SETTINGS, ...Object.fromEntries(rows.map((r) => [r.key, r.value])) } as Settings;
}
