// Minimal XML reader and writer for the UNAS API (the Workers runtime has no DOMParser).
// Handles the XML declaration, comments, CDATA, entities and self-closing tags. Attributes are
// read but UNAS does not use them. Not a validating parser: malformed input throws.

const ENTITIES = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };

const decode = (s) => s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
  if (e[0] === '#') {
    const code = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) ? String.fromCodePoint(code) : m;
  }
  return ENTITIES[e.toLowerCase()] ?? m;
});

class Node {
  constructor(name, attrs = {}) {
    this.name = name;
    this.attrs = attrs;
    this.children = [];
    this.content = '';
  }

  // First child element with the name, or a path "Customer/Contact/Name".
  get(path) {
    let node = this;
    for (const part of String(path).split('/')) {
      node = node && node.children.find((c) => c.name === part);
      if (!node) return null;
    }
    return node;
  }

  // Every child element with the name (one level).
  all(name) {
    return this.children.filter((c) => c.name === name);
  }

  // Trimmed text of the element at path ('' if missing).
  text(path) {
    const node = path ? this.get(path) : this;
    return node ? node.content.trim() : '';
  }
}

export function parseXml(input) {
  const src = String(input || '').replace(/^﻿/, '');
  const root = new Node('#document');
  const stack = [root];
  let i = 0;
  while (i < src.length) {
    const lt = src.indexOf('<', i);
    if (lt === -1) {
      stack[stack.length - 1].content += decode(src.slice(i));
      break;
    }
    if (lt > i) stack[stack.length - 1].content += decode(src.slice(i, lt));
    if (src.startsWith('<![CDATA[', lt)) {
      const end = src.indexOf(']]>', lt);
      if (end === -1) throw new Error('Lezáratlan CDATA szakasz az XML-ben.');
      stack[stack.length - 1].content += src.slice(lt + 9, end);
      i = end + 3;
    } else if (src.startsWith('<!--', lt)) {
      const end = src.indexOf('-->', lt);
      i = end === -1 ? src.length : end + 3;
    } else if (src.startsWith('<?', lt) || src.startsWith('<!', lt)) {
      const end = src.indexOf('>', lt);
      i = end === -1 ? src.length : end + 1;
    } else if (src[lt + 1] === '/') {
      const end = src.indexOf('>', lt);
      if (end === -1) throw new Error('Hibás XML: lezáratlan elem.');
      const name = src.slice(lt + 2, end).trim();
      const open = stack.pop();
      if (!open || open.name !== name || stack.length === 0) throw new Error(`Hibás XML: váratlan </${name}> elem.`);
      i = end + 1;
    } else {
      const end = src.indexOf('>', lt);
      if (end === -1) throw new Error('Hibás XML: lezáratlan elem.');
      let body = src.slice(lt + 1, end);
      const selfClosing = body.endsWith('/');
      if (selfClosing) body = body.slice(0, -1);
      const m = body.trim().match(/^([^\s/>]+)([\s\S]*)$/);
      if (!m) throw new Error('Hibás XML: üres elemnév.');
      const attrs = {};
      for (const a of m[2].matchAll(/([^\s=]+)\s*=\s*("([^"]*)"|'([^']*)')/g)) attrs[a[1]] = decode(a[3] ?? a[4] ?? '');
      const node = new Node(m[1], attrs);
      stack[stack.length - 1].children.push(node);
      if (!selfClosing) stack.push(node);
      i = end + 1;
    }
  }
  if (stack.length !== 1) throw new Error('Hibás XML: lezáratlan elemek.');
  const top = root.children[0];
  if (!top) throw new Error('Üres XML válasz.');
  return top;
}

const escape = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// buildXml('Params', { ApiKey: 'x', Items: [{ Item: {...} }] }) with the XML declaration.
// Values: string/number (text), object (child elements), array (repeated elements of that name).
export function buildXml(rootName, value) {
  return `<?xml version="1.0" encoding="UTF-8" ?>\n${element(rootName, value)}`;
}

function element(name, value) {
  if (Array.isArray(value)) return value.map((v) => element(name, v)).join('');
  if (value && typeof value === 'object') {
    const inner = Object.entries(value).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => element(k, v)).join('');
    return `<${name}>${inner}</${name}>`;
  }
  return `<${name}>${escape(value ?? '')}</${name}>`;
}
