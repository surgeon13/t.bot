# t.bot install — Windows (Node 18+ required)
$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $Root

Write-Host "==> t.bot install (root: $Root)"

function Test-NodeOk {
    try {
        $v = node -p "process.versions.node.split('.')[0]" 2>$null
        return [int]$v -ge 18
    } catch { return $false }
}

if (-not (Get-Command node -ErrorAction SilentlyContinue) -or -not (Test-NodeOk)) {
    Write-Host "Node.js 18+ is required. Install from https://nodejs.org/ then re-run this script."
    exit 1
}

Write-Host "==> Node $(node -v) npm $(npm -v)"
Write-Host "==> npm install (includes Playwright Chromium)..."
npm install

$cfg = Join-Path $Root "config.json"
$example = Join-Path $Root "config.example.json"
if (-not (Test-Path $cfg)) {
    if (Test-Path $example) {
        Copy-Item $example $cfg
        Write-Host "==> Created config.json from config.example.json — edit url, username, password."
    }
} else {
    Write-Host "==> config.json already exists — kept as-is."
}

Write-Host ""
Write-Host "Done. Next steps:"
Write-Host "  cd $Root"
Write-Host "  npm run gui          # dashboard http://127.0.0.1:3733"
Write-Host ""
Write-Host "See docs/setup/windows.md"
