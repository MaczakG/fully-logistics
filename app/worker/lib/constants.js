// Status labels and other fixed lists. Served to the browser by GET /api/meta, so the labels and
// chip colours are defined once. tone: neutral | info | accent | ok | warn | danger

export const STATUSES = {
  inbound: {
    expected: { label: 'Várható', tone: 'info' },
    arrived: { label: 'Megérkezett', tone: 'accent' },
    receiving: { label: 'Átvétel alatt', tone: 'warn' },
    completed: { label: 'Betárolva', tone: 'ok' },
    cancelled: { label: 'Sztornózva', tone: 'neutral' },
  },
  order: {
    new: { label: 'Új', tone: 'info' },
    hold: { label: 'Felfüggesztve', tone: 'warn' },
    picking: { label: 'Komissió alatt', tone: 'accent' },
    packed: { label: 'Feladásra kész', tone: 'ok' },
    shipped: { label: 'Feladva', tone: 'neutral' },
    delivered: { label: 'Kézbesítve', tone: 'ok' },
    returned: { label: 'Visszáru', tone: 'warn' },
    cancelled: { label: 'Sztornózva', tone: 'danger' },
  },
  wave: {
    open: { label: 'Nyitott', tone: 'info' },
    picking: { label: 'Kiszedés alatt', tone: 'accent' },
    picked: { label: 'Kiszedve, csomagolásra vár', tone: 'warn' },
    completed: { label: 'Lezárva', tone: 'ok' },
    cancelled: { label: 'Megszakítva', tone: 'neutral' },
  },
  count: {
    open: { label: 'Nyitott', tone: 'info' },
    counting: { label: 'Számlálás alatt', tone: 'accent' },
    counted: { label: 'Számlálva, könyvelésre vár', tone: 'warn' },
    posted: { label: 'Könyvelve', tone: 'ok' },
    cancelled: { label: 'Törölve', tone: 'neutral' },
  },
  pickup: {
    planned: { label: 'Tervezett', tone: 'info' },
    arrived: { label: 'Futár a rámpán', tone: 'accent' },
    closed: { label: 'Elszállítva', tone: 'ok' },
    cancelled: { label: 'Törölve', tone: 'neutral' },
  },
  transport: {
    requested: { label: 'Ajánlatkérés', tone: 'info' },
    booked: { label: 'Lefoglalva', tone: 'accent' },
    in_transit: { label: 'Úton', tone: 'warn' },
    delivered: { label: 'Leszállítva', tone: 'ok' },
    cancelled: { label: 'Törölve', tone: 'neutral' },
  },
  statement: {
    draft: { label: 'Piszkozat', tone: 'info' },
    approved: { label: 'Jóváhagyva', tone: 'accent' },
    invoiced: { label: 'Számlázva', tone: 'ok' },
    void: { label: 'Érvénytelenítve', tone: 'neutral' },
  },
  quote: {
    draft: { label: 'Piszkozat', tone: 'info' },
    sent: { label: 'Elküldve', tone: 'accent' },
    accepted: { label: 'Elfogadva', tone: 'ok' },
    rejected: { label: 'Elutasítva', tone: 'neutral' },
  },
  contract: {
    draft: { label: 'Előkészítés', tone: 'info' },
    active: { label: 'Hatályos', tone: 'ok' },
    terminated: { label: 'Felmondva', tone: 'warn' },
    expired: { label: 'Lejárt', tone: 'neutral' },
  },
  partner: {
    active: { label: 'Aktív', tone: 'ok' },
    inactive: { label: 'Inaktív', tone: 'neutral' },
  },
};

export const PARTNER_TYPES = {
  client: 'Ügyfél',
  carrier: 'Fuvarozó',
  supplier: 'Beszállító',
};

export const CARRIERS = {
  gls: 'GLS',
  dpd: 'DPD',
  foxpost: 'Foxpost',
  mpl: 'MPL (Magyar Posta)',
  dhl: 'DHL',
  other: 'Egyéb',
};

export const WEBSHOP_PLATFORMS = {
  shopify: 'Shopify',
  woocommerce: 'WooCommerce',
  shoprenter: 'Shoprenter',
  unas: 'UNAS',
};

export const MOVEMENT_TYPES = {
  inbound: 'Betárolás',
  pick: 'Kiszedés',
  return: 'Visszáru',
  adjust: 'Korrekció',
  transfer_out: 'Áttárolás (ki)',
  transfer_in: 'Áttárolás (be)',
  cancel_pick: 'Kiszedés visszavonása',
};

export const LOCATION_KINDS = {
  storage: 'Tárolóhely',
  receiving: 'Áruátvételi zóna',
  packing: 'Csomagolóhely',
  returns: 'Visszáru zóna',
  quarantine: 'Karantén (zárolt)',
};

// Flat tariff keys with label and unit, in the order the Tarifák tab and the calculator show them.
// Storage prices per location size are separate (partner_storage_prices).
export const TARIFFS = [
  { key: 'order_base', label: 'Alap rendeléskezelés', unit: 'Ft / rendelés', group: 'handling' },
  { key: 'item_2', label: '2. termék', unit: 'Ft', group: 'handling' },
  { key: 'item_3', label: '3. termék', unit: 'Ft', group: 'handling' },
  { key: 'item_extra', label: '4. és további termék', unit: 'Ft / db', group: 'handling' },
  { key: 'packaging', label: 'Csomagolóanyag', unit: 'Ft / rendelés', group: 'handling' },
  { key: 'inbound_unit', label: 'Betárolás', unit: 'Ft / db', group: 'inbound' },
  { key: 'return_unit', label: 'Visszáru kezelése', unit: 'Ft / csomag', group: 'inbound' },
  { key: 'hourly_work', label: 'Óradíjas munka (szettképzés, átcímkézés)', unit: 'Ft / óra', group: 'extra' },
  { key: 'cod_fixed', label: 'Utánvétkezelés, fix', unit: 'Ft / utánvétes rendelés', group: 'extra' },
  { key: 'cod_pct', label: 'Utánvétkezelés, arányos', unit: '% az utánvét összegéből', group: 'extra' },
  { key: 'discount_handling_pct', label: 'Kedvezmény a rendeléskezelésből', unit: '%', group: 'discount' },
  { key: 'discount_storage_pct', label: 'Kedvezmény a tárolásból', unit: '%', group: 'discount' },
  { key: 'vat_pct', label: 'ÁFA', unit: '%', group: 'vat' },
];
