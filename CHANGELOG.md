# Changelog

All notable changes to **t.bot** are documented here. The project follows [Semantic Versioning](https://semver.org/) loosely while in pre-1.0.

## Unreleased

_(nothing yet)_

## 0.9.3 — 2026-05-28

### Added

- **GUI Quit bot** — header button and `POST /api/quit` shut down the embedded scheduler, browser session, and GUI process cleanly.
- **GUI Adventures panel** — list adventures, highlight shortest, **Send shortest** (`GET /api/adventures`, `POST /api/adventures/send-shortest`).
- **GUI proxy pool** — multiple addresses, rotation (`round-robin` / `random` / `sticky`), add/remove in the form, **Test** active proxy.
- **GUI inline scheduler** — periodic hero + resource runs in the same process as the dashboard (opt out with `GUI_NO_SCHEDULER=1`).
- **GUI themes** — Dark, Light, Ocean, Peach, and Auto (system) color palettes.
- **`npm run gui:dev`** — nodemon restarts server code; SSE hot-reloads `public/` in the browser.
- **`paths.js`** — shared project paths; runtime state under **`data/`** with automatic migration from legacy root files.
- **Per-hero GUI claims** — `POST /api/bonus/time` and `/api/bonus/danger` without sending the hero on an adventure.
- **Scoped bonus status poll** — `GET /api/bonuses/status?scope=hero|resources|all` so a hero-button click does not open the shop wizard.

### Changed

- **GUI layout** — account bar (player, login, IP), proxy + lifetime totals row, refreshed bonus cards and status labels.
- **Embedded scheduler** in `gui.js` shares the GUI browser and action lock with manual claims.
- **Account bar** — player name and public IP with **Refresh** (`POST /api/account/refresh`).
- **Proxy editor** — saves via `PUT /api/config/proxy`; session closes until **Re-login**.
- **Documentation** — expanded [docs/gui.md](docs/gui.md), configuration state paths, scheduler/GUI integration.

### Fixed

- Hero bonus button in the GUI no longer triggers a full resource shop poll afterward (scoped refresh).
- Port-in-use (`EADDRINUSE`) shows a clear message when another GUI instance is already running.
- Session re-check and re-login when the Travian shell disappears between actions.

## 0.9.2 — 2026-05-21

### Added

- **GUI account bar** — player name (from game UI), login username, public IP (browser/proxy egress), **Refresh** button.
- **GUI proxy editor** — form saves to `config.json` via `PUT /api/config/proxy`; session restarts on save; **Re-login** applies changes.
- **GUI proxy bar** — shows configured proxy address, working / failed / off state, and **Test proxy** button (`POST /api/proxy/test`). Auto-check after login.

### Added

- **HTTP/HTTPS/SOCKS5 proxy** — optional `proxy` block in `config.json` (Playwright `browser.newContext({ proxy })`). Applies to GUI, menu, scheduler, and one-shot CLI runs.
- Menu **(S)** settings for proxy on/off, server, username, password, and bypass list.

## 0.9.1 — 2026-05-21

### Added

- **Web GUI** (`npm run gui`) — Express server on `http://127.0.0.1:3733` with per-bonus buttons, hero stats panel, live log (SSE), and session re-login.
- **Claim all available resources** — GUI button and `POST /api/bonus/resources/claim-all` open the shop once and watch every claimable +15% resource video.
- **`browserLaunch.js`** — Shared Playwright launch with headless-by-default, `--headless=new`, automation-hardening args, and optional system Chrome (`channel: 'chrome'`).
- **`heroStats.js`** — Reads hero attributes from the React `/hero/attributes` page for the GUI.
- **Bonus status polling** — `GET /api/bonuses/status` reports hero adventure bonuses and all four resource boxes (claimable / active / timer).
- **Per-resource claim** — `claimResourceBonus(page, 'Wood'|'Clay'|'Iron'|'Crop')` for GUI single-button claims.
- **Debug endpoints** — `GET /api/debug/dom`, `/api/debug/shop`, `/api/debug/advantages` for selector tuning.
- **Documentation** — `docs/` folder (configuration, GUI, troubleshooting, architecture).
- **[docs/scheduler.md](docs/scheduler.md)** and expanded command tables in README.

### Changed

- **Headless is now the default** (`headless: true` in `config.example.json`; omitted or `true` in config runs without a window).
- **Video ad flow** — Two-step Travian dialog: info screen **Watch video** → `#videoArea` iframe; play detection scans ad iframes and supports auto-play in headless.
- **Shop / Advantages selectors** — Updated for `paymentShopV5` wizard and text-based Advantages tab (`a.tabItem`).
- **Resource bonus boxes** — Anchored on `.advantagesBonusBox.{lumber|clay|iron|crop}ProductionBonus` with `.bonusVideo` for claimable state.
- **Resource batch claim** — Reopens shop between videos if the wizard closes; returns `{ claimed, failed, available, claimedCount }`.
- **GUI poll cache** — Reduces duplicate shop opens when refreshing bonus status.

### Fixed

- Login timeouts (cookie banner, explicit field waits, debug snapshots in `debug/`).
- Resource bonus scheduler/GUI opening the shop multiple times in quick succession.
- Wrong resource order when claiming from a fixed array instead of DOM state.

---

## 0.9.0 — 2026-04-26

First packaged pre-release for export.

- Travian login via Playwright (Chromium).
- Hero adventures: claim **time** and **danger** video bonuses; does not auto-send hero on adventures.
- **15% resource video bonuses** from shop Advantages tab.
- `resourceBonuses` config, `npm run resources`, and `resource-bonus-state.json` due-time tracking.
- Interactive menu (`npm start`), one-shot claim (`npm run bonuses`), optional periodic scheduler (`npm run schedule`).
- `config.json` for credentials and options; `config.example.json` template.
- Append-only `bot.log`; `schedule-state.json` for next-run display in menu.
- Shared `videoAds.js` dialog watcher; `terminalControl.js` commands (`status`, `stop`, `run`) during long tasks.
- Random action delays; headless toggle; schedule interval (hours, min **0.25 h** between scheduler runs).

---

Use of this tool must comply with [Travian’s](https://www.travian.com/) terms of service and your local laws.
