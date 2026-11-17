# Fully Logistics WMS telepítése Ubuntu szerverre

Ez az útmutató egy másik Claude munkamenetnek (vagy egy rendszergazdának) szól, aki shell
hozzáféréssel (sudo) dolgozik a cég saját, fizikai Ubuntu szerverén. A cél: a böngészős WMS
(`app/` mappa, Node.js + SQLite) fusson a szerveren, és egy linken keresztül (pl.
`https://wms.fully.hu`) elérhető legyen.

## Szabályok (kötelező)

- **Nincs AWS.** Az `app/deploy/aws/` szkripteket ne használd, AWS-hez ne nyúlj. A szerver a cég
  saját gépe.
- **Titkot soha ne kérj a chatbe** (jelszó, token, API kulcs). A titkokat a szerveren kell
  generálni, és a `/etc/fully-app/env` fájlban maradnak. Ha a felhasználónak kell beírnia
  valamit (pl. egy Cloudflare token), azt a szerver termináljába írja, ne a chatbe.
- **Ne futtasd a `server/demo-seed.mjs` szkriptet.** Az kitalált demóadatokat tesz az éles
  adatbázisba.
- Az `ENCRYPTION_KEY` értékét telepítés után **soha ne generáld újra**. Ha elveszik, a mentett
  futár-, webshop- és számlázó-jelszavakat mindenkinek újra meg kell adnia.
- Ügyféladat (az adatbázis, a mentések) ne kerüljön ki a szerverről, és a gitbe se.

## Először kérdezd meg a felhasználót

1. **Milyen címen legyen elérhető?** Például `wms.fully.hu`. A fully.hu domain DNS-e valószínűleg
   a Cloudflare-nél van, de ezt ellenőrizni kell.
2. **Van-e a szervernek nyilvános IP-címe?** Kérdezd meg azt is, hogy a router a 80-as és a
   443-as portot a szerverre tudja-e irányítani.
   - Ha igen: **A út** (Caddy, saját HTTPS tanúsítvány).
   - Ha nem, vagy nem tudja: **B út** (Cloudflare Tunnel). Ehhez nem kell portot nyitni.
3. **Hova menjen a mentés másolata?** A szerver naponta ment helyben, de egy második helyre
   (NAS, USB lemez, másik gép) is el kellene vinni.

## Mi van a tárolóban

- A tároló neve: `MaczakG/fully-logistics` (privát). A WMS jelenleg a
  `claude/zen-einstein-rdf7rm` ágon van, a MaczakG/fully-logistics#2 pull requestben. Ha
  az már be van olvasztva, használd a `main` ágat.
- A program: `app/`. Csak Node.js kell hozzá, npm csomag nem (a `node:sqlite` beépített).
  A buildhez a tároló gyökerében lévő `assets/` mappa is kell, ezért a teljes tárolót klónozd.
- Indítás: `node server/index.mjs`. Adatbázis-migráció: `node server/migrate.mjs`. Build (a
  `dist/` mappa): `node build.mjs`. Állapotlekérés: `GET /api/health` → `{"ok":true}`.
- A beállítások környezeti változók, ezek leírása a `server/config.mjs` elején van. A systemd
  egység mintája: `app/deploy/aws/systemd/fully-app.service`.
- A beépített óránkénti mentés (`BACKUP=1`) csak S3-ba tud menteni, ezért itt ki marad, és
  helyette a lenti helyi mentés fut.

## Telepítés

Ubuntu 24.04 LTS, sudo joggal. A parancsok sorban futtathatók.

### 1. Csomagok, időzóna

```bash
sudo timedatectl set-timezone Europe/Budapest
sudo apt-get update
sudo apt-get install -y ca-certificates curl git sqlite3 openssl
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
sudo bash /tmp/nodesource_setup.sh
sudo apt-get install -y nodejs
node --version   # v24.x
```

### 2. Felhasználó és mappák

```bash
id fullyapp >/dev/null 2>&1 || sudo useradd --system --home-dir /var/lib/fully-app --shell /usr/sbin/nologin fullyapp
sudo install -d -m 750 -o fullyapp -g fullyapp /var/lib/fully-app /var/lib/fully-app/files
sudo install -d -m 750 -o root -g fullyapp /etc/fully-app
sudo install -d -m 755 /opt/fully-app
```

### 3. A kód (csak olvasási jogú deploy kulccsal)

```bash
sudo install -d -m 700 /root/.ssh
sudo ssh-keygen -t ed25519 -N '' -C 'fully-wms-server' -f /root/.ssh/fully_wms_deploy
sudo cat /root/.ssh/fully_wms_deploy.pub
```

