import { z } from 'zod';

const Env = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().default(4000),
  APP_ORIGIN: z.url().default('http://localhost:5173'),
  DATABASE_URL: z.string().optional(),
  /** Direct (non-pooled) connection for migrations, e.g. Neon's DATABASE_URL_UNPOOLED. Falls back to DATABASE_URL. */
  DATABASE_URL_UNPOOLED: z.string().optional(),
  PGLITE_DIR: z.string().default('.data/pglite'),
  STORAGE_DIR: z.string().default('storage/uploads'),
  SMTP_URL: z.string().optional(),
  MAIL_FROM: z.string().default('Devtics DMS <no-reply@localhost>'),
  /** Session lifetime limits */
  SESSION_IDLE_HOURS: z.coerce.number().default(12),
  SESSION_MAX_DAYS: z.coerce.number().default(7),
  /** Login / password-change attempts per IP per minute */
  AUTH_RATE_PER_MIN: z.coerce.number().int().default(10),
});

export type Config = z.infer<typeof Env>;

export function loadConfig(env: Record<string, string | undefined> = process.env): Config {
  const cfg = Env.parse(env);
  if (cfg.NODE_ENV === 'production' && !cfg.DATABASE_URL) {
    throw new Error('DATABASE_URL is required in production (PGlite is for development and tests only)');
  }
  return cfg;
}
