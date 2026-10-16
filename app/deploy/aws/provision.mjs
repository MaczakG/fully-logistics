// Creates the AWS side once: a Lightsail bucket (files, backups, releases), a static IP, and an
// Ubuntu server that installs itself (cloud-init.sh) and runs the first release. Safe to run again:
// what exists is kept. At the end deploy/aws/config.json holds the names (no secrets) and the
// script prints the temporary HTTPS address and the one-time setup token for the first admin.
//
//   AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... node deploy/aws/provision.mjs [--size 1] [--name fully-app]

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { presignS3, presignS3Get } from '../../server/sigv4.mjs';
import {
  HERE, awsFromEnv, buildBundle, checkHttps, deployBucket, log, ls, putHostnames, randomToken, readConfig,
  sleep, sslipName, uploadRelease, waitForVersion, waitOps, writeConfig,
} from './lib.mjs';

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const aws = awsFromEnv();
const name = arg('--name', 'fully-app');
const ramGb = Number(arg('--size', '1'));
const notFound = (err) => err.code === 'NotFoundException' || /does not exist|not found/i.test(err.message);

async function ensureBucket(conf) {
  if (conf.bucket) {
    try { await ls(aws, 'GetBuckets', { bucketName: conf.bucket }); return; } catch (err) { if (!notFound(err)) throw err; }
  }
  const { bundles } = await ls(aws, 'GetBucketBundles', { includeInactive: false });
  const bundle = bundles.filter((b) => b.isActive).sort((a, b) => a.price - b.price)[0];
  conf.bucket = conf.bucket || `${name}-${randomToken(6).toLowerCase().replace(/[^a-z0-9]/g, '')}`.slice(0, 54);
  log(`Tárhely (bucket) létrehozása: ${conf.bucket} (${bundle.bundleId}, ${bundle.price} USD/hó)`);
  await waitOps(aws, await ls(aws, 'CreateBucket', { bucketName: conf.bucket, bundleId: bundle.bundleId, tags: [{ key: 'app', value: name }] }), 'CreateBucket');
  for (let i = 0; i < 60; i++) {
    const { buckets } = await ls(aws, 'GetBuckets', { bucketName: conf.bucket });
    if (buckets[0] && buckets[0].state && buckets[0].state.code === 'OK') break;
    await sleep(3000);
  }
}

async function ensureStaticIp(conf) {
  conf.staticIpName = conf.staticIpName || `${name}-ip`;
  try {
    const { staticIp } = await ls(aws, 'GetStaticIp', { staticIpName: conf.staticIpName });
    conf.ip = staticIp.ipAddress;
    return staticIp;
  } catch (err) { if (!notFound(err)) throw err; }
  log(`Állandó IP-cím foglalása: ${conf.staticIpName}`);
  await waitOps(aws, await ls(aws, 'AllocateStaticIp', { staticIpName: conf.staticIpName }), 'AllocateStaticIp');
  const { staticIp } = await ls(aws, 'GetStaticIp', { staticIpName: conf.staticIpName });
  conf.ip = staticIp.ipAddress;
  return staticIp;
}

async function pickBundle() {
  const { bundles } = await ls(aws, 'GetBundles', { includeInactive: false });
  const fit = bundles.filter((b) => b.isActive && (b.supportedPlatforms || []).includes('LINUX_UNIX') && b.ramSizeInGb === ramGb && !/ipv6/i.test(b.bundleId));
  if (!fit.length) throw new Error(`Nincs ${ramGb} GB-os Linux csomag ebben a régióban.`);
  return fit.sort((a, b) => a.price - b.price)[0];
}

async function pickBlueprint() {
  const { blueprints } = await ls(aws, 'GetBlueprints', { includeInactive: false });
  for (const id of ['ubuntu_24_04', 'ubuntu_22_04']) if (blueprints.some((b) => b.blueprintId === id && b.isActive)) return id;
  throw new Error('Nincs Ubuntu 24.04 vagy 22.04 kép ebben a régióban.');
}

