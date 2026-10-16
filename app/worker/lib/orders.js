// Order status changes and the order timeline. Used by orders, picking, transport, history and
// the webshop sync, so the lifecycle stays the same wherever an order moves:
//   new -> picking -> packed -> shipped -> delivered
//   new <-> hold ; new/hold -> cancelled ; shipped/delivered -> returned

import { batch, first, run, stmt } from './db.js';
import { conflict } from './http.js';
import { STATUSES } from './constants.js';
import { budapestDate, nowIso } from './time.js';

const ALLOWED = {
  new: ['hold', 'picking', 'cancelled'],
  hold: ['new', 'cancelled'],
  picking: ['new', 'packed'],
  packed: ['picking', 'shipped'],
  shipped: ['delivered', 'returned'],
  delivered: ['returned'],
  returned: [],
  cancelled: [],
};

const TIMESTAMP = { packed: 'packed_at', shipped: 'shipped_at', delivered: 'delivered_at', cancelled: 'cancelled_at' };

export function canMove(from, to) {
  return (ALLOWED[from] || []).includes(to);
}

// Changes status with a timeline entry. Throws 409 for a move the lifecycle does not allow.
export async function setOrderStatus(ctx, orderId, to, text = '', extra = {}) {
  const db = ctx.env.DB;
  const order = await first(db, 'SELECT id, number, status FROM orders WHERE id = ?', orderId);
  if (!order) throw conflict('A rendelés nem található.');
  if (order.status === to) return order;
  if (!canMove(order.status, to)) {
    throw conflict(`A(z) ${order.number} rendelés nem tehető át „${STATUSES.order[order.status].label}” állapotból „${STATUSES.order[to].label}” állapotba.`);
  }
  const at = nowIso();
  const changes = { status: to, updated_at: at, ...extra };
  if (TIMESTAMP[to]) changes[TIMESTAMP[to]] = at;
  if (to === 'shipped') changes.shipped_date = budapestDate();
  const keys = Object.keys(changes);
  await batch(db, [
    stmt(db, `UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND status = ?`, ...keys.map((k) => changes[k]), orderId, order.status),
    stmt(db, 'INSERT INTO order_events (order_id, at, type, text, user_id) VALUES (?, ?, ?, ?, ?)',
      orderId, at, 'status', text || STATUSES.order[to].label, ctx.user ? ctx.user.id : null),
  ]);
  return { ...order, status: to };
}

export const addOrderEvent = (ctx, orderId, type, text) =>
  run(ctx.env.DB, 'INSERT INTO order_events (order_id, type, text, user_id) VALUES (?, ?, ?, ?)', orderId, type, text, ctx.user ? ctx.user.id : null);

// Number of pieces in an order (for the 2nd, 3rd, 4th+ item tariffs).
export const ITEM_COUNT_SQL = '(SELECT COALESCE(SUM(qty), 0) FROM order_lines WHERE order_id = o.id)';
