#!/usr/bin/env node
/**
 * Fully Logistics static site builder. Zero dependencies (Node 18+).
 *
 *   node build.mjs
 *
 * Reads templates from src/ and writes the finished site to dist/: the generated HTML pages plus a
 * verbatim copy of assets/ and robots.txt. dist/ is the only folder that gets deployed (see
 * wrangler.jsonc), so source files, docs and .git can never end up on the web server. It is rebuilt
 * from scratch on every run and is not committed. Also lints the output:
 *   - every local href / src / srcset target must exist inside dist/
 *   - no unresolved {{macros}}
 *   - no em dash or en dash characters anywhere in the markup (house style)
 *   - no deployed file over the 25 MiB Cloudflare limit, and no hidden files in dist/
 *
 * Template syntax (see src/pages/*.html):
 *   {{> partial}}                        include src/partials/partial.html
 *   {{icon:name}} {{icon:name:cls}}      inline Phosphor icon from src/icons/name.svg
 *   {{img name="x" alt="..." sizes="..." class="..." [priority]}}
 *                                        responsive <img> from src/images.json
 *   {{faq_items}} {{faq_jsonld}}         FAQ markup and schema.org data from src/data/faq.json
 *   {{nav:key}}                          aria-current="page" when the page's nav key matches
 *   {{navgroup:key}}                     data-current="true" when the page's nav group matches
 *   {{some.path}}                        value from the page context (front matter + site.json)
 */
import { readFileSync, writeFileSync, readdirSync, statSync, existsSync, mkdirSync, rmSync, copyFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SRC = join(ROOT, 'src');
const OUT = join(ROOT, 'dist');
// Files and folders copied verbatim into dist/ (paths relative to the project root).
const STATIC = ['assets', 'robots.txt'];
const read = (p) => readFileSync(p, 'utf8');
const json = (p) => JSON.parse(read(p));

const site = json(join(SRC, 'data', 'site.json'));
const faq = json(join(SRC, 'data', 'faq.json'));
const images = json(join(SRC, 'images.json'));
const layout = read(join(SRC, 'layout.html'));

const partials = Object.fromEntries(
  readdirSync(join(SRC, 'partials'))
    .filter((f) => f.endsWith('.html'))
    .map((f) => [f.replace(/\.html$/, ''), read(join(SRC, 'partials', f))]),
);

const icons = Object.fromEntries(
  readdirSync(join(SRC, 'icons'))
    .filter((f) => f.endsWith('.svg'))
    .map((f) => [f.replace(/\.svg$/, ''), read(join(SRC, 'icons', f)).replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, '')]),
);

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const warnings = [];
const warn = (msg) => warnings.push(msg);

// ---------------------------------------------------------------- macros

function iconSvg(name, extra = '') {
  const inner = icons[name];
  if (inner === undefined) {
    warn(`unknown icon "${name}"`);
    return '';
  }
  const cls = ['icon', extra].filter(Boolean).join(' ');
  return `<svg class="${cls}" viewBox="0 0 256 256" fill="currentColor" aria-hidden="true" focusable="false">${inner}</svg>`;
}

function parseAttrs(str) {
  const attrs = {};
  for (const m of str.matchAll(/(\w[\w-]*)="([^"]*)"|(\w[\w-]*)/g)) {
    if (m[1]) attrs[m[1]] = m[2];
    else attrs[m[3]] = true;
  }
  return attrs;
}

function imgTag(attrStr, ctx) {
  const a = parseAttrs(attrStr);
  const meta = images[a.name];
  if (!meta) {
    warn(`unknown image "${a.name}" on ${ctx.path}`);
    return '';
  }
  const variants = meta.variants;
  const largest = variants[variants.length - 1];
  const mid = variants.find((v) => v.w >= 1000) || largest;
  const file = (v) => `${ctx.root}assets/img/${a.name}-${v.w}.webp`;
  const srcset = variants.map((v) => `${file(v)} ${v.w}w`).join(', ');
  if (!a.alt && a.alt !== '') warn(`image "${a.name}" on ${ctx.path} has no alt attribute`);
  const parts = [
    a.class ? `class="${esc(a.class)}"` : '',
    `src="${file(mid)}"`,
    `srcset="${srcset}"`,
    `sizes="${esc(a.sizes || '100vw')}"`,
    `width="${largest.w}"`,
    `height="${largest.h}"`,
    `alt="${esc(a.alt ?? '')}"`,
    a.priority ? 'fetchpriority="high"' : 'loading="lazy"',
    'decoding="async"',
  ].filter(Boolean);
  return `<img ${parts.join(' ')}>`;
}

