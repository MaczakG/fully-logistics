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

## Mi van az alkalmazásokban

| Modul | Asztali | PDA (iPhone) |
|---|---|---|
| Betárolás, Megrendelések, Komissió (csomagolóállomással), Leltár, Készlet (térképpel), Rendeléstörténet (visszáruval), Fuvarszervezés | igen | igen, nagy gombokkal és vonalkódolvasással |
| Partnerek, Ajánlatkészítő, Elszámolás | igen | nem |
| Beállítások, Felhasználók (jogosultságok) | igen | nem |

Ki mit lát, azt a szerepköre jogosultságai döntik el, ugyanúgy, mint a böngészőben.

Az asztali alkalmazás a klasszikus Windows-programok szerint működik: a listák a főablakban vannak,
egy rekord (rendelés, partner, ajánlat, elszámolás ...) a saját ablakában nyílik meg, így több is
lehet nyitva egymás mellett. A kisebb szerkesztések kis párbeszédablakban jelennek meg. Billentyűk:
**Esc** bezárja a párbeszédablakot, **Ctrl+W** a rekord ablakát, **F5** frissít, az Ajánlatkészítőben
**Ctrl+S** ment. Ha egy ablakban nem mentett módosítás van, bezárás előtt rákérdez.

## Asztali alkalmazás letöltése

1. GitHubon a repó oldalán: **Releases** > **Fully WMS asztali alkalmazás** (a legfrissebb). Minden
   `main` ágra kerülő módosítás után magától frissül.
2. Töltsd le a géped szerinti fájlt:
   - `FullyWms-windows-x64.zip`: Windows 10 és 11;
   - `FullyWms-macos-arm64.zip`: Mac M1 vagy újabb processzorral;
   - `FullyWms-macos-x64.zip`: régebbi, Intel processzoros Mac;
   - `FullyWms-linux-x64.tar.gz`: Linux.
3. Indítás:
   - **Windows:** csomagold ki, és indítsd el a `FullyWms\FullyWms.exe` fájlt. Telepíteni nem kell, a
     .NET is benne van. A SmartScreen első indításkor figyelmeztet, mert a fájl nincs digitálisan
     aláírva: kattints a „További információ”, majd a „Futtatás mindenképp” gombra.
   - **Mac:** a letöltött zip kicsomagolásával megjelenik a `Fully WMS` alkalmazás; húzd az
     Alkalmazások (Applications) mappába. Az első indításnál a macOS jelzi, hogy nem tudja
     ellenőrizni a fejlesztőt: zárd be az üzenetet, majd Rendszerbeállítások > Adatvédelem és
     biztonság > lent a „Megnyitás mindenképp” gomb. Ezt csak egyszer kell megtenni.
   - **Linux:** `tar xzf FullyWms-linux-x64.tar.gz`, majd `./FullyWms/FullyWms`.

Egy pull requesthez tartozó változat is letölthető: **Actions** > **Native apps** > a futás >
**Artifacts** (30 napig érhető el).

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

- **Széles ablak:** bal oldalt a menü; a rekordok saját ablakban, a szerkesztések párbeszédablakban
  (`Services/WindowPresenter.cs`).
- **Keskeny ablak és telefon:** a kezdőképernyőn nagy csempék, fent Vissza és Kezdőlap gomb, minden
  oldal ugyanabban a nézetben, egymás után.

### Csomagolás

`build/package-desktop.sh <rid> <mappa> [verzió]` egy platform letölthető fájlját készíti el
(`win-x64`, `linux-x64`, `osx-arm64`, `osx-x64`). A macOS-es változathoz Mac kell, mert az
alkalmazást alá kell írni; a GitHub Actions ezt Mac gépen végzi.

A modulok a saját fájljukból jelentkeznek be (`AppModules.Use`, `PageLocator.Register`), így egy új
modul felvételéhez nem kell a közös listákat szerkeszteni.
