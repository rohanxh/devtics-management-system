import type { FastifyBaseLogger } from 'fastify';
import type { DB } from './db/client.ts';
import type { EventProcessor } from './core/events.ts';

export interface Job {
  name: string;
  everyMinutes: number;
  run(db: DB): Promise<void>;
}

/** Periodic jobs (overdue scans, reminders, digests). Modules push into this list. */
export const JOBS: Job[] = [];

/**
 * In-process scheduler: drains the event outbox every few seconds and runs periodic jobs.
 * ponytail: single-instance timers; move to a distributed scheduler (pg-boss / cron worker) when scaling out.
 */
export function startScheduler(db: DB, events: EventProcessor, log: FastifyBaseLogger) {
  const timers: NodeJS.Timeout[] = [];
  timers.push(setInterval(() => events.processPending().catch((err) => log.error({ err }, 'event processing failed')), 3000));
  for (const job of JOBS) {
    const run = () => job.run(db).then(() => events.kick()).catch((err) => log.error({ err }, `job ${job.name} failed`));
    setTimeout(run, 10_000);
    timers.push(setInterval(run, job.everyMinutes * 60_000));
  }
  return () => timers.forEach(clearInterval);
}
