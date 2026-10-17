# Telepítés AWS-re (AWS Lightsail)

Az alkalmazás egy AWS Lightsail szerveren fut Frankfurtban (eu-central-1). A weboldal (fully.hu) továbbra is a Cloudflare-en marad.

| Elem | Mi ez | Költség |
| --- | --- | --- |
| Szerver | Ubuntu 24.04, 1 GB RAM, állandó IP-cím. Node.js futtatja az alkalmazást, előtte a Caddy adja a HTTPS-t | kb. 7 USD/hó |
| Tárhely (bucket) | a feltöltött fájlok (szerződések, címkék, számlák, fotók), az óránkénti adatbázis-mentések és a kiadott verziók | kb. 1 USD/hó |
| Napi pillanatkép | a szerver teljes lemeze, minden éjjel (01:00 UTC), az utolsó 7 nap | 1 USD/hó alatt |

Az adatbázis egy SQLite fájl a szerveren (`/var/lib/fully-app/fully-app.sqlite`). Óránként tömörített mentés készül róla a tárhelyre (`backups/db/`): az utolsó 48 óra minden mentése megmarad, utána 60 napig napi egy.

## Biztonság

- **HTTPS mindenhol:** a Caddy automatikusan kér és megújít Let's Encrypt tanúsítványt, a böngészőnek HSTS-t küld, a HTTP-t HTTPS-re irányítja.
- **Tűzfal:** csak a 80-as és a 443-as port nyitott. SSH csak a Lightsail konzol böngészős termináljából érhető el.
- **Az alkalmazás jogai:** saját, jogosultság nélküli felhasználóként fut (`fullyapp`), a systemd elzárja a rendszer többi részétől. Csak az adatbázis mappáját írhatja.
- **Titkok:** a beállítások a `/etc/fully-app/env` fájlban vannak, csak a root és az alkalmazás olvashatja.
  - Az `ENCRYPTION_KEY` a szerveren készül, és onnan nem kerül ki. Ezzel titkosítja az alkalmazás a futár-, webshop- és számlázó-jelszavakat.
- **Frissítések:** a biztonsági frissítések automatikusan települnek (unattended-upgrades).
- **Böngésző oldali védelem:** az alkalmazás saját fejlécei (CSP, X-Frame-Options, nosniff) ugyanúgy mennek, mint a Cloudflare-en.

## Az AWS kulcs (egyszer)

1. AWS konzol > **IAM > Users > Create user**, név: `fully-app-deploy`. Konzol-hozzáférés nem kell.
2. **Permissions > Add permissions > Create inline policy > JSON**, és ez a tartalom:
   ```json
   { "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Action": "lightsail:*", "Resource": "*" }] }
   ```
   Név: `lightsail-only`. Ezzel a kulccsal csak a Lightsailt lehet kezelni, mást nem.
3. A felhasználónál **Security credentials > Create access key > Command Line Interface (CLI)**.
4. A kulcsot ne másold be a chatbe. A Claude felhőkörnyezetének beállításaiban add meg: a munkamenet címsorában a környezet menüje, majd **Edit**. Ott **Network secrets** vagy környezeti változó:
   - `AWS_ACCESS_KEY_ID`
   - `AWS_SECRET_ACCESS_KEY`
   - `AWS_REGION` = `eu-central-1`

   Az új munkamenet már látja ezeket.

## Első telepítés

```bash
cd app
node deploy/aws/provision.mjs
```

Létrehozza a tárhelyet, az állandó IP-címet és a szervert. A szerver magától feltelepíti magát, ez 5-10 perc. A végén kiírja:

- az ideiglenes címet, pl. `https://3-121-45-67.sslip.io`: az IP-címből képzett ingyenes név, érvényes HTTPS tanúsítvánnyal;
- a **telepítési kódot**: az első belépéskor ezzel hozod létre az első adminisztrátort. Utána nem használható.

A `deploy/aws/config.json` a nem titkos adatokat őrzi (tárhely neve, IP-cím, nevek); ezt a fájlt commitold.

## Új verzió kiadása

```bash
node deploy/aws/release.mjs
```

1. Elkészíti és feltölti a csomagot.
2. A szerver egy percen belül észreveszi az új verziót.
3. Menti az adatbázist, lefuttatja az adatbázis-frissítéseket (migrációkat), és újraindul.
4. Ha az új verzió nem indul el rendben, magától visszaáll az előzőre. A szkript kiírja, mi volt a hiba.

