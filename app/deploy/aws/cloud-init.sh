#!/bin/bash
# First boot of the AWS Lightsail server (launch script). provision.mjs fills in the placeholders.
# Installs Node.js 24, Caddy (HTTPS) and SQLite, creates the app user and folders, writes the app's
# settings, downloads the first release and hands over to the deploy agent (deploy/aws/agent.mjs).
# Log: /var/log/fully-app-init.log
set -euo pipefail
exec > >(tee -a /var/log/fully-app-init.log) 2>&1
echo "fully-app init $(date -Is)"
# Whatever happens, the log goes to the bucket (status/init.log) so the deploy script can show it.
upload_log() { sleep 1; curl -fsS --retry 3 -X PUT --upload-file /var/log/fully-app-init.log '__LOG_URL__' || true; }
trap upload_log EXIT
export DEBIAN_FRONTEND=noninteractive

if [ ! -f /swapfile ]; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi
timedatectl set-timezone Europe/Budapest || true

apt-get update -y
apt-get install -y ca-certificates curl gnupg debian-keyring debian-archive-keyring apt-transport-https sqlite3 unattended-upgrades

# Node.js 24 LTS (NodeSource)
curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource_setup.sh
bash /tmp/nodesource_setup.sh
apt-get install -y nodejs

# Caddy (official repository)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' -o /etc/apt/sources.list.d/caddy-stable.list
apt-get update -y
apt-get install -y caddy

id fullyapp >/dev/null 2>&1 || useradd --system --home-dir /var/lib/fully-app --shell /usr/sbin/nologin fullyapp
install -d -m 755 /opt/fully-app /opt/fully-app/releases /opt/fully-app/bootstrap
install -d -m 750 -o fullyapp -g fullyapp /var/lib/fully-app
install -d -m 750 -o root -g fullyapp /etc/fully-app

# The app's settings. ENCRYPTION_KEY is made here and never leaves the server (it is in the daily
# snapshots); without it, saved courier, webshop and invoicing passwords have to be entered again.
if [ ! -f /etc/fully-app/env ]; then
  umask 027
  cat > /etc/fully-app/env <<EOF
NODE_ENV=production
PORT=8787
HOST=127.0.0.1
TRUST_PROXY=1
BACKUP=1
DB_PATH=/var/lib/fully-app/fully-app.sqlite
FILES_DRIVER=s3
S3_BUCKET=__BUCKET__
S3_REGION=__REGION__
S3_ACCESS_KEY_ID=__S3_KEY_ID__
S3_SECRET_ACCESS_KEY=__S3_SECRET__
SETUP_TOKEN=__SETUP_TOKEN__
ENCRYPTION_KEY=$(openssl rand -base64 32)
EOF
  chown root:fullyapp /etc/fully-app/env
  chmod 640 /etc/fully-app/env
  umask 022
fi

# Until the agent has written its own, Caddy answers on port 80 only.
printf ':80 {\n\trespond "Fully Logistics: telepites folyamatban" 503\n}\n' > /etc/caddy/Caddyfile
systemctl reload-or-restart caddy

# First release, through a short-lived presigned link.
curl -fsS --retry 8 --retry-delay 5 -o /opt/fully-app/bootstrap/release.tar.gz '__BOOTSTRAP_URL__'
echo '__BOOTSTRAP_SHA256__  /opt/fully-app/bootstrap/release.tar.gz' | sha256sum -c -
tar -xzf /opt/fully-app/bootstrap/release.tar.gz -C /opt/fully-app/bootstrap
node --no-warnings /opt/fully-app/bootstrap/app/deploy/aws/agent.mjs --bootstrap
echo "fully-app init done $(date -Is)"
