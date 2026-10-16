#!/usr/bin/env node
/**
 * Builds the single page app into app/dist/ (deployed as static assets of the fully-app Worker).
 *
 *   node build.mjs
 *
 * - copies public/ as it is
 * - copies the site's self-hosted fonts and favicon (../assets) so the app looks like fully.hu
 * - inlines an SVG sprite of every icon (../src/icons and icons/) into index.html at <!-- ICONS -->;
 *   scripts use them as <svg><use href="#i-name"></svg> through FL.icon("name")
 * - lints: every FL.icon("...") and {{icon:...}} reference exists, no em or en dashes in shipped
 *   text (house style), no file over 25 MiB
 */
import { readFileSync, writeFileSync, readdirSync, statSync, mkdirSync, rmSync, copyFileSync, existsSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = dirname(fileURLToPath(import.meta.url));
const SITE = join(ROOT, '..');
const OUT = join(ROOT, 'dist');
const warnings = [];

function copyTree(from, to) {
  if (statSync(from).isDirectory()) {
    mkdirSync(to, { recursive: true });
    for (const name of readdirSync(from)) copyTree(join(from, name), join(to, name));
  } else {
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to);
  }
}

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
}

rmSync(OUT, { recursive: true, force: true });
copyTree(join(ROOT, 'public'), OUT);
copyTree(join(SITE, 'assets', 'fonts'), join(OUT, 'assets', 'fonts'));
copyFileSync(join(SITE, 'assets', 'favicon.svg'), join(OUT, 'favicon.svg'));

// ---------------------------------------------------------------- icon sprite
const icons = {};
for (const dir of [join(SITE, 'src', 'icons'), join(ROOT, 'icons')]) {
  for (const f of readdirSync(dir).filter((n) => n.endsWith('.svg'))) {
    icons[f.replace(/\.svg$/, '')] = readFileSync(join(dir, f), 'utf8').replace(/^[\s\S]*?<svg[^>]*>|<\/svg>\s*$/g, '');
  }
}
const sprite = `<svg xmlns="http://www.w3.org/2000/svg" style="display:none" aria-hidden="true">${Object.entries(icons)
  .map(([name, body]) => `<symbol id="i-${name}" viewBox="0 0 256 256">${body}</symbol>`)
  .join('')}</svg>`;
const indexPath = join(OUT, 'index.html');
writeFileSync(indexPath, readFileSync(indexPath, 'utf8').replace('<!-- ICONS -->', sprite));

// ---------------------------------------------------------------- lint
const DASHES = /[\u2013\u2014]|&mdash;|&ndash;/;
for (const file of walk(OUT)) {
  const rel = relative(OUT, file).split('\\').join('/');
  const size = statSync(file).size;
  if (size > 25 * 1024 * 1024) warnings.push(`${rel}: over the 25 MiB asset limit`);
  if (!/\.(html|js|css|json|txt)$/.test(file)) continue;
  const text = readFileSync(file, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (DASHES.test(line)) warnings.push(`${rel}:${i + 1}: em/en dash: ${line.trim().slice(0, 80)}`);
  });
  for (const m of text.matchAll(/(?:FL\.icon|icon)\(\s*'([a-z0-9-]+)'/g)) {
    if (!icons[m[1]]) warnings.push(`${rel}: unknown icon "${m[1]}"`);
  }
}
for (const src of walk(join(ROOT, 'worker'))) {
  const text = readFileSync(src, 'utf8');
  text.split('\n').forEach((line, i) => {
    if (DASHES.test(line)) warnings.push(`${relative(ROOT, src)}:${i + 1}: em/en dash in a message: ${line.trim().slice(0, 80)}`);
  });
}

const files = walk(OUT);
console.log(`app/dist/ holds ${files.length} files, ${Object.keys(icons).length} icons in the sprite.`);
if (warnings.length) {
  console.error(`\n${warnings.length} warning(s):`);
  for (const w of warnings) console.error(`  - ${w}`);
  process.exitCode = 1;
} else {
  console.log('Lint clean.');
}
if (!existsSync(join(OUT, 'index.html'))) process.exitCode = 1;
