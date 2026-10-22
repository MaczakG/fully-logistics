# Fully Logistics partner API

Ezzel az API-val a saját rendszeredből (webshop, ERP, raktárkezelő) közvetlenül adhatsz fel rendeléseket és várható beszállításokat a Fully Logistics raktárába, követheted a rendelések állapotát és csomagszámát, lekérdezheted a készletedet, és karbantarthatod a cikktörzsedet.

- Cím: `https://app.fully.hu/api/v1`
- Formátum: JSON, UTF-8 kódolással
- Verzió: v1. Új mezők megjelenhetnek a válaszokban, ezért a kliensed hagyja figyelmen kívül azokat, amelyeket nem ismer. Visszafelé nem kompatibilis változás csak új verziószámmal (v2) jön.

Ez a dokumentáció a `https://app.fully.hu/api/v1/docs` címen is elérhető, API kulcs nélkül.

## Gyors kezdés

1. Kérj API kulcsot a kapcsolattartódtól. A kulcsot egyszer, a létrehozáskor mutatjuk meg, ezért rögtön mentsd el biztonságos helyre.
2. Próbáld ki, hogy működik:

```bash
curl https://app.fully.hu/api/v1/me \
  -H "Authorization: Bearer flk_IDE_JON_A_KULCSOD"
```

```json
{
  "partner": { "code": "KUTYA", "name": "Kutyabarát Webshop Kft." },
  "rate_limit": { "per_minute": 120 }
}
```

3. Töltsd fel a termékeidet (`PUT /products/{sku}`), add fel az első rendelést (`POST /orders`), és figyeld az állapotát (`GET /orders/{ref}`).

## Hitelesítés

Minden kérésben küldd el az API kulcsot a `Authorization` fejlécben, Bearer sémával:

```
Authorization: Bearer flk_9mJbV3l0Qe1sZb8yWcXo4tA7uR2nK5pD6hF0gL1iM3q
```

- A kulcs `flk_` előtaggal kezdődik. Egy kulcs mindig egy ügyfélhez tartozik, és csak annak az ügyfélnek az adatait látja és módosítja.
- A kulcsot csak szerveroldalon használd. Ne tedd böngészőben futó kódba, mobilalkalmazásba vagy nyilvános tárolóba.
- Több kulcsod is lehet (például éles rendszer és tesztkörnyezet). Ha egy kulcs kiszivárgott, szólj, és visszavonjuk; a visszavont kulcs azonnal érvénytelen.
- Hiányzó, hibás vagy visszavont kulcs esetén `401` a válasz:

```json
{ "error": { "code": "unauthorized", "message": "Hiányzó vagy érvénytelen API kulcs." } }
```

## Kérések és válaszok

- A törzzsel küldött kéréseknél (`POST`, `PUT`) add meg a `Content-Type: application/json` fejlécet.
- Időpontok ISO 8601 formátumban, UTC időzónában: `2026-10-16T08:30:00.000Z`. Bemenetként bármilyen ISO 8601 időpontot elfogadunk időzónával (például `2026-10-16T10:30:00+02:00`).
- Naptári dátumok `ÉÉÉÉ-HH-NN` formátumban (például `2026-10-20`), budapesti idő szerint.
- Mennyiségek egész számok (darab). Pénzösszegek számok, a pénznem külön mezőben van (alapból `HUF`).
- Az URL-be kerülő cikkszámot és azonosítót URL-kódold (például a `/` helyett `%2F`).
- Ismeretlen mezőt a kérés törzsében nem fogadunk el (`400`, a mező nevével). Így egy elgépelt mezőnév nem vész el csendben.

## Hibák

Hiba esetén a válasz HTTP státuszkódja jelzi a hiba fajtáját, a törzs pedig mindig ilyen szerkezetű:

```json
{
  "error": {
    "code": "bad_request",
    "message": "Ellenőrizd a rendelés tételeit.",
    "fields": { "lines.1.sku": "Ismeretlen cikkszám: KB-9999" }
  }
}
```

A `message` magyar nyelvű, embernek szóló leírás. A `fields` csak mezőhibáknál szerepel: a kulcs a hibás mező (tételeknél `lines.<sorszám>.<mező>`, a sorszám 0-tól indul), az érték a hiba.

