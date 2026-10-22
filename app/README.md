# Fully Logistics WMS (app.fully.hu)

Raktárkezelő és adminisztrációs rendszer a Fully Logistics munkatársainak: betárolás, megrendelések, komissió, leltár, készlet, rendeléstörténet, fuvarszervezés, partnerek tarifákkal, ajánlatkészítő, havi elszámolás és számlázás, beállítások, felhasználók és jogosultsági mátrix.

**Üzemeltetés: AWS Lightsail** (Frankfurt). Egy Node.js szerver szolgálja ki az API-t és a felületet. Az adatok egy SQLite adatbázisban vannak a szerveren, óránkénti mentéssel. A fájlok (szerződések, címkék, számlák) a Lightsail tárhelyen vannak, a HTTPS-t a Caddy adja. Telepítés, frissítés, domain, mentések: **[deploy/aws/README.md](deploy/aws/README.md)**. A weboldal (fully.hu) ettől függetlenül, a repó gyökeréből települ a Cloudflare-re.

Ugyanez a kód Cloudflare Workers-en (D1, R2) is fut. Ezt az alábbi, „Alternatíva” részben leírt út használja.

Fejlesztői leírás: [DEVELOPING.md](DEVELOPING.md). Partner API dokumentáció: [docs/partner-api.md](docs/partner-api.md), élesben a `/api/v1/docs` címen.

## Első belépés után

Nyisd meg az alkalmazás címét. Az első indításkor a rendszer a telepítési kódot kéri (AWS-en a `provision.mjs` írja ki), és létrehozza az első adminisztrátort. Utána érdemes a lenti 8. pont sorrendjében haladni (Cégadatok, Raktár, Raktárhelyek, Alap tarifák, Futárok és számlázó, Partnerek, Felhasználók).

## Telefonon és PDA-n

Telefonon (640 px szélességig) az app kézi terminálként működik. Belépés után a kezdőképernyő nagy ikonos csempéken mutatja azokat a modulokat, amelyekhez a szerepkör hozzáfér. A csempéken látszik, mennyi munka vár (például „1 átvételre vár”, „5 új”). A felső sávban a Vissza gomb egy szinttel feljebb, a négyzetes ikon a kezdőképernyőre visz. A táblázatok sorai kártyák, a szűrők a Szűrők gomb mögött vannak, a párbeszédablakok alulról nyílnak.

A beolvasómező mellett két gomb van:

- **Kamera:** a telefon kamerájával olvassa be a vonalkódot. Ott jelenik meg, ahol a böngésző tud vonalkódot olvasni (például Androidon a Chrome-ban, iPhone-on nem).
- **Billentyűzet:** beépített szkennerű PDA-n kikapcsolja a képernyő-billentyűzetet, így az nem takarja el a képernyőt. A beállítást az eszköz megjegyzi.

**Betárolás, átvétel:** a darabszámot be kell írni, +/− gomb nincs. Menete:

1. Olvasd be a terméket, vagy koppints a tételnél a **Mennyiség beírása** gombra.
2. Megnyílik a termék adatlapja: várt mennyiség, eddig átvett, hátralévő.
3. Írd be a beérkezett darabszámot (ha kell, jelöld a sérültet, add meg a sarzsot és a lejáratot), és nyomd meg a **Rögzítés** gombot vagy az Entert.

Amíg a mennyiséget nem rögzíted, semmi sem kerül átvételre. A termék újabb beolvasása eggyel növeli a beírt darabszámot, így darabonként is számolhatsz. Ha a vártnál több lenne az átvett mennyiség, a rendszer rákérdez. A tételnél a **Javítás** gombbal az összesített átvett és sérült mennyiség utólag átírható.

## Raktártérkép

**Készlet > Térkép**: a raktárhelyek rajza. A rendszer a helykódokból (zóna, állvány, szint, pozíció, pl. `A-01-03`) rakja össze, ahogy a Beállítások > Raktárhelyek tömeges létrehozása építi őket:
- **Elrendezés:** zónánként egymás mellett az állványok, a szintek alulról felfelé, az állvány száma alul.
- **Színek:** a foglalt hely sötét (benne az ügyfél kódja), a szabad hely üres. A fix, de üres hely szaggatott keretes, az inaktív csíkozott, a karanténhely piros keretes.
- **Szűrés:** az „Ügyfél kiemelése” sárgával mutatja egy ügyfél helyeit, és kiírja, hány helye van méretenként. A méret, a foglaltság és a hely kódja szerinti szűrés halványítja a többi helyet.
- **Részletek:** egy helyre kattintva látszik, mi van rajta (cikk, sarzs, lejárat, mennyiség), és mikor volt rajta utoljára mozgás.

