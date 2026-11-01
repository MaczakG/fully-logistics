-- Courier integrations (worker/integrations/couriers).

-- One label request per order at a time: a double click at the packing station must not book two
-- shipments with the carrier. Rows are deleted when the request ends; a row older than two
-- minutes (crashed request) is taken over.
CREATE TABLE courier_label_locks (
  order_id INTEGER PRIMARY KEY REFERENCES orders(id) ON DELETE CASCADE,
  locked_at TEXT NOT NULL
);

-- State of the delivery sync per carrier between cron runs (MPL tracking is asynchronous: the
-- request id of a submitted tracking query is kept here until its report is collected).
CREATE TABLE courier_sync_state (
  carrier_code TEXT PRIMARY KEY,
  state TEXT NOT NULL DEFAULT '{}',      -- JSON
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
