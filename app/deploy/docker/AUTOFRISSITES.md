# Automatikus frissítés beállítása

Ez az útmutató a WMS szerverét üzemeltető munkamenetnek (vagy rendszergazdának) szól. A cél: a
szerver percenként megnézze, van-e új verzió a követett ágon (`main`), és ha van, telepítse.
Ugyanazt futtatja, mint a kézi frissítés (`fully-wms-update`: mentés, letöltés, újraépítés,
állapotellenőrzés). Ezután a `main` ágba beolvasztott változás egy-két percen belül élesben van,
SSH és jelszó nélkül.

A beállítás egyszeri, és a szerveren, helyben kell elvégezni (`ssh mag_user@192.168.0.132` az
irodai hálózatról, vagy monitorral és billentyűzettel a mini PC-n). A szerver üzemeltetése:
[FRISSITES.md](FRISSITES.md).

## Hogyan működik

- A `fully-wms-autoupdate.timer` percenként elindítja a `fully-wms-autoupdate` szkriptet. Ez
  lekéri a GitHubról a követett ágat (`git fetch`).
- **Ha nincs új commit,** a szkript azonnal kilép. A percenkénti futás így csak egy lekérés, a
  mentés és az újraépítés csak új verziónál fut le.
- **Ha van új commit,** a szkript lefuttatja a `fully-wms-update`-et.
- **Ha egy verzió frissítése nem sikerül** (mentés-, build- vagy állapothiba), a szkript
  megjegyzi a commitot a `/var/lib/fully-wms-autoupdate/failed` fájlban, és azt nem próbálja
  újra. Különben percenként mentene és építene. A következő új commitot már igen.
- **Két futás nem fedi egymást:** a systemd nem indít újat, amíg az előző fut.
- **Visszaállás után szünetel.** Ha a tároló nem ágon áll (az előző verzióra visszaállás után egy
  régebbi commiton), az automatikus frissítés nem csinál semmit, amíg vissza nem állsz az ágra.

A szkript és a systemd egységek a tárolóban vannak: `app/deploy/docker/fully-wms-autoupdate`,
`fully-wms-autoupdate.service`, `fully-wms-autoupdate.timer`. Ki vannak próbálva egy próba
tárolón: nincs új commit; új commit; ugyanaz a commit újra; hibás frissítés; a hibás commit
újra; a következő commit; régebbi commitra visszaállva; vissza az ágon.

## Beállítás

1. Először frissíts kézzel, hogy a szerveren legyenek az új fájlok:

   ```bash
   sudo fully-wms-update
   ```

2. Telepítsd a szkriptet és az egységeket, majd kapcsold be az időzítőt:

   ```bash
   cd /opt/fully-wms/repo/app/deploy/docker
   sudo install -m 750 fully-wms-autoupdate /usr/local/sbin/fully-wms-autoupdate
   sudo install -m 644 fully-wms-autoupdate.service fully-wms-autoupdate.timer /etc/systemd/system/
   sudo systemctl daemon-reload
   sudo systemctl enable --now fully-wms-autoupdate.timer
   ```

3. Próbáld ki:

   ```bash
   sudo systemctl start fully-wms-autoupdate
   systemctl status fully-wms-autoupdate --no-pager    # "status=0/SUCCESS"
   systemctl list-timers fully-wms-autoupdate.timer    # a következő futás egy percen belül
   ```

   Ha nincs új verzió, a napló üres marad. Ha van, ott látszik a frissítés kimenete:
   `journalctl -u fully-wms-autoupdate -n 30 --no-pager`.

## Kész, ha

- [ ] `systemctl is-enabled fully-wms-autoupdate.timer` → `enabled`, és a
  `systemctl list-timers` mutatja.
- [ ] A kézi `sudo systemctl start fully-wms-autoupdate` hiba nélkül lefut.
- [ ] A [FRISSITES.md](FRISSITES.md) „Automatikus frissítés” része igaz a szerverre.

## Kezelés

| Mit | Parancs |
| --- | --- |
| Mi történt az utóbbi frissítéseknél | `journalctl -u fully-wms-autoupdate --since today --no-pager` |
| Szüneteltetés (újraindítás után is) | `sudo systemctl disable --now fully-wms-autoupdate.timer` |
| Újraindítás | `sudo systemctl enable --now fully-wms-autoupdate.timer` |
| Egy hibás verzió újrapróbálása | `sudo rm /var/lib/fully-wms-autoupdate/failed`, utána egy percen belül újra próbálja |
| Azonnali ellenőrzés, nem kell kivárni a percet | `sudo systemctl start fully-wms-autoupdate` |

Kézi frissítés (`sudo fully-wms-update`) továbbra is lehetséges. Ne futtasd viszont akkor, amikor az
automatikus éppen fut (`systemctl is-active fully-wms-autoupdate` → `activating`). Ilyenkor várd
meg, vagy használd az azonnali ellenőrzést.

## Figyelem

- Mostantól ami a `main` ágba bekerül, az egy-két percen belül élesben van. Csak kipróbált
  változást olvassz be.
- Ha egy frissítés hibás, az előző verzióra visszaállás menete ugyanaz, mint eddig
  ([FRISSITES.md](FRISSITES.md), Visszaállás). Amíg a tároló a régi commiton áll, az automatikus
  frissítés szünetel. Csak akkor állj vissza a `main` ágra, ha a javítás már be van olvasztva,
  különben a hibás verzió egy percen belül újra feltelepül.
- A percenkénti lekérés a meglévő, csak olvasási jogú deploy kulccsal megy. Új titok nem kell.
