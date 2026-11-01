-- Returned goods keep their lot and expiry (from the picks of the order), so they go back into
-- the same stock row and FEFO picking and lot tracing stay right.
ALTER TABLE return_lines ADD COLUMN lot TEXT NOT NULL DEFAULT '';
ALTER TABLE return_lines ADD COLUMN expiry TEXT NOT NULL DEFAULT '';
