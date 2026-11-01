// Request validation. Describe the expected fields once, get clean values or a 400 with
// per-field Hungarian messages the form can show next to the inputs.
//
//   const data = validate(body, {
//     name: { type: 'str', required: true, max: 200 },
//     qty: { type: 'int', min: 1 },
//     date: { type: 'date' },
//     status: { type: 'enum', values: ['active', 'inactive'] },
//   });
//
// Types: str, text (multi-line), int, num, bool, date (YYYY-MM-DD), time (HH:MM), email, enum, id, json.
// Options: required, min, max, default, values (enum), nullable (allow null for optional values).
// Fields missing from the body are left out of the result unless they have a default, so the same
// spec works for create (required) and partial update (PATCH).

import { badRequest } from './http.js';
import { isDate, isTime } from './time.js';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function validate(body, spec, { partial = false } = {}) {
  const out = {};
  const errors = {};
  for (const [key, rule] of Object.entries(spec)) {
    let v = body ? body[key] : undefined;
    if (v === undefined) {
      if (rule.default !== undefined && !partial) out[key] = rule.default;
      else if (rule.required && !partial) errors[key] = 'Kötelező mező.';
      continue;
    }
    if (v === null || (typeof v === 'string' && v.trim() === '' && !['str', 'text'].includes(rule.type))) {
      if (rule.required) errors[key] = 'Kötelező mező.';
      else if (rule.nullable || ['date', 'int', 'num', 'id'].includes(rule.type)) out[key] = null;
      else if (rule.default !== undefined) out[key] = rule.default;
      continue;
    }
    try {
      v = coerce(v, rule);
    } catch (e) {
      errors[key] = e.message;
      continue;
    }
    if (rule.required && v === '') {
      errors[key] = 'Kötelező mező.';
      continue;
    }
    out[key] = v;
  }
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt mezőket.', errors);
  return out;
}

function coerce(v, rule) {
  switch (rule.type) {
    case 'str':
    case 'text': {
      if (typeof v !== 'string' && typeof v !== 'number') throw new Error('Szöveget várunk.');
      const s = rule.type === 'str' ? String(v).trim() : String(v).replace(/\r\n/g, '\n');
      const max = rule.max ?? (rule.type === 'str' ? 300 : 10000);
      if (s.length > max) throw new Error(`Legfeljebb ${max} karakter lehet.`);
      if (rule.min && s.length < rule.min) throw new Error(`Legalább ${rule.min} karakter kell.`);
      return s;
    }
    case 'int':
    case 'id': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
      if (typeof n !== 'number' || !Number.isInteger(n)) throw new Error('Egész számot várunk.');
      const min = rule.type === 'id' ? 1 : rule.min;
      if (min !== undefined && n < min) throw new Error(`Legalább ${min} legyen.`);
      if (rule.max !== undefined && n > rule.max) throw new Error(`Legfeljebb ${rule.max} lehet.`);
      return n;
    }
    case 'num': {
      const n = typeof v === 'string' && v.trim() !== '' ? Number(v.replace(',', '.')) : v;
      if (typeof n !== 'number' || !Number.isFinite(n)) throw new Error('Számot várunk.');
      if (rule.min !== undefined && n < rule.min) throw new Error(`Legalább ${rule.min} legyen.`);
      if (rule.max !== undefined && n > rule.max) throw new Error(`Legfeljebb ${rule.max} lehet.`);
      return n;
    }
    case 'bool':
      if (typeof v === 'boolean') return v;
      if (v === 1 || v === '1' || v === 'true') return true;
      if (v === 0 || v === '0' || v === 'false') return false;
      throw new Error('Igen/nem értéket várunk.');
    case 'date':
      if (v === '' && !rule.required) return null;
      if (!isDate(v)) throw new Error('Dátumot várunk (ÉÉÉÉ-HH-NN).');
      return v;
    case 'time':
      if (v === '' && !rule.required) return '';
      if (!isTime(v)) throw new Error('Időpontot várunk (ÓÓ:PP).');
      return v;
    case 'email': {
      const s = String(v).trim();
      if (s === '' && !rule.required) return '';
      if (!EMAIL.test(s) || s.length > 254) throw new Error('Érvényes e-mail címet adj meg.');
      return s.toLowerCase();
    }
    case 'enum':
      if (!rule.values.includes(v)) throw new Error('Érvénytelen érték.');
      return v;
    case 'json':
      return v;
    default:
      throw new Error(`unknown rule type ${rule.type}`);
  }
}

// Validates an array of objects (order lines, inbound lines ...). Errors are keyed "lines.2.qty".
export function validateList(list, spec, { key = 'lines', min = 1, max = 1000 } = {}) {
  if (!Array.isArray(list)) throw badRequest('Ellenőrizd a megjelölt mezőket.', { [key]: 'Listát várunk.' });
  if (list.length < min) throw badRequest('Ellenőrizd a megjelölt mezőket.', { [key]: `Legalább ${min} tétel kell.` });
  if (list.length > max) throw badRequest('Ellenőrizd a megjelölt mezőket.', { [key]: `Legfeljebb ${max} tétel lehet.` });
  const errors = {};
  const out = list.map((item, i) => {
    try {
      return validate(item, spec);
    } catch (e) {
      for (const [f, msg] of Object.entries(e.fields || {})) errors[`${key}.${i}.${f}`] = msg;
      return null;
    }
  });
  if (Object.keys(errors).length) throw badRequest('Ellenőrizd a megjelölt tételeket.', errors);
  return out;
}
