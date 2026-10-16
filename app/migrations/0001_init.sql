-- Fully Logistics WMS: initial schema.
-- Conventions: INTEGER PRIMARY KEY ids, timestamps as ISO 8601 UTC text ("2026-10-16T08:30:00.000Z"),
-- calendar dates as "YYYY-MM-DD" in Europe/Budapest, money in HUF as REAL, quantities as INTEGER pieces.

-- ------------------------------------------------------------------ users, roles, sessions

CREATE TABLE roles (
  id INTEGER PRIMARY KEY,
  key TEXT NOT NULL UNIQUE,              -- stable identifier, e.g. "admin", "warehouse_manager"
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  is_admin INTEGER NOT NULL DEFAULT 0,   -- 1: every permission, cannot be edited or deleted
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- One row per granted (role, module, action). Missing row = not allowed.
-- action: view | create | edit | delete | approve
CREATE TABLE role_permissions (
  role_id INTEGER NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  PRIMARY KEY (role_id, module, action)
);

CREATE TABLE users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL DEFAULT '',
  role_id INTEGER NOT NULL REFERENCES roles(id),
  password_hash TEXT NOT NULL,           -- "pbkdf2-sha256$<iterations>$<salt b64>$<hash b64>"
  active INTEGER NOT NULL DEFAULT 1,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  last_login_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY,           -- SHA-256 of the cookie value; the raw token is never stored
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT NOT NULL DEFAULT '',
  user_agent TEXT NOT NULL DEFAULT ''
);
CREATE INDEX sessions_user ON sessions(user_id);

-- ------------------------------------------------------------------ settings, numbering, audit

CREATE TABLE settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL                    -- JSON
);

-- Per prefix and year running numbers: BT-2026-00001, R-2026-000001 ...
CREATE TABLE sequences (
  prefix TEXT NOT NULL,
  year INTEGER NOT NULL,
  value INTEGER NOT NULL,
  PRIMARY KEY (prefix, year)
);

CREATE TABLE audit_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor TEXT NOT NULL DEFAULT '',        -- user name, "API: <partner>" or "Rendszer"
  module TEXT NOT NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL DEFAULT '',
  entity_id TEXT NOT NULL DEFAULT '',
  summary TEXT NOT NULL DEFAULT '',
  details TEXT                           -- JSON
);
CREATE INDEX audit_at ON audit_log(at);
CREATE INDEX audit_entity ON audit_log(entity, entity_id);

-- ------------------------------------------------------------------ partners