function faqItems() {
  return faq
    .map(
      (item, i) => `<details class="acc" name="faq"${i === 0 ? ' open' : ''}>
  <summary class="acc__q"><span>${esc(item.q)}</span><span class="acc__icon" aria-hidden="true">${iconSvg('plus')}</span></summary>
  <div class="acc__a"><p>${esc(item.a)}</p></div>
</details>`,
    )
    .join('\n');
}

function faqJsonLd() {
  const data = {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faq.map((item) => ({
      '@type': 'Question',
      name: item.q,
      acceptedAnswer: { '@type': 'Answer', text: item.a },
    })),
  };
  return `<script type="application/ld+json">${JSON.stringify(data)}</script>`;
}

function seoTags(ctx) {
  const tags = [
    `<meta property="og:type" content="website">`,
    `<meta property="og:site_name" content="${esc(site.name)}">`,
    `<meta property="og:title" content="${esc(ctx.title)}">`,
    `<meta property="og:description" content="${esc(ctx.description)}">`,
    `<meta name="twitter:card" content="summary_large_image">`,
  ];
  if (site.url) {
    const base = site.url.replace(/\/$/, '');
    tags.push(`<link rel="canonical" href="${base}/${ctx.path === 'index.html' ? '' : ctx.path}">`);
    tags.push(`<meta property="og:url" content="${base}/${ctx.path === 'index.html' ? '' : ctx.path}">`);
    tags.push(`<meta property="og:image" content="${base}/assets/img/og.jpg">`);
  }
  return tags.join('\n  ');
}

function preloadTag(ctx) {
  if (!ctx.preload) return '';
  const meta = images[ctx.preload.name];
  if (!meta) return '';
  const srcset = meta.variants.map((v) => `${ctx.root}assets/img/${ctx.preload.name}-${v.w}.webp ${v.w}w`).join(', ');
  const mid = meta.variants.find((v) => v.w >= 1000) || meta.variants[meta.variants.length - 1];
  return `<link rel="preload" as="image" href="${ctx.root}assets/img/${ctx.preload.name}-${mid.w}.webp" imagesrcset="${srcset}" imagesizes="${esc(ctx.preload.sizes || '100vw')}" fetchpriority="high">`;
}

// ---------------------------------------------------------------- expansion

function lookup(ctx, path) {
  return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
}

function expand(html, ctx) {
  // 1. partials (recursive)
  for (let depth = 0; depth < 6 && /\{\{>\s*[\w-]+\s*\}\}/.test(html); depth++) {
    html = html.replace(/\{\{>\s*([\w-]+)\s*\}\}/g, (_, name) => {
      if (!(name in partials)) {
        warn(`unknown partial "${name}"`);
        return '';
      }
      return partials[name];
    });
  }
  // 2. macros
  html = html
    .replace(/\{\{icon:([\w-]+)(?::([\w -]+))?\}\}/g, (_, name, extra) => iconSvg(name, extra))
    .replace(/\{\{img\s+([^}]*)\}\}/g, (_, attrs) => imgTag(attrs, ctx))
    .replace(/\{\{faq_items\}\}/g, faqItems)
    .replace(/\{\{faq_jsonld\}\}/g, faqJsonLd)
    .replace(/\{\{navgroup:([\w-]+)\}\}/g, (_, key) => (ctx.navGroup === key ? ' data-current="true"' : ''))
    .replace(/\{\{nav:([\w-]+)\}\}/g, (_, key) => (ctx.nav === key ? ' aria-current="page"' : ''));
  // 3. variables
  html = html.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, path) => {
    const value = lookup(ctx, path);
    if (value === undefined) {
      warn(`missing variable "${path}" on ${ctx.path}`);
      return '';
    }
    return value;
  });
  return html;
}

// ---------------------------------------------------------------- pages

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : full.endsWith('.html') ? [full] : [];
  });
}

// Start from an empty dist/ so removed images or pages never linger, then copy the static files.
function copyTree(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}
rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
for (const item of STATIC) copyTree(join(ROOT, item), join(OUT, item));

