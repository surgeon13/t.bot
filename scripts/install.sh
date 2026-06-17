#!/usr/bin/env bash
# t.bot install — system deps (Linux) + npm install + config hint.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> t.bot install (root: $ROOT)"

# Optional: install apt packages on Debian/Ubuntu/Pi OS
if [[ -f /etc/os-release ]]; then
  # shellcheck disable=SC1091
  . /etc/os-release
  case "${ID:-}:${ID_LIKE:-}" in
    debian:*|ubuntu:*|raspbian:*|*:debian|*:ubuntu) ;;
    *)
      echo "Note: for Playwright deps on ${PRETTY_NAME:-this OS}, see docs/setup/linux.md"
      ;;
  esac
  if [[ "${ID:-}" == "debian" || "${ID:-}" == "ubuntu" || "${ID:-}" == "raspbian" ]]; then
    if command -v apt-get &>/dev/null; then
      read -r -p "Install system packages for Chromium via apt? [Y/n] " ans
      ans="${ans:-Y}"
      if [[ "$ans" =~ ^[Yy] ]]; then
        sudo bash "$ROOT/scripts/install-system-deps.sh"
      fi
    fi
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
  if [[ -f /etc/os-release ]] && command -v apt-get &>/dev/null; then
    read -r -p "Install Node.js 20 via NodeSource (sudo)? [Y/n] " ans
    ans="${ans:-Y}"
    if [[ "$ans" =~ ^[Yy] ]]; then
      sudo bash "$ROOT/scripts/install-node-linux.sh"
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