-- type: client (we store and ship for them) | carrier | supplier
CREATE TABLE partners (
  id INTEGER PRIMARY KEY,
  type TEXT NOT NULL CHECK (type IN ('client', 'carrier', 'supplier')),
  code TEXT NOT NULL UNIQUE,             -- short code, e.g. "KUTYA", also used as SKU prefix hint
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  tax_number TEXT NOT NULL DEFAULT '',
  eu_vat_number TEXT NOT NULL DEFAULT '',
  company_reg_number TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'HU',
  zip TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  billing_name TEXT NOT NULL DEFAULT '',
  billing_country TEXT NOT NULL DEFAULT 'HU',
  billing_zip TEXT NOT NULL DEFAULT '',
  billing_city TEXT NOT NULL DEFAULT '',
  billing_address TEXT NOT NULL DEFAULT '',
  billing_email TEXT NOT NULL DEFAULT '',
  payment_days INTEGER NOT NULL DEFAULT 8,
  currency TEXT NOT NULL DEFAULT 'HUF',
  website TEXT NOT NULL DEFAULT '',
  carrier_code TEXT NOT NULL DEFAULT '', -- carriers only: gls | dpd | foxpost | mpl | dhl | other
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX partners_type ON partners(type, status);

CREATE TABLE partner_contacts (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  position TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  is_primary INTEGER NOT NULL DEFAULT 0,
  notes TEXT NOT NULL DEFAULT ''
);
CREATE INDEX partner_contacts_partner ON partner_contacts(partner_id);

CREATE TABLE partner_contracts (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  number TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  end_date TEXT,                         -- NULL: indefinite
  notice_days INTEGER NOT NULL DEFAULT 30,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('draft', 'active', 'terminated', 'expired')),
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX partner_contracts_partner ON partner_contracts(partner_id);

-- Files live in R2 (binding FILES) under r2_key.
CREATE TABLE documents (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER REFERENCES partners(id) ON DELETE CASCADE,
  contract_id INTEGER REFERENCES partner_contracts(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'other',    -- contract | quote | invoice | label | other
  filename TEXT NOT NULL,
  content_type TEXT NOT NULL DEFAULT 'application/octet-stream',
  size INTEGER NOT NULL DEFAULT 0,
  r2_key TEXT NOT NULL UNIQUE,
  uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  uploaded_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX documents_partner ON documents(partner_id);

-- ------------------------------------------------------------------ locations

-- Location sizes (M, L, XL, pallet ...). Extendable. Prices are per partner (partner_storage_prices).
CREATE TABLE location_sizes (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  width_cm REAL,
  depth_cm REAL,
  height_cm REAL,
  max_kg REAL,
  sort INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);

-- One location holds the goods of one partner at a time (enforced in worker/lib/stock.js).
-- partner_id: optional fixed assignment ("dedicated location").
CREATE TABLE locations (
  id INTEGER PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,             -- e.g. "A-01-03": zone, rack, level
  zone TEXT NOT NULL DEFAULT '',
  size_id INTEGER NOT NULL REFERENCES location_sizes(id),
  partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  kind TEXT NOT NULL DEFAULT 'storage' CHECK (kind IN ('storage', 'receiving', 'packing', 'returns', 'quarantine')),
  pick_sequence INTEGER NOT NULL DEFAULT 0, -- walking order for pick lists; 0: sort by code
  active INTEGER NOT NULL DEFAULT 1,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX locations_zone ON locations(zone);

-- ------------------------------------------------------------------ products and stock

CREATE TABLE products (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  sku TEXT NOT NULL,
  name TEXT NOT NULL,
  ean TEXT NOT NULL DEFAULT '',
  unit TEXT NOT NULL DEFAULT 'db',
  weight_kg REAL,
  width_cm REAL,
  depth_cm REAL,
  height_cm REAL,
  min_stock INTEGER NOT NULL DEFAULT 0,
  track_lot INTEGER NOT NULL DEFAULT 0,
  track_expiry INTEGER NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (partner_id, sku)
);
CREATE INDEX products_ean ON products(ean);

-- Current stock by product, location and lot. Rows with qty 0 are deleted.
CREATE TABLE stock (
  id INTEGER PRIMARY KEY,
  product_id INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',       -- YYYY-MM-DD or ''
  qty INTEGER NOT NULL CHECK (qty >= 0),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (product_id, location_id, lot, expiry)
);
CREATE INDEX stock_location ON stock(location_id);

-- Every stock change, the ledger behind stock history and billing.
-- type: inbound | pick | return | adjust | transfer_out | transfer_in | cancel_pick
CREATE TABLE movements (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  date TEXT NOT NULL,                    -- Budapest calendar date of the movement
  type TEXT NOT NULL,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER REFERENCES locations(id),
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL,                  -- signed: + into stock, - out of stock
  ref_type TEXT NOT NULL DEFAULT '',     -- inbound | order | wave | count | return | manual
  ref_id INTEGER,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX movements_partner_date ON movements(partner_id, date);
CREATE INDEX movements_product ON movements(product_id, at);
CREATE INDEX movements_ref ON movements(ref_type, ref_id);

-- End of day occupancy, one row per occupied location and day (storage billing, pro rata by day).
CREATE TABLE storage_snapshots (
  date TEXT NOT NULL,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  size_id INTEGER NOT NULL REFERENCES location_sizes(id),
  PRIMARY KEY (date, location_id)
);
CREATE INDEX storage_snapshots_partner ON storage_snapshots(partner_id, date);

-- ------------------------------------------------------------------ inbound (Betárolás)

-- status: expected | arrived | receiving | completed | cancelled
CREATE TABLE inbounds (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  supplier_id INTEGER REFERENCES partners(id),
  source TEXT NOT NULL DEFAULT 'manual', -- manual | csv | api
  external_ref TEXT NOT NULL DEFAULT '', -- supplier delivery note, partner ASN id
  expected_date TEXT,
  arrived_at TEXT,
  completed_at TEXT,
  status TEXT NOT NULL DEFAULT 'expected',
  pallets INTEGER NOT NULL DEFAULT 0,
  cartons INTEGER NOT NULL DEFAULT 0,
  note TEXT NOT NULL DEFAULT '',
  has_discrepancy INTEGER NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX inbounds_status ON inbounds(status, expected_date);
CREATE INDEX inbounds_partner ON inbounds(partner_id);

CREATE TABLE inbound_lines (
  id INTEGER PRIMARY KEY,
  inbound_id INTEGER NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  expected_qty INTEGER NOT NULL DEFAULT 0,
  received_qty INTEGER NOT NULL DEFAULT 0,
  damaged_qty INTEGER NOT NULL DEFAULT 0,
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  location_id INTEGER REFERENCES locations(id),
  putaway_qty INTEGER NOT NULL DEFAULT 0, -- already booked into stock
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX inbound_lines_inbound ON inbound_lines(inbound_id);

-- ------------------------------------------------------------------ orders (Megrendelések, Rendeléstörténet)

-- status: new | hold | picking | packed | shipped | delivered | returned | cancelled
CREATE TABLE orders (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  source TEXT NOT NULL DEFAULT 'manual', -- manual | csv | api | shopify | woocommerce | shoprenter | unas
  external_id TEXT NOT NULL DEFAULT '',  -- id in the partner's system
  external_number TEXT NOT NULL DEFAULT '', -- order number the customer sees
  status TEXT NOT NULL DEFAULT 'new',
  priority TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal', 'express')),
  customer_name TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  country TEXT NOT NULL DEFAULT 'HU',
  zip TEXT NOT NULL DEFAULT '',
  city TEXT NOT NULL DEFAULT '',
  address TEXT NOT NULL DEFAULT '',
  pickup_point_id TEXT NOT NULL DEFAULT '', -- parcel locker or pickup point (Foxpost, GLS, MPL ...)
  carrier_id INTEGER REFERENCES partners(id), -- partner of type carrier
  carrier_service TEXT NOT NULL DEFAULT '',
  cod_amount REAL NOT NULL DEFAULT 0,    -- cash on delivery, 0: none
  currency TEXT NOT NULL DEFAULT 'HUF',
  note TEXT NOT NULL DEFAULT '',
  wave_id INTEGER REFERENCES waves(id) ON DELETE SET NULL,
  pickup_id INTEGER REFERENCES carrier_pickups(id) ON DELETE SET NULL,
  package_count INTEGER NOT NULL DEFAULT 1,
  weight_kg REAL,
  tracking_number TEXT NOT NULL DEFAULT '',
  label_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  ordered_at TEXT,                       -- when the customer ordered (from the webshop)
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  packed_at TEXT,
  shipped_at TEXT,
  shipped_date TEXT,                     -- Budapest date of shipping, used for billing
  delivered_at TEXT,
  cancelled_at TEXT,
  fulfillment_synced_at TEXT             -- tracking sent back to the webshop
);
-- One order per webshop/API order id; manual orders have no external id.
CREATE UNIQUE INDEX orders_external ON orders(partner_id, source, external_id) WHERE external_id <> '';
CREATE INDEX orders_status ON orders(status, created_at);
CREATE INDEX orders_partner ON orders(partner_id, created_at);
CREATE INDEX orders_shipped ON orders(partner_id, shipped_date);
CREATE INDEX orders_tracking ON orders(tracking_number);

CREATE TABLE order_lines (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  picked_qty INTEGER NOT NULL DEFAULT 0,
  external_line_id TEXT NOT NULL DEFAULT ''
);
CREATE INDEX order_lines_order ON order_lines(order_id);
CREATE INDEX order_lines_product ON order_lines(product_id);

CREATE TABLE order_events (
  id INTEGER PRIMARY KEY,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  type TEXT NOT NULL,                    -- created | status | note | label | sync | return
  text TEXT NOT NULL,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX order_events_order ON order_events(order_id);

-- Returns (visszáru): one row per returned parcel, lines say what came back and where it went.
CREATE TABLE returns (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  received_date TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);
CREATE INDEX returns_partner ON returns(partner_id, received_date);

CREATE TABLE return_lines (
  id INTEGER PRIMARY KEY,
  return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  condition TEXT NOT NULL DEFAULT 'sellable' CHECK (condition IN ('sellable', 'damaged')),
  location_id INTEGER REFERENCES locations(id),
  document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL -- photo of damaged goods
);

-- ------------------------------------------------------------------ picking (Komissió)

-- status: open | picking | picked | completed | cancelled
CREATE TABLE waves (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'open',
  picker_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  started_at TEXT,
  completed_at TEXT
);
CREATE INDEX waves_status ON waves(status);

-- Planned and confirmed picks: which order line is picked from which location.
CREATE TABLE picks (
  id INTEGER PRIMARY KEY,
  wave_id INTEGER NOT NULL REFERENCES waves(id) ON DELETE CASCADE,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_line_id INTEGER NOT NULL REFERENCES order_lines(id) ON DELETE CASCADE,
  product_id INTEGER NOT NULL REFERENCES products(id),
  location_id INTEGER NOT NULL REFERENCES locations(id),
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL CHECK (qty > 0),
  picked_qty INTEGER NOT NULL DEFAULT 0,
  picked_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  picked_at TEXT
);
CREATE INDEX picks_wave ON picks(wave_id);
CREATE INDEX picks_order ON picks(order_id);

-- ------------------------------------------------------------------ inventory counts (Leltár)

-- type: cycle | zone | full | product ; status: open | counting | counted | posted | cancelled
CREATE TABLE counts (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'cycle',
  scope TEXT NOT NULL DEFAULT '',        -- zone code, location codes or product ids as text, shown to users
  blind INTEGER NOT NULL DEFAULT 1,      -- counters do not see the expected quantity
  status TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  counted_at TEXT,
  posted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  posted_at TEXT
);

CREATE TABLE count_lines (
  id INTEGER PRIMARY KEY,
  count_id INTEGER NOT NULL REFERENCES counts(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  product_id INTEGER REFERENCES products(id), -- NULL: location expected empty, found product recorded on count
  lot TEXT NOT NULL DEFAULT '',
  expiry TEXT NOT NULL DEFAULT '',
  expected_qty INTEGER NOT NULL DEFAULT 0,
  counted_qty INTEGER,                   -- NULL: not counted yet
  counted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  counted_at TEXT
);
CREATE INDEX count_lines_count ON count_lines(count_id);

-- ------------------------------------------------------------------ transport (Fuvarszervezés)

-- Daily carrier pickups: packed orders are attached, closing the manifest marks them shipped.
-- status: planned | arrived | closed | cancelled
CREATE TABLE carrier_pickups (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  carrier_id INTEGER NOT NULL REFERENCES partners(id),
  date TEXT NOT NULL,
  window_from TEXT NOT NULL DEFAULT '', -- HH:MM
  window_to TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'planned',
  manifest_number TEXT NOT NULL DEFAULT '',
  manifest_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  note TEXT NOT NULL DEFAULT '',
  closed_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  closed_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX carrier_pickups_date ON carrier_pickups(date, carrier_id);

-- Pallet and truck transports (LTL, FTL), inbound or outbound.
-- status: requested | booked | in_transit | delivered | cancelled
CREATE TABLE transports (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  direction TEXT NOT NULL DEFAULT 'out' CHECK (direction IN ('in', 'out')),
  partner_id INTEGER REFERENCES partners(id),   -- the client the transport is for
  carrier_id INTEGER REFERENCES partners(id),
  date TEXT NOT NULL,
  time_from TEXT NOT NULL DEFAULT '',
  time_to TEXT NOT NULL DEFAULT '',
  origin TEXT NOT NULL DEFAULT '',
  destination TEXT NOT NULL DEFAULT '',
  pallets INTEGER NOT NULL DEFAULT 0,
  weight_kg REAL,
  vehicle TEXT NOT NULL DEFAULT '',     -- e.g. "12 t, ponyvás", license plate
  price REAL,
  carrier_ref TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested',
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX transports_date ON transports(date);

-- ------------------------------------------------------------------ tariffs and billing

-- Flat tariffs per partner. key: order_base | item_2 | item_3 | item_extra | packaging | inbound_unit |
-- return_unit | hourly_work | cod_fixed | cod_pct | discount_handling_pct | discount_storage_pct | vat_pct
CREATE TABLE partner_tariffs (
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  key TEXT NOT NULL,
  value REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, key)
);

-- Monthly price of one location of a size, per partner.
CREATE TABLE partner_storage_prices (
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  size_id INTEGER NOT NULL REFERENCES location_sizes(id) ON DELETE CASCADE,
  price REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (partner_id, size_id)
);

-- Custom tariff items. kind: monthly (fixed fee every month) | per_unit (billed by recorded quantity)
CREATE TABLE partner_custom_items (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'db',
  price REAL NOT NULL DEFAULT 0,
  kind TEXT NOT NULL DEFAULT 'per_unit' CHECK (kind IN ('monthly', 'per_unit')),
  active INTEGER NOT NULL DEFAULT 1
);

-- Manually recorded billable work: hourly work or quantities of per_unit custom items.
CREATE TABLE billing_entries (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('hourly_work', 'custom')),
  custom_item_id INTEGER REFERENCES partner_custom_items(id) ON DELETE SET NULL,
  qty REAL NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX billing_entries_partner ON billing_entries(partner_id, date);

-- Monthly statement per client. status: draft | approved | invoiced | void
CREATE TABLE statements (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  partner_id INTEGER NOT NULL REFERENCES partners(id),
  period TEXT NOT NULL,                  -- YYYY-MM
  status TEXT NOT NULL DEFAULT 'draft',
  lines TEXT NOT NULL DEFAULT '[]',      -- JSON: [{group, name, qty, unit, price, amount}]
  net REAL NOT NULL DEFAULT 0,
  vat_pct REAL NOT NULL DEFAULT 27,
  vat REAL NOT NULL DEFAULT 0,
  gross REAL NOT NULL DEFAULT 0,
  generated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  approved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  approved_at TEXT,
  invoice_provider TEXT NOT NULL DEFAULT '', -- szamlazz | billingo
  invoice_number TEXT NOT NULL DEFAULT '',
  invoice_document_id INTEGER REFERENCES documents(id) ON DELETE SET NULL,
  invoiced_at TEXT,
  invoice_error TEXT NOT NULL DEFAULT '',
  UNIQUE (partner_id, period)
);

-- Saved quotes from Ajánlatkészítő. data: the calculator state as JSON.
CREATE TABLE quotes (
  id INTEGER PRIMARY KEY,
  number TEXT NOT NULL UNIQUE,
  partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  client_name TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'rejected')),
  data TEXT NOT NULL DEFAULT '{}',
  monthly_net REAL NOT NULL DEFAULT 0,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- ------------------------------------------------------------------ integrations

-- Partner REST API keys. The key is shown once; only its SHA-256 hash is stored.
CREATE TABLE api_keys (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  name TEXT NOT NULL DEFAULT '',
  prefix TEXT NOT NULL,                  -- first characters, shown in the list to tell keys apart
  key_hash TEXT NOT NULL UNIQUE,
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_used_at TEXT,
  revoked_at TEXT
);
CREATE INDEX api_keys_partner ON api_keys(partner_id);

-- Webshop connection of a client. platform: shopify | woocommerce | shoprenter | unas
-- credentials: AES-GCM encrypted JSON (worker/lib/crypto.js), never sent to the browser.
CREATE TABLE webshop_connections (
  id INTEGER PRIMARY KEY,
  partner_id INTEGER NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  platform TEXT NOT NULL,
  shop_url TEXT NOT NULL,
  credentials TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON: import status filter, auto import, default carrier, stock sync
  active INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,
  last_sync_cursor TEXT NOT NULL DEFAULT '',
  last_error TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX webshop_connections_partner ON webshop_connections(partner_id);

-- Our own courier contracts (one per carrier code). credentials encrypted like above.
CREATE TABLE courier_accounts (
  id INTEGER PRIMARY KEY,
  carrier_code TEXT NOT NULL UNIQUE,     -- gls | dpd | foxpost | mpl | dhl
  carrier_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  credentials TEXT NOT NULL DEFAULT '',
  settings TEXT NOT NULL DEFAULT '{}',   -- JSON: sender address, default service, label format, test mode
  active INTEGER NOT NULL DEFAULT 0,
  last_error TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- Log of calls to outside systems (webshops, couriers, invoicing) for troubleshooting.
CREATE TABLE integration_log (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  system TEXT NOT NULL,                  -- e.g. "shopify", "gls", "billingo", "api"
  direction TEXT NOT NULL DEFAULT 'out', -- out: we called them | in: they called us
  partner_id INTEGER REFERENCES partners(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 1,
  status INTEGER,
  message TEXT NOT NULL DEFAULT '',
  ref_type TEXT NOT NULL DEFAULT '',
  ref_id INTEGER
);
CREATE INDEX integration_log_at ON integration_log(at);
