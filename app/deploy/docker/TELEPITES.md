# Fully Logistics WMS telepítése Dockerrel, saját Ubuntu szerverre

Ez az útmutató egy másik Claude munkamenetnek (vagy egy rendszergazdának) szól, aki sudo joggal
dolgozik a cég saját, fizikai Ubuntu szerverén. A cél: a böngészős WMS (`app/`, Node.js + SQLite)
Docker konténerben fusson, és egy linken keresztül (pl. `https://wms.fully.hu`) elérhető legyen.

A konténer fájljai ebben a mappában vannak (`app/deploy/docker/`): `Dockerfile`,
`compose.yaml`, `Caddyfile`. Ezek ki vannak próbálva: az image felépül, induláskor lefutnak a
migrációk, a beállító kóddal létrejön az első admin, a belépés működik, és az adatok
újraindítás után is megmaradnak.

## Szabályok (kötelező)

- **Nincs AWS.** Az `app/deploy/aws/` szkripteket ne használd.
- **Titkot soha ne kérj a chatbe** (jelszó, token, kulcs). A titkok a szerveren keletkeznek,
  és a szerveren lévő `.env` fájlban maradnak. Ha a felhasználónak kell beírnia valamit
  (pl. a Cloudflare tunnel tokenjét), azt a szerver termináljába írja (`sudo nano .env`), ne a
  chatbe.
- **Ne futtasd a `server/demo-seed.mjs` szkriptet.** Az kitalált demóadatokat tesz az éles
  adatbázisba.
- Az `ENCRYPTION_KEY` értékét telepítés után **soha ne generáld újra**. Ha elveszik, a mentett
  futár-, webshop- és számlázó-jelszavakat mindenkinek újra meg kell adnia.
- Az adatbázis és a mentések ne kerüljenek ki a szerverről, és a gitbe se.

## Először kérdezd meg a felhasználót

1. **Milyen címen legyen elérhető?** Például `wms.fully.hu`.
2. **Van-e a szervernek nyilvános IP-címe?** Kérdezd meg azt is, hogy a router a 80-as és a
   443-as portot a szerverre tudja-e irányítani.
   - Ha igen: **`caddy` profil**. A Caddy konténer saját HTTPS tanúsítványt szerez.
   - Ha nem, vagy nem tudja: **`tunnel` profil**. Ez Cloudflare Tunnel, nem kell hozzá
     portot nyitni, de a domain DNS-ének a Cloudflare-nél kell lennie.
3. **Hova menjen a mentés másolata?** A szerver naponta ment helyben, de egy második helyre
   (NAS, USB lemez, másik gép) is el kellene vinni.

## A tároló

- A tároló neve: `MaczakG/fully-logistics` (privát). A WMS jelenleg a
  `claude/zen-einstein-rdf7rm` ágon van, a MaczakG/fully-logistics#2 pull requestben. Ha
  az már be van olvasztva, használd a `main` ágat.
- Az image a teljes tárolóból épül (build context: a tároló gyökere), mert a buildhez a
  gyökérben lévő `assets/` és `src/icons/` is kell.

## Telepítés

### 1. Docker (ha még nincs)

```bash
docker --version && docker compose version || {
  sudo apt-get update && sudo apt-get install -y ca-certificates curl git
  sudo install -m 0755 -d /etc/apt/keyrings
  sudo curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc
  sudo chmod a+r /etc/apt/keyrings/docker.asc
  echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.asc] https://download.docker.com/linux/ubuntu $(. /etc/os-release && echo "${UBUNTU_CODENAME:-$VERSION_CODENAME}") stable" \
    | sudo tee /etc/apt/sources.list.d/docker.list >/dev/null
  sudo apt-get update && sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin
}
sudo systemctl enable --now docker
sudo timedatectl set-timezone Europe/Budapest
```

### 2. A kód (csak olvasási jogú deploy kulccsal)

```bash
sudo install -d -m 700 /root/.ssh
sudo ssh-keygen -t ed25519 -N '' -C 'fully-wms-server' -f /root/.ssh/fully_wms_deploy
sudo cat /root/.ssh/fully_wms_deploy.pub
```

A kiírt **nyilvános** kulcsot add át a felhasználónak (ez nem titok). Ő adja hozzá a GitHubon:
MaczakG/fully-logistics → Settings → Deploy keys → Add deploy key, az „Allow write access”
maradjon kikapcsolva. Ezután:

