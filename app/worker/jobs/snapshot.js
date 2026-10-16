// Daily storage snapshot for pro-rata storage billing: which partner occupies which location at
// the end of each Budapest day. Contract:
//   takeDailySnapshot(env, date?) -> Promise<{ date, rows }>  idempotent for a date
//
// Stub until the billing module implements it.

export const takeDailySnapshot = async () => ({ date: null, rows: 0 });