A kiírt **nyilvános** kulcsot add át a felhasználónak (ez nem titok). Ő adja hozzá a GitHubon:
MaczakG/fully-logistics → Settings → Deploy keys → Add deploy key, az „Allow write access”
maradjon kikapcsolva. Ezután:

```bash
sudo GIT_SSH_COMMAND='ssh -i /root/.ssh/fully_wms_deploy -o StrictHostKeyChecking=accept-new' \
  git clone --branch claude/zen-einstein-rdf7rm git@github.com:MaczakG/fully-logistics.git /opt/fully-app/repo
sudo git -C /opt/fully-app/repo config core.sshCommand 'ssh -i /root/.ssh/fully_wms_deploy'
cd /opt/fully-app/repo/app && sudo node build.mjs
```

### 4. Beállítások és titkok (a szerveren generálva)

A parancs nem ír felül egy már létező fájlt (a meglévő `ENCRYPTION_KEY` megmarad):

```bash
sudo sh -c 'test -f /etc/fully-app/env && exit 0; umask 027; cat > /etc/fully-app/env <<EOF
NODE_ENV=production
PORT=8787
HOST=127.0.0.1
TRUST_PROXY=1
DB_PATH=/var/lib/fully-app/fully-app.sqlite
FILES_DRIVER=disk
FILES_DIR=/var/lib/fully-app/files
SETUP_TOKEN=$(openssl rand -hex 16)
ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF
chown root:fullyapp /etc/fully-app/env; chmod 640 /etc/fully-app/env'
```

### 5. Adatbázis és szolgáltatás

```bash
sudo -u fullyapp bash -c 'set -a; . /etc/fully-app/env; set +a; cd /opt/fully-app/repo/app && node server/migrate.mjs'
sed 's#/opt/fully-app/current/app#/opt/fully-app/repo/app#' /opt/fully-app/repo/app/deploy/aws/systemd/fully-app.service \
  | sudo tee /etc/systemd/system/fully-app.service >/dev/null
sudo systemctl daemon-reload
sudo systemctl enable --now fully-app
sleep 2; curl -fsS http://127.0.0.1:8787/api/health   # {"ok":true}
```

Hiba esetén: `journalctl -u fully-app -n 50 --no-pager`.

### 6/A. Link Caddyvel (nyilvános IP és nyitott 80/443 esetén)

A DNS-ben a cím A rekordja mutasson a szerver nyilvános IP-címére. Ha a Cloudflare kezeli, a
rekord legyen „DNS only” (szürke felhő), különben a Caddy nem kap tanúsítványt.

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https gnupg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
sudo chmod o+r /usr/share/keyrings/caddy-stable-archive-keyring.gpg /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

A `/etc/caddy/Caddyfile` tartalma (a címet cseréld a választottra):

```
wms.fully.hu {
	encode zstd gzip
	request_body {
		max_size 25MB
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	reverse_proxy 127.0.0.1:8787
}
```

```bash
sudo caddy validate --config /etc/caddy/Caddyfile && sudo systemctl reload caddy
sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw --force enable
```

### 6/B. Link Cloudflare Tunnellel (nyilvános IP és portnyitás nélkül)

Feltétel: a domain DNS-e a Cloudflare-nél van. Bejövő portot nem kell nyitni.

```bash
sudo mkdir -p --mode=0755 /usr/share/keyrings
curl -fsSL https://pkg.cloudflare.com/cloudflare-main.gpg | sudo tee /usr/share/keyrings/cloudflare-main.gpg >/dev/null
echo 'deb [signed-by=/usr/share/keyrings/cloudflare-main.gpg] https://pkg.cloudflare.com/cloudflared any main' | sudo tee /etc/apt/sources.list.d/cloudflared.list
sudo apt-get update && sudo apt-get install -y cloudflared
sudo cloudflared tunnel login
```

A `login` kiír egy linket. Ezt add át a felhasználónak, ő nyitja meg a böngészőben, és
kiválasztja a domaint. A tanúsítvány a szerveren marad, a chatbe semmit nem kell beírni.

```bash
sudo cloudflared tunnel create fully-wms            # kiírja a tunnel azonosítóját (UUID)
sudo cloudflared tunnel route dns fully-wms wms.fully.hu
sudo install -d -m 755 /etc/cloudflared
sudo cp /root/.cloudflared/<UUID>.json /etc/cloudflared/
```

A `/etc/cloudflared/config.yml` tartalma:

