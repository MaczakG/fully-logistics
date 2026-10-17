// CSV import and export. Hungarian Excel uses ";" as separator and needs a UTF-8 BOM to show
// accented characters correctly, so exports are written that way. Imports accept ";" or ","
// (detected from the header line), quoted fields, CRLF line ends and a leading BOM.

export function parseCsv(text) {
  const src = String(text).replace(/^﻿/, '');
  const firstLine = src.slice(0, src.search(/\r?\n|$/));
  const sep = (firstLine.match(/;/g) || []).length >= (firstLine.match(/,/g) || []).length ? ';' : ',';
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += c;
    } else if (c === '"' && field === '') quoted = true;
    else if (c === sep) {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  const nonEmpty = rows.filter((r) => r.some((f) => f.trim() !== ''));
  if (!nonEmpty.length) return { headers: [], records: [] };
  const headers = nonEmpty[0].map((h) => normalizeHeader(h));
  const records = nonEmpty.slice(1).map((r, i) => {
    const rec = { _line: i + 2 };
    headers.forEach((h, j) => (rec[h] = (r[j] ?? '').trim()));
    return rec;
  });
  return { headers, records };
}

// "Cikkszám " -> "cikkszam", so templates can use simple ASCII keys.
export function normalizeHeader(h) {
  return String(h)
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_|_$/g, '');
}

// columns: [{ key, label }] ; rows: objects. Returns a string with BOM.
export function toCsv(columns, rows) {
  const cell = (v) => {
    const s = v == null ? '' : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [columns.map((c) => cell(c.label)).join(';')];
  for (const r of rows) lines.push(columns.map((c) => cell(typeof c.value === 'function' ? c.value(r) : r[c.key])).join(';'));
  return `﻿${lines.join('\r\n')}\r\n`;
}

// Hungarian decimal comma friendly number parsing for CSV cells. Returns NaN for junk.
export function csvNumber(s) {
  if (s == null || String(s).trim() === '') return NaN;
  return Number(String(s).replace(/\s/g, '').replace(',', '.'));
}
