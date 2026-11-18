# Fully WMS: frissítés és telepítés

2026-11-17

## Áttekintés

A WMS a `wms` mini PC-n fut Dockerben, kívülről a `https://app.fully.hu` címen érhető el Cloudflare Tunnelen át. Új verziót a szerveren egyetlen paranccsal lehet telepíteni: `sudo fully-wms-update`.

| Mi | Hol |
| --- | --- |
| Szerver | `wms`, Ubuntu Server 26.04 LTS, LAN IP `192.168.0.132` |
| Belépés | `ssh mag_user@192.168.0.132`, csak kulccsal (a laptop `id_ed25519` kulcsa) |
| Kód | `/opt/fully-wms/repo`, követett ág: `main` (MaczakG/fully-logistics, csak olvasási deploy kulcs) |
| Docker-fájlok és `.env` | `/opt/fully-wms/repo/app/deploy/docker` |
| Konténerek | `docker-wms-1` (WMS, csak `127.0.0.1:8787`), `docker-tunnel-1` (Cloudflare Tunnel) |
| Adatok | `/var/lib/fully-wms`: adatbázis `fully-app.sqlite`, feltöltött fájlok `files/` |
| Helyi mentések | `/var/backups/fully-wms`, minden éjjel 02:30, 30 napig |
| Második mentés | Google Drive mappa (rclone `gdrive`), 90 napig |
| Szkriptek | `/usr/local/sbin/fully-wms-update`, `/usr/local/sbin/fully-wms-backup` |

Minden `docker compose` parancsot a Docker-mappából kell futtatni: `cd /opt/fully-wms/repo/app/deploy/docker`. A `sudo` a `mag_user` jelszavát kéri.

## Új verzió telepítése

Az új verzió akkor kerül a szerverre, ha a kód már fent van a GitHubon a követett ágon, és a szerveren lefut a `sudo fully-wms-update`. A leállás általában fél percnél rövidebb.

**Automatikus frissítés:** ha be van állítva ([AUTOFRISSITES.md](AUTOFRISSITES.md)), a szerver percenként megnézi a `main` ágat, és az új verziót magától telepíti. Ilyenkor az 1. lépés után nincs teendő, a többi lépés csak kézi frissítéskor kell. Hogy fut-e: `systemctl list-timers fully-wms-autoupdate.timer`.

1. A változás kerüljön be a `main` ágba (PR-rel, beolvasztva). A szerver csak a GitHubra már feltöltött kódot látja.
2. Lépj be a laptopról: `ssh mag_user@192.168.0.132`
3. Nézd meg, mi jön (nem kötelező): `sudo git -C /opt/fully-wms/repo fetch && sudo git -C /opt/fully-wms/repo log --oneline HEAD..@{u}`
4. Telepítsd: `sudo fully-wms-update`
5. Ellenőrizd a következő rész szerint.

A `fully-wms-update` sorban ezt csinálja:

1. Mentést készít (`fully-wms-backup`): adatbázis és fájlok, helyben és a Google Drive-ra.
2. Letölti az új kódot (`git pull --ff-only`).
3. Újraépíti és újraindítja a WMS konténert (`docker compose up -d --build`).
4. 5 másodperc múlva lekéri a `/api/health`-et. A `{"ok":true}` válasz jelenti a sikert.

Az új konténer induláskor magától lefuttatja az adatbázis-migrációkat. Ha a mentés, a letöltés vagy a build hibát ad, a szkript megáll, és a régi konténer tovább fut. Ha az új konténer hibásan indul el, lásd a Visszaállás részt.

## Ellenőrzés frissítés után

A frissítés akkor sikeres, ha a nyilvános címen `{"ok":true}` jön, és a WMS konténer `healthy`.

1. Kívülről: `curl -s https://app.fully.hu/api/health` → `{"ok":true}`
2. Konténerek: `cd /opt/fully-wms/repo/app/deploy/docker && sudo docker compose ps` → a `wms` `healthy`, a `tunnel` `Up`.
3. Napló, ha valami gyanús (pl. migrációs hiba): `sudo docker compose logs --tail 50 wms`
4. Melyik verzió fut: `sudo git -C /opt/fully-wms/repo log -1 --oneline`
5. Böngészőben: nyisd meg a `https://app.fully.hu` címet, lépj be, és kattints végig egy-két fő oldalt. Ha még a régi felület jön, töltsd újra a lapot (Ctrl+F5).

