// SigV4 against the worked example in the AWS documentation ("Create a signed AWS API request",
// IAM ListUsers, 2015-08-30), plus S3 key encoding.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encodeKey, presignS3Get, signRequest, signingKey } from '../server/sigv4.mjs';

const credentials = { accessKeyId: 'AKIDEXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY' };

test('signing key of the documented example', () => {
  assert.equal(signingKey(credentials.secretAccessKey, '20150830', 'us-east-1', 'iam').toString('hex'),
    'c4afb1cc5771d871763a393e44b703571b55cc28424d1a5e86da6ed3c154a4b9');
});

test('signature of the documented ListUsers request', () => {
  const r = signRequest({
    method: 'GET',
    url: 'https://iam.amazonaws.com/?Action=ListUsers&Version=2010-05-08',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=utf-8' },
    service: 'iam',
    region: 'us-east-1',
    credentials,
    now: new Date('2015-08-30T12:36:00Z'),
  });
  assert.equal(r.signature, '5d672d79c15b13162d9279b0855cfba6789a8edb4c82c400e06b5924a6f2b5d7');
  assert.match(r.headers.authorization, /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/20150830\/us-east-1\/iam\/aws4_request, SignedHeaders=content-type;host;x-amz-date, Signature=/);
});

test('S3 keys keep their slashes and encode the rest', () => {
  assert.equal(encodeKey('files/contract/2026-10/a b+c(1).pdf'), 'files/contract/2026-10/a%20b%2Bc%281%29.pdf');
});

test('presigned S3 URL of the documented example', () => {
  const url = presignS3Get({
    bucket: 'examplebucket', region: 'us-east-1', key: 'test.txt', expiresIn: 86400, now: new Date('2013-05-24T00:00:00Z'),
    endpoint: 'https://examplebucket.s3.amazonaws.com',
    credentials: { accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' },
  });
  assert.equal(url, 'https://examplebucket.s3.amazonaws.com/test.txt?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request&X-Amz-Date=20130524T000000Z&X-Amz-Expires=86400&X-Amz-SignedHeaders=host&X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404');
});
