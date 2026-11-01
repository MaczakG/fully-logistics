// The Lightsail launch script must survive /bin/sh (Lightsail runs it inside its own sh script):
// the wrapper is valid POSIX sh and writes the bash setup script byte for byte, with nothing expanded.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { HERE, launchScript } from '../deploy/aws/lib.mjs';

const values = {
  BUCKET: 'fully-app-abc123', REGION: 'eu-central-1', S3_KEY_ID: 'AKIAEXAMPLE123', S3_SECRET: 'ab/cd+ef=gh',
  SETUP_TOKEN: 'Tok_en-1', BOOTSTRAP_URL: 'https://b.s3.eu-central-1.amazonaws.com/releases/x.tar.gz?X-Amz-Signature=1&a=b',
  LOG_URL: 'https://b.s3.eu-central-1.amazonaws.com/status/init.log?X-Amz-Signature=2', BOOTSTRAP_SHA256: 'a'.repeat(64),
};

test('the plain setup script is bash only, which is why it is wrapped', () => {
  const r = spawnSync('dash', ['-n', join(HERE, 'cloud-init.sh')], { encoding: 'utf8' });
  assert.notEqual(r.status, 0);
});

test('the wrapper is valid sh and writes the filled-in bash script unchanged', async () => {
  const script = await launchScript(values);
  assert.equal(script.split('\n')[0], '#!/bin/sh');
  const dir = mkdtempSync(join(tmpdir(), 'fl-launch-'));
  try {
    const file = join(dir, 'launch.sh');
    writeFileSync(file, script);
    assert.equal(spawnSync('dash', ['-n', file]).status, 0);
    // Run the wrapper for real under dash, writing into the temp folder instead of /root, without bash.
    writeFileSync(file, script.replaceAll('/root/', `${dir}/`).replace(`bash ${dir}/fully-app-init.sh`, 'true'));
    const r = spawnSync('dash', [file], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    const inner = readFileSync(join(dir, 'fully-app-init.sh'), 'utf8');
    let expected = readFileSync(join(HERE, 'cloud-init.sh'), 'utf8');
    for (const [k, v] of Object.entries(values)) expected = expected.split(`__${k}__`).join(v);
    assert.equal(inner, `${expected.replace(/\n$/, '')}\n`.replaceAll('/root/', `${dir}/`));
    assert.match(inner, /ENCRYPTION_KEY=\$\(openssl rand -base64 32\)/, 'command substitutions stay for bash');
    assert.equal(spawnSync('bash', ['-n', join(dir, 'fully-app-init.sh')]).status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('unexpected values are refused before anything reaches the server', async () => {
  await assert.rejects(launchScript({ ...values, SETUP_TOKEN: "x'; rm -rf /" }), /SETUP_TOKEN/);
  await assert.rejects(launchScript({ ...values, BOOTSTRAP_URL: "https://x/'y" }), /BOOTSTRAP_URL/);
});
