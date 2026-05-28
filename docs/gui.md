# Web GUI

Start the local control panel:

```bash
npm run gui
```

Default URL: **http://127.0.0.1:3733** (binds to localhost only).

### Hot reload (development)

```bash
npm run gui:dev
```

Uses [nodemon](https://nodemon.io/) plus a small live-reload hook:

| You edit | What happens |
|----------|----------------|
| `public/*.html`, `*.css`, `app.js` | Browser tab refreshes automatically (SSE) |
| `gui.js`, `adventures.js`, other root `*.js` | Server restarts (~1 s delay); Playwright session re-logs in |

`gui:dev` sets `OPEN_BROWSER=0` (open http://127.0.0.1:3733 yourself once). For a normal run without watchers, use `npm run gui`.

The GUI process:

1. Launches Playwright (headless by default — see [Configuration](configuration.md)).
2. Logs in once and keeps a single browser session.
3. Serves static files from `public/` and JSON APIs from `gui.js`.
4. Optionally opens your system browser tab (unless `OPEN_BROWSER=0`).

Automatic bonus runs are configured in the **Scheduler** panel (account bar). When **Periodic all bonuses** is ON and you save, the GUI runs the scheduler in the same process (same browser session as manual claims). You do not need a second terminal unless you set `GUI_NO_SCHEDULER=1`. See [scheduler.md](scheduler.md).

## Panels

### Appearance

**Dark** / **Light** / **Ocean** / **Peach** / **Auto** in the header — switches the GUI color theme. **Ocean** is cool teal; **Peach** is warm beige/cream. **Auto** follows your OS light/dark preference. The choice is stored in the browser (`localStorage`, key `tbot-theme`).

### Session strip

- **Green** — logged in, idle.  
- **Amber** — action in progress (only one browser task at a time).  
- **Red** — login failed; use **↻ Re-login**.  

Shows the configured username and the next scheduled resource bonus line when available.

| Button | Action |
|--------|--------|
| **↻ Re-login** | Close Playwright session and log in again (applies next proxy in round-robin). |
| **Quit bot** | `POST /api/quit` — stops embedded scheduler, closes browser, exits GUI process. |

After a single hero bonus click, only hero status is re-polled (Adventures page). After a resource click, only the shop is opened for that resource’s status — not both.

### Account bar

| Field | Source |
|-------|--------|
| **Player** | In-game name read from the Travian UI after login |
| **Login** | `config.json` username (account email/name used to log in) |
| **IP** | Public outbound IP as seen by the browser (through the proxy when enabled) |

**Refresh** calls `POST /api/account/refresh` to re-read name and IP without a full re-login.

### Proxy panel

**Status row** — connectivity test for the **active** proxy in the current browser session.

**Proxy pool** — list of all configured addresses (add with **Add**, remove with **×**). Tags:

| Tag | Meaning |
|-----|---------|
| **Active** | Used in the current session |
| **Next** | Next address on **Re-login** (round-robin) |
| Green/red edge | Last test result for the active proxy |

**Rotation** — `round-robin`, `random`, or `sticky` (always first). Shared username/password/bypass for every address in the pool.

**Save** — writes `config.json` (`PUT /api/config/proxy`), closes the session; **Re-login** to apply the next proxy.

**Password** — optional. If one is already saved, leave the field **empty** when you click **Save** to keep it; type a new value only to replace it. The hint line under the proxy form explains this (it is not the same as the **Save** button).

Shows connectivity state:

| Indicator | Meaning |
|-----------|---------|
| Gray dot — **Off** | `proxy.enabled` is false |
| Amber — **Unknown** | Proxy on but not tested yet (log in first) |
| Green — **Working** | Last test reached Travian through the browser context |
| Red — **Failed** | Timeout or unexpected page (check server, auth, bypass) |

**Test proxy** runs `POST /api/proxy/test` (opens Travian home URL through the same Playwright context as bonuses). Auto-tested after a successful login / re-login.

### Account bar — Scheduler

Inline on the same row as **Player** / **Login** / **IP** (fills the rest of the bar to the right edge). Controls the same options as menu **(S)** / `config.json` → `schedule` and `resourceBonuses`:

| Control | Config key | Meaning |
|---------|------------|---------|
| **Periodic all bonuses** | `schedule.enabled` | When ON, `npm run schedule` runs hero time/danger videos + optional resources on a timer |
| **Every N h** | `schedule.intervalHours` | Hours between full claim cycles (min **0.25**) |
| **Resource videos** | `resourceBonuses.enabled` | Include shop +15% videos in scheduled runs (only when due) |
| **Every N h** (resource) | `resourceBonuses.intervalHours` | Spacing after a successful resource batch (min **0.25**) |

**Save** — `PUT /api/config/schedule` (does not close the browser session). Restarts the embedded scheduler when settings change.

**Run now** — `POST /api/schedule/run-now` skips the wait and starts the next full claim cycle (same as `run` in the CLI scheduler terminal). Requires **All bonuses** ON.

Status lines show the next full run (`schedule-state.json`) and next resource batch (`resource-bonus-state.json`) when timers exist.

### Gather bonuses

First panel in the main column (full width).

| Control | Action |
|---------|--------|
| Adventure time bonus | Claims −25% travel time video on Adventures page |
| Adventure hardness bonus | Claims danger-reduction video |
| Wood / Clay / Iron / Crop | Opens shop → Advantages → claims that resource’s video if **claimable** |
| **Claim all available resources** | One shop visit; watches every resource that has `.bonusVideo` (not already on +25% gold buff) |
| **Refresh all bonuses** | Polls Adventures + shop once (`scope=all`; cached ~30s unless `?force=1`) |

Resource buttons show status from the last poll:

- **Claimable** — purple Activate + video icon present.  
- **Active** — buff running; countdown from `.timerReact` when readable.  
- **Unavailable** — on cooldown or shop unreachable.  

After a successful claim, the UI shows an optimistic **~8h active** until the next refresh confirms timers.

### Hero (dashboard column)

**Hero** panel in the top row beside **Proxy** and **Lifetime totals** (same height). Click the header bar (hero name + HP / adventure count) to collapse or expand. **↻** refreshes stats from `/hero/attributes`.

### Adventures (in hero dropdown)

Lists available adventures from the Travian adventures page (place, distance, travel time, difficulty). Each row shows **Time** and **Dist**; the **shortest** sendable row is highlighted.

| Control | Action |
|---------|--------|
| **Refresh** | `GET /api/adventures` — re-read the list |
| **Send shortest** | `POST /api/adventures/send-shortest` — sends the adventure with the lowest parsed travel time |
| **Send** (per row) | `POST /api/adventures/send` with `{ "index": N }` — sends that specific adventure |

The hero is **not** sent automatically by the scheduler or bonus routine; only this button (or future extensions) sends them.

### Lifetime totals

Shows how many times each **video bonus was successfully watched** by t.bot on this machine (persisted in `data/totals-state.json`). This is not the same as “buff active now” on the bonus buttons — it is a running success counter. **Last completed** is the most recent claim the bot logged.

### Live log

Server-sent events stream from `bot.log` (and in-memory buffer). Successful bonus lines trigger a quiet status refresh after a few seconds.

### Farm lists

Panel in the **proxy column** (directly under the Proxy applet, left of Lifetime totals). Each cycle sends **all checked** lists, then waits a random delay between **min** and **max** minutes. See **[farm-list.md](farm-list.md)** for config keys and API routes.

| Control | Action |
|---------|--------|
| **Runner ON** | Enable background timer |
| **Load from game** | Load all farm list names from Travian |
| **All / None** | Check or uncheck every list |
| Per-list checkbox | Include list in each send cycle when checked |
| **Save** | Persist `farmList` in `config.json` |
| **Run now** | Send all checked lists as soon as possible |
| **Send all** | Immediate send of all checked lists |

### Extensions

Placeholder section for future features (build queue, marketplace, etc.).

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `3733` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `OPEN_BROWSER` | open | Set to `0` to skip launching the OS browser tab |
| `GUI_NO_SCHEDULER` | off | Set to `1` to disable the in-process scheduler (use `npm run schedule` separately) |
| `DEV_RELOAD` | off | Set to `1` by `npm run gui:dev` — SSE reload when `public/` changes |

Example:

```bash
set PORT=4000
set OPEN_BROWSER=0
npm run gui
```

## HTTP API (reference)

All `POST` bonus routes clear the bonus poll cache and run under a mutex (queue if busy).

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/health` | `{ loggedIn, busy, action }` |
| `GET` | `/api/status` | Session, **totals**, **account**, **proxy** status, **proxyConfig** for the form |
| `GET` | `/api/config/proxy` | Proxy fields for the GUI form (password not returned; `hasPassword` flag) |
| `PUT` | `/api/config/proxy` | Save proxy to `config.json` and close session |
| `GET` | `/api/config/schedule` | Scheduler settings + next-run status for the form |
| `PUT` | `/api/config/schedule` | Save `schedule` / `resourceBonuses` to `config.json` |
| `POST` | `/api/schedule/run-now` | Trigger the next full scheduled claim cycle immediately |
| `POST` | `/api/proxy/test` | Re-test proxy through the browser; returns `{ ok, proxy }` |
| `POST` | `/api/account/refresh` | Re-read player name and public IP |
| `GET` | `/api/hero?deep=1` | Hero stats object |
| `GET` | `/api/adventures` | Adventure list + hero-away flag + shortest index |
| `POST` | `/api/adventures/send-shortest` | Send hero to shortest sendable adventure |
| `POST` | `/api/adventures/send` | Send hero to adventure by row `index` |
| `GET` | `/api/bonuses/status` | Bonus poll; `?force=1` bypasses cache; `?scope=` `hero`, `resources`, or `all` (default) |
| `POST` | `/api/quit` | Graceful shutdown (scheduler + browser + HTTP server) |
| `GET` | `/api/resources/status` | Resource boxes only |
| `POST` | `/api/bonus/time` | Claim adventure time bonus |
| `POST` | `/api/bonus/danger` | Claim adventure danger bonus |
| `POST` | `/api/bonus/resource/:name` | `Wood`, `Clay`, `Iron`, or `Crop` |
| `POST` | `/api/bonus/resources/claim-all` | Batch resource videos |
| `POST` | `/api/relogin` | Close session and log in again |
| `POST` | `/api/quit` | Graceful shutdown |
| `GET` | `/api/config/farm-list` | Farm list settings + timer status |
| `PUT` | `/api/config/farm-list` | Save farm list settings |
| `POST` | `/api/farm-list/run-now` | Queue next farm list send |
| `POST` | `/api/farm-list/send-all` | Send all checked lists immediately |
| `GET` | `/api/farm-list/discover` | Read list names from farm list page |
| `GET` | `/api/log/stream` | SSE log stream |

Debug (read-only, for development):

| Method | Path |
|--------|------|
| `GET` | `/api/debug/dom` |
| `GET` | `/api/debug/shop` |
| `GET` | `/api/debug/advantages` |

### Claim-all response shape

```json
{
  "ok": true,
  "status": "claimed",
  "claimedCount": 2,
  "available": ["Wood", "Crop"],
  "claimed": ["Wood", "Crop"],
  "failed": [],
  "message": "Claimed Wood, Crop"
}
```

## Adding a new GUI feature

1. Add UI in `public/index.html` (new card under `<main>`).  
2. Wire clicks in `public/app.js`.  
3. Add route(s) in `gui.js` using `withSession()` so actions do not overlap.  
4. Document the endpoint here and in [Architecture](architecture.md).