## Saját domain (app.fully.hu)

1. A domainregisztrálónál vegyél fel egy **A rekordot**:
   - **Név:** `app`
   - **Érték:** a szerver IP-címe (a `config.json`-ban és a provision kimenetében van)
   - **TTL:** 300 vagy 3600
2. Pár perc múlva:
   ```bash
   node deploy/aws/domain.mjs app.fully.hu
   ```
   Ellenőrzi, hogy a domain már a szerverre mutat, és beállítja. Egy percen belül tanúsítvány is lesz rá. Az ideiglenes cím is működik tovább; a `--only` kapcsolóval csak az új név marad.

## Mintaadatok

A kipróbáláshoz mintaadatok tölthetők a szerverre: 3 ügyfél, futárok, beszállító, raktárhelyek, 12 termék készlettel, betárolások, 17 rendelés minden állapotban, komissió, futárátvétel, leltár, ajánlatok és elszámolás. Minden minta partner kódja és cikkszáma `DEMO-` kezdetű.

```bash
node deploy/aws/task.mjs demo-seed     # betöltés (ha már van, nem csinál semmit)
node deploy/aws/task.mjs demo-remove   # törlés; a valódi adatokhoz nem nyúl
```

Élesítés előtt töröld a mintaadatokat, főleg mielőtt valódi futár-hozzáférést állítasz be: a minta rendelések kitalált csomagszámait a futár nyomkövetése is lekérdezné.

`node deploy/aws/task.mjs backup` azonnali adatbázis-mentést készít.

## Állapot

```bash
node deploy/aws/status.mjs
```

Mutatja:

- melyik verzió fut, és melyiket kérted;
- egészséges-e az alkalmazás;
- mennyi a szabad lemezterület;
- a legutóbbi üzeneteket.

A szerver első telepítésének naplója a tárhelyen van: `status/init.log`.

## Visszaállítás mentésből

Lightsail konzol > a szerver > **Connect using SSH**, majd:

```bash
sudo systemctl stop fully-app
cd /opt/fully-app/current/app
sudo -u fullyapp env $(sudo cat /etc/fully-app/env | xargs) node server/backup.mjs --restore backups/db/2026-10-16/1415.sqlite.gz --to /var/lib/fully-app/restored.sqlite
sudo -u fullyapp mv /var/lib/fully-app/fully-app.sqlite /var/lib/fully-app/fully-app.sqlite.old
sudo -u fullyapp mv /var/lib/fully-app/restored.sqlite /var/lib/fully-app/fully-app.sqlite
sudo rm -f /var/lib/fully-app/fully-app.sqlite-wal /var/lib/fully-app/fully-app.sqlite-shm
sudo systemctl start fully-app
```

Ha az egész szerver elveszne:

1. A napi pillanatképből (Lightsail > **Snapshots**) új szerver indítható. Ez az `ENCRYPTION_KEY`-t is visszahozza.
2. Ha pillanatkép sincs, a `provision.mjs` új szervert épít, és a tárhelyen lévő mentés visszatölthető. Ilyenkor a futár-, webshop- és számlázó-jelszavakat újra meg kell adni: **Beállítások > Tárolt hozzáférés törlése**, majd újra kitöltés.

## Hogyan működik

- `server/` futtatja ugyanazt az alkalmazáskódot Node.js-en:
  - a D1 helyett SQLite (`node:sqlite`);
  - az R2 helyett a Lightsail tárhely (S3 API);
  - a statikus fájlok a `dist/`-ből;
  - az időzített feladatok percenkénti időzítővel.
- `deploy/aws/agent.mjs` percenként fut a szerveren (systemd timer). A tárhelyről olvassa, melyik verziónak kell futnia (`releases/current.json`) és milyen nevekre kell HTTPS (`deploy/config.json`), és ehhez igazítja a szervert. Ezért nem kell SSH a telepítéshez.
- `deploy/aws/cloud-init.sh` a szerver első indulásakor fut:
  - feltelepíti a Node.js 24-et és a Caddy-t;
  - létrehozza a felhasználót és a mappákat;
  - letölti az első verziót, és átadja a vezérlést a frissítőnek (agent).
- A tesztek (`npm test`) ezen a Node.js futtatókörnyezeten futnak. A `test/deploy-agent.test.mjs` a frissítőt próbálja végig kamu tárhellyel: telepítés, hibás verzió visszaállítása, hibás migráció, domainváltás.
