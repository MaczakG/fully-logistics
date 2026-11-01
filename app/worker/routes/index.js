// Registers every /api route. Each module file exports register(router).

import * as core from './core.js';
import * as inbound from './inbound.js';
import * as orders from './orders.js';
import * as picking from './picking.js';
import * as counts from './counts.js';
import * as stock from './stock.js';
import * as history from './history.js';
import * as transport from './transport.js';
import * as partners from './partners.js';
import * as quotes from './quotes.js';
import * as billing from './billing.js';
import * as settings from './settings.js';
import * as users from './users.js';

const MODULES = [core, inbound, orders, picking, counts, stock, history, transport, partners, quotes, billing, settings, users];

export function registerAll(router) {
  for (const m of MODULES) m.register(router);
  return router;
}
