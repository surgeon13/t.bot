#!/usr/bin/env bash
# Install Node.js 20.x on Debian/Ubuntu/Raspberry Pi OS (NodeSource).
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install-node-linux.sh"
  exit 1
fi

if ! command -v apt-get &>/dev/null; then
  echo "install-node-linux.sh supports apt-based systems only."
  echo "Install Node 18+ from https://nodejs.org/ for your distro."
  exit 1
fi

echo "[install-node-linux] Installing Node.js 20.x (NodeSource)…"
apt-get update -qq
apt-get install -y ca-certificates curl gnupg
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs

echo "[install-node-linux] $(node -v) $(npm -v)"
