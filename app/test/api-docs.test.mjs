// Partner API documentation: the bundled copy matches docs/partner-api.md, and the Markdown
// renderer behind GET /api/v1/docs escapes everything and renders the constructs the docs use.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import bundled from '../worker/api/docs-content.js';
import { renderMarkdown, slug, docsPage } from '../worker/api/docs.js';

const APP = join(dirname(fileURLToPath(import.meta.url)), '..');
const source = readFileSync(join(APP, 'docs', 'partner-api.md'), 'utf8');

test('the bundled documentation is up to date (run: node worker/api/build-docs.mjs)', () => {
  assert.equal(bundled, source);
});

test('the documentation covers every endpoint and has no en or em dashes', () => {
  for (const path of ['GET /products', 'PUT /products/{sku}', 'GET /stock', 'GET /stock/{sku}', 'POST /orders', 'GET /orders', 'GET /orders/{ref}',
    'POST /orders/{ref}/cancel', 'POST /inbounds', 'GET /inbounds/{ref}']) {
    assert.ok(source.includes(`### ${path}`), path);
  }
  for (const word of ['Authorization: Bearer', 'X-RateLimit-Remaining', 'Retry-After', 'external_id', 'next_cursor', 'curl ']) assert.ok(source.includes(word), word);
  assert.doesNotMatch(source, /[–—]/);
  const { toc } = renderMarkdown(source);
  for (const anchor of source.matchAll(/\]\(#([a-z0-9-]+)\)/g)) assert.ok(toc.some((t) => t.id === anchor[1]), `anchor #${anchor[1]}`);
});

test('markdown renderer: escaping, code, tables, lists, links', () => {
  const { html, toc } = renderMarkdown([
    '# Cím <b>',
    '## Első rész',
    'Szöveg **félkövér** és `kód <x>` és [link](https://example.com/?a=1&b=2) és [rossz](javascript:alert).',
    '',
    '```json',
    '{ "a": "<script>" }',
    '```',
    '',
    '| A | B |',
    '| --- | --- |',
    '| `x` | <i>y</i> |',
    '',
    '- egy',
    '- kettő',
    '',
    '1. első',
    '2. második',
    '',
    '> Megjegyzés',
    '## Első rész',
  ].join('\n'));
  assert.match(html, /<h1 id="cim-b">Cím &lt;b&gt;<\/h1>/);
  assert.match(html, /<strong>félkövér<\/strong>/);
  assert.match(html, /<code>kód &lt;x&gt;<\/code>/);
  assert.match(html, /<a href="https:\/\/example.com\/\?a=1&amp;b=2" rel="noopener">link<\/a>/);
  assert.doesNotMatch(html, /href="javascript/i);
  assert.match(html, /és rossz\./);
  assert.match(html, /<pre><code class="lang-json">\{ &quot;a&quot;: &quot;&lt;script&gt;&quot; \}<\/code><\/pre>/);
  assert.match(html, /<table><thead><tr><th>A<\/th><th>B<\/th><\/tr><\/thead><tbody><tr><td><code>x<\/code><\/td><td>&lt;i&gt;y&lt;\/i&gt;<\/td><\/tr><\/tbody><\/table>/);
  assert.match(html, /<ul><li>egy<\/li><li>kettő<\/li><\/ul>/);
  assert.match(html, /<ol><li>első<\/li><li>második<\/li><\/ol>/);
  assert.match(html, /<blockquote><p>Megjegyzés<\/p><\/blockquote>/);
  assert.deepEqual(toc.map((t) => t.id), ['elso-resz', 'elso-resz-2'], 'repeated headings get unique ids');
  assert.doesNotMatch(html, /<script|<i>/);
  assert.equal(slug('Kéréskorlát'), 'kereskorlat');
});

test('the page is a standalone HTML document with a strict content security policy', async () => {
  const res = docsPage();
  assert.match(res.headers.get('content-type'), /text\/html/);
  assert.match(res.headers.get('content-security-policy'), /default-src 'none'/);
  const page = await res.text();
  assert.match(page, /^<!doctype html>/);
  assert.match(page, /<nav aria-label="Tartalom">/);
  assert.doesNotMatch(page, /<script/);
});