A mintától eltérő kódú helyek (pl. `KARANTEN`, `RAMPA-BE`) az „Egyéb helyek” részbe kerülnek.

## Ajánlatkészítő: belső fedezetszámítás

Az ajánlat alatti „Belső fedezetszámítás” rész nem kerül az ajánlatba. Megmutatja, hány raktáros kell az ajánlott forgalomhoz, mekkora területet foglal az ügyfél áruja, mennyi raktárbérleti díj esik rá, és mennyi a havi fedezet (profit). Az alapadatokat egyszer kell megadni: **Beállítások > Raktár > Költségkalkuláció**.

- **Létszám:** a havi munkaidő a percnormákból jön. Rendelésenként, a rendelés további termékeiként, betárolt darabonként és visszárunként van egy-egy norma, ehhez jönnek az óradíjas munka órái. Ezt osztja el egy raktáros havi hasznos óráival. A bérköltség ennyi fő része egy raktáros havi költségéből.
- **Terület és bérleti díj:** az egy m²-re eső bérleti díj a havi bérleti díj osztva a bérelt alapterülettel. Méretenként (M, L, XL, raklaphely) meg kell adni az állványt:
  - egy állványrekesz alapterületét a folyosó rá eső részével együtt (m²),
  - a szintek számát,
  - és hogy hány hely van egy szinten.

  Egy hely helyigénye: alapterület / (szintek × hely szintenként). Például egy 1,1 m²-es polc, 5 szinttel és szintenként 2 hellyel: 0,11 m² helyenként. Ebből jön ki, hány hely férne el a raktárban, és mennyi egy hely havi bérleti díja. Az ügyfél tárolóhelyei ennyi területet és bérleti díjat foglalnak.
- **Fedezet:** az ajánlat havi nettó összege, mínusz a bérköltség, a helyfoglalás szerinti bérleti díj és a csomagolóanyag beszerzési ára.

Az új ajánlat a Beállítások értékeivel indul. Az ajánlatnál a „Feltételezések ennél az ajánlatnál” alatt ezek csak arra az ajánlatra átírhatók. A „Beállítások értékeinek betöltése” gomb visszahozza a Beállítások aktuális értékeit. A mentett ajánlatok a saját értékeiket tartják meg.

## Alternatíva: egyszeri beállítás a Cloudflare-en

Most nem ezt használjuk. Ehhez Cloudflare fiók kell, amelyben a `fully.hu` domain is kezelve van (a DNS a Cloudflare-en). Ha a domain még nincs a Cloudflare-en: **Add a domain**, majd a domainregisztrálónál a névszervereket a Cloudflare által mutatottakra kell állítani.

### 1. Workers Paid csomag (5 USD/hó)

**Workers & Pages > Plans**: a Workers Paid csomag kell, mert az ingyenes csomag kérésenként csak 10 ms processzoridőt enged, a biztonságos jelszó-ellenőrzésnek ennél több kell.

### 2. D1 adatbázis

**Storage & Databases > D1 SQL Database > Create Database**: név `fully-app`, helyként (Location) válaszd az **Eastern Europe** lehetőséget. Az adatbázis azonosítója (Database ID) az `app/wrangler.jsonc` fájlban van (`database_id`). Ha új adatbázist hozol létre, ott kell kicserélni.

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
2. **Beállítások > Raktár**: munkarend, és a Költségkalkuláció az ajánlatok belső fedezetszámításához (bérleti díj, alapterület, állványok szintekkel, bérköltség, percnormák).
3. **Beállítások > Raktárhelyek**: a méretek (M, L, XL, Raklaphely, bővíthető) és a raktárhelyek, tömeges létrehozással.
4. **Beállítások > Alap tarifák**: a listaárak. Az új partnerek és ajánlatok ezekből indulnak.
5. **Beállítások > Futárszolgálatok** és **Számlázó**: a hozzáférések, amikor megvannak.
6. **Partnerek**: ügyfelek, fuvarozók, beszállítók. Az ügyfeleknél a Tarifák és az Integrációk fül.
7. **Felhasználók**: a munkatársak és a Jogosultságok fülön a szerepkörök jogai.

## Helyi futtatás

```bash
cd app
npm install
node build.mjs
SETUP_TOKEN=local-setup-token ENCRYPTION_KEY=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") \
  MIGRATE_ON_START=1 npm start     # Node.js, mint az AWS szerveren: http://localhost:8787, adatok: app/data/
npm run dev                        # vagy wrangler dev (Cloudflare futtatókörnyezet), .dev.vars kell hozzá
npm test                           # minden teszt a Node.js futtatókörnyezeten; npm run test:workers: wrangler dev-vel
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
