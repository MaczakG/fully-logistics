// Dates in the warehouse's time zone. Calendar dates ("YYYY-MM-DD") always mean Europe/Budapest,
// timestamps are stored as ISO UTC strings.

export const TZ = 'Europe/Budapest';

const dateFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const timeFmt = new Intl.DateTimeFormat('sv-SE', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

export const nowIso = () => new Date().toISOString();

// "2026-10-16" for the given instant in Budapest.
export const budapestDate = (d = new Date()) => dateFmt.format(d);

// "14:05" for the given instant in Budapest.
export const budapestTime = (d = new Date()) => timeFmt.format(d);

export const budapestYear = (d = new Date()) => parseInt(budapestDate(d).slice(0, 4), 10);

// Adds whole days to a "YYYY-MM-DD" date.
export function addDays(date, days) {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// "2026-10" -> { from: "2026-10-01", to: "2026-10-31", days: 31 }
export function monthRange(period) {
  if (!/^\d{4}-\d{2}$/.test(period)) throw new Error(`invalid period ${period}`);
  const [y, m] = period.split('-').map(Number);
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${period}-01`, to: `${period}-${String(days).padStart(2, '0')}`, days };
}

// A real calendar day: "2027-02-31" parses (it rolls over to March), so compare the round trip.
export const isDate = (s) => {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
};
export const isTime = (s) => typeof s === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(s);
