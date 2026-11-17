// GET /api/v1/docs: the partner API documentation as a standalone HTML page, rendered from
// docs/partner-api.md (bundled as docs-content.js, see build-docs.mjs) with a small Markdown
// renderer: headings, paragraphs, fenced code, tables, lists, block quotes, inline code, bold and
// links. Everything is escaped; only http(s), mailto and in-page links become anchors.

import markdown from './docs-content.js';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

export function slug(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/`/g, '').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'szakasz';
}

function inline(text) {
  // Inline code is taken out first (placeholders), so nothing inside it is formatted.
  const codes = [];
  const s = esc(String(text).replace(/`([^`]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0000${codes.length - 1}\u0000`;
  }))
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (m, label, href) => {
      const h = href.replace(/&amp;/g, '&');
      if (!/^(https?:\/\/|mailto:|#)/i.test(h)) return label;
      return `<a href="${esc(h)}"${/^https?:/i.test(h) ? ' rel="noopener"' : ''}>${label}</a>`;
    });
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[Number(i)])}</code>`);
}

const cells = (line) => line.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

// Markdown -> { html, toc: [{ id, text }] } (toc: the level 2 headings).
export function renderMarkdown(md) {
  const lines = String(md).replace(/\r\n/g, '\n').split('\n');
  const html = [];
  const toc = [];
  const used = new Set();
  let para = [];
  const flush = () => {
    if (para.length) html.push(`<p>${inline(para.join(' '))}</p>`);
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = line.match(/^```\s*([\w-]*)\s*$/);
    if (fence) {
      flush();
      const code = [];
      for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) code.push(lines[i]);
      html.push(`<pre><code${fence[1] ? ` class="lang-${esc(fence[1])}"` : ''}>${esc(code.join('\n'))}</code></pre>`);
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.+?)\s*#*\s*$/);
    if (h) {
      flush();
      const level = h[1].length;
      let id = slug(h[2]);
      for (let n = 2; used.has(id); n++) id = `${slug(h[2])}-${n}`;
      used.add(id);
      if (level === 2) toc.push({ id, text: h[2].replace(/`/g, '') });
      html.push(`<h${level} id="${id}">${inline(h[2])}${level > 1 ? ` <a class="anchor" href="#${id}" aria-label="Hivatkozás erre a részre">#</a>` : ''}</h${level}>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{3,}/.test(lines[i + 1])) {
      flush();
      const head = cells(line);
      const rows = [];
      for (i += 2; i < lines.length && /^\|.*\|\s*$/.test(lines[i]); i++) rows.push(cells(lines[i]));
      i--;
      html.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    const li = line.match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
    if (li) {
      flush();
      const ordered = /\d/.test(li[2]);
      const items = [];
      for (; i < lines.length; i++) {
        const m = lines[i].match(/^(\s*)([-*]|\d+\.)\s+(.*)$/);
        if (m) items.push(m[3]);
        else if (/^\s{2,}\S/.test(lines[i]) && items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
      }
      i--;
      const tag = ordered ? 'ol' : 'ul';
      html.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join('')}</${tag}>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flush();
      const quote = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) quote.push(lines[i].replace(/^>\s?/, ''));
      i--;
      html.push(`<blockquote><p>${inline(quote.join(' '))}</p></blockquote>`);
      continue;
    }
    if (!line.trim()) {
      flush();
      continue;
    }
    para.push(line.trim());
  }
  flush();
  return { html: html.join('\n'), toc };
}

const CSS = `
:root{color-scheme:light dark;--bg:#f7f7f5;--fg:#1d1d1b;--muted:#5d5d58;--line:#dcdcd6;--card:#fff;--code:#efefea;--accent:#0b6b5d}
@media (prefers-color-scheme:dark){:root{--bg:#141413;--fg:#ecece8;--muted:#a3a39c;--line:#33332f;--card:#1c1c1a;--code:#262623;--accent:#5cc8b2}}
*{box-sizing:border-box}html{-webkit-text-size-adjust:100%}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,-apple-system,"Segoe UI",Roboto,Arial,sans-serif}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);gap:40px;max-width:1160px;margin:0 auto;padding:32px 24px 80px}
nav{position:sticky;top:24px;align-self:start;font-size:14px}nav p{margin:0 0 8px;color:var(--muted);font-weight:600}
nav ol{list-style:none;margin:0;padding:0}nav a{display:block;padding:4px 0;color:var(--muted);text-decoration:none}nav a:hover{color:var(--accent)}
main{min-width:0}h1{font-size:32px;line-height:1.2;margin:0 0 8px}h2{font-size:24px;margin:48px 0 12px;padding-top:16px;border-top:1px solid var(--line)}
h3{font-size:19px;margin:32px 0 8px}h4{font-size:16px;margin:24px 0 8px}
.anchor{color:var(--line);text-decoration:none;font-weight:400}h2:hover .anchor,h3:hover .anchor{color:var(--muted)}
a{color:var(--accent)}p,ul,ol{margin:0 0 14px}li{margin:4px 0}
code{font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;background:var(--code);padding:1px 5px;border-radius:4px}
pre{background:var(--card);border:1px solid var(--line);border-radius:8px;padding:14px 16px;overflow-x:auto;margin:0 0 16px}pre code{background:none;padding:0;font-size:13.5px}
.table{overflow-x:auto;margin:0 0 16px;border:1px solid var(--line);border-radius:8px;background:var(--card)}
table{border-collapse:collapse;width:100%;font-size:14.5px}th,td{text-align:left;vertical-align:top;padding:8px 12px;border-bottom:1px solid var(--line)}
tr:last-child td{border-bottom:0}th{font-weight:600;background:var(--code)}
blockquote{margin:0 0 16px;padding:10px 16px;border-left:3px solid var(--accent);background:var(--card);border-radius:0 8px 8px 0}blockquote p{margin:0}
@media (max-width:860px){.wrap{grid-template-columns:1fr;gap:16px;padding:20px 16px 60px}nav{position:static}nav ol{columns:2}}
`;

export function docsPage() {
  const { html, toc } = renderMarkdown(markdown);
  const page = `<!doctype html>
<html lang="hu">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Fully Logistics partner API</title>
<meta name="description" content="A Fully Logistics WMS partner REST API dokumentációja fejlesztőknek.">
<style>${CSS}</style>
</head>
<body>
<div class="wrap">
<nav aria-label="Tartalom"><p>Tartalom</p><ol>${toc.map((t) => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ol></nav>
<main>
${html}
</main>
</div>
</body>
</html>`;
  return new Response(page, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'public, max-age=300',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; img-src data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
    },
  });
}

export function docsMarkdown() {
  return new Response(markdown, {
    headers: { 'content-type': 'text/markdown; charset=utf-8', 'cache-control': 'public, max-age=300', 'x-content-type-options': 'nosniff' },
  });
}
