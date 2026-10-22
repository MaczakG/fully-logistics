// Assumptions of the internal costing in the quote calculator (Ajánlatkészítő > Belső
// fedezetszámítás). Kept in the "costing" setting (Beállítások > Raktár) and copied into every new
// quote, where they can be changed for that quote alone:
//
//   rent           monthly rent of the warehouse (Ft, net)
//   area_m2        rented floor area (m²); rent / area_m2 is the rent of one m²
//   racks          per size code, the rack that holds that size: { area, levels, per_level }
//                    area       floor area of one rack bay with its share of the aisle (m²)
//                    levels     shelf levels of the bay
//                    per_level  locations of that size on one level
//                  one location takes area / (levels x per_level) m² of floor (rackSpace); that
//                  times the rent of one m² is its rent, area_m2 / it is how many would fit
//   worker_cost    full monthly cost of one warehouse worker (wage and contributions, Ft)
//   worker_hours   productive hours of one worker in a month
//   min_*          minute norms: per order, per further item in an order, per received piece,
//                  per return
//   pack_cost      purchase price of the packaging material per order (Ft)

// Estimates to start from: shelving bays of 1 m x 0.5 m with 0.6 m² of aisle, a pallet rack bay
// of three pallets (2.7 m x 1.1 m) with half of a 3 m forklift aisle.
export const RACK_DEFAULTS = {
  M: { area: 1.1, levels: 5, per_level: 2 },
  L: { area: 1.1, levels: 4, per_level: 2 },
  XL: { area: 1.1, levels: 3, per_level: 1 },
  PAL: { area: 7, levels: 4, per_level: 3 },
};

export const COSTING_DEFAULTS = {
  rent: 0,
  area_m2: 0,
  racks: RACK_DEFAULTS,
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
export const RACK_LIMITS = { area: 1e4, levels: 100, per_level: 1000 };

// Floor area of one location of a rack (0 when the rack is not filled in).
export const rackSpace = (r) => (r && r.area > 0 && r.levels > 0 && r.per_level > 0 ? r.area / (r.levels * r.per_level) : 0);

// Until 23 October 2026 the floor area of a location was one number per size ("space": m² per
// location). Such a value becomes a rack of one level with one location; the estimates that
// shipped as defaults then (never changed by anyone) give way to the rack defaults.
const OLD_SPACE_DEFAULTS = { M: 0.15, L: 0.25, XL: 0.4, PAL: 1.2 };
function racksFromSpace(space) {
  const s = space && typeof space === 'object' && !Array.isArray(space) ? space : {};
  const untouched = Object.entries(s).every(([code, v]) => Number(v) === OLD_SPACE_DEFAULTS[code]);
  if (untouched) return { ...RACK_DEFAULTS };
  return Object.fromEntries(Object.entries(s).map(([code, v]) => [code, { area: Number(v) || 0, levels: 1, per_level: 1 }]));
}
const racksOf = (c) => (c.racks && typeof c.racks === 'object' && !Array.isArray(c.racks) ? c.racks : c.space ? racksFromSpace(c.space) : {});

const toNum = (v) => (typeof v === 'string' ? Number(v.replace(',', '.').replace(/\s/g, '')) : Number(v));
const obj = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

// Lenient: anything that is not a positive number counts as 0 (the calculator's rule), values above
// the limits are cut. Used for the copy inside a quote.
export function looseCosting(input) {
  const c = obj(input);
  const pos = (v, max) => { const x = toNum(v); return Number.isFinite(x) && x > 0 ? Math.min(x, max) : 0; };
  const out = Object.fromEntries(Object.entries(COSTING_LIMITS).map(([k, max]) => [k, pos(c[k], max)]));
  out.racks = Object.fromEntries(Object.entries(racksOf(c)).slice(0, 50)
    .map(([code, r]) => [String(code).trim().slice(0, 20), Object.fromEntries(Object.entries(RACK_LIMITS).map(([k, max]) => [k, pos(obj(r)[k], max)]))])
    .filter(([code]) => code));
  return out;
}

// Strict, for the settings form: field errors for what is not a number from 0 to the limit.
export function checkCosting(input) {
  const c = obj(input);
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
  out.racks = {};
  for (const [code, r] of Object.entries(obj(c.racks)).slice(0, 50)) {
    const key = String(code).trim().slice(0, 20);
    if (!key) continue;
    out.racks[key] = Object.fromEntries(Object.entries(RACK_LIMITS).map(([k, max]) => [k, read(obj(r)[k], max, `racks.${key}.${k}`)]));
    if (out.racks[key].levels % 1) errors[`racks.${key}.levels`] = 'Egész szám legyen.';
    if (out.racks[key].per_level % 1) errors[`racks.${key}.per_level`] = 'Egész szám legyen.';
  }
  return { costing: out, errors };
}

// The stored setting over the defaults (a size missing from both has an empty rack).
export const costingWithDefaults = (stored) => {
  const s = obj(stored);
  const { space: _old, ...rest } = s;
  return { ...COSTING_DEFAULTS, ...rest, racks: { ...RACK_DEFAULTS, ...racksOf(s) } };
};