```bash
sudo install -d -m 755 /opt/fully-wms
sudo GIT_SSH_COMMAND='ssh -i /root/.ssh/fully_wms_deploy -o StrictHostKeyChecking=accept-new' \
  git clone --branch claude/zen-einstein-rdf7rm git@github.com:MaczakG/fully-logistics.git /opt/fully-wms/repo
sudo git -C /opt/fully-wms/repo config core.sshCommand 'ssh -i /root/.ssh/fully_wms_deploy'
```

### 3. Adatmappa és beállítások

A konténer `node` felhasználóként (uid 1000) fut, ezért az adatmappa az övé:

```bash
sudo install -d -m 750 -o 1000 -g 1000 /var/lib/fully-wms /var/lib/fully-wms/files
```

A `.env` fájl a titkokkal, a szerveren generálva. A parancs nem ír felül egy már létező fájlt,
így a meglévő `ENCRYPTION_KEY` megmarad. A `COMPOSE_PROFILES` értéke a választott út: `caddy`
vagy `tunnel`.

```bash
cd /opt/fully-wms/repo/app/deploy/docker
sudo sh -c 'test -f .env && exit 0; umask 077; cat > .env <<EOF
COMPOSE_PROFILES=caddy
WMS_DOMAIN=wms.fully.hu
WMS_DATA_DIR=/var/lib/fully-wms
SETUP_TOKEN=$(openssl rand -hex 16)
ENCRYPTION_KEY=$(openssl rand -base64 32)
TUNNEL_TOKEN=
EOF'
sudo nano .env   # COMPOSE_PROFILES és WMS_DOMAIN a válaszok szerint
```

A `.env` szerepel a `.gitignore`-ban, nem kerül a gitbe.

### 4/A. Link Caddyvel (`COMPOSE_PROFILES=caddy`)

- A DNS-ben a `WMS_DOMAIN` A rekordja mutasson a szerver nyilvános IP-címére. Ha a Cloudflare
  kezeli, a rekord legyen „DNS only” (szürke felhő), különben a Caddy nem kap tanúsítványt.
- A routeren a 80-as és a 443-as port menjen a szerverre.
- `sudo ufw allow OpenSSH && sudo ufw allow 80,443/tcp && sudo ufw --force enable`

### 4/B. Link Cloudflare Tunnellel (`COMPOSE_PROFILES=tunnel`)

A felhasználó a Cloudflare felületén (Zero Trust → Networks → Tunnels) létrehoz egy tunnelt,
például `fully-wms` néven, Docker típussal. A Cloudflare egy parancsot mutat, benne egy hosszú
tokennel. A felhasználó **csak a tokent** írja a szerveren a `.env` fájlba
(`TUNNEL_TOKEN=...`, `sudo nano .env`), a chatbe ne.

A tunnel nyilvános címe (Public hostname) legyen a választott cím, a szolgáltatás típusa
`HTTP`, a címe `wms:8787`. Bejövő portot nem kell nyitni.

### 5. Indítás

```bash
cd /opt/fully-wms/repo/app/deploy/docker
sudo docker compose up -d --build
sudo docker compose ps
curl -fsS http://127.0.0.1:8787/api/health   # {"ok":true}
```

A WMS konténer csak a szerveren belül érhető el (`127.0.0.1:8787`), kívülről a Caddyn vagy a
tunnelen át. A konténerek a szerver újraindítása után maguktól elindulnak
(`restart: unless-stopped`).

Hiba esetén: `sudo docker compose logs --tail 50 wms`. Ha a Docker Hub `429 Too Many Requests`
hibát ad, várj néhány percet, vagy jelentkezz be a szerveren: `sudo docker login`.

### 6. Első adminisztrátor

Nyisd meg a linket: a program az „Első indítás” képernyővel indul. Ehhez kell a telepítési kód:

```bash
sudo grep '^SETUP_TOKEN=' /opt/fully-wms/repo/app/deploy/docker/.env
```

A kód csak az első adminisztrátor létrehozásáig használható. Ezt a lépést a felhasználó végezze
el: ő adja meg a saját nevét, e-mail címét és jelszavát. A jelszót ne kérd el.

### 7. Napi helyi mentés

