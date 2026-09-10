#!/usr/bin/env bash
# t.bot install — system deps (Linux) + npm install + config hint.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> t.bot install (root: $ROOT)"

# Run a command as root: directly when already root, else via sudo.
as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif command -v sudo &>/dev/null; then
    sudo "$@"
  else
    echo "Need root for: $* (install sudo, or re-run this script as root)"
    return 1
  fi
}

# Ask a yes/no question. Non-interactive shells (CI, pipes) take the default.
confirm() {
  local prompt="$1" ans
  if [[ ! -t 0 ]]; then
    echo "$prompt [Y/n] Y (non-interactive)"
    return 0
  fi
  read -r -p "$prompt [Y/n] " ans || ans=""
  ans="${ans:-Y}"
  [[ "$ans" =~ ^[Yy] ]]
}

# True on Debian, Ubuntu, Raspberry Pi OS and their derivatives.
is_debian_like() {
  [[ -f /etc/os-release ]] || return 1
  # shellcheck disable=SC1091
  . /etc/os-release
  case " ${ID:-} ${ID_LIKE:-} " in
    *" debian "*|*" ubuntu "*|*" raspbian "*) return 0 ;;
    *) return 1 ;;
  esac
}

if [[ "$(uname -s)" == "Linux" ]]; then
  if is_debian_like && command -v apt-get &>/dev/null; then
    if confirm "Install system packages for Chromium via apt?"; then
      # Missing libs surface later as a browser launch error, so a failure here
      # is a warning — npm install should still run.
      as_root bash "$ROOT/scripts/install-system-deps.sh" || {
        echo "WARN: system package install failed — see docs/setup/linux.md"
        echo "      If the browser fails to launch, install the libs manually."
      }
    fi
  else
    src="$(. /etc/os-release 2>/dev/null && echo "${PRETTY_NAME:-this OS}")"
    echo "Note: for Playwright deps on ${src:-this OS}, see docs/setup/linux.md"
  fi
fi

need_node() {
  if ! command -v node &>/dev/null; then return 0; fi
  local major
  major="$(node -p "process.versions.node.split('.')[0]")"
  [[ "$major" -lt 18 ]]
}

if need_node; then
  echo "Node.js 18+ is required."
  if is_debian_like && command -v apt-get &>/dev/null; then
    if confirm "Install Node.js 20 via NodeSource (root)?"; then
      as_root bash "$ROOT/scripts/install-node-linux.sh"
    else
      echo "Install Node from https://nodejs.org/ then re-run: bash scripts/install.sh"
      exit 1
    fi
  else
    echo "Install Node 18+ from https://nodejs.org/ then re-run: bash scripts/install.sh"
    exit 1
  fi
fi

echo "==> Node $(node -v) npm $(npm -v)"
echo "==> npm install (includes Playwright Chromium)…"
npm install

if [[ ! -f config.json ]]; then
  if [[ -f config.example.json ]]; then
    cp config.example.json config.json
    echo "==> Created config.json from config.example.json — edit url, username, password."
  else
    echo "==> config.json will be created on first run."
  fi
else
  echo "==> config.json already exists — kept as-is."
fi

echo ""
echo "Done. Next steps:"
echo "  cd $ROOT"
echo "  npm run gui          # dashboard http://127.0.0.1:3733"
echo "  OPEN_BROWSER=0 npm run gui   # headless server (Pi / SSH)"
echo ""
echo "Platform guides: docs/setup/README.md"
