# t.bot documentation

**Version 0.9.1**

This folder contains detailed guides. For a quick start, see the [main README](../README.md).

| Guide | Contents |
|-------|----------|
| [Configuration](configuration.md) | Every `config.json` option, state files, timers |
| [Scheduler](scheduler.md) | `npm run schedule`, intervals, terminal commands |
| [Web GUI](gui.md) | `npm run gui`, buttons, API, environment variables |
| [Resource bonuses](resource-bonuses.md) | Shop flow, claimable vs active, batch claim |
| [Troubleshooting](troubleshooting.md) | Login, videos, headless, debug snapshots |
| [Architecture](architecture.md) | Module map and data flow |

## What t.bot does

t.bot automates **watching Travian Legends video ads** to claim:

1. **Hero adventure bonuses** — time reduction (−25% travel) and danger reduction (on the Adventures page).
2. **Resource production bonuses** — +15% Wood / Clay / Iron / Crop for ~8 hours (shop → **Advantages** → purple **Activate** + video icon).

It does **not** send your hero on adventures, manage troops, or interact with the map beyond opening the pages needed for bonuses.

## All npm commands

| Command | Script | Description |
|---------|--------|-------------|
| `npm start` | `menu.js` | Interactive terminal menu |
| `npm run gui` | `gui.js` | Web control panel at http://127.0.0.1:3733 |
| `npm run bonuses` | `claim-all-bonuses.js` | One shot: login → hero bonuses → due resources → exit |
| `npm run resources` | `claim-resource-bonuses.js` | One shot: login → force all claimable resource videos → exit |
| `npm run schedule` | `scheduler.js` | **Loop:** repeat `bonuses` every `schedule.intervalHours` (requires `schedule.enabled`) |
| `npm run export` | `scripts/export-zip.js` | Create `t.bot-v<version>.zip` for deployment |

## Typical workflows

| Goal | Command |
|------|---------|
| Click bonuses yourself in a browser UI | `npm run gui` |
| One-shot hero + due resource bonuses | `npm run bonuses` |
| Force all claimable resource videos now | `npm run resources` or GUI **Claim all available resources** |
| **Automatic runs on a timer** | [Scheduler guide](scheduler.md): `schedule.enabled: true`, then `npm run schedule` in a second terminal |
| Tweak settings interactively | `npm start` → **(S)** settings |

## Support files (do not commit)

| File | Purpose |
|------|---------|
| `config.json` | Your credentials and options (auto-created on first run if missing) |
| `bot.log` | Append-only run log |
| `schedule-state.json` | Next scheduler run (menu display) |
| `resource-bonus-state.json` | Resource bonus due times and per-resource claims |
| `debug/` | Optional HTML/JSON snapshots when login or video steps fail |
