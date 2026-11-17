// Publishes the current code to the AWS server: builds the bundle, uploads it to the bucket and
// waits until the server's deploy agent has installed it (backup, migrations, health check, and
// automatic rollback if the new version does not start).
//
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node deploy/aws/release.mjs

import { awsFromEnv, buildBundle, checkHttps, deployBucket, log, readConfig, uploadRelease, waitForVersion } from './lib.mjs';

async function main() {
  const aws = awsFromEnv();
  const conf = await readConfig();
  if (!conf || !conf.bucket) throw new Error('Nincs deploy/aws/config.json: előbb a provision.mjs kell.');
  const bucket = await deployBucket(aws, conf);
  try {
    const bundle = await buildBundle();
    log(`Feltöltés: ${bundle.version} (${Math.round(bundle.buf.length / 1024)} KB)`);
    await uploadRelease(bucket, bundle);
    log('Várakozás a szerverre (legfeljebb egy perc, amíg észreveszi)...');
    await waitForVersion(bucket, bundle.version, { minutes: 10 });
    for (const h of conf.hostnames) log(`https://${h}: ${await checkHttps(h)}`);
    log(`Kész: ${bundle.version} fut.`);
  } finally {
    await bucket.cleanup();
  }
}

main().catch((err) => { console.error(`HIBA: ${err.message}`); process.exit(1); });
