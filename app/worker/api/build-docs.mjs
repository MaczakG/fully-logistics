#!/usr/bin/env node
// Bundles docs/partner-api.md into worker/api/docs-content.js, which GET /api/v1/docs renders.
// The Worker cannot import .md files without a wrangler rule, so the Markdown is embedded as a JS
// string. Run after editing the documentation (test/api-docs.test.mjs fails while they differ):
//
//   node worker/api/build-docs.mjs

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const source = join(here, '..', '..', 'docs', 'partner-api.md');
const target = join(here, 'docs-content.js');

const md = readFileSync(source, 'utf8');
writeFileSync(target, `// Generated from docs/partner-api.md by worker/api/build-docs.mjs. Do not edit by hand.\nexport default ${JSON.stringify(md)};\n`);
console.log(`worker/api/docs-content.js: ${md.length} characters from docs/partner-api.md`);
