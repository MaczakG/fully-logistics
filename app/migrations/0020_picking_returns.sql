-- Komissió and Rendeléstörténet additions.
--
-- picks.short_qty: pieces the picker did not find at the location (Hiány). A pick is resolved when
--   picked_qty + short_qty = qty. The shortage is re-planned from other locations where possible.
-- picks.restocked_qty: picked pieces put back into stock (cancel_pick movement) because the wave or
--   the order was cancelled. Pieces held for the order: picked_qty - restocked_qty.
-- return_photos: photos of a returned parcel (documents of kind "photo").

ALTER TABLE picks ADD COLUMN short_qty INTEGER NOT NULL DEFAULT 0;
ALTER TABLE picks ADD COLUMN restocked_qty INTEGER NOT NULL DEFAULT 0;

CREATE TABLE return_photos (
  return_id INTEGER NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  document_id INTEGER NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  PRIMARY KEY (return_id, document_id)
);

CREATE INDEX orders_wave ON orders(wave_id);
CREATE INDEX picks_line ON picks(order_line_id);
CREATE INDEX returns_order ON returns(order_id);
CREATE INDEX return_lines_return ON return_lines(return_id);
