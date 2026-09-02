#!/usr/bin/env bash
# Bootstrap an Arcade host on a fresh Debian VM. Safe to re-run: it updates the
# checkout, reinstalls deps and restarts, without touching data/ or the env file.
#
#   sudo bash setup-vm.sh <git-repo-url> <domain>
#
# <domain> may be a real hostname pointed at this VM, or <ip-with-dashes>.nip.io
# (e.g. 34-71-2-9.nip.io) for a working certificate without buying a domain.
set -euo pipefail

REPO="${1:?usage: setup-vm.sh <git-repo-url> <domain>}"
DOMAIN="${2:?usage: setup-vm.sh <git-repo-url> <domain>}"

APP_DIR=/opt/arcade/app
VENV=/opt/arcade/venv
ENV_FILE=/etc/arcade.env
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

echo "==> packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git python3 python3-venv sqlite3 curl \
  debian-keyring debian-archive-keyring apt-transport-https

if ! command -v caddy >/dev/null; then
  echo "==> caddy"
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/gpg.key \
    | gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -fsSL https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi

echo "==> service user"
id -u arcade >/dev/null 2>&1 || useradd --system --home /opt/arcade --shell /usr/sbin/nologin arcade
mkdir -p /opt/arcade

echo "==> code"
# The checkout is owned by the arcade user but git runs here as root, which git
# refuses ("dubious ownership") unless the path is marked safe.
git config --global --add safe.directory "$APP_DIR" 2>/dev/null || true
if [ -d "$APP_DIR/.git" ]; then
  BRANCH="$(git -C "$APP_DIR" symbolic-ref --short HEAD)"
  git -C "$APP_DIR" fetch --quiet origin "$BRANCH"
  git -C "$APP_DIR" reset --hard --quiet "origin/$BRANCH"
else
  git clone --quiet "$REPO" "$APP_DIR"
fi

echo "==> python deps"
[ -d "$VENV" ] || python3 -m venv "$VENV"
"$VENV/bin/pip" install --quiet --upgrade pip
"$VENV/bin/pip" install --quiet -r "$APP_DIR/requirements.txt"

echo "==> data dir"
mkdir -p "$APP_DIR/data"
chown -R arcade:arcade /opt/arcade

# Secrets are generated once and then left alone, so re-running never logs
# everyone out or changes the password behind your back.
if [ ! -f "$ENV_FILE" ]; then
  echo "==> generating secrets"
  ADMIN_PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"
  {
    echo "ARCADE_ADMIN_PASSWORD=${ADMIN_PW}"
    echo "ARCADE_SECRET_KEY=$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
  } > "$ENV_FILE"
  chmod 600 "$ENV_FILE"
  NEW_PASSWORD="$ADMIN_PW"
fi

echo "==> systemd"
install -m 644 "$HERE/arcade.service" /etc/systemd/system/arcade.service
systemctl daemon-reload
systemctl enable --quiet arcade
systemctl restart arcade

echo "==> caddy"
sed "s|^ARCADE_DOMAIN|${DOMAIN}|" "$HERE/Caddyfile" > /etc/caddy/Caddyfile
mkdir -p /var/log/caddy && chown caddy:caddy /var/log/caddy
systemctl reload caddy || systemctl restart caddy

sleep 2
systemctl is-active --quiet arcade && echo "==> arcade: running" || {
  echo "!! arcade failed to start:"; journalctl -u arcade -n 20 --no-pager; exit 1; }

echo
echo "  https://${DOMAIN}"
if [ -n "${NEW_PASSWORD:-}" ]; then
  echo "  dashboard password: ${NEW_PASSWORD}"
  echo "  (stored in ${ENV_FILE} - save it somewhere now)"
else
  echo "  dashboard password unchanged (see ${ENV_FILE})"
fi
echo
