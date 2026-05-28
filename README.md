# t.bot

**Version 0.9.3**

Node.js + [Playwright](https://playwright.dev/) helper for **Travian Legends** video bonuses: hero adventure **time** and **danger** reductions, plus **+15%** Wood / Clay / Iron / Crop production from the shop **Advantages** tab.

The bot watches the required video ads and clicks through Travian’s dialogs. The **web GUI** can send your hero to the **shortest** available adventure on demand; scheduled/CLI bonus runs still do **not** auto-send. It does not build villages or control troops.

> Use only in line with [Travian’s](https://www.travian.com/) terms of service and your local rules.

## Features (0.9.3)

- **Web GUI** — per-bonus buttons, hero stats, adventures list, live log, **Claim all available resources**, **Quit bot**
- **Embedded scheduler** — periodic runs inside the GUI process (or `npm run schedule` in a second terminal)
- **Proxy pool** — multiple servers with round-robin / random / sticky rotation
- **GUI themes** — Dark, Light, Ocean, Peach, Auto
- **Headless by default** — optional visible browser; prefers installed Chrome for video ads
- **Optional HTTP/SOCKS5 proxy** — route all browser traffic through `config.json` → `proxy`
- **CLI menu**, **one-shot** scripts, and **scheduler** loop
- **Resource bonus polling** — claimable vs active buff + countdown timers; scoped polls avoid opening the shop after hero-only actions
- **Runtime state in `data/`** — logs and JSON state files (auto-migrated from project root)
- **Debug helpers** — snapshots under `debug/` and `/api/debug/*` when tuning selectors

📖 **Full documentation:** [docs/README.md](docs/README.md)

| Topic | Guide |
|-------|--------|
| `config.json` options | [docs/configuration.md](docs/configuration.md) |
| Periodic scheduler | [docs/scheduler.md](docs/scheduler.md) |
| Web GUI & API | [docs/gui.md](docs/gui.md) |
| Resource +15% bonuses | [docs/resource-bonuses.md](docs/resource-bonuses.md) |
| Login, videos, headless | [docs/troubleshooting.md](docs/troubleshooting.md) |
| Module map | [docs/architecture.md](docs/architecture.md) |
| Release history | [CHANGELOG.md](CHANGELOG.md) |

## Requirements

- [Node.js](https://nodejs.org/) **v18+**
- Travian Legends account and server URL
- **Recommended:** Google Chrome installed (better headless video than bundled Chromium alone)

## Project layout

Clone or unzip into a folder named **`t.bot`** (export zip uses that name). Runtime files go under **`data/`** (created automatically):

```
t.bot/
  config.json          ← your settings (gitignored)
  config.example.json
  package.json
  *.js                 ← bot code
  public/              ← web GUI
  docs/
  scripts/
  paths.js             ← project + data/ paths
  data/                ← bot.log, *-state.json (gitignored)
  debug/               ← login/video snapshots (gitignored)
```

## Quick start

```bash
cd t.bot
npm install
```

`npm install` runs `npx playwright install chromium` automatically.

Create config (never commit the real file):

On first run, if `config.json` is missing, the bot **creates it automatically** from `config.example.json` (or built-in defaults). You can also copy the template yourself:

```bash
copy config.example.json config.json
```

Edit `config.json`: set `url`, `username`, `password`. Defaults use **`"headless": true`**.

### Run the GUI (recommended)

```bash
npm run gui
```

Open **http://127.0.0.1:3733** (or the port you set). Use **Refresh all bonuses** on startup to read current states, then claim individually or with **Claim all available resources**.

### All commands

| Command | Purpose |
|---------|---------|
| `npm start` | Interactive terminal menu (settings, adventures check, claim bonuses) |
| `npm run gui` | Web control panel (see above) |
| `npm run gui:dev` | Same GUI with hot reload for UI + server code ([details](docs/gui.md)) |
| `npm run bonuses` | One shot: login → hero bonuses → resource bonuses **if enabled and due** → exit |
| `npm run resources` | One shot: login → **force** all claimable resource videos → exit |
| `npm run schedule` | **Scheduler loop** — repeat `bonuses` on a timer until stopped ([guide](docs/scheduler.md)) |
| `npm run export` | Create clean `t.bot-v<version>.zip` for another PC |

### Scheduler (`npm run schedule`)

Long-running process (`scheduler.js`). Each cycle = same as `npm run bonuses`, then wait **`schedule.intervalHours`** (default 3 h, min 15 min).

1. Set `"schedule": { "enabled": true }` in config, or menu **(S)** / GUI scheduler → Periodic claims **ON**.  
2. **GUI:** `npm run gui` runs the timer automatically (same browser as the dashboard). **CLI:** run `npm run schedule` in a second terminal.  
3. Next run time is written to `schedule-state.json` after the first cycle.

CLI: while waiting, type **`status`**, **`stop`**, or **`run`** / **`now`** in the scheduler terminal. Set **`GUI_NO_SCHEDULER=1`** to disable the built-in GUI scheduler. Full details: **[docs/scheduler.md](docs/scheduler.md)**.

**Environment (GUI):**

```bash
set PORT=4000
set OPEN_BROWSER=0
npm run gui
```

## Configuration summary

| Key | Default | Notes |
|-----|---------|--------|
| `headless` | `true` | Set `false` if videos fail |
| `browserChannel` | `true` | Use installed Chrome when possible |
| `proxy.enabled` | `false` | Route browser via `proxy.server` (http/https/socks5) |
| `resourceBonuses.enabled` | `false` | Required for scheduler/menu auto resource runs |
| `resourceBonuses.intervalHours` | `8` | Between scheduled resource batch attempts |
| `schedule.enabled` | `false` | Enables periodic `npm run schedule` |
| `schedule.intervalHours` | `3` | Between full bonus runs |

See [docs/configuration.md](docs/configuration.md) for every field and state file.

## Project layout

| Path | Role |
|------|------|
| `menu.js` | Interactive CLI |
| `gui.js` / `public/` | Web GUI (Express + static UI) |
| `browserLaunch.js` | Shared Playwright launch (headless, Chrome channel) |
| `auth.js` | Config load/save + login |
| `adventures.js` | Hero time/danger video bonuses |
| `resourceBonuses.js` | Shop Advantages +15% videos |
| `videoAds.js` | Shared video dialog watcher |
| `heroStats.js` | Hero panel for GUI |
| `claimJob.js` | One-shot browser session for CLI |
| `claim-all-bonuses.js` / `claim-resource-bonuses.js` | CLI entry wrappers |
| `scheduler.js` / `scheduleState.js` | Periodic runs |
| `terminalControl.js` | `status` / `stop` / `run` during tasks |
| `paths.js` | `data/`, `debug/`, config paths; legacy file migration |
| `logger.js` / `data/bot.log` | Logging (+ GUI SSE) |
| `config.example.json` | Safe template → copy to `config.json` |
| `docs/` | Detailed guides |

Local state (gitignored): `config.json`, `data/` (`bot.log`, `*-state.json`), `debug/`.

## Terminal commands (during long runs)

While **`npm run schedule`** or a menu claim task is running, type in **that** terminal:

| Command | Aliases | Effect |
|---------|---------|--------|
| `status` | `s` | Current state (scheduler shows next run time) |
| `stop` | `q`, `quit` | Stop after the current browser step |
| `run` | `now` | Scheduler only: start the next cycle now |

## Sharing / export zip

From the project folder:

```bash
npm run export
```

Creates **`t.bot-v<version>.zip`** (unpacks to a **`t.bot/`** folder) without `node_modules`, secrets, or local state. Recipients run `npm install`, copy `config.example.json` → `config.json`, and configure credentials.

Do **not** ship `config.json`, `data/`, or `debug/`.

## License

ISC (see `package.json`).
