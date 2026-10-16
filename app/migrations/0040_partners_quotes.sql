-- Partnerek and Ajánlatkészítő: indexes for the partner summary (carriers, suppliers) and the quote list.
-- The tables themselves are in 0001_init.sql.

-- Carrier summary: orders shipped with a carrier in a month.
CREATE INDEX IF NOT EXISTS orders_carrier_shipped ON orders(carrier_id, shipped_date);
-- Supplier summary: inbounds of a supplier.
CREATE INDEX IF NOT EXISTS inbounds_supplier ON inbounds(supplier_id, created_at);
-- Carrier summary: last pickups of a carrier.
CREATE INDEX IF NOT EXISTS carrier_pickups_carrier ON carrier_pickups(carrier_id, date);
-- Partner pages: contacts, contracts and keys are already indexed by partner; quotes by update time for the list.
CREATE INDEX IF NOT EXISTS quotes_updated ON quotes(updated_at);
CREATE INDEX IF NOT EXISTS quotes_partner ON quotes(partner_id);
