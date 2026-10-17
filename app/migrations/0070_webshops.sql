-- Webshop integrations (worker/integrations/webshops): which webshop order each imported order
-- came from, orders waiting for a retry, connection runtime state and the stock last sent.

-- One row per imported order. remote_id is the id the shop's API uses (Shopify order GID,
-- WooCommerce order id, Shoprenter resource id, UNAS Key); the fulfilment push state lives here.
CREATE TABLE webshop_orders (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES webshop_connections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  remote_number TEXT NOT NULL DEFAULT '',  -- order number the customer sees
  remote_cancelled_at TEXT,                -- seen cancelled in the shop (handled once)
  fulfillment_attempts INTEGER NOT NULL DEFAULT 0,
  fulfillment_error TEXT NOT NULL DEFAULT '',
  fulfillment_next_at TEXT,                -- retry the push not before this
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (connection_id, remote_id)
);

-- Orders that could not be imported yet (unknown SKU, SKU missing in the shop ...).
-- payload: the normalised order as JSON, imported again on retry.
CREATE TABLE webshop_pending_orders (
  id INTEGER PRIMARY KEY,
  connection_id INTEGER NOT NULL REFERENCES webshop_connections(id) ON DELETE CASCADE,
  remote_id TEXT NOT NULL,
  external_number TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL,
  error TEXT NOT NULL DEFAULT '',
  attempts INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_attempt_at TEXT NOT NULL,
  next_attempt_at TEXT,
  UNIQUE (connection_id, remote_id)
);

-- Runtime state of a connection: cached access token (encrypted like credentials), pause after
-- refused credentials or rate limits, and a lock so two syncs of one shop never overlap.
CREATE TABLE webshop_connection_state (
  connection_id INTEGER PRIMARY KEY REFERENCES webshop_connections(id) ON DELETE CASCADE,
  token TEXT NOT NULL DEFAULT '',
  backoff_until TEXT,
  backoff_reason TEXT NOT NULL DEFAULT '',
  failed_credentials TEXT NOT NULL DEFAULT '', -- SHA-256 of the credentials that were refused
  failed_at TEXT,
  lock_until TEXT
);

-- Stock last sent to the shop per SKU ("Készlet visszaküldése"); only changes are sent again.
-- missing: the shop does not know the SKU (or refused it), tried again after a day.
CREATE TABLE webshop_stock_sync (
  connection_id INTEGER NOT NULL REFERENCES webshop_connections(id) ON DELETE CASCADE,
  sku TEXT NOT NULL,
  qty INTEGER NOT NULL,
  missing INTEGER NOT NULL DEFAULT 0,
  synced_at TEXT NOT NULL,
  PRIMARY KEY (connection_id, sku)
);
