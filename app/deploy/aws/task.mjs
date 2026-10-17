// Runs a one-off job on the AWS server through the deploy agent and prints its output.
// Only the jobs the agent knows (TASKS in agent.mjs) can run:
//
//   node deploy/aws/task.mjs demo-seed     sample data for trying things out (partners, stock, orders ...)
//   node deploy/aws/task.mjs demo-remove   removes the sample data again, real data stays
//   node deploy/aws/task.mjs backup        a database backup to the bucket now

import { awsFromEnv, deployBucket, log, randomToken, readConfig, sleep } from './lib.mjs';

const KNOWN = ['demo-seed', 'demo-remove', 'backup'];

async function main() {
  const task = process.argv[2];
  if (!KNOWN.includes(task)) throw new Error(`Használat: node deploy/aws/task.mjs ${KNOWN.join(' | ')}`);
  const aws = awsFromEnv();
  const conf = await readConfig();
  if (!conf || !conf.bucket) throw new Error('Nincs deploy/aws/config.json: előbb a provision.mjs kell.');
  const bucket = await deployBucket(aws, conf);
  try {
    const id = randomToken(9).replace(/[^A-Za-z0-9]/g, 'x');
    await bucket.put('tasks/current.json', JSON.stringify({ id, task, at: new Date().toISOString() }), { httpMetadata: { contentType: 'application/json' } });
    log(`Feladat elküldve: ${task} (${id}). A szerver egy percen belül elindítja...`);
    const until = Date.now() + 20 * 60 * 1000;
    while (Date.now() < until) {
      const o = await bucket.get(`status/task-${id}.json`).catch(() => null);
      if (o) {
        const r = JSON.parse(await o.text());
        log(r.output || '');
        if (!r.ok) throw new Error(`A(z) ${task} feladat nem sikerült.`);
        log(`Kész: ${task}.`);
        return;
      }
      await sleep(10000);
    }
    throw new Error('A szerver 20 perc alatt sem jelentette a feladat eredményét (node deploy/aws/status.mjs).');
  } finally {
    await bucket.cleanup();
  }
}

main().catch((err) => { console.error(`HIBA: ${err.message}`); process.exit(1); });
