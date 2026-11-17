-- Partner REST API (worker/api/v1.js): per key request counter for the rate limit, and indexes
-- for the partner scoped order lookups.

-- Fixed one minute windows. bucket: minutes since the Unix epoch. Old buckets are deleted as new
-- ones start.
CREATE TABLE api_rate_limits (
  key_id INTEGER NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  bucket INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (key_id, bucket)
);

-- GET /api/v1/orders pages by (updated_at, id) within one partner.
CREATE INDEX orders_api_updated ON orders(partner_id, updated_at, id);
-- GET /api/v1/orders/:ref finds an order by the partner's own id.
CREATE INDEX orders_api_external ON orders(partner_id, external_id);
-- GET /api/v1/inbounds/:ref finds an inbound by the partner's ASN reference.
CREATE INDEX inbounds_api_external ON inbounds(partner_id, external_ref);
