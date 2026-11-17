// Sets the names the server answers on with HTTPS. The first one is the main address.
// A name is only added when its DNS already points at the server, so Caddy can get the certificate.
//
//   node deploy/aws/domain.mjs app.fully.hu            app.fully.hu first, the temporary name kept
//   node deploy/aws/domain.mjs app.fully.hu --only     app.fully.hu alone

import { resolve4 } from 'node:dns/promises';
import { awsFromEnv, checkHttps, deployBucket, log, putHostnames, readConfig, sleep, sslipName, writeConfig } from './lib.mjs';

async function main() {
  const name = (process.argv[2] || '').toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(name)) throw new Error('Adj meg egy domaint, pl.: node deploy/aws/domain.mjs app.fully.hu');
  const aws = awsFromEnv();
  const conf = await readConfig();
  if (!conf || !conf.ip) throw new Error('Nincs deploy/aws/config.json: előbb a provision.mjs kell.');
  const ips = await resolve4(name).catch(() => []);
  if (!ips.includes(conf.ip)) {
    throw new Error(`A(z) ${name} még nem a szerverre mutat (most: ${ips.join(', ') || 'nincs A rekord'}, kell: ${conf.ip}). Vedd fel az A rekordot, és próbáld újra pár perc múlva.`);
  }
  const rest = process.argv.includes('--only') ? [] : [sslipName(conf.ip)];
  conf.hostnames = [name, ...rest.filter((h) => h !== name)];
  const bucket = await deployBucket(aws, conf);
  try {
    await putHostnames(bucket, conf.hostnames);
  } finally {
    await bucket.cleanup();
  }
  await writeConfig(conf);
  log(`Beállítva: ${conf.hostnames.join(', ')}. A szerver egy percen belül átveszi és tanúsítványt kér.`);
  await sleep(90000);
  log(`https://${name}: ${await checkHttps(name)}`);
}

main().catch((err) => { console.error(`HIBA: ${err.message}`); process.exit(1); });
