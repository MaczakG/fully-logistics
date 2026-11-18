-- Fuvarszervezés: the trucks of the carriers that do egyedi fuvarok (every transport that is not a
-- courier parcel), the orders planned onto a truck for a day in stop order, the pallets of an order,
-- and the map positions of addresses (looked up once, then kept).
CREATE TABLE trucks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  carrier_id INTEGER NOT NULL REFERENCES partners(id),
  plate TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '',
  driver TEXT NOT NULL DEFAULT '',
  pallets INTEGER NOT NULL DEFAULT 0,
  max_kg REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE UNIQUE INDEX trucks_plate ON trucks(plate);
CREATE INDEX trucks_carrier ON trucks(carrier_id);

ALTER TABLE orders ADD COLUMN pallets INTEGER NOT NULL DEFAULT 0;
ALTER TABLE orders ADD COLUMN truck_id INTEGER REFERENCES trucks(id);
ALTER TABLE orders ADD COLUMN truck_date TEXT;
ALTER TABLE orders ADD COLUMN truck_seq INTEGER NOT NULL DEFAULT 0;
CREATE INDEX orders_truck ON orders(truck_id, truck_date);

-- address: country|zip|city|address as the order has it; lat and lng are null when nothing was found.
CREATE TABLE geocodes (
  address TEXT PRIMARY KEY,
  lat REAL,
  lng REAL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