| HTTP | code | Mikor |
| --- | --- | --- |
| 400 | `bad_request` | Hibás JSON, hiányzó vagy érvénytelen mező, ismeretlen cikkszám, ismeretlen mező. |
| 401 | `unauthorized` | Hiányzó, hibás vagy visszavont API kulcs. |
| 404 | `not_found` | Nincs ilyen végpont, termék, rendelés vagy betárolás (a sajátjaid között). |
| 405 | `method_not_allowed` | A végpont létezik, de ezzel a metódussal nem hívható. |
| 409 | `conflict` | A művelet az aktuális állapotban nem végezhető el (például már komissió alatt lévő rendelés sztornója). |
| 429 | `rate_limited` | Túl sok kérés, lásd a [Kéréskorlát](#kereskorlat) részt. |
| 500 | `server_error` | Váratlan hiba nálunk. Az üzenetben lévő azonosítóval keress minket. |

Hálózati hiba vagy `5xx` válasz esetén nyugodtan próbáld újra a kérést: a rendelés és a betárolás létrehozása idempotens (lásd lent).

## Lapozás

A listák (`GET /products`, `/stock`, `/orders`, `/inbounds`) így válaszolnak:

```json
{
  "items": [ { "...": "..." } ],
  "total": 1342,
  "next_cursor": "eyJ1IjoiMjAyNi0xMC0xNlQwODozMDowMC4wMDBaIiwiaSI6NDJ9"
}
```

- `limit`: hány elem jöjjön egy oldalon (alapból 50, legfeljebb 200; a készletnél alapból 100, legfeljebb 500).
- `next_cursor`: a következő oldal kulcsa. Add át változtatás nélkül a `cursor` paraméterben, a többi szűrőt pedig hagyd ugyanúgy. Ha `null`, nincs több oldal.
- `total`: a szűrőknek megfelelő elemek száma összesen.

```bash
curl "https://app.fully.hu/api/v1/orders?status=shipped&limit=100&cursor=eyJ1IjoiMjAyNi0x..." \
  -H "Authorization: Bearer $FLK_KEY"
```

A cursor alapú lapozás akkor is pontos, ha lapozás közben új elemek jönnek létre vagy módosulnak.

## Kéréskorlát

API kulcsonként percenként legfeljebb **120 kérést** fogadunk (naptári percenként számolva). Minden válaszban látod, hol tartasz:

| Fejléc | Jelentés |
| --- | --- |
| `X-RateLimit-Limit` | A percenkénti keret (120). |
| `X-RateLimit-Remaining` | Ebben a percben még ennyi kérés fér bele. |
| `X-RateLimit-Reset` | Unix időbélyeg (másodperc), amikor a keret újraindul. |

Ha túlléped, `429` a válasz egy `Retry-After` fejléccel (másodpercben); ennyit várj, mielőtt újrapróbálod. Tömeges feladatnál (például több ezer termék feltöltése) küldd a kéréseket egymás után, ne párhuzamosan.

## Idempotencia

Új rendelést és új betárolást **biztonságosan újraküldhetsz**: a saját azonosítód alapján ismerjük fel, ha már megkaptuk.

- Rendelésnél az `external_id`, betárolásnál az `external_ref` kötelező. Ügyfelenként egyedinek kell lennie (például a webshopod rendelésazonosítója).
- Első beküldéskor `201 Created` a válasz az új rendeléssel.
- Ugyanazzal az azonosítóval újra beküldve `200 OK` a válasz, és a már meglévő rendelést kapod vissza változatlanul; új rendelés nem jön létre. Ez akkor is így van, ha közben a tartalmat megváltoztattad: módosítani nem lehet így a rendelést.
- Ha a kérésed időtúllépés vagy hálózati hiba miatt bizonytalan kimenetelű, egyszerűen küldd el újra ugyanazzal az azonosítóval.

## Termékek

A cikktörzsed: csak olyan cikkszámra adhatsz fel rendelést és betárolást, amely itt szerepel.

| Mező | Típus | Leírás |
| --- | --- | --- |
| `sku` | szöveg | Cikkszám, legfeljebb 120 karakter. Ügyfelenként egyedi, a kis és nagybetű számít. |
| `name` | szöveg | Megnevezés, legfeljebb 200 karakter. Új terméknél kötelező. |
| `ean` | szöveg | Vonalkód (EAN, GTIN), legfeljebb 64 karakter: számjegy, betű, pont, kötőjel, aláhúzás. |
| `unit` | szöveg | Mennyiségi egység, alapból `db`. |
| `weight_kg` | szám vagy null | Tömeg kilogrammban. |
| `width_cm`, `depth_cm`, `height_cm` | szám vagy null | Méretek centiméterben. |
| `min_stock` | egész | Minimumkészlet, ez alatt figyelmeztetünk. Alapból 0. |
| `active` | logikai | Csak olvasható. Inaktív termékre nem adható fel rendelés. |
| `created_at`, `updated_at` | időpont | Csak olvasható. |

### GET /products

Szűrők: `sku` (vesszővel elválasztva legfeljebb 100 cikkszám), `active` (`1` vagy `0`), `updated_since` (időpont, az ennél nem régebben módosultak), valamint `limit` és `cursor`. Cikkszám szerint rendezve.

```bash
curl "https://app.fully.hu/api/v1/products?limit=2" -H "Authorization: Bearer $FLK_KEY"
```

```json
{
  "items": [
    {
      "sku": "KB-1001", "name": "Prémium kutyatáp 12 kg", "ean": "5990000010015", "unit": "db",
      "weight_kg": 12, "width_cm": null, "depth_cm": null, "height_cm": null, "min_stock": 20,
      "active": true, "created_at": "2026-10-01T09:12:44.120Z", "updated_at": "2026-10-01T09:12:44.120Z"
    },
    {
      "sku": "KB-1002", "name": "Macskaalom 10 l", "ean": "5990000010022", "unit": "db",
      "weight_kg": 6, "width_cm": null, "depth_cm": null, "height_cm": null, "min_stock": 10,
      "active": true, "created_at": "2026-10-01T09:12:44.120Z", "updated_at": "2026-10-01T09:12:44.120Z"
    }
  ],
  "total": 3,
  "next_cursor": "eyJzIjoiS0ItMTAwMiJ9"
}
```

### GET /products/{sku}

Egy termék a fenti szerkezetben, vagy `404`, ha nincs ilyen cikkszámod.

### PUT /products/{sku}

Létrehozza vagy módosítja a terméket. Új termék esetén `201 Created`, meglévőnél `200 OK` a válasz, mindkét esetben a termékkel. Meglévő terméknél csak az elküldött mezők változnak, a többi marad. Ha a törzsben is megadod a `sku` mezőt, egyeznie kell az URL-ben lévővel.

```bash
curl -X PUT "https://app.fully.hu/api/v1/products/KB-2001" \
  -H "Authorization: Bearer $FLK_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "name": "Jutalomfalat 200 g", "ean": "5990000020014", "weight_kg": 0.25, "min_stock": 30 }'
```

```json
{
  "sku": "KB-2001", "name": "Jutalomfalat 200 g", "ean": "5990000020014", "unit": "db",
  "weight_kg": 0.25, "width_cm": null, "depth_cm": null, "height_cm": null, "min_stock": 30,
  "active": true, "created_at": "2026-10-16T08:30:00.000Z", "updated_at": "2026-10-16T08:30:00.000Z"
}
```

Terméket törölni vagy inaktiválni az API-n nem lehet; ezt kérd a kapcsolattartódtól.

## Készlet

| Mező | Leírás |
| --- | --- |
| `on_hand` | A raktárban lévő teljes mennyiség (a zárolt mennyiséggel együtt). |
| `blocked` | Zárolt mennyiség (karanténban, például sérült vagy ellenőrzésre váró áru). |
| `reserved` | A még ki nem szedett nyitott rendelésekre foglalt mennyiség (új, felfüggesztett és komissió alatti rendelések). |
| `available` | Szabad készlet: `on_hand - blocked - reserved`. Negatív is lehet, ha a nyitott rendelések több árut kérnek, mint amennyi szabad. |

### GET /stock

Minden aktív termék (és az inaktívak közül azok, amelyekből van még készlet), cikkszám szerint rendezve. Szűrők: `sku` (vesszővel elválasztva legfeljebb 100), `limit` (alapból 100, legfeljebb 500), `cursor`.

```bash
curl "https://app.fully.hu/api/v1/stock?sku=KB-1001,KB-1002" -H "Authorization: Bearer $FLK_KEY"
```

```json
{
  "items": [
    { "sku": "KB-1001", "name": "Prémium kutyatáp 12 kg", "on_hand": 50, "reserved": 2, "blocked": 0, "available": 48 },
    { "sku": "KB-1002", "name": "Macskaalom 10 l", "on_hand": 25, "reserved": 0, "blocked": 0, "available": 25 }
  ],
  "total": 2,
  "next_cursor": null
}
```

### GET /stock/{sku}

Egy cikkszám készlete, tételenként (gyártási tétel és lejárat szerint) is:

```json
{
  "sku": "KB-1001", "name": "Prémium kutyatáp 12 kg", "on_hand": 50, "reserved": 2, "blocked": 0, "available": 48,
  "lots": [
    { "lot": "L2409", "expiry": "2027-01-31", "qty": 10, "blocked": 0 },
    { "lot": "L2410", "expiry": "2027-03-31", "qty": 40, "blocked": 0 }
  ]
}
```

## Rendelések

### POST /orders

Új kiszállítandó rendelés. A tételeket cikkszám szerint add meg; a cikkszámnak szerepelnie kell a termékeid között.

| Mező | Típus | Leírás |
| --- | --- | --- |
| `external_id` | szöveg, kötelező | A te azonosítód, legfeljebb 120 karakter. Erre épül az idempotencia. |
| `external_number` | szöveg | A vevő által látott rendelésszám (a csomagcímkén és a kísérőlapon szerepelhet). |
| `priority` | `normal` vagy `express` | Expressz rendelést előbb komissiózunk. Alapból `normal`. |
| `customer_name` | szöveg, kötelező | A címzett neve, legfeljebb 200 karakter. |
| `company` | szöveg | Cégnév. |
| `email` | szöveg | A címzett e-mail címe (a futár értesítéséhez). |
| `phone` | szöveg | A címzett telefonszáma (a futár értesítéséhez). |
| `country` | szöveg | Kétbetűs országkód (ISO 3166-1), alapból `HU`. |
| `zip`, `city`, `address` | szöveg | Szállítási cím: irányítószám, település, utca és házszám. |
| `pickup_point_id` | szöveg | Csomagpont vagy csomagautomata azonosítója, ha oda kéri a vevő. |
| `carrier_code` | szöveg | Futár: `gls`, `dpd`, `foxpost`, `mpl`, `dhl` vagy `other`. Üresen a szerződés szerinti alapértelmezett futárral megy. |
| `carrier_service` | szöveg | Futárszolgáltatás kódja, ha nem az alapszolgáltatás kell. MPL: kézbesítési mód (`HA` házhoz, `PM` postán maradó, `PP` PostaPont, `CS` csomagautomata); GLS: kiegészítő szolgáltatás (például `T12`); DPD: háromjegyű szolgáltatáskód; DHL: termékkód. Üresen a szerződés szerinti alapszolgáltatással megy. |
| `cod_amount` | szám | Utánvét összege; 0 vagy hiányzik, ha nincs utánvét. |
| `currency` | szöveg | Az utánvét pénzneme, alapból `HUF`. |
| `note` | szöveg | Megjegyzés a rendeléshez, legfeljebb 2000 karakter. |
| `ordered_at` | időpont | Mikor rendelt a vevő. |
| `lines` | lista, kötelező | Legalább egy tétel, legfeljebb 1000. |

A tételek (`lines`) mezői:

| Mező | Típus | Leírás |
| --- | --- | --- |
| `sku` | szöveg, kötelező | Cikkszám a termékeid közül. |
| `qty` | egész, kötelező | Mennyiség, 1 és 100000 között. |
| `external_line_id` | szöveg | A tétel azonosítója a te rendszeredben. |

```bash
curl -X POST "https://app.fully.hu/api/v1/orders" \
  -H "Authorization: Bearer $FLK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_id": "WEB-100045",
    "external_number": "#100045",
    "customer_name": "Minta Mária",
    "email": "maria@example.com",
    "phone": "+36301234567",
    "zip": "1111",
    "city": "Budapest",
    "address": "Fő utca 1.",
    "carrier_code": "gls",
    "cod_amount": 12990,
    "lines": [
      { "sku": "KB-1001", "qty": 1 },
      { "sku": "KB-1003", "qty": 2, "external_line_id": "L2" }
    ]
  }'
```

Válasz (`201 Created`, ismételt beküldésnél `200 OK`):

```json
{
  "number": "R-2026-000123",
  "external_id": "WEB-100045",
  "external_number": "#100045",
  "source": "api",
  "status": "new",
  "status_label": "Új",
  "priority": "normal",
  "customer_name": "Minta Mária",
  "company": "",
  "email": "maria@example.com",
  "phone": "+36301234567",
  "country": "HU",
  "zip": "1111",
  "city": "Budapest",
  "address": "Fő utca 1.",
  "pickup_point_id": "",
  "carrier_code": "gls",
  "carrier_name": "GLS General Logistics Systems Hungary Kft.",
  "carrier_service": "",
  "cod_amount": 12990,
  "currency": "HUF",
  "note": "",
  "package_count": 1,
  "weight_kg": null,
  "tracking_number": "",
  "tracking_url": "",
  "ordered_at": null,
  "created_at": "2026-10-16T08:30:00.000Z",
  "updated_at": "2026-10-16T08:30:00.000Z",
  "packed_at": null,
  "shipped_at": null,
  "delivered_at": null,
  "cancelled_at": null,
  "lines": [
    { "sku": "KB-1001", "name": "Prémium kutyatáp 12 kg", "qty": 1, "picked_qty": 0, "external_line_id": "" },
    { "sku": "KB-1003", "name": "Rágócsont, 3 db", "qty": 2, "picked_qty": 0, "external_line_id": "L2" }
  ]
}
```

Ismeretlen vagy inaktív cikkszám esetén `400` a válasz, a hibás tételt a `fields` mutatja (például `"lines.1.sku": "Ismeretlen cikkszám: KB-9999"`), és nem jön létre rendelés.

### GET /orders

A rendeléseid a módosítás ideje szerint növekvő sorrendben (a legrégebben módosult elöl), így a lista végigolvasásával minden változást megkapsz.

Szűrők:

- `status`: egy vagy több állapot vesszővel elválasztva, például `status=shipped,delivered` (lásd [Állapotok](#allapotok)).
- `updated_since`: csak az ennél az időpontnál nem régebben módosult rendelések.
- `limit`, `cursor`: lapozás.

```bash
curl "https://app.fully.hu/api/v1/orders?updated_since=2026-10-16T00:00:00Z&status=shipped" \
  -H "Authorization: Bearer $FLK_KEY"
```

Az elemek szerkezete ugyanaz, mint a `POST /orders` válaszában.

### GET /orders/{ref}

Egy rendelés a mi rendelésszámunk (`R-2026-000123`) vagy a te `external_id` azonosítód alapján. Feladás után itt látod a csomagszámot (`tracking_number`) és, ha a futárnál ismert, a nyomkövetési linket (`tracking_url`).

```bash
curl "https://app.fully.hu/api/v1/orders/WEB-100045" -H "Authorization: Bearer $FLK_KEY"
```

### POST /orders/{ref}/cancel

Sztornózza a rendelést, amíg még nem kezdtük el a komissiózást (állapota `new` vagy `hold`). Törzs nélkül is hívható; opcionálisan megadhatod az okát:

```bash
curl -X POST "https://app.fully.hu/api/v1/orders/WEB-100045/cancel" \
  -H "Authorization: Bearer $FLK_KEY" \
  -H "Content-Type: application/json" \
  -d '{ "reason": "A vevő visszamondta" }'
```

- Sikeres sztornó után a válasz a rendelés `cancelled` állapottal.
- Már sztornózott rendelésnél ugyanez a válasz, hiba nélkül (az ismételt hívás biztonságos).
- Ha a rendelés már komissió alatt van, vagy annál előrébb jár, `409 Conflict` a válasz; ilyenkor keresd az ügyfélszolgálatunkat, és megnézzük, megállítható-e még.

## Betárolások

Előre jelezd a raktárba érkező szállításokat (ASN): így gyorsabban és pontosabban vesszük át az árut, és az eltéréseket is látod.

### POST /inbounds

| Mező | Típus | Leírás |
| --- | --- | --- |
| `external_ref` | szöveg, kötelező | A te azonosítód (szállítólevél vagy ASN szám), legfeljebb 120 karakter. Erre épül az idempotencia. |
| `expected_date` | dátum | A várható érkezés napja (`ÉÉÉÉ-HH-NN`). |
| `pallets` | egész | Raklapok száma. |
| `cartons` | egész | Kartonok száma. |
| `note` | szöveg | Megjegyzés, legfeljebb 2000 karakter. |
| `lines` | lista, kötelező | Legalább egy tétel. |

A tételek mezői: `sku` (kötelező), `expected_qty` (egész, kötelező), `lot` (gyártási tétel), `expiry` (lejárat, `ÉÉÉÉ-HH-NN`), `note`.

```bash
curl -X POST "https://app.fully.hu/api/v1/inbounds" \
  -H "Authorization: Bearer $FLK_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "external_ref": "SZL-2026-0815",
    "expected_date": "2026-10-20",
    "pallets": 2,
    "lines": [
      { "sku": "KB-1001", "expected_qty": 120, "lot": "L2411", "expiry": "2027-05-31" },
      { "sku": "KB-1002", "expected_qty": 60 }
    ]
  }'
```

Válasz (`201 Created`, ismételt beküldésnél `200 OK`):

```json
{
  "number": "BT-2026-00042",
  "external_ref": "SZL-2026-0815",
  "source": "api",
  "status": "expected",
  "status_label": "Várható",
  "expected_date": "2026-10-20",
  "arrived_at": null,
  "completed_at": null,
  "pallets": 2,
  "cartons": 0,
  "note": "",
  "has_discrepancy": false,
  "created_at": "2026-10-16T08:30:00.000Z",
  "updated_at": "2026-10-16T08:30:00.000Z",
  "lines": [
    { "sku": "KB-1001", "name": "Prémium kutyatáp 12 kg", "expected_qty": 120, "received_qty": 0, "damaged_qty": 0, "lot": "L2411", "expiry": "2027-05-31" },
    { "sku": "KB-1002", "name": "Macskaalom 10 l", "expected_qty": 60, "received_qty": 0, "damaged_qty": 0, "lot": "", "expiry": "" }
  ]
}
```

### GET /inbounds

A betárolásaid a módosítás ideje szerint növekvő sorrendben. Szűrők: `status`, `updated_since`, `limit`, `cursor`, ugyanúgy, mint a rendeléseknél.

### GET /inbounds/{ref}

Egy betárolás a mi számunk (`BT-2026-00042`) vagy a te `external_ref` azonosítód alapján. Az átvétel után a `received_qty` és a `damaged_qty` mutatja, mi érkezett meg ténylegesen; ha eltérés volt, a `has_discrepancy` értéke `true`.

## Állapotok

Rendelések (`status`):

| Érték | Megnevezés | Jelentés |
| --- | --- | --- |
| `new` | Új | Beérkezett, komissióra vár. Még sztornózható. |
| `hold` | Felfüggesztve | Nálunk felfüggesztve (például hiányzó készlet vagy egyeztetés miatt). Még sztornózható. |
| `picking` | Komissió alatt | Szedjük a raktárban. |
| `packed` | Feladásra kész | Becsomagolva, a futárra vár. |
| `shipped` | Feladva | Átadtuk a futárnak, van csomagszáma. |
| `delivered` | Kézbesítve | A futár kézbesítette. |
| `returned` | Visszáru | Visszaérkezett hozzánk. |
| `cancelled` | Sztornózva | Nem kerül kiszállításra. |

Betárolások (`status`):

| Érték | Megnevezés | Jelentés |
| --- | --- | --- |
| `expected` | Várható | Bejelentve, még nem érkezett meg. |
| `arrived` | Megérkezett | A szállítás megérkezett, átvételre vár. |
| `receiving` | Átvétel alatt | Számoljuk és polcra tesszük. |
| `completed` | Betárolva | Az áru készleten van. |
| `cancelled` | Sztornózva | Nem érkezik meg, vagy visszavontuk. |

## Változások követése

Webhookot jelenleg nem küldünk; a változásokat a listák lekérdezésével követheted:

1. Jegyezd meg, mikor kérdeztél utoljára (vagy a legutóbb kapott elem `updated_at` értékét).
2. Néhány percenként kérdezd le: `GET /orders?updated_since=<az előző időpont>`, és lapozz végig a `next_cursor` segítségével.
3. A kapott rendeléseknél nézd meg az állapotot és a csomagszámot, majd mentsd el a legnagyobb `updated_at` értéket a következő lekérdezéshez.

Az `updated_since` határa beleszámít, ezért egy-egy rendelés kétszer is megjöhet; ezt az `external_id` vagy a `number` alapján szűrd ki. Ötpercenkénti lekérdezés bőven elég, és jól belefér a kéréskorlátba.

## Kapcsolat

Kérdés vagy hiba esetén írj a kapcsolattartódnak, és küldd el a kérés idejét, a végpontot és a válasz `message` mezőjét (500-as hibánál az azonosítót is).
