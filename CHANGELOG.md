# Changelog

All notable changes to **t.bot** are documented here. The project follows [Semantic Versioning](https://semver.org/) loosely while in pre-1.0.

## Unreleased

### Added

- **GUI proxy bar** — shows configured proxy address, working / failed / off state, and **Test proxy** button (`POST /api/proxy/test`). Auto-check after login.

## 0.9.2 — 2026-05-21

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
