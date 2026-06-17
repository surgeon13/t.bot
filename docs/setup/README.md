# Platform setup guides

Step-by-step install for **t.bot** on common systems. All paths assume the project folder is **`t.bot/`** with Node.js **18+**.

| Platform | Guide | Install script |
|----------|--------|----------------|
| **Raspberry Pi** (3/4/5, Pi OS) | [raspberry-pi.md](raspberry-pi.md) | `bash scripts/install.sh` |
| **Linux** (Debian/Ubuntu) | [linux.md](linux.md) | `bash scripts/install.sh` |
| **Windows** | [windows.md](windows.md) | `powershell -ExecutionPolicy Bypass -File scripts/install.ps1` |
| **macOS** | [macos.md](macos.md) | `bash scripts/install.sh` |

## Quick install (any platform with Node already)

```bash
cd t.bot
npm install
cp config.example.json config.json   # or let first run create it
# edit config.json — url, username, password
npm run gui
```

`npm install` runs Playwright’s Chromium download automatically.

## Get the code

**Git**

```bash
git clone https://github.com/surgeon13/t.bot.git
cd t.bot
git checkout v0.9.9   # or latest tag
```

**Release zip** — [GitHub Releases](https://github.com/surgeon13/t.bot/releases) → `t.bot-v<version>.zip`, unzip, `cd t.bot`.

## After install

| Goal | Command |
|------|---------|
| Web dashboard | `npm run gui` → http://127.0.0.1:3733 |
| Headless server (Pi / SSH) | `OPEN_BROWSER=0 npm run gui` |
| Scheduler only (no GUI) | `npm run schedule` (needs `schedule.enabled: true`) |
| One-shot bonuses | `npm run bonuses` |

See [gui.md](../gui.md) for environment variables (`PORT`, `HOST`, `OPEN_BROWSER`).

## Copying config from another machine

Copy **`config.json`** into the new `t.bot/` folder (never commit it). Runtime state in **`data/`** is optional — omit it for a clean start.
