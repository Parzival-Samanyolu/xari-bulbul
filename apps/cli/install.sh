#!/usr/bin/env bash
# Installs the `xari` terminal app on a Linux server (Ubuntu/Debian/Fedora/Oracle Linux, x64 or arm64):
#   curl -fsSL https://raw.githubusercontent.com/Parzival-Samanyolu/xari-bulbul/main/apps/cli/install.sh | sudo bash
# Options (environment): XARI_REF=<branch or tag> (default main), XARI_SRC=<local checkout to build instead
# of cloning>, XARI_SWAP_GB=<total swap to reach, default 4; 0 skips>, XARI_SKIP_KEY=1 (don't ask for a key).
# Safe to run again: it updates the app and leaves existing swap, settings and keys alone.
set -euo pipefail

REPO=https://github.com/Parzival-Samanyolu/xari-bulbul.git
REF=${XARI_REF:-main}
SWAP_GB=${XARI_SWAP_GB:-4}
NODE_VERSION=22.12.0
PREFIX=/opt/xari
say() { printf '\033[35m✿\033[0m %s\n' "$*"; }
warn() { printf '\033[33m!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[31m✕\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] || die "Run with sudo: curl -fsSL … | sudo bash"
[[ $(uname -s) == Linux ]] || die "This installer is for Linux servers."
# The person who ran sudo gets the settings and the key, not root.
USER_NAME=${SUDO_USER:-root}
USER_HOME=$(getent passwd "$USER_NAME" | cut -d: -f6)

# ---------------------------------------------------------------- swap
# Small servers run out of memory while installing and building; top swap up to SWAP_GB with an
# extra swap file (the existing swap stays as it is).
add_swap() {
  (( SWAP_GB > 0 )) || return 0
  local have_kb want_kb need_mb
  have_kb=$(awk '/SwapTotal/ {print $2}' /proc/meminfo)
  want_kb=$(( SWAP_GB * 1024 * 1024 ))
  if (( have_kb + 65536 >= want_kb )); then say "Swap: $(( have_kb / 1024 )) MB, enough"; return 0; fi
  need_mb=$(( (want_kb - have_kb) / 1024 ))
  local file=/swapfile-xari
  if [[ -f $file ]]; then warn "$file already exists; leaving swap as it is"; return 0; fi
  local free_mb; free_mb=$(df -Pm / | awk 'NR==2 {print $4}')
  if (( free_mb < need_mb + 1024 )); then warn "Only ${free_mb} MB free on disk; skipping the extra swap"; return 0; fi
  say "Adding ${need_mb} MB of swap ($file), for $SWAP_GB GB in total"
  fallocate -l "${need_mb}M" "$file" 2>/dev/null || dd if=/dev/zero of="$file" bs=1M count="$need_mb" status=none
  chmod 600 "$file"
  mkswap -q "$file" >/dev/null
  swapon "$file"
  grep -q "^$file " /etc/fstab || echo "$file none swap sw 0 0" >> /etc/fstab
  # Prefer RAM; use swap only when memory is really short, so the machine stays responsive.
  echo 'vm.swappiness=10' > /etc/sysctl.d/90-xari-swap.conf
  sysctl -q -p /etc/sysctl.d/90-xari-swap.conf || true
}

# ---------------------------------------------------------------- packages
install_packages() {
  local missing=()
  for c in git curl tar xz; do command -v "$c" >/dev/null || missing+=("$c"); done
  (( ${#missing[@]} )) || return 0
  say "Installing ${missing[*]}"
  if command -v apt-get >/dev/null; then
    DEBIAN_FRONTEND=noninteractive apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq git curl tar xz-utils ca-certificates >/dev/null
  elif command -v dnf >/dev/null; then dnf -y -q install git curl tar xz ca-certificates
  elif command -v yum >/dev/null; then yum -y -q install git curl tar xz ca-certificates
  else die "Install git, curl, tar and xz, then run this again."; fi
}

# Node 22 from nodejs.org (the distribution's Node is often too old), in /opt/xari/node.
install_node() {
  local v; v=$(command -v node >/dev/null && node -p 'process.versions.node.split(".")[0]' || echo 0)
  if (( v >= 22 )); then NODE=$(command -v node); say "Node $(node -v) found"; return 0; fi
  local arch
  case $(uname -m) in x86_64) arch=x64 ;; aarch64 | arm64) arch=arm64 ;; *) die "Unsupported CPU: $(uname -m)" ;; esac
  if [[ ! -x $PREFIX/node/bin/node ]]; then
    say "Installing Node $NODE_VERSION ($arch)"
    mkdir -p "$PREFIX/node"
    curl -fsSL "https://nodejs.org/dist/v$NODE_VERSION/node-v$NODE_VERSION-linux-$arch.tar.xz" | tar -xJ -C "$PREFIX/node" --strip-components=1
  fi
  NODE=$PREFIX/node/bin/node
  export PATH=$PREFIX/node/bin:$PATH
}

# ---------------------------------------------------------------- build
build_cli() {
  local src
  if [[ -n ${XARI_SRC:-} ]]; then
    src=$XARI_SRC
  else
    src=$PREFIX/src
    if [[ -d $src/.git ]]; then
      say "Updating the source ($REF)"
      git -C "$src" fetch -q --depth 1 origin "$REF" && git -C "$src" checkout -q -f FETCH_HEAD
    else
      say "Downloading the source ($REF)"
      rm -rf "$src"
      git clone -q --depth 1 --branch "$REF" "$REPO" "$src" || die "Could not download $REPO ($REF). If the repo is private, clone it yourself and run with XARI_SRC=/path/to/it."
    fi
  fi
  say "Building xari (a minute or two on a small server)"
  cd "$src"
  # pnpm comes with Node (corepack); only the CLI and the engine are installed, not the desktop app.
  export COREPACK_ENABLE_DOWNLOAD_PROMPT=0 NODE_OPTIONS=--max-old-space-size=1024
  "$(dirname "$NODE")/corepack" enable --install-directory "$PREFIX/node-bin" >/dev/null 2>&1 || true
  local pnpm="$PREFIX/node-bin/pnpm"
  [[ -x $pnpm ]] || pnpm="$(dirname "$NODE")/corepack pnpm"
  $pnpm install -s --frozen-lockfile --filter "@harness/cli..." --config.node-linker=hoisted
  $pnpm -s build:cli
  install -d "$PREFIX/bin"
  install -m 755 apps/cli/dist/xari.mjs "$PREFIX/bin/xari.mjs"
  # The command: the bundled app on this Node, whatever Node is first on PATH.
  cat > /usr/local/bin/xari <<EOF
#!/bin/sh
exec "$NODE" "$PREFIX/bin/xari.mjs" "\$@"
EOF
  chmod 755 /usr/local/bin/xari
  say "Installed: $(xari --version) → /usr/local/bin/xari"
}

# ---------------------------------------------------------------- settings and key
# Same folder the desktop app uses: settings, chats and (on servers without a keyring) keys.
DATA_DIR="$USER_HOME/.config/Xarı Bülbül"

set_up_key() {
  [[ ${XARI_SKIP_KEY:-} == 1 ]] && return 0
  [[ -r /dev/tty ]] || { warn "No terminal to ask for a key; set SYNAPSE_API_KEY or OPENROUTER_API_KEY later."; return 0; }
  if [[ -f "$DATA_DIR/xb-secrets.json" ]]; then say "A key is already saved for $USER_NAME"; return 0; fi
  echo
  echo "Which model service should xari use?"
  echo "  1) Synapse (your own server; key from the Synapse website)"
  echo "  2) OpenRouter (key from openrouter.ai/keys)"
  echo "  3) Skip for now"
  local pick; read -r -p "Choose 1-3 [1]: " pick </dev/tty || pick=3
  local provider model
  case ${pick:-1} in
    1) provider=synapse; model=synapse-2 ;;
    2) provider=openrouter; model=openrouter/free ;;
    *) return 0 ;;
  esac
  local key; read -r -s -p "Paste the API key (not shown): " key </dev/tty; echo
  [[ -n $key ]] || { warn "No key entered; skipping."; return 0; }
  install -d -m 700 -o "$USER_NAME" "$DATA_DIR"
  # Stored only on this server, readable only by $USER_NAME (no keyring on most servers).
  PROVIDER=$provider KEY=$key MODEL=$model DIR="$DATA_DIR" "$NODE" -e '
    const fs = require("fs"), path = require("path"), d = process.env.DIR
    const sf = path.join(d, "xb-secrets.json"), st = path.join(d, "settings.json")
    const secrets = fs.existsSync(sf) ? JSON.parse(fs.readFileSync(sf, "utf8")) : {}
    secrets[process.env.PROVIDER] = process.env.KEY
    fs.writeFileSync(sf, JSON.stringify(secrets), { mode: 0o600 })
    const s = fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, "utf8")) : {}
    s.models = { ...(s.models || {}), default: { providerId: process.env.PROVIDER, modelId: process.env.MODEL } }
    fs.writeFileSync(st, JSON.stringify(s, null, 2))
  '
  chown -R "$USER_NAME" "$DATA_DIR"
  chmod 600 "$DATA_DIR/xb-secrets.json"
  say "Saved the $provider key for $USER_NAME; default model $provider/$model"
}

add_swap
install_packages
install_node
build_cli
set_up_key
echo
say "Done. Start it in a project folder:  cd ~/my-project && xari"
say "One-off answers:  xari -p \"explain this repo\"   ·   Update later: run this installer again."
