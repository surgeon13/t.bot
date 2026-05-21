# Web GUI

Start the local control panel:

```bash
npm run gui
```

Default URL: **http://127.0.0.1:3733** (binds to localhost only).

The GUI process:

1. Launches Playwright (headless by default — see [Configuration](configuration.md)).
2. Logs in once and keeps a single browser session.
3. Serves static files from `public/` and JSON APIs from `gui.js`.
4. Optionally opens your system browser tab (unless `OPEN_BROWSER=0`).

**Note:** Periodic automatic claims use **`npm run schedule`** in a separate terminal, not the GUI. See [scheduler.md](scheduler.md).

## Panels

### Session strip

- **Green** — logged in, idle.  
- **Amber** — action in progress (only one browser task at a time).  
- **Red** — login failed; use **↻ Re-login**.  

Shows the configured username and the next scheduled resource bonus line when available.

### Hero

Displays parsed stats from `/hero/attributes` (health, XP, fight strength, off/def bonus, resource bonus %, speed, home village, free attribute points, adventure badge).

- **Refresh hero** — re-reads the page (may navigate away briefly).

### Gather bonuses

| Control | Action |
|---------|--------|
| Adventure time bonus | Claims −25% travel time video on Adventures page |
| Adventure hardness bonus | Claims danger-reduction video |
| Wood / Clay / Iron / Crop | Opens shop → Advantages → claims that resource’s video if **claimable** |
| **Claim all available resources** | One shop visit; watches every resource that has `.bonusVideo` (not already on +25% gold buff) |
| **Refresh all bonuses** | Polls Adventures + shop once (cached ~30s unless forced) |

Resource buttons show status from the last poll:

- **Claimable** — purple Activate + video icon present.  
- **Active** — buff running; countdown from `.timerReact` when readable.  
- **Unavailable** — on cooldown or shop unreachable.  

After a successful claim, the UI shows an optimistic **~8h active** until the next refresh confirms timers.

### Totals

Lifetime counters for how many times each bonus type was claimed (from `totals` module).

### Live log

Server-sent events stream from `bot.log` (and in-memory buffer). Successful bonus lines trigger a quiet status refresh after a few seconds.

### Extensions

Placeholder section in `public/index.html` for future features.

## Environment variables

| Variable | Default | Effect |
|----------|---------|--------|
| `PORT` | `3733` | HTTP listen port |
| `HOST` | `127.0.0.1` | Bind address |
| `OPEN_BROWSER` | open | Set to `0` to skip launching the OS browser tab |

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
| `GET` | `/api/status` | Session, totals, last bonus, schedule lines |
| `GET` | `/api/hero?deep=1` | Hero stats object |
| `GET` | `/api/bonuses/status` | Hero + resource poll; `?force=1` bypasses cache |
| `GET` | `/api/resources/status` | Resource boxes only |
| `POST` | `/api/bonus/time` | Claim adventure time bonus |
| `POST` | `/api/bonus/danger` | Claim adventure danger bonus |
| `POST` | `/api/bonus/resource/:name` | `Wood`, `Clay`, `Iron`, or `Crop` |
| `POST` | `/api/bonus/resources/claim-all` | Batch resource videos |
| `POST` | `/api/relogin` | Close session and log in again |
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
