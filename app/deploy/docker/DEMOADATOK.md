# Fél évnyi demóadat az éles adatbázisba

Ez az útmutató a WMS szerverét üzemeltető munkamenetnek szól. A tulajdonos azt kérte, hogy az éles
adatbázisban legyen fél évnyi kitalált (demó) adat, hogy minden képernyőn életszerű mennyiség
látszódjon: listák, keresés, export, elszámolások. A szerver üzemeltetése:
[FRISSITES.md](FRISSITES.md).

## Mit csinál

A `server/demo-history.mjs` a szerveren, az alkalmazás saját API-ján át rögzíti az adatokat. Előbb
a demóadatokat teszi fel úgy, ahogy fél éve álltak, aztán az azóta eltelt napokat egyenként
végigjátssza:

- **50 webshop-ügyfél**, mindegyik havonta 850 és 930 közötti rendeléssel (hétvégén kevesebb jön), így
  minden teljes hónap 800 és 1000 rendelés közé esik. Néhányat sztornóznak vagy felfüggesztenek.
- **Mindenkinek saját tarifája van**, és egy rendelés díja (kezelés, 2-3. termék, további termékek,
  csomagolóanyag, utánvét) nettó 800 Ft alatt marad, a legnagyobb rendelésnél is.
- **Raktári munka hétköznap:** komissió, csomagolás, majd átadás a GLS-nek, a DPD-nek és a Foxpostnak. A csomagot
  egy-két nap múlva kézbesítik, és néhány visszajön.
- **Raklapos rendelések:** néhány ügyfél boltoknak és cégeknek is küld raklapon. Ezeket a
  Fuvartervező a Duna Cargo és a Mátra Logisztika teherautóira (5 teherautó, egy szervizben) teszi,
  és a teherautók délben elindulnak.
- **Készlet:** ha fogy, utánrendel. A szállítmányt átveszi és polcra teszi.
- **Elszámolás:** esténként tárolási pillanatkép készül, pénteken óradíjas munka kerül rögzítésre,
  minden hónap 1-jén elkészülnek és jóváhagyásra kerülnek az előző havi elszámolások.
- **A mai nap** délelőttje a futtatás előtti másfél órába kerül: új rendelések, egy félig kiszedett
  hullám, futárra váró csomagok és félig megtervezett teherautók.

Eredmény: 60 partner (50 webshop-ügyfél 155 termékkel, 5 fuvarozó, 5 beszállító), 5 teherautó,
körülbelül 270 000 rendelés és 300 jóváhagyott elszámolás. **Futásidő: fél óra körül (lassabb gépen
akár egy óra), az adatbázis körülbelül 1 GB lesz**, ezért előtte nézd meg, van-e elég hely
(`df -h /var/lib/fully-wms`). Rövidebb időszakhoz: `--months 3` (fele annyi rendelés és idő).

**Biztonság:**
- Minden demóadat `DEMO-` kezdetű partnerkódot és cikkszámot kap. A valódi adatokhoz nem nyúl.
- **Semmi nem megy ki a szerverről.** A csomagszámok kitaláltak és kézzel rögzítettek, ezért
  futár-API-t nem hív. Az elszámolások nincsenek számlázva, ezért a számlázót sem hívja. A
  demóügyfeleknek nincs webshopjuk és API-kulcsuk.
- **Az időt csak a szkript folyamata szimulálja.** A futó szerver közben a valós órával dolgozik
  tovább, és nem kell leállítani.
- Ha már van demóadat (`DEMO-` partner), a szkript nem csinál semmit.

## Előfeltétel

A szerveren olyan verzió fusson, amelyben megvan a szkript. Ehhez a 6-os PR legyen beolvasztva a
`main` ágba, és a szerver legyen frissítve: automatikusan, vagy kézzel a `sudo fully-wms-update`
paranccsal. Ellenőrzés:

```bash
cd /opt/fully-wms/repo/app/deploy/docker
sudo docker compose exec -T wms ls server/demo-history.mjs
```

## Lépések

A szerveren, helyben (`ssh mag_user@192.168.0.132` az irodai hálózatról):

1. Mentés:

   ```bash
   sudo fully-wms-backup
   ```

2. Ha korábban már futott a demó-feltöltő (`server/demo-seed.mjs`), előbb töröld a régi demóadatot:

   ```bash
   cd /opt/fully-wms/repo/app/deploy/docker
   sudo docker compose exec -T wms node server/demo-seed.mjs --remove
   ```

3. Feltöltés, napközben (a mai nap délelőttje a futtatás előtti másfél órába kerül):

   ```bash
   cd /opt/fully-wms/repo/app/deploy/docker
   sudo docker compose exec -T wms node server/demo-history.mjs
   ```

   A végén összesítést ír: partnerek, rendelések állapot szerint, hullámok, futárátadások,
   elszámolások. Más hosszúságú időszakhoz: `--months 3` (1 és 24 között).

4. Nézd meg a böngészőben (`https://app.fully.hu`):
   - Megrendelések: van új, komissió alatti és feladásra kész rendelés;
   - Rendeléstörténet: fél évnyi kézbesített rendelés;
   - Havi elszámolások: az elmúlt hónapok jóváhagyott elszámolásai;
   - Fuvarszervezés, Fuvartervező: a mai teherautók félig megtervezve, a térképen a járatok;
   - Készletmozgások.

## Ha hiba van

A szkript kiírja a hibát és azt, hogyan törölhető a félbemaradt adat:

```bash
sudo docker compose exec -T wms node server/demo-seed.mjs --remove
```

Utána újra futtatható. Ha a hiba megmarad, a teljes kimenetet add át a fejlesztőnek. Titkot ne
tegyél bele.

## Törlés később

Ugyanez a parancs törli az összes demóadatot, bármikor:

```bash
cd /opt/fully-wms/repo/app/deploy/docker
sudo docker compose exec -T wms node server/demo-seed.mjs --remove
```

**Ami a törlés után megmarad:**
- **A napló bejegyzései.** A naplóból semmi nem törlődik.
- **A számsorozatok.** A rendelések, hullámok és elszámolások számozása ott folytatódik, ahol a
  demó abbahagyta, ezért a valódi rendelések számai nem 1-ről indulnak.

## Kész, ha

- [ ] A szkript „Kész ... másodperc alatt” sorral végzett.
- [ ] Az alkalmazásban látszanak a fél évre visszamenő rendelések és elszámolások.
- [ ] A tulajdonos tudja, hogy a `demo-seed.mjs --remove` paranccsal bármikor törölhető.
