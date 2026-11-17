-- Betárolás: arrival and closing details, who received a line, and one row per putaway so the
-- receiving report shows exactly which location got how many pieces of which line.

ALTER TABLE inbounds ADD COLUMN arrival_note TEXT NOT NULL DEFAULT '';
ALTER TABLE inbounds ADD COLUMN completed_by INTEGER REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE inbounds ADD COLUMN discrepancy_note TEXT NOT NULL DEFAULT '';  -- reason given when closing with a discrepancy
ALTER TABLE inbounds ADD COLUMN cancelled_at TEXT;
ALTER TABLE inbounds ADD COLUMN cancel_reason TEXT NOT NULL DEFAULT '';
CREATE INDEX inbounds_completed ON inbounds(completed_at);
CREATE INDEX inbounds_external_ref ON inbounds(partner_id, external_ref);

ALTER TABLE inbound_lines ADD COLUMN received_by INTEGER REFERENCES users(id) ON DELETE SET NULL; -- last user who counted on the line
ALTER TABLE inbound_lines ADD COLUMN received_at TEXT;

CREATE TABLE inbound_putaways (
  id INTEGER PRIMARY KEY,
  inbound_id INTEGER NOT NULL REFERENCES inbounds(id) ON DELETE CASCADE,
  line_id INTEGER NOT NULL REFERENCES inbound_lines(id) ON DELETE CASCADE,
  location_id INTEGER NOT NULL REFERENCES locations(id),
  qty INTEGER NOT NULL CHECK (qty > 0),
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX inbound_putaways_inbound ON inbound_putaways(inbound_id);

-- Cikktörzs: products of a partner by name and the movement ledger by type and date.
CREATE INDEX products_partner_name ON products(partner_id, name);
CREATE INDEX movements_type_date ON movements(type, date);
CREATE INDEX movements_date ON movements(date);