async function main() {
  const conf = { region: aws.region, ...(await readConfig()) };
  if (conf.region !== aws.region) throw new Error(`A config.json régiója ${conf.region}, az AWS_REGION ${aws.region}.`);
  conf.instanceName = conf.instanceName || name;

  await ensureBucket(conf);
  await ensureStaticIp(conf);
  conf.hostnames = conf.hostnames && conf.hostnames.length ? conf.hostnames : [sslipName(conf.ip)];

  let instance = null;
  try { ({ instance } = await ls(aws, 'GetInstance', { instanceName: conf.instanceName })); } catch (err) { if (!notFound(err)) throw err; }

  let setupToken = null;
  if (!instance) {
    // The server's own bucket key goes into its settings; a second, temporary key does this deploy.
    const { accessKeys = [] } = await ls(aws, 'GetBucketAccessKeys', { bucketName: conf.bucket });
    for (const k of accessKeys) await ls(aws, 'DeleteBucketAccessKey', { bucketName: conf.bucket, accessKeyId: k.accessKeyId });
    const { accessKey: serverKey } = await ls(aws, 'CreateBucketAccessKey', { bucketName: conf.bucket });
    conf.serverKeyId = serverKey.accessKeyId;
    await writeConfig(conf);

    const bucket = await deployBucket(aws, conf);
    try {
      log('Az alkalmazás csomagolása és feltöltése...');
      const bundle = await buildBundle();
      await uploadRelease(bucket, bundle);
      await putHostnames(bucket, conf.hostnames);
      const url = presignS3Get({ bucket: conf.bucket, region: conf.region, key: `releases/${bundle.version}.tar.gz`, credentials: { accessKeyId: serverKey.accessKeyId, secretAccessKey: serverKey.secretAccessKey }, expiresIn: 6 * 3600 });
      const logUrl = presignS3({ method: 'PUT', bucket: conf.bucket, region: conf.region, key: 'status/init.log', credentials: { accessKeyId: serverKey.accessKeyId, secretAccessKey: serverKey.secretAccessKey }, expiresIn: 7 * 24 * 3600 });
      setupToken = randomToken(18);
      const safe = (v, re) => { if (!re.test(v)) throw new Error('Váratlan karakter egy beállításban.'); return v; };
      const userData = (await readFile(join(HERE, 'cloud-init.sh'), 'utf8'))
        .replace('__BUCKET__', safe(conf.bucket, /^[a-z0-9-]+$/))
        .replace('__REGION__', safe(conf.region, /^[a-z0-9-]+$/))
        .replace('__S3_KEY_ID__', safe(serverKey.accessKeyId, /^[A-Z0-9]+$/))
        .replace('__S3_SECRET__', safe(serverKey.secretAccessKey, /^[A-Za-z0-9/+=]+$/))
        .replace('__SETUP_TOKEN__', safe(setupToken, /^[A-Za-z0-9_-]+$/))
        .replace('__BOOTSTRAP_URL__', safe(url, /^https:\/\/[^'\s]+$/))
        .replace('__LOG_URL__', safe(logUrl, /^https:\/\/[^'\s]+$/))
        .replace('__BOOTSTRAP_SHA256__', bundle.sha256);
      if (userData.length > 16000) throw new Error('A launch script túl hosszú.');

      const plan = await pickBundle();
      const blueprintId = await pickBlueprint();
      log(`Szerver létrehozása: ${conf.instanceName} (${plan.bundleId}: ${plan.ramSizeInGb} GB RAM, ${plan.price} USD/hó, ${blueprintId}, ${conf.region}a)`);
      await waitOps(aws, await ls(aws, 'CreateInstances', {
        instanceNames: [conf.instanceName],
        availabilityZone: `${conf.region}a`,
        blueprintId,
        bundleId: plan.bundleId,
        userData,
        addOns: [{ addOnType: 'AutoSnapshot', autoSnapshotAddOnRequest: { snapshotTimeOfDay: '01:00' } }],
        tags: [{ key: 'app', value: name }],
      }), 'CreateInstances');
      for (let i = 0; i < 90; i++) {
        ({ instance } = await ls(aws, 'GetInstance', { instanceName: conf.instanceName }));
        if (instance.state && instance.state.name === 'running') break;
        await sleep(5000);
      }
      log('Állandó IP hozzárendelése és tűzfal beállítása (80, 443; SSH csak a Lightsail konzolból)...');
      await waitOps(aws, await ls(aws, 'AttachStaticIp', { staticIpName: conf.staticIpName, instanceName: conf.instanceName }), 'AttachStaticIp');
      await waitOps(aws, await ls(aws, 'PutInstancePublicPorts', {
        instanceName: conf.instanceName,
        portInfos: [
          { fromPort: 80, toPort: 80, protocol: 'tcp' },
          { fromPort: 443, toPort: 443, protocol: 'tcp' },
          { fromPort: 22, toPort: 22, protocol: 'tcp', cidrListAliases: ['lightsail-connect'] },
        ],
      }), 'PutInstancePublicPorts');
      await writeConfig(conf);

      log('Várakozás, amíg a szerver feltelepíti magát (5-10 perc)...');
      try {
        await waitForVersion(bucket, bundle.version, { minutes: 20 });
      } catch (err) {
        const initLog = await bucket.get('status/init.log').then((o) => (o ? o.text() : ''), () => '');
        if (initLog) log(`A szerver telepítési naplójának vége:\n${initLog.split('\n').slice(-40).join('\n')}`);
        throw err;
      }
    } finally {
      await bucket.cleanup();
    }
  } else {
    log(`A szerver már létezik (${conf.instanceName}, ${conf.ip}). Új verzió: node deploy/aws/release.mjs`);
  }
  await writeConfig(conf);

  const host = conf.hostnames[0];
  log('');
  log(`Kész. Cím: https://${host}`);
  log(`HTTPS ellenőrzés innen: ${await checkHttps(host)}`);
  if (setupToken) log(`Első belépés: a telepítési kód (csak az első adminisztrátor létrehozásáig érvényes): ${setupToken}`);
}

main().catch((err) => {
  console.error(`HIBA: ${err.message}`);
  process.exit(1);
});
