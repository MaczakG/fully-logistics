// A small S3 lookalike for tests: checks every request's SigV4 signature (same algorithm as
// server/sigv4.mjs) and keeps objects in memory. Path-style: http://127.0.0.1:<port>/<key>.
import { createServer } from 'node:http';
import { signRequest } from '../server/sigv4.mjs';

export async function startFakeS3({ credentials, region = 'eu-central-1' }) {
  const objects = new Map();
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks);
      const url = `http://${req.headers.host}${req.url}`;
      const amz = String(req.headers['x-amz-date'] || '');
      const when = new Date(amz.replace(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/, '$1-$2-$3T$4:$5:$6Z'));
      const signed = Number.isNaN(when.getTime()) ? null : signRequest({
        method: req.method, url, body, service: 's3', region, credentials,
        headers: req.headers['content-type'] ? { 'content-type': req.headers['content-type'] } : {},
        now: when,
      });
      if (!signed || signed.headers.authorization !== req.headers.authorization) {
        res.statusCode = 403;
        return res.end('<Error><Code>SignatureDoesNotMatch</Code><Message>bad signature</Message></Error>');
      }
      const u = new URL(url);
      const key = decodeURIComponent(u.pathname.slice(1));
      if (req.method === 'PUT') {
        objects.set(key, { body, type: req.headers['content-type'], at: new Date() });
        res.setHeader('etag', '"e1"');
        return res.end();
      }
      if (req.method === 'GET' && u.searchParams.get('list-type') === '2') {
        const prefix = u.searchParams.get('prefix') || '';
        const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
        const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;');
        return res.end(`<ListBucketResult><IsTruncated>false</IsTruncated>${keys.map((k) => `<Contents><Key>${esc(k)}</Key><Size>${objects.get(k).body.length}</Size><LastModified>${objects.get(k).at.toISOString()}</LastModified></Contents>`).join('')}</ListBucketResult>`);
      }
      const o = objects.get(key);
      if (req.method === 'DELETE') { objects.delete(key); res.statusCode = 204; return res.end(); }
      if (!o) { res.statusCode = 404; return res.end('<Error><Code>NoSuchKey</Code></Error>'); }
      res.setHeader('content-type', o.type || 'application/octet-stream');
      res.setHeader('content-length', o.body.length);
      return res.end(req.method === 'HEAD' ? undefined : o.body);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    objects,
    json: (key) => (objects.has(key) ? JSON.parse(objects.get(key).body.toString('utf8')) : null),
    close: () => new Promise((r) => server.close(r)),
  };
}