const built = [];
for (const file of walk(join(SRC, 'pages'))) {
  const rel = relative(join(SRC, 'pages'), file).split('\\').join('/');
  const raw = read(file);
  const fm = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!fm) throw new Error(`${rel}: missing front matter`);
  const front = JSON.parse(fm[1]);
  const depth = rel.split('/').length - 1;
  const ctx = {
    site,
    ...front,
    cta: { ...site.cta, ...(front.cta || {}) },
    path: rel,
    root: '../'.repeat(depth),
  };
  // Preload the LCP image: the first {{img}} marked `priority`. Its `sizes` are reused verbatim
  // so the browser fetches exactly one candidate file instead of two.
  ctx.preload = null;
  for (const m of fm[2].matchAll(/\{\{img\s+([^}]*)\}\}/g)) {
    const a = parseAttrs(m[1]);
    if (a.priority) {
      ctx.preload = { name: a.name, sizes: a.sizes || '100vw' };
      break;
    }
  }
  ctx.seo = seoTags(ctx);
  ctx.preloadTag = preloadTag(ctx);
  const composed = layout.replace('{{content}}', fm[2]);
  const out = expand(composed, ctx).replace(/\n{3,}/g, '\n\n').trim() + '\n';
  const dest = join(OUT, rel);
  mkdirSync(dirname(dest), { recursive: true });
  writeFileSync(dest, out);
  built.push({ rel, dest, out });
}

// ---------------------------------------------------------------- lint

const DASHES = /[\u2013\u2014]|&mdash;|&ndash;|&#8212;|&#8211;/;
for (const { rel, dest, out } of built) {
  const withoutJsonLd = out.replace(/<script type="application\/ld\+json">[\s\S]*?<\/script>/g, '');
  if (/\{\{/.test(withoutJsonLd)) warn(`${rel}: unresolved template syntax`);
  out.split('\n').forEach((line, i) => {
    if (DASHES.test(line)) warn(`${rel}:${i + 1}: em/en dash found: ${line.trim().slice(0, 80)}`);
  });
  const refs = [];
  for (const m of out.matchAll(/\b(?:href|src)="([^"]+)"/g)) refs.push(m[1]);
  for (const m of out.matchAll(/\b(?:srcset|imagesrcset)="([^"]+)"/g)) {
    m[1].split(',').forEach((c) => refs.push(c.trim().split(/\s+/)[0]));
  }
  for (const ref of refs) {
    if (/^(https?:|mailto:|tel:|#|data:)/.test(ref) || ref === '') continue;
    const target = join(dirname(dest), ref.split('#')[0].split('?')[0]);
    if (!existsSync(target)) warn(`${rel}: broken reference ${ref}`);
  }
  const ids = [...out.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]);
  const dup = ids.filter((id, i) => ids.indexOf(id) !== i);
  if (dup.length) warn(`${rel}: duplicate id(s) ${[...new Set(dup)].join(', ')}`);
  for (const m of out.matchAll(/href="#([^"]+)"/g)) {
    if (!ids.includes(m[1])) warn(`${rel}: in-page link #${m[1]} has no target`);
  }
}

// Deployment guardrails (Cloudflare Workers assets: 25 MiB per file, 20,000 files on the free plan).
const MAX_BYTES = 25 * 1024 * 1024;
let fileCount = 0;
let totalBytes = 0;
(function inspect(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    const rel = relative(OUT, full).split('\\').join('/');
    if (name.startsWith('.')) warn(`dist/${rel}: hidden file or folder would be published`);
    const st = statSync(full);
    if (st.isDirectory()) {
      inspect(full);
      continue;
    }
    fileCount++;
    totalBytes += st.size;
    if (st.size > MAX_BYTES) warn(`dist/${rel}: ${(st.size / 1048576).toFixed(1)} MiB exceeds the 25 MiB asset limit`);
  }
})(OUT);
if (fileCount > 20000) warn(`dist/ has ${fileCount} files, over the 20,000 file limit`);

console.log(`Built ${built.length} pages: ${built.map((b) => b.rel).join(', ')}`);
console.log(`dist/ holds ${fileCount} files, ${(totalBytes / 1048576).toFixed(1)} MB in total.`);
if (warnings.length) {
  console.error(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.error(`  - ${w}`);
  process.exitCode = 1;
} else {
  console.log('Lint clean.');
}
