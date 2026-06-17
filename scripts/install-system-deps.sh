#!/usr/bin/env bash
# Install Playwright/Chromium system libraries on Debian, Ubuntu, Raspberry Pi OS.
set -euo pipefail

if [[ "${EUID:-$(id -u)}" -ne 0 ]]; then
  echo "Run with sudo: sudo bash scripts/install-system-deps.sh"
  exit 1
fi

if ! command -v apt-get &>/dev/null; then
  echo "install-system-deps.sh supports apt-based systems (Debian/Ubuntu/Pi OS) only."
  echo "On other distros: npm install, then see https://playwright.dev/docs/library#system-requirements"
  exit 1
fi

echo "[install-system-deps] Updating apt index…"
apt-get update -qq

echo "[install-system-deps] Installing browser dependencies…"
apt-get install -y --no-install-recommends \
  libnss3 libnspr4 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
  libxkbcommon0 libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 \
  libasound2 libpango-1.0-0 libcairo2 libx11-6 libxext6 libxcb1 \
  libatspi2.0-0 libgtk-3-0 libxshmfence1 \
  ca-certificates curl git unzip

echo "[install-system-deps] Done."
