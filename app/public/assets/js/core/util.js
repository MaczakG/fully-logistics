/* Fully Logistics WMS: shared helpers. Everything lives on window.FL.
   Plain scripts, no build step: core/util.js, core/api.js, core/ui.js, views/*.js, core/app.js load
   in that order (defer), so views can use everything here at load time. */
window.FL = window.FL || {};
(() => {
  'use strict';
  const FL = window.FL;

  /* ------------------------------------------------------------ HTML
     FL.html`...` escapes every interpolated value, so data never becomes markup by accident.
     Use FL.raw(str) for markup you built yourself; arrays are joined; null, undefined, false
     render as nothing. The result is a Raw object; put it into the page with String(x) or
     el.innerHTML = x. */
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  FL.esc = (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (c) => ESC[c]);

  class Raw {
    constructor(s) { this.s = s; }
    toString() { return this.s; }
  }
  FL.Raw = Raw;
  FL.raw = (s) => (s instanceof Raw ? s : new Raw(String(s == null ? '' : s)));
  const piece = (v) => {
    if (v == null || v === false) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(piece).join('');
    return FL.esc(v);
  };
  FL.html = (strings, ...values) => new Raw(strings.reduce((out, s, i) => out + s + (i < values.length ? piece(values[i]) : ''), ''));

  /* ------------------------------------------------------------ formatting (Hungarian) */
  const TZ = 'Europe/Budapest';
  const nf0 = new Intl.NumberFormat('hu-HU', { maximumFractionDigits: 0 });
  const nf = (d) => new Intl.NumberFormat('hu-HU', { minimumFractionDigits: 0, maximumFractionDigits: d });
  const df = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const dlong = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, year: 'numeric', month: 'long', day: 'numeric' });
  const dtf = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
  const tf = new Intl.DateTimeFormat('hu-HU', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const isoDay = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });

  // "2026-10-16" is a calendar date (no time zone shift); anything else is parsed as an instant.
  const toDate = (v) => {
    if (v == null || v === '') return null;
    if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T12:00:00Z`);
    const d = new Date(v);
    return Number.isNaN(d.getTime()) ? null : d;
  };

  FL.fmt = {
    int: (v) => (v == null || v === '' ? '' : nf0.format(Math.round(Number(v)))),
    num: (v, d = 2) => (v == null || v === '' ? '' : nf(d).format(Number(v))),
    money: (v, d = 0) => (v == null || v === '' ? '' : `${nf(d).format(Number(v))} Ft`),
    pct: (v, d = 1) => (v == null || v === '' ? '' : `${nf(d).format(Number(v))}%`),
    qty: (v, unit = 'db') => (v == null ? '' : `${nf0.format(Number(v))} ${unit}`),
    date: (v) => { const d = toDate(v); return d ? df.format(d) : ''; },
    dateLong: (v) => { const d = toDate(v); return d ? dlong.format(d) : ''; },
    dateTime: (v) => { const d = toDate(v); return d ? dtf.format(d) : ''; },
    time: (v) => { const d = toDate(v); return d ? tf.format(d) : ''; },
    kg: (v) => (v == null || v === '' ? '' : `${nf(2).format(Number(v))} kg`),
  };

  // Today's Budapest date as "YYYY-MM-DD", or the date of an instant.
  FL.today = (d = new Date()) => isoDay.format(d);
  FL.addDays = (date, n) => { const d = new Date(`${date}T12:00:00Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  FL.thisMonth = () => FL.today().slice(0, 7);

  /* ------------------------------------------------------------ misc */
  FL.debounce = (fn, ms = 250) => {
    let t;
    return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
  };

  // { a: 1, b: '', c: null } -> "?a=1" (empty values skipped)
  FL.qs = (params = {}) => {
    const u = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== '' && v != null && v !== false) u.set(k, v);
    const s = u.toString();
    return s ? `?${s}` : '';
  };

  FL.downloadBlob = (blob, filename) => {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  // Group array items by key function.
  FL.groupBy = (list, fn) => list.reduce((m, x) => { const k = fn(x); (m[k] ||= []).push(x); return m; }, {});
})();
