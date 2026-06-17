#!/usr/bin/env bash
# Optional: increase swap on Raspberry Pi (helps 1 GB models run Chromium).
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/setup-pi-swap.sh"
  exit 1
fi

SWAP_MB="${SWAP_MB:-2048}"
CONF=/etc/dphys-swapfile

if [[ ! -f "$CONF" ]]; then
  echo "dphys-swapfile not found — not Raspberry Pi OS?"
  exit 1
fi

echo "[setup-pi-swap] Setting CONF_SWAPSIZE=${SWAP_MB} in $CONF"
sed -i "s/^CONF_SWAPSIZE=.*/CONF_SWAPSIZE=${SWAP_MB}/" "$CONF" || echo "CONF_SWAPSIZE=${SWAP_MB}" >> "$CONF"

dphys-swapfile swapoff 2>/dev/null || true
dphys-swapfile setup
dphys-swapfile swapon

echo "[setup-pi-swap] Done. Current swap:"
swapon --show || true
