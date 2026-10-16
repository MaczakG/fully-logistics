-- Default roles, permissions, settings and location sizes. Everything here can be changed in the app.

INSERT INTO roles (id, key, name, description, is_admin) VALUES
  (1, 'admin', 'Adminisztrátor', 'Minden modulhoz teljes hozzáférés. Nem szerkeszthető.', 1),
  (2, 'warehouse_manager', 'Raktárvezető', 'Minden raktári folyamat és jóváhagyás.', 0),
  (3, 'warehouse_operator', 'Raktáros', 'Betárolás, komissió, leltárszámlálás, készlet megtekintése.', 0),
  (4, 'customer_service', 'Ügyfélszolgálat', 'Megrendelések, rendeléstörténet, fuvarszervezés, partnerek megtekintése.', 0),
  (5, 'sales', 'Értékesítő', 'Partnerek és tarifák, ajánlatkészítő, készlet megtekintése.', 0);

-- Raktárvezető: every warehouse action, read access to the commercial and admin modules.
INSERT INTO role_permissions (role_id, module, action)
SELECT 2, m.value, a.value
FROM json_each('["inbound","orders","picking","counts","stock","history","transport"]') m,
     json_each('["view","create","edit","delete","approve"]') a;
INSERT INTO role_permissions (role_id, module, action) VALUES
  (2, 'partners', 'view'), (2, 'quotes', 'view'), (2, 'billing', 'view'),
  (2, 'settings', 'view'), (2, 'users', 'view');

-- Raktáros
INSERT INTO role_permissions (role_id, module, action) VALUES
  (3, 'inbound', 'view'), (3, 'inbound', 'create'), (3, 'inbound', 'edit'),
  (3, 'orders', 'view'),
  (3, 'picking', 'view'), (3, 'picking', 'create'), (3, 'picking', 'edit'),
  (3, 'counts', 'view'), (3, 'counts', 'edit'),
  (3, 'stock', 'view'),
  (3, 'history', 'view'),
  (3, 'transport', 'view'), (3, 'transport', 'edit');

-- Ügyfélszolgálat
INSERT INTO role_permissions (role_id, module, action) VALUES
  (4, 'inbound', 'view'), (4, 'inbound', 'create'),
  (4, 'orders', 'view'), (4, 'orders', 'create'), (4, 'orders', 'edit'), (4, 'orders', 'delete'),
  (4, 'picking', 'view'),
  (4, 'stock', 'view'),
  (4, 'history', 'view'), (4, 'history', 'create'), (4, 'history', 'edit'),
  (4, 'transport', 'view'), (4, 'transport', 'create'), (4, 'transport', 'edit'),
  (4, 'partners', 'view');

-- Értékesítő
INSERT INTO role_permissions (role_id, module, action) VALUES
  (5, 'stock', 'view'),
  (5, 'history', 'view'),
  (5, 'partners', 'view'), (5, 'partners', 'create'), (5, 'partners', 'edit'), (5, 'partners', 'approve'),
  (5, 'quotes', 'view'), (5, 'quotes', 'create'), (5, 'quotes', 'edit'), (5, 'quotes', 'delete'),
  (5, 'billing', 'view');

INSERT INTO location_sizes (id, code, name, sort) VALUES
  (1, 'M', 'Polchely M', 10),
  (2, 'L', 'Polchely L', 20),
  (3, 'XL', 'Polchely XL', 30),
  (4, 'PAL', 'Raklaphely', 40);

INSERT INTO settings (key, value) VALUES
  ('company', json('{"name":"Fully Logistics","tax_number":"","company_reg_number":"","country":"HU","zip":"2351","city":"Alsónémedi","address":"Depó út 14","email":"","phone":"","bank_account":"","website":"https://fully.hu"}')),
  ('warehouse', json('{"cutoff":"14:00","open":"06:00","close":"18:00","workdays":[1,2,3,4,5],"default_carrier_code":""}')),
  ('default_tariffs', json('{"order_base":600,"item_2":80,"item_3":60,"item_extra":50,"packaging":150,"inbound_unit":49,"return_unit":499,"hourly_work":0,"cod_fixed":0,"cod_pct":0,"discount_handling_pct":0,"discount_storage_pct":0,"vat_pct":27,"storage":{"M":780,"L":990,"XL":1350,"PAL":0}}')),
  ('quote_terms', json('["Az árak nettó árak, az ÁFA-t nem tartalmazzák.","A futárszolgálat díja nem része az ajánlatnak, a szerződött futárpartner árai szerint kerül továbbszámlázásra.","A munkanapokon 14:00-ig beérkező rendeléseket még aznap feladjuk.","Hibás kiszállítás esetén a csere költségét mi álljuk.","Számlázás havonta, utólag, 8 napos fizetési határidővel.","A szerződés 30 napos felmondási idővel bármikor felmondható."]')),
  ('invoicing', json('{"provider":"","szamlazz":{"configured":false},"billingo":{"configured":false}}'));
