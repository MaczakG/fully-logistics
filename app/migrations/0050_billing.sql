-- Elszámolás (billing): statement bookkeeping, invoicing state and the daily snapshot run log.

-- Who generated the draft, tariffs used (JSON), void details, and the invoicing state:
--   invoice_external_id  the provider's own id of the invoice (Billingo document id, Számlázz.hu
--                        external key), used to download the PDF again
--   invoice_lock_at      set while an invoice is being issued, so a double click cannot create two
--                        invoices; cleared when the call ends (stale after 5 minutes)
--   invoice_uncertain    1 when the last attempt ended without a clear answer (timeout, network,
--                        5xx); the next attempt first looks the invoice up at the provider
ALTER TABLE statements ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';
ALTER TABLE statements ADD COLUMN generated_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE statements ADD COLUMN voided_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE statements ADD COLUMN voided_at TEXT;
ALTER TABLE statements ADD COLUMN void_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE statements ADD COLUMN invoice_external_id TEXT NOT NULL DEFAULT '';
ALTER TABLE statements ADD COLUMN invoice_lock_at TEXT;
ALTER TABLE statements ADD COLUMN invoice_uncertain INTEGER NOT NULL DEFAULT 0;
CREATE INDEX statements_period ON statements(period, status);

-- One row per recorded snapshot day, also when no location was occupied, so "recorded but empty"
-- and "missed" can be told apart. source: cron | fallback | manual
CREATE TABLE snapshot_runs (
  date TEXT PRIMARY KEY,
  taken_at TEXT NOT NULL,
  rows INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'cron'
);

CREATE INDEX movements_type_date ON movements(type, date);
CREATE INDEX returns_date ON returns(received_date);
CREATE INDEX orders_shipped_date ON orders(shipped_date);
CREATE INDEX billing_entries_date ON billing_entries(date);
