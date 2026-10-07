import { loadConfig } from './config.ts';
import { bootstrap } from './bootstrap.ts';
import { startScheduler } from './jobs.ts';

const config = loadConfig();
const { app, database, events } = await bootstrap(config, { logger: true });
events.log = (msg, err) => app.log.error({ err }, msg);
const stopScheduler = startScheduler(database.db, events, app.log);

await app.listen({ port: config.PORT, host: config.NODE_ENV === 'production' ? '0.0.0.0' : '127.0.0.1' });

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.once(sig, async () => {
    stopScheduler();
    await app.close();
    await database.close();
    process.exit(0);
  });
}