Az adatbázist a konténer menti egységes másolatként (a szerverre nem kell `sqlite3`). A
feltöltött fájlok a gépen lévő adatmappából mennek tarba.

```bash
sudo tee /usr/local/sbin/fully-wms-backup >/dev/null <<'EOF'
#!/bin/bash
# The WMS database (consistent copy) and the uploaded files, kept for 30 days.
set -euo pipefail
cd /opt/fully-wms/repo/app/deploy/docker
DATA=$(grep '^WMS_DATA_DIR=' .env | cut -d= -f2-)
DIR=/var/backups/fully-wms
STAMP=$(date +%F-%H%M)
install -d -m 700 "$DIR"
docker compose exec -T wms node -e "new (require('node:sqlite').DatabaseSync)(process.env.DB_PATH).exec(\"VACUUM INTO '/data/backup-$STAMP.sqlite'\")"
mv "$DATA/backup-$STAMP.sqlite" "$DIR/db-$STAMP.sqlite"
gzip "$DIR/db-$STAMP.sqlite"
tar -czf "$DIR/files-$STAMP.tar.gz" -C "$DATA" files
find "$DIR" -type f -mtime +30 -delete
EOF
sudo chmod 750 /usr/local/sbin/fully-wms-backup
sudo tee /etc/systemd/system/fully-wms-backup.service >/dev/null <<'EOF'
[Unit]
Description=Fully Logistics WMS backup
[Service]
Type=oneshot
ExecStart=/usr/local/sbin/fully-wms-backup
EOF
sudo tee /etc/systemd/system/fully-wms-backup.timer >/dev/null <<'EOF'
[Unit]
Description=Daily Fully Logistics WMS backup
[Timer]
OnCalendar=*-*-* 02:30
Persistent=true
[Install]
WantedBy=timers.target
EOF
sudo systemctl daemon-reload && sudo systemctl enable --now fully-wms-backup.timer
sudo systemctl start fully-wms-backup && sudo ls -la /var/backups/fully-wms
```

A mentést vigyétek egy második helyre is (lásd a 3. kérdést).

Visszaállítás:
1. `sudo docker compose stop wms`.
2. A kicsomagolt mentés kerüljön `/var/lib/fully-wms/fully-app.sqlite` néven a helyére,
   `1000:1000` tulajdonossal. Előtte töröld a régi `-wal` és `-shm` fájlokat.
3. `sudo docker compose start wms`. Induláskor a migrációk maguktól lefutnak.

### 8. Frissítés (új verzió a gitből)

```bash
sudo tee /usr/local/sbin/fully-wms-update >/dev/null <<'EOF'
#!/bin/bash
set -euo pipefail
/usr/local/sbin/fully-wms-backup
git -C /opt/fully-wms/repo pull --ff-only
cd /opt/fully-wms/repo/app/deploy/docker
docker compose up -d --build
sleep 5; curl -fsS http://127.0.0.1:8787/api/health
EOF
sudo chmod 750 /usr/local/sbin/fully-wms-update
```

Használat: `sudo fully-wms-update`. Az új konténer induláskor maga futtatja a migrációkat.

## Kész, ha

- [ ] `https://<cím>` HTTPS-en betölti a belépő (vagy „Első indítás”) képernyőt, kívülről is
  (pl. mobilnetről).
- [ ] A felhasználó létrehozta az első adminisztrátort, és be tud lépni. Belépés után nem dobja
  vissza a belépéshez.
- [ ] `sudo reboot` után a link magától újra működik.
- [ ] `/var/backups/fully-wms` alatt van mai mentés, és a timer aktív
  (`systemctl list-timers fully-wms-backup.timer`).

## Utána (külön feladat a tárolóban)

A natív asztali és iPhone alkalmazás alapértelmezett szervercíme még egy régi, megszűnt címre
mutat. A címet a `native/src/Fully.Wms.Core/SettingsStore.cs` fájl `DefaultServer` értéke adja
(a régit tedd az `OldServers` listába), a hozzá tartozó teszt a
`native/tests/Fully.Wms.Tests/SettingsStoreTests.cs`. Ezt az új linkre kell átírni, és PR-ben
beküldeni.

## Mit jelents a felhasználónak

A linket, hogy melyik utat választottad (`caddy` vagy `tunnel`), hol vannak a mentések, és
hogyan kell frissíteni (`sudo fully-wms-update`). Titkot ne írj a jelentésbe.
