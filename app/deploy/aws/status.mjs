// What the server reports (status/agent.json): installed and wanted version, health, last messages.
//
//   node deploy/aws/status.mjs

import { awsFromEnv, checkHttps, deployBucket, log, readConfig, readStatus } from './lib.mjs';

async function main() {
  const aws = awsFromEnv();
  const conf = await readConfig();
  if (!conf || !conf.bucket) throw new Error('Nincs deploy/aws/config.json.');
  const bucket = await deployBucket(aws, conf);
  try {
    log(JSON.stringify(await readStatus(bucket), null, 2));
  } finally {
    await bucket.cleanup();
  }
  for (const h of conf.hostnames || []) log(`https://${h}: ${await checkHttps(h)}`);
}

main().catch((err) => { console.error(`HIBA: ${err.message}`); process.exit(1); });