## Visszaállás előző verzióra

Ha az új verzió hibás, állj vissza az előző commitra. Ha az új verzió migrációt is futtatott, az adatbázist is a frissítés előtti mentésből kell visszatölteni, mert a régi kód nem biztos, hogy ismeri az új szerkezetet.

### A kód visszaállítása

1. `cd /opt/fully-wms/repo/app/deploy/docker`
2. Keresd meg az előző, jó commitot: `sudo git -C /opt/fully-wms/repo log --oneline -5`
3. Állj rá: `sudo git -C /opt/fully-wms/repo checkout <commit>`
4. Építsd újra: `sudo docker compose up -d --build wms`
5. Ellenőrizd az előző rész szerint.

Ezután a tároló nincs ágon, ezért a következő `fully-wms-update` előtt állj vissza az ágra: `sudo git -C /opt/fully-wms/repo checkout main`. Amíg nincs ágon, az automatikus frissítés szünetel. Csak akkor állj vissza a `main`-re, ha a javítás már be van olvasztva, különben a hibás verzió egy percen belül újra feltelepül.

### Az adatbázis visszaállítása mentésből

1. Állítsd le a WMS-t: `cd /opt/fully-wms/repo/app/deploy/docker && sudo docker compose stop wms`
2. Keresd meg a frissítés előtti mentést: `sudo ls -lt /var/backups/fully-wms | head`. A fájlnév formája `db-ÉÉÉÉ-HH-NN-ÓÓPP.sqlite.gz`.
3. Tedd félre a mostani állapotot: `sudo cp -a /var/lib/fully-wms /var/lib/fully-wms.elotte-$(date +%F-%H%M)`
4. Töröld a régi naplófájlokat, és tedd a helyére a mentést (az időbélyeget cseréld le):

```bash
sudo rm -f /var/lib/fully-wms/fully-app.sqlite-wal /var/lib/fully-wms/fully-app.sqlite-shm
sudo sh -c 'gunzip -c /var/backups/fully-wms/db-<időbélyeg>.sqlite.gz > /var/lib/fully-wms/fully-app.sqlite'
sudo chown 1000:1000 /var/lib/fully-wms/fully-app.sqlite
```

5. Ha a feltöltött fájlok is kellenek: `sudo tar -xzf /var/backups/fully-wms/files-<időbélyeg>.tar.gz -C /var/lib/fully-wms`
6. Indítsd el: `sudo docker compose start wms`. A migrációk induláskor maguk lefutnak.

Ha a szerveren lévő mentés is elveszett, a Google Drive-ról húzd vissza: `sudo rclone --config /root/.config/rclone/rclone.conf copy gdrive:db-<időbélyeg>.sqlite.gz /var/backups/fully-wms/`

## Követett ág

A szerver 2026-11-17 óta a `main` ágat követi: a MaczakG/fully-logistics#2 beolvasztása után átállítottuk, és a `dd35501` commit fut rajta. Ha egyszer másik ágra kell váltani, ez a menete:

1. `sudo git -C /opt/fully-wms/repo fetch origin`
2. `sudo git -C /opt/fully-wms/repo switch <ág>`
3. `sudo fully-wms-update`
4. Ellenőrzés: `sudo git -C /opt/fully-wms/repo branch --show-current`

A deploy kulcs az egész tárolóra érvényes, ágváltáshoz nem kell újat felvenni.

## Rendszer- és konténerfrissítések

Az Ubuntu biztonsági frissítései maguk települnek. Havonta egyszer érdemes kézzel teljes rendszerfrissítést futtatni, és frissíteni a konténerek alapképeit, mert a `fully-wms-update` ezeket nem tölti le újra.

| Mit | Parancs | Milyen gyakran |
| --- | --- | --- |
| Ubuntu biztonsági frissítések | automatikus (unattended-upgrades) | naponta, magától |
| Teljes Ubuntu-frissítés, Dockerrel együtt | `sudo apt update && sudo apt full-upgrade -y` | havonta |
| Újraindítás, ha kell | ha létezik a `/var/run/reboot-required` fájl: `sudo reboot` | frissítés után |
| WMS alapkép (`node:24-slim`) | `sudo docker compose build --pull wms && sudo docker compose up -d wms` | havonta |
| Cloudflare Tunnel (`cloudflared`) | `sudo docker compose pull tunnel && sudo docker compose up -d tunnel` | havonta |
| Régi képek törlése | `sudo docker image prune -f` | az előzők után |

