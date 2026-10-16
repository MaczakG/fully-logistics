# Fully Logistics WMS (app.fully.hu)

Raktárkezelő és adminisztrációs rendszer a Fully Logistics munkatársainak: betárolás, megrendelések, komissió, leltár, készlet, rendeléstörténet, fuvarszervezés, partnerek tarifákkal, ajánlatkészítő, havi elszámolás és számlázás, beállítások, felhasználók és jogosultsági mátrix.

Egy Cloudflare Worker szolgálja ki az API-t és a felületet, az adatok a Cloudflare D1 adatbázisban, a fájlok (szerződések, címkék, számlák) az R2 tárhelyen vannak. A weboldal (fully.hu) ettől függetlenül, a repó gyökeréből települ.

Fejlesztői leírás: [DEVELOPING.md](DEVELOPING.md). Partner API dokumentáció: [docs/partner-api.md](docs/partner-api.md), élesben a `https://app.fully.hu/api/v1/docs` címen.

## Egyszeri beállítás a Cloudflare-en

Ehhez Cloudflare fiók kell, amelyben a `fully.hu` domain is kezelve van (a DNS a Cloudflare-en). Ha a domain még nincs a Cloudflare-en: **Add a domain**, majd a domainregisztrálónál a névszervereket a Cloudflare által mutatottakra kell állítani.

### 1. Workers Paid csomag (5 USD/hó)

**Workers & Pages > Plans**: a Workers Paid csomag kell, mert az ingyenes csomag kérésenként csak 10 ms processzoridőt enged, a biztonságos jelszó-ellenőrzésnek ennél több kell.

### 2. D1 adatbázis

**Storage & Databases > D1 SQL Database > Create Database**: név `fully-app`, helyként (Location) válaszd az **Eastern Europe** lehetőséget. A létrehozás után másold ki a **Database ID**-t, és írd be az `app/wrangler.jsonc` fájlba a `REPLACE_WITH_D1_DATABASE_ID` helyére (vagy küldd el, és beírom).

### 3. R2 tárhely

**Storage & Databases > R2 Object Storage**: ha még nincs bekapcsolva, kapcsold be (fizetési adat kell hozzá, de havi 10 GB ingyenes). **Create bucket**: név `fully-app-files`, hely **Eastern Europe**.

### 4. A Worker létrehozása a GitHub repóból

**Workers & Pages > Create > Import a repository**: válaszd a `MaczakG/fully-logistics` repót, és állítsd be:

| Beállítás | Érték |
| --- | --- |
| Project name | `fully-app` |
| Root directory | `app` |
| Build command | `npm run build` |
| Deploy command | `npm run deploy` |
| Build watch paths (Include) | `app/*`, `assets/fonts/*`, `src/icons/*` |

A `npm run deploy` először lefuttatja az adatbázis-migrációkat, utána telepíti az új verziót. Ha egy migráció hibás, a telepítés leáll, és a régi verzió fut tovább.

### 5. Jogosultság a migrációkhoz

A Workers Builds automatikusan létrehozott API tokenje alapból nem fér hozzá a D1 adatbázishoz. **My Profile > API Tokens**: keresd meg a Workers Builds tokenjét, **Edit**, és adj hozzá egy sort: **Account > D1 > Edit**. Mentés után indítsd újra a buildet (**Deployments > Retry build**).

### 6. Titkok

**Workers & Pages > fully-app > Settings > Variables and Secrets > Add**, típus **Secret**:

| Név | Érték |
| --- | --- |
| `SETUP_TOKEN` | egy hosszú, véletlenszerű jelszó. Ezzel hozod létre az első adminisztrátort. |
| `ENCRYPTION_KEY` | 32 véletlen bájt base64 kódolással. Ezzel titkosítja a rendszer a futár-, webshop- és számlázó-hozzáféréseket. Létrehozás: `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` |

Az `ENCRYPTION_KEY` értékét őrizd meg biztonságos helyen. Ha elveszik vagy megváltozik, a mentett hozzáféréseket újra meg kell adni.

### 7. Domain

Az `app/wrangler.jsonc` beállítja az `app.fully.hu` egyéni domaint, a Cloudflare az első sikeres telepítéskor hozza létre (a DNS-rekorddal és a tanúsítvánnyal együtt). Amíg ez nincs meg, az app a `fully-app.<fiókod>.workers.dev` címen is elérhető.

A weboldalhoz: **Workers & Pages > fully-logistics > Settings > Domains & Routes > Add > Custom domain**: `fully.hu`, és ugyanígy `www.fully.hu`. Érdemes a weboldal Workerjénél a **Build watch paths** alatt kizárni az `app/*` útvonalat (Exclude), hogy az app változásai ne telepítsék újra a weboldalt.

