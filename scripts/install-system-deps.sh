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

# Libraries whose package name is stable across releases.
BASE_PKGS=(
  libnss3 libnspr4 libdrm2 libxkbcommon0 libxcomposite1 libxdamage1
  libxfixes3 libxrandr2 libgbm1 libpango-1.0-0 libcairo2 libx11-6
  libxext6 libxcb1 libxshmfence1
  ca-certificates curl git unzip
)

# Libraries renamed with a "t64" suffix by the 64-bit time_t transition
# (Ubuntu 24.04+, Debian 13+). Older releases still use the plain name.
T64_PKGS=(
  libatk1.0-0 libatk-bridge2.0-0 libcups2 libasound2 libatspi2.0-0 libgtk-3-0
)

echo "[install-system-deps] Updating apt index…"
apt-get update -qq

# True when apt has a real installation candidate for the package.
# Uses a capture rather than a `| grep -q` pipeline: grep exits on the first
# match, and the resulting SIGPIPE on apt-cache would fail the whole pipeline
# under `set -o pipefail`.
has_candidate() {
  local out
  out="$(apt-cache policy "$1" 2>/dev/null)" || return 1
  [[ "$out" == *"Candidate: "* && "$out" != *"Candidate: (none)"* ]]
}

PKGS=()
MISSING=()

for pkg in "${BASE_PKGS[@]}"; do
  if has_candidate "$pkg"; then
    PKGS+=("$pkg")
  else
    MISSING+=("$pkg")
  fi
done

for pkg in "${T64_PKGS[@]}"; do
  if has_candidate "${pkg}t64"; then
    PKGS+=("${pkg}t64")
  elif has_candidate "$pkg"; then
    PKGS+=("$pkg")
  else
    MISSING+=("$pkg")
  fi
done

if [[ ${#MISSING[@]} -gt 0 ]]; then
  echo "[install-system-deps] Not available on this release, skipping: ${MISSING[*]}"
fi

if [[ ${#PKGS[@]} -eq 0 ]]; then
  echo "[install-system-deps] No known packages available — see docs/setup/linux.md"
  exit 1
fi

echo "[install-system-deps] Installing browser dependencies…"
apt-get install -y --no-install-recommends "${PKGS[@]}"

echo "[install-system-deps] Done."