A `docker compose` parancsokat a Docker-mappából futtasd. Az automatikus frissítés nem indítja újra a gépet; újraindítás után a konténerek maguktól elindulnak, ezt az Ellenőrzés rész szerint nézd meg.

## Hibaelhárítás

A legtöbb hibát a napló megmutatja: `sudo docker compose logs --tail 50 wms` (vagy `tunnel`), a Docker-mappából.

| Tünet | Ok | Megoldás |
| --- | --- | --- |
| `fully-wms-update`: „Not possible to fast-forward” | A követett ágat valaki átírta (force push) | `sudo git -C /opt/fully-wms/repo fetch && sudo git -C /opt/fully-wms/repo reset --hard @{u}`, majd újra `sudo fully-wms-update`. A `.env` nincs a gitben, ez nem érinti. |
| `fully-wms-update`: „You are not currently on a branch” | Visszaállás után a tároló egy commiton áll | `sudo git -C /opt/fully-wms/repo checkout <ág>` |
| Build közben `429 Too Many Requests` | A Docker Hub korlátozza a letöltést | Várj néhány percet, vagy jelentkezz be: `sudo docker login` |
| A `wms` konténer újra és újra indul, vagy `unhealthy` | Hibás verzió vagy migrációs hiba | Nézd meg a naplót, és ha kell, állj vissza (Visszaállás rész) |
| A böngészőben Cloudflare 1033-as hiba | A tunnel konténer áll, vagy nem kapcsolódik | `sudo docker compose logs --tail 20 tunnel`, majd `sudo docker compose up -d tunnel` |
| A böngészőben 502-es hiba | A tunnel él, de a WMS nem válaszol | `sudo docker compose ps`, a `wms` naplója |
| A mentés hibás (`systemctl status fully-wms-backup`: failed) | Lejárt a Google Drive engedély | A laptopról: `ssh -t -L 53682:127.0.0.1:53682 mag_user@192.168.0.132 sudo rclone --config /root/.config/rclone/rclone.conf config reconnect gdrive:`, és a kiírt linket nyisd meg a laptop böngészőjében |
| Az automatikus frissítés nem telepít egy új verziót | Ennek a verziónak a frissítése egyszer már nem sikerült, ezért nem próbálja újra | `journalctl -u fully-wms-autoupdate -n 50 --no-pager`; ha megvan az ok, `sudo rm /var/lib/fully-wms-autoupdate/failed`, vagy olvassz be egy javítást |
| Betelt a lemez | Régi Docker-képek és build-gyorsítótár | `df -h /`, `sudo docker system df`, `sudo docker image prune -f`, `sudo docker builder prune -f` |
| Másik gépről „Permission denied (publickey)” | Csak a laptop kulcsa engedélyezett | A mini PC-n monitorral belépve vedd fel az új nyilvános kulcsot a `~/.ssh/authorized_keys` fájlba |

## Szabályok és biztonság

Ezek megszegése adatvesztést vagy leállást okoz, ezért frissítéskor is érvényesek.

- Az `ENCRYPTION_KEY` értékét a `.env`-ben soha ne generáld újra és ne írd felül. Ha elveszik, a mentett futár-, webshop- és számlázó-jelszavakat mindenkinek újra meg kell adnia.
- A `.env` csak a szerveren létezik (root, 600). Ne másold ki, ne tedd gitbe, ne küldd el chatben.
- Titkot (jelszó, token, kulcs) soha ne írj chatbe. Ha valamit a `.env`-be kell írni, a szerver termináljában tedd: `sudo nano .env`.
- Demóadatot (`server/demo-seed.mjs`, `server/demo-history.mjs`) csak a tulajdonos kérésére tegyél fel, a [DEMOADATOK.md](DEMOADATOK.md) szerint: kitalált adatokat tesz az éles adatbázisba.
- Frissítés előtt mindig legyen mentés. A `fully-wms-update` ezt magától megcsinálja, kézzel: `sudo fully-wms-backup`.
- A Cloudflare DNS-ben a `fully.hu`, `www`, `mail` és `ftp` rekord maradjon „DNS only” (szürke felhő), különben leáll az e-mail. Csak az `app` legyen narancs.
- A deploy kulcs csak olvasni tud: a szerverről nem lehet a GitHubra írni, és ez így is maradjon.
