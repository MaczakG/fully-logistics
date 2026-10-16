// Scheduled jobs (wrangler.jsonc "triggers.crons"):
//   "*/10 * * * *"  every 10 minutes: import new webshop orders
//   "5 * * * *"     hourly: storage snapshot (takes the end-of-day snapshot once per Budapest day)

import { syncAll } from './integrations/webshops/index.js';
import { takeDailySnapshot } from './jobs/snapshot.js';

export async function scheduled(event, env) {
  const jobs = [];
  if (event.cron === '*/10 * * * *') jobs.push(['webshops', () => syncAll(env)]);
  if (event.cron === '5 * * * *') jobs.push(['snapshot', () => takeDailySnapshot(env)]);
  for (const [name, job] of jobs) {
    try {
      await job();
    } catch (err) {
      console.error(`cron ${name} failed`, err && err.stack ? err.stack : err);
    }
  }
}
