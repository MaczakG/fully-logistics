-- Leltár (inventory counts) and Fuvarszervezés (carrier pickups, transports): columns and indexes
-- the two modules need on top of 0001_init.sql.

-- ------------------------------------------------------------------ counts
-- type gains "locations" (an explicit list of location codes) next to cycle | zone | full | product.
-- filter: JSON of what the count was created for ({ zone, limit, product_ids, location_ids }), so a
-- location recount takes the same products again.
ALTER TABLE counts ADD COLUMN filter TEXT NOT NULL DEFAULT '{}';
ALTER TABLE counts ADD COLUMN started_at TEXT;
ALTER TABLE counts ADD COLUMN cancelled_at TEXT;
ALTER TABLE counts ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS counts_status_created ON counts(status, created_at);

-- snapshot_mid: highest movements.id when expected_qty was read from stock. A movement of the same
--   product and location with a higher id means the stock changed after the snapshot.
-- added: 1 for products found during counting that were not in the snapshot.
-- posted_at, posted_diff: when the line was booked and the difference booked (setStockQty).
ALTER TABLE count_lines ADD COLUMN snapshot_mid INTEGER NOT NULL DEFAULT 0;
ALTER TABLE count_lines ADD COLUMN added INTEGER NOT NULL DEFAULT 0;
ALTER TABLE count_lines ADD COLUMN posted_at TEXT;
ALTER TABLE count_lines ADD COLUMN posted_diff INTEGER;
CREATE INDEX IF NOT EXISTS count_lines_location ON count_lines(location_id, count_id);
CREATE UNIQUE INDEX IF NOT EXISTS count_lines_key ON count_lines(count_id, location_id, product_id, lot, expiry) WHERE product_id IS NOT NULL;

-- ------------------------------------------------------------------ carrier pickups
ALTER TABLE carrier_pickups ADD COLUMN arrived_at TEXT;
ALTER TABLE carrier_pickups ADD COLUMN cancelled_at TEXT;
ALTER TABLE carrier_pickups ADD COLUMN created_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE carrier_pickups ADD COLUMN updated_at TEXT;
CREATE INDEX IF NOT EXISTS transport_orders_pickup ON orders(pickup_id);
CREATE INDEX IF NOT EXISTS transport_orders_waiting ON orders(status, carrier_id, pickup_id);

-- ------------------------------------------------------------------ transports
ALTER TABLE transports ADD COLUMN cancelled_at TEXT;
CREATE INDEX IF NOT EXISTS transports_status_date ON transports(status, date);
