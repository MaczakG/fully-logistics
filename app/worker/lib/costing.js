// Assumptions of the internal costing in the quote calculator (Ajánlatkészítő > Belső
// fedezetszámítás). Kept in the "costing" setting (Beállítások > Raktár) and copied into every new
// quote, where they can be changed for that quote alone:
//
//   rent           monthly rent of the warehouse (Ft, net)
//   area_m2        rented floor area (m²); rent / area_m2 is the rent of one m²
//   space          floor area one storage location takes, aisles included, per size code (m²);
//                  area_m2 / space is how many of that size fit, space x rent per m² its rent
//   worker_cost    full monthly cost of one warehouse worker (wage and contributions, Ft)
//   worker_hours   productive hours of one worker in a month
//   min_*          minute norms: per order, per further item in an order, per received piece,
//                  per return
//   pack_cost      purchase price of the packaging material per order (Ft)

export const COSTING_DEFAULTS = {
  rent: 0,
  area_m2: 0,
  space: { M: 0.15, L: 0.25, XL: 0.4, PAL: 1.2 },
  worker_cost: 0,
  worker_hours: 150,
  min_order: 3,
  min_item: 0.5,
  min_inbound: 0.3,
  min_return: 5,
  pack_cost: 0,
};

// Upper limits of the numbers (anything above is a typo).
export const COSTING_LIMITS = {
  rent: 1e10, area_m2: 1e6, worker_cost: 1e8, worker_hours: 744,
  min_order: 600, min_item: 600, min_inbound: 600, min_return: 600, pack_cost: 1e6,
};
export const SPACE_MAX = 100;

const toNum = (v) => (typeof v === 'string' ? Number(v.replace(',', '.').replace(/\s/g, '')) : Number(v));

// Lenient: anything that is not a positive number counts as 0 (the calculator's rule), values above
// the limits are cut. Used for the copy inside a quote.
export function looseCosting(input) {
  const c = input && typeof input === 'object' ? input : {};
  const pos = (v, max) => { const x = toNum(v); return Number.isFinite(x) && x > 0 ? Math.min(x, max) : 0; };
  const out = Object.fromEntries(Object.entries(COSTING_LIMITS).map(([k, max]) => [k, pos(c[k], max)]));
  const space = c.space && typeof c.space === 'object' && !Array.isArray(c.space) ? c.space : {};
  out.space = Object.fromEntries(Object.entries(space).slice(0, 50)
    .map(([code, v]) => [String(code).trim().slice(0, 20), pos(v, SPACE_MAX)]).filter(([code]) => code));
  return out;
}

// Strict, for the settings form: field errors for what is not a number from 0 to the limit.
export function checkCosting(input) {
  const c = input && typeof input === 'object' ? input : {};
  const errors = {};
  const out = {};
  const read = (v, max, key) => {
    if (v === undefined || v === null || v === '') return 0;
    const x = toNum(v);
    if (!Number.isFinite(x) || x < 0) { errors[key] = 'Nulla vagy pozitív szám legyen.'; return 0; }
    if (x > max) { errors[key] = `Legfeljebb ${max.toLocaleString('hu-HU')} lehet.`; return 0; }
    return x;
  };
  for (const [k, max] of Object.entries(COSTING_LIMITS)) out[k] = read(c[k], max, k);
  if (out.worker_hours === 0 && !errors.worker_hours) errors.worker_hours = 'Adj meg legalább egy órát.';
  const space = c.space && typeof c.space === 'object' && !Array.isArray(c.space) ? c.space : {};
  out.space = {};
  for (const [code, v] of Object.entries(space).slice(0, 50)) {
    const key = String(code).trim().slice(0, 20);
    if (key) out.space[key] = read(v, SPACE_MAX, `space.${key}`);
  }
  return { costing: out, errors };
}

// The stored setting over the defaults (a size missing from both counts as 0 m²).
export const costingWithDefaults = (stored) => {
  const s = stored && typeof stored === 'object' ? stored : {};
  return { ...COSTING_DEFAULTS, ...s, space: { ...COSTING_DEFAULTS.space, ...(s.space || {}) } };
};
