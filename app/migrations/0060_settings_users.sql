-- Beállítások and Felhasználók: indexes for the filters of the activity and integration logs, the
-- location list (size, fixed partner) and the "is this location or user still referenced" checks
-- before deleting. Additive only.

CREATE INDEX IF NOT EXISTS audit_module_at ON audit_log(module, at);
CREATE INDEX IF NOT EXISTS audit_user_at ON audit_log(user_id, at);
CREATE INDEX IF NOT EXISTS integration_log_system_at ON integration_log(system, at);
CREATE INDEX IF NOT EXISTS locations_size ON locations(size_id);
CREATE INDEX IF NOT EXISTS locations_partner ON locations(partner_id);
CREATE INDEX IF NOT EXISTS movements_location ON movements(location_id);
CREATE INDEX IF NOT EXISTS users_role ON users(role_id);
