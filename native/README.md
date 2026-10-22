# Fully WMS: asztali alkalmazás és iPhone-os PDA

Egy C#/XAML kódbázis ([Avalonia](https://avaloniaui.net), .NET 10), két alkalmazás:

| Alkalmazás | Hol fut | Mit tud |
|---|---|---|
| **Fully WMS** (asztali) | Windows, macOS, Linux | a teljes WMS, normál, átméretezhető ablakban (nem teljes képernyős; megjegyzi a méretét és a helyét) |
| **Fully PDA** (iPhone, iPad) | iOS 15-től | a raktári modulok nagy gombokkal, vonalkódolvasás kamerával vagy Bluetooth-os olvasóval |

Mindkettő a meglévő szerverhez csatlakozik (alapból `https://18-185-119-189.sslip.io`, a
bejelentkezésnél a „módosítás” linkkel átírható). Az adatbázis, a jogosultságok, a webshop- és
futárkapcsolatok és a naplózás a szerveren vannak, az alkalmazások ugyanazt az API-t hívják, mint
korábban a böngészős felület. Ugyanazokkal a felhasználókkal és jelszavakkal lehet belépni.

## Asztali alkalmazás letöltése

1. GitHubon: **Actions** > **Native apps** > a legutóbbi zöld futás > **Artifacts**.
2. Töltsd le a géped szerintit:
   - `FullyWms-win-x64`: Windows;
   - `FullyWms-osx-arm64`: Mac M1-től;
   - `FullyWms-osx-x64`: régebbi, Intel processzoros Mac;
   - `FullyWms-linux-x64`: Linux.
3. Csomagold ki, és indítsd el a `FullyWms` (Windowson `FullyWms.exe`) fájlt. Telepíteni nem kell, a
   .NET is benne van.

A fájl nincs digitálisan aláírva, ezért első indításkor:

- **Windows:** a SmartScreen figyelmeztet; kattints a „További információ”, majd a „Futtatás
  mindenképp” gombra.
- **macOS:** jobb klikk > Megnyitás.

## iPhone-os PDA telepítése (TestFlight)

Saját iPhone-ra az Apple TestFlight alkalmazásán keresztül kerül fel. Mac nem kell hozzá, a GitHub
fordítja le és tölti fel.

### Egyszeri beállítás

1. **Apple Developer Program** tagság (99 USD/év): <https://developer.apple.com/programs/>.
2. **App Store Connect API-kulcs:** <https://appstoreconnect.apple.com> > Users and Access >
   Integrations > App Store Connect API > „+”.
   - Szerepkör: **App Manager**.
   - Jegyezd fel az **Issuer ID** és a **Key ID** értékét, és töltsd le a `.p8` fájlt. Ez csak
     egyszer tölthető le.
3. **Tanúsítványkulcs:** egy terminálban (Windowson PowerShellben) futtasd ezt:

   ```
   ssh-keygen -t rsa -b 2048 -m PEM -f fully_cert_key -N ""
   ```

   A `fully_cert_key` fájl tartalma kell a következő lépésben. Tartsd biztonságos helyen, és ne
   küldd el senkinek.
4. **GitHub titkok:** a repó oldalán Settings > Secrets and variables > Actions > New repository
   secret. Ezt a négyet kell felvenni:

   | Név | Érték |
   |---|---|
   | `APP_STORE_CONNECT_ISSUER_ID` | az Issuer ID |
   | `APP_STORE_CONNECT_KEY_IDENTIFIER` | a Key ID |
   | `APP_STORE_CONNECT_PRIVATE_KEY` | a `.p8` fájl teljes tartalma |
   | `CERTIFICATE_PRIVATE_KEY` | a `fully_cert_key` fájl teljes tartalma |

5. **Az alkalmazás felvétele az App Store Connectben:** Apps > „+” > New App.
   - Platform: iOS; név: `Fully PDA`; nyelv: magyar.
   - Bundle ID: `hu.fully.pda`. Ha még nincs a listában, előbb vedd fel itt:
     <https://developer.apple.com/account/resources/identifiers/list>.
   - SKU: bármi, például `fully-pda`.

### Új változat feltöltése

1. GitHubon: **Actions** > **Native apps** > **Run workflow**, pipáld be a „TestFlight” mezőt,
   majd **Run workflow**.
2. Kb. 15 perc múlva a build megjelenik az App Store Connectben (TestFlight fül). A feldolgozás
   után add hozzá magad belső tesztelőként (Internal Testing).
3. Az iPhone-on telepítsd az Apple **TestFlight** alkalmazását. Onnan telepíthető a Fully PDA, és
   onnan érkeznek a frissítések is.

A titkok csak a GitHubon vannak, a kódban és a naplókban nem jelennek meg. Az első futás az Apple
fiókban elkészíti az aláíró tanúsítványt és a profilt, a későbbiek ugyanezeket használják.

## Fejlesztés

Kell hozzá a .NET 10 SDK: <https://dot.net>.

- **Indítás:** `dotnet run --project src/Fully.Wms.Desktop`. Visual Studio, Rider és VS Code alatt
  is megy, az Avalonia bővítménnyel a XAML előnézete is.
- **Tesztek:** `dotnet test tests/Fully.Wms.Tests`.

Az élő API- és képernyőtesztek a mintaadatos szerverrel futnak (`app/DEVELOPING.md`).
Képernyőképet is készítenek, ha megadod a mappát:

```
FL_TEST_SERVER=http://localhost:8899 FL_SCREENSHOTS=/tmp/kepek dotnet test tests/Fully.Wms.Tests
```

### Felépítés

| Projekt | Tartalom |
|---|---|
| `src/Fully.Wms.Core` | API-kliens (munkamenet, hibák), adatmodellek, formázás; nincs benne felület |
| `src/Fully.Wms` | a képernyők (XAML, `Views/`) és a nézetmodellek (`ViewModels/`), közös az asztali és a telefonos alkalmazásban |
| `src/Fully.Wms.Desktop` | az asztali indító |
| `src/Fully.Wms.iOS` | az iOS-es indító, a kamerás vonalkódolvasó és a dokumentummegosztás |
| `tests/Fully.Wms.Tests` | egység-, API- és képernyőtesztek |

### Megjelenés

- **Széles ablak:** bal oldalt a menü.
- **Keskeny ablak és telefon:** a kezdőképernyőn nagy csempék, fent Vissza és Kezdőlap gomb.

A modulok a saját fájljukból jelentkeznek be (`AppModules.Use`, `PageLocator.Register`), így egy új
modul felvételéhez nem kell a közös listákat szerkeszteni.
