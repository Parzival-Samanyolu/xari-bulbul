#!/usr/bin/env bash
# Deploys the share-info collector to the VPS. Run from the Mac:
#   ./deploy.sh                 # host defaults to the ssh alias "oracle-amd1"
#   ./deploy.sh other-host
# Idempotent: safe to run again for updates.
set -euo pipefail

HOST="${1:-oracle-amd1}"
DOMAIN="193-122-49-121.sslip.io"
HERE="$(cd "$(dirname "$0")" && pwd)"
STAGE=".xb-telemetry-deploy"

echo "==> Running tests locally"
(cd "$HERE" && node --experimental-sqlite --disable-warning=ExperimentalWarning --test 'test/*.test.js' >/dev/null) \
  || { echo "Tests failed; not deploying." >&2; exit 1; }

echo "==> Copying files to $HOST:~/$STAGE"
ssh "$HOST" "mkdir -p ~/$STAGE && (command -v rsync >/dev/null || sudo apt-get install -y -qq rsync)"
rsync -az --delete \
  "$HERE/server.js" "$HERE/package.json" "$HERE/src" \
  "$HERE/xb-telemetry.service" "$HERE/Caddyfile" \
  "$HOST:$STAGE/"

echo "==> Configuring $HOST"
ssh "$HOST" "sudo STAGE=\"\$HOME/$STAGE\" DOMAIN=$DOMAIN bash -s" <<'REMOTE'
set -euo pipefail
export DEBIAN_FRONTEND=noninteractive

# --- Node 22 (NodeSource) ---------------------------------------------------
node_major() { command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0; }
if [ "$(node_major)" -lt 22 ]; then
  echo "--> Installing Node 22 from NodeSource"
  apt-get update -qq
  apt-get install -y -qq ca-certificates curl gnupg
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y -qq nodejs
fi
echo "--> node $(node --version)"
node --experimental-sqlite -e 'require("node:sqlite")' 2>/dev/null \
  || { echo "This Node build has no node:sqlite (needs 22.5+)." >&2; exit 1; }

# --- Caddy (official apt repo) ----------------------------------------------
if ! command -v caddy >/dev/null; then
  echo "--> Installing Caddy"
  apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' \
    | gpg --batch --yes --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' \
    > /etc/apt/sources.list.d/caddy-stable.list
  apt-get update -qq
  apt-get install -y -qq caddy
fi
echo "--> $(caddy version | head -n1)"

# --- App code ---------------------------------------------------------------
install -d -m 0755 /opt/xb-telemetry
rsync -a --delete --exclude Caddyfile --exclude xb-telemetry.service "$STAGE/" /opt/xb-telemetry/
chown -R root:root /opt/xb-telemetry
chmod -R u=rwX,go=rX /opt/xb-telemetry

# --- Secrets: STATS_TOKEN, generated once ----------------------------------
install -d -m 0700 /etc/xb-telemetry
NEW_TOKEN=""
if [ ! -f /etc/xb-telemetry/env ] || ! grep -q '^STATS_TOKEN=.\+' /etc/xb-telemetry/env; then
  NEW_TOKEN="$(head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  echo "STATS_TOKEN=$NEW_TOKEN" > /etc/xb-telemetry/env
fi
chmod 0600 /etc/xb-telemetry/env

# --- systemd ----------------------------------------------------------------
install -m 0644 "$STAGE/xb-telemetry.service" /etc/systemd/system/xb-telemetry.service
systemctl daemon-reload
systemctl enable xb-telemetry >/dev/null 2>&1
systemctl restart xb-telemetry

# --- Caddy site ---------------------------------------------------------------
install -d -m 0755 /etc/caddy/sites
install -m 0644 "$STAGE/Caddyfile" /etc/caddy/sites/xb-telemetry.caddy
if grep -q 'root \* /usr/share/caddy' /etc/caddy/Caddyfile 2>/dev/null && ! grep -q '^import sites/' /etc/caddy/Caddyfile; then
  # Stock Caddyfile from the package: replace it, keeping a backup.
  cp /etc/caddy/Caddyfile /etc/caddy/Caddyfile.dist
  echo 'import sites/*.caddy' > /etc/caddy/Caddyfile
elif ! grep -q '^import sites/\*\.caddy' /etc/caddy/Caddyfile 2>/dev/null; then
  printf '\nimport sites/*.caddy\n' >> /etc/caddy/Caddyfile
fi
caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null
systemctl enable caddy >/dev/null 2>&1
systemctl reload caddy 2>/dev/null || systemctl restart caddy

# --- Firewall: 80/443 ---------------------------------------------------------
# Oracle's Ubuntu images ship /etc/iptables/rules.v4 with a final
# "-A INPUT -j REJECT --reject-with icmp-host-prohibited", so 80/443 must be
# inserted *before* that rule and saved so they survive reboots.
for port in 80 443; do
  if ! iptables -C INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT 2>/dev/null; then
    reject_at="$(iptables -L INPUT --line-numbers -n | awk '$2=="REJECT"{print $1; exit}')"
    if [ -n "$reject_at" ]; then
      iptables -I INPUT "$reject_at" -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
    else
      iptables -A INPUT -p tcp -m state --state NEW -m tcp --dport "$port" -j ACCEPT
    fi
    echo "--> iptables: opened tcp/$port"
  fi
done
if ! command -v netfilter-persistent >/dev/null; then
  echo iptables-persistent iptables-persistent/autosave_v4 boolean true | debconf-set-selections
  echo iptables-persistent iptables-persistent/autosave_v6 boolean true | debconf-set-selections
  apt-get install -y -qq iptables-persistent
fi
netfilter-persistent save >/dev/null 2>&1 || iptables-save > /etc/iptables/rules.v4
if command -v ufw >/dev/null && ufw status | grep -q '^Status: active'; then
  ufw allow 80/tcp >/dev/null
  ufw allow 443/tcp >/dev/null
  echo "--> ufw: allowed 80/443"
fi

# --- Check --------------------------------------------------------------------
for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8787/healthz >/dev/null 2>&1 && break
  sleep 0.5
done
if curl -fsS http://127.0.0.1:8787/healthz >/dev/null; then
  echo "--> xb-telemetry is healthy on 127.0.0.1:8787"
else
  echo "xb-telemetry did not come up; recent logs:" >&2
  journalctl -u xb-telemetry -n 30 --no-pager >&2
  exit 1
fi

if [ -n "$NEW_TOKEN" ]; then
  echo
  echo "New stats token (saved in /etc/xb-telemetry/env, shown only now):"
  echo "  $NEW_TOKEN"
  echo "Dashboard: https://$DOMAIN/?token=$NEW_TOKEN"
fi
REMOTE

echo
echo "==> Checking https://$DOMAIN/healthz from here"
if curl -fsS --max-time 20 "https://$DOMAIN/healthz" >/dev/null 2>&1; then
  echo "    OK. The app's TELEMETRY_URL is https://$DOMAIN/v1/events"
else
  echo "    Not reachable yet. Caddy may still be getting its certificate, or the"
  echo "    Oracle VCN blocks the ports (see below). Retry in a minute."
fi
echo
echo "Reminder: the Oracle Cloud VCN security list (or NSG) for this instance must allow"
echo "ingress TCP 80 and 443 from 0.0.0.0/0. The host firewall is handled by this script;"
echo "the VCN is not: Console > Networking > Virtual cloud networks > subnet > Security list."