### 8. Első belépés

Nyisd meg a `https://app.fully.hu` címet. Az első indításkor a rendszer a `SETUP_TOKEN` értékét kéri, és létrehozza az első adminisztrátort. Utána érdemes ebben a sorrendben haladni:

1. **Beállítások > Cégadatok**: a saját cégadatok (ajánlatokon és számlákon jelennek meg).
2. **Beállítások > Raktárhelyek**: a méretek (M, L, XL, Raklaphely, bővíthető) és a raktárhelyek, tömeges létrehozással.
3. **Beállítások > Alap tarifák**: a listaárak. Az új partnerek és ajánlatok ezekből indulnak.
4. **Beállítások > Futárszolgálatok** és **Számlázó**: a hozzáférések, amikor megvannak.
5. **Partnerek**: ügyfelek, fuvarozók, beszállítók. Az ügyfeleknél a Tarifák és az Integrációk fül.
6. **Felhasználók**: a munkatársak és a Jogosultságok fülön a szerepkörök jogai.

## Helyi futtatás

```bash
cd app
npm install
cp .dev.vars.example .dev.vars
npm run dev      # http://localhost:8787, telepítési kód: local-setup-token
npm test
```

## Időzített feladatok

- 10 percenként: új rendelések letöltése a bekötött webshopokból, a feladott csomagok nyomkövetési számának visszaküldése és (ha be van kapcsolva) a készlet visszaküldése a webshopba.
- Óránként: a napi tárhely-pillanatkép (a napi arányos tárolási díjhoz). 23 óra után egyszer rögzíti az adott napot.
- Óránként: a feladott csomagok kézbesítési állapotának lekérdezése a futároktól (a kézbesített rendelések „Kézbesítve” állapotba kerülnek).

## Ajánlott: kéréskorlát a partner API-ra

Az API kulcsonként percenként 120 kérést enged. A kulcs nélküli kéréseket is érdemes a Cloudflare-en korlátozni: **fully.hu zóna > Security > WAF > Rate limiting rules > Create rule**. Feltétel: *Hostname* egyenlő `app.fully.hu` és *URI Path* kezdete `/api/v1/`. Korlát: 300 kérés / 1 perc IP-címenként, művelet: *Block*, 1 percre.

## Amit élesben kell először kipróbálni

A külső rendszerek kapcsolatait a hivatalos dokumentációjuk alapján építettük meg, és tesztszerverekkel ellenőriztük. Valódi hozzáféréssel még nem futottak, ezért az első használatkor érdemes egy-egy próbát tenni.

- **Futárok (GLS, DPD, Foxpost, MPL, DHL):** **Beállítások > Futárszolgálatok > Kapcsolat tesztelése**, utána egy próbacímke egy belső címre. Ahol van, a futár tesztrendszerét (a „Tesztrendszer” kapcsolót) használd először. Az MPL-nél a futárátvétel lezárása a Magyar Posta napi zárását is elvégzi, a feladójegyzék PDF-et a futárátvétel oldalán találod.
- **Számlázó (Számlázz.hu, Billingo):** egy próbaelszámolás jóváhagyása és kiszámlázása. A Számlázz.hu-nál díjbekérő vagy teszt Számla Agent kulccsal, a Billingónál egy teszt fiókkal. Figyeld a kedvezménysorokat (negatív tételek) és a kerekítést.
- **Webshopok (Shopify, WooCommerce, Shoprenter, UNAS):** a partner **Integrációk** fülén a kapcsolat felvétele, **Kapcsolat tesztelése**, majd **Szinkronizálás most**. A Shoprenter API-ban nincs nyomkövetési szám mező, ott a rendelés állapota változik, és kérésre a megjegyzésbe kerül a szám. Az UNAS néhány hibás belépés után letiltja az IP-címet, ezért ott hibás kulcsot nem próbálunk újra magától.

## Könyvelővel egyeztetendő

- **Teljesítési dátum** a havi számlákon: alapból a fizetési határidő, legfeljebb a hónap végét követő 60. nap (Áfa tv. 58. §). **Beállítások > Számlázó** alatt átállítható.
- **Tárolási díj:** csak a tároló és a karantén raktárhelyek számítanak, az átvételi, csomagoló és visszáru zóna nem.
- **Utánvét kezelési díj (%):** csak a forintos utánvét összegéből számolunk, és a visszaküldött rendelések is beleszámítanak.