```yaml
tunnel: <UUID>
credentials-file: /etc/cloudflared/<UUID>.json
ingress:
  - hostname: wms.fully.hu
    service: http://127.0.0.1:8787
  - service: http_status:404
```

```bash
sudo cloudflared service install && sudo systemctl enable --now cloudflared
sudo ufw allow OpenSSH && sudo ufw --force enable
```

### 7. Első adminisztrátor

Nyisd meg a linket: a program az „Első indítás” képernyővel indul. Ehhez kell a telepítési kód:

```bash
sudo grep '^SETUP_TOKEN=' /etc/fully-app/env
```

A kód csak az első adminisztrátor létrehozásáig használható. Ezt a lépést a felhasználó végezze
el: ő adja meg a saját nevét, e-mail címét és jelszavát. A jelszót ne kérd el.

### 8. Napi helyi mentés

```bash
sudo tee /usr/local/sbin/fully-app-backup >/dev/null <<'EOF'
#!/bin/bash
# The database (consistent copy) and the uploaded files, kept for 30 days.
set -euo pipefail
DIR=/var/backups/fully-app
STAMP=$(date +%F-%H%M)
install -d -m 700 "$DIR"
sqlite3 /var/lib/fully-app/fully-app.sqlite ".backup '$DIR/db-$STAMP.sqlite'"
gzip "$DIR/db-$STAMP.sqlite"
tar -czf "$DIR/files-$STAMP.tar.gz" -C /var/lib/fully-app files
find "$DIR" -type f -mtime +30 -delete
EOF
sudo chmod 750 /usr/local/sbin/fully-app-backup
sudo tee /etc/systemd/system/fully-app-backup.service >/dev/null <<'EOF'
[Unit]
Description=Fully Logistics WMS backup
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/fully-app-backup
EOF
sudo tee /etc/systemd/system/fully-app-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily Fully Logistics WMS backup
[Timer]
OnCalendar=*-*-* 02:30
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now fully-app-backup.timer
sudo systemctl start fully-app-backup && ls -la /var/backups/fully-app
```

A mentést vigyétek egy második helyre is (lásd a 3. kérdést). Ha az adatbázis egy szerver
hibája miatt elveszne, a helyi mentés is vele veszhet.

Visszaállítás: állítsd le a szolgáltatást (`systemctl stop fully-app`), a kicsomagolt `.sqlite`
fájl kerüljön a `DB_PATH` helyére `fullyapp` tulajdonossal, futtasd a 5. lépés migrációját, majd
indítsd újra a szolgáltatást.

### 9. Frissítés (új verzió a gitből)

```bash
sudo tee /usr/local/sbin/fully-app-update >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
/usr/local/sbin/fully-app-backup
git -C /opt/fully-app/repo pull --ff-only
cd /opt/fully-app/repo/app && node build.mjs
sudo -u fullyapp bash -c 'set -a; . /etc/fully-app/env; set +a; cd /opt/fully-app/repo/app && node server/migrate.mjs'
systemctl restart fully-app
sleep 2; curl -fsS http://127.0.0.1:8787/api/health
EOF
sudo chmod 750 /usr/local/sbin/fully-app-update
```

Használat: `sudo fully-app-update`.

## Kész, ha

- [ ] `https://<cím>` HTTPS-en betölti a belépő (vagy „Első indítás”) képernyőt, kívülről is
  (pl. mobilnetről).
- [ ] A felhasználó létrehozta az első adminisztrátort, és be tud lépni.
- [ ] Belépés után nem dobja vissza a belépéshez. Ha mégis, a proxy nem küld
  `X-Forwarded-Proto: https` fejlécet: ellenőrizd a 6. lépést.
- [ ] A szerver újraindítása után (`sudo reboot`) magától újra elérhető.
- [ ] `/var/backups/fully-app` alatt van mai mentés, és a timer aktív
  (`systemctl list-timers fully-app-backup.timer`).

## Utána (külön feladat a tárolóban)

- A natív asztali és iPhone alkalmazás alapértelmezett szervercíme még egy régi, megszűnt
  címre mutat. A címet a `native/src/Fully.Wms.Core/SettingsStore.cs` fájl `DefaultServer`
  értéke adja (a régit tedd az `OldServers` listába), a hozzá tartozó teszt a
  `native/tests/Fully.Wms.Tests/SettingsStoreTests.cs`. Ezt az új linkre kell átírni, és PR-ben
  beküldeni.

## Mit jelents a felhasználónak

A linket, hogy melyik utat választottad (Caddy vagy Tunnel), hol vannak a mentések, és hogyan
kell frissíteni (`sudo fully-app-update`). Titkot ne írj a jelentésbe.
