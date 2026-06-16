# Configuration

All runtime options live in **`config.json`** at the project root. Never commit the real file.

**Version 0.9.7** — see [CHANGELOG.md](../CHANGELOG.md) for release history.

### First-time config

If **`config.json` does not exist**, the first call to `loadConfig()` (any command that starts the bot) will:

1. Copy **`config.example.json`** → `config.json` when the example file is present, or  
2. Write **`config.json`** from built-in defaults in `auth.js` if the example is missing.

A log line reminds you to edit `url`, `username`, and `password`. You can still create the file manually:

```bash
copy config.example.json config.json
```

## Full example

```json
{
  "url": "https://YOUR_SERVER.travian.com/",
  "username": "your@email.com",
  "password": "your_password",
  "delay": {
    "min": 500,
    "max": 1500
  },
  "autoMode": false,
  "headless": true,
  "browserChannel": true,
  "proxy": {
    "enabled": false,
    "server": "http://127.0.0.1:8080",
    "username": "",
    "password": "",
    "bypass": "localhost,127.0.0.1"
  },
  "schedule": {
    "enabled": false,
    "intervalHours": 3
  },
  "resourceBonuses": {
    "enabled": false,
    "intervalHours": 8
  },
  "farmList": {
    "enabled": false,
    "sendAllMode": false,
    "lists": [
      { "name": "Farm 1", "enabled": true },
      { "name": "Farm 2", "enabled": true }
    ],
    "intervalMinutesMin": 5,
    "intervalMinutesMax": 15
  },
  "workSleep": {
    "enabled": false,
    "workMinutesMin": 30,
    "workMinutesMax": 60,
    "sleepMinutesMin": 15,
    "sleepMinutesMax": 45
  },
  "microPause": {
    "enabled": false,
    "pauseMinutesMin": 2,
    "pauseMinutesMax": 5,
    "intervalMinutesMin": 20,
    "intervalMinutesMax": 45
  },
  "dailySchedule": {
    "enabled": false,
    "hours": []
  }
}
```

## Options reference

### Account

| Key | Type | Required | Description |
|-----|------|----------|-------------|
| `url` | string | Yes | Server home URL, e.g. `https://ts31.x1.international.travian.com/` (trailing slash optional). |
| `username` | string | Yes | Login email or account name. |
| `password` | string | Yes | Account password. |

### Behaviour

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `delay.min` | number | `500` | Minimum pause (ms) between UI actions. |
| `delay.max` | number | `1500` | Maximum pause (ms); actual delay is random in `[min, max]`. |
| `autoMode` | boolean | `false` | If `true`, `npm start` claims hero + resource bonuses once after login, then opens the menu. |
| `headless` | boolean | **`true`** | Run Playwright without a visible window. Set `false` if videos fail to start or finish. |
| `browserChannel` | boolean | `true` | When not `false`, launch tries **installed Google Chrome** (`channel: 'chrome'`) before bundled Chromium — often better for headless video codecs. |

### Proxy (`proxy`)

All browser traffic (GUI, menu, scheduler, `npm run bonuses` / `resources`) goes through the proxy when enabled. Implemented via [Playwright’s `proxy` option](https://playwright.dev/docs/network#http-proxy) on `browser.newContext()`.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `proxy.enabled` | boolean | `false` | Set `true` to route Chromium through `proxy.server`. |
| `proxy.server` | string | `""` | Single proxy, or first entry when `servers` is set. `host:port` is fine — **`http://` is added automatically**. |
| `proxy.servers` | string[] | `[]` | Optional list of proxies (same shared username/password). GUI accepts comma- or newline-separated values in the server field. |
| `proxy.rotation` | string | `"round-robin"` | With multiple servers: `round-robin` (next proxy on each new browser session / Re-login), `random`, or `sticky` (always first). |
| `proxy.username` | string | `""` | Optional proxy authentication. |
| `proxy.password` | string | `""` | Optional proxy password (stored in `config.json` — keep file private). |
| `proxy.bypass` | string | `""` | Optional comma-separated hosts that skip the proxy (Playwright `bypass` list). |

**Example (authenticated HTTP proxy):**

```json
"proxy": {
  "enabled": true,
  "server": "http://proxy.example.com:3128",
  "username": "myuser",
  "password": "mypass",
  "bypass": "localhost,127.0.0.1"
}
```

After changing proxy settings, restart long-running processes or use GUI **Re-login** so a new browser context is created.

**Bulk paste** (`host:port:user:pass` per line): each proxy stores its own credentials in the pool entry. The shared **User** / **Password** fields apply only to plain `host:port` entries without embedded auth.

**Login batches:** each Re-login or automatic connect tries up to **3** proxies from the pool (one proxy when daily schedule forces a slot). After a failed batch, automatic retries pause for ~45 seconds; the GUI shows a cooldown message. **Next proxies** (`POST /api/proxy/refresh`) or **Re-login** retry immediately. A background recovery timer retries every ~3 minutes during active automation windows.

Legacy: you may set `"proxy": "http://host:8080"` as a string instead of an object; it is treated as enabled with that server.

### Scheduler (`schedule`)

Used by **`npm run schedule`** and shown in the menu when enabled. See **[scheduler.md](scheduler.md)** for setup, terminal commands, and how it interacts with resource due times.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schedule.enabled` | boolean | `false` | Must be `true` for the scheduler loop to run meaningful work. |
| `schedule.intervalHours` | number | `3` | Hours between full claim runs (`npm run bonuses` logic). Minimum enforced: **0.25** (15 minutes). |

The scheduler can wake **earlier** if `resourceBonuses` is enabled and `resource-bonus-state.json` says the next resource run is sooner.

### Farm list runner (`farmList`)

See **[farm-list.md](farm-list.md)** for GUI usage.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `farmList.enabled` | boolean | `false` | Enable the farm list timer in the GUI. |
| `farmList.sendAllMode` | boolean | `false` | When `true`, click Travian’s global **Start all farm lists** instead of sending each checked list individually. |
| `farmList.lists` | object[] | `[]` | `{ "name": "Farm 1", "enabled": true }` — names as shown in Travian; checked lists are sent each cycle. |
| `farmList.intervalMinutesMin` | number | `5` | Minimum minutes until the next send cycle. |
| `farmList.intervalMinutesMax` | number | `15` | Maximum minutes (random delay in range). |

### Work / sleep rhythm (`workSleep`)

Alternates **work** windows (automation allowed) and **sleep** windows (farm list + bonus schedulers pause). Each window length is random between min and max **minutes**. The GUI may close the browser during sleep (see [gui.md](gui.md)).

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `workSleep.enabled` | boolean | `false` | Enable work/sleep cycling. |
| `workSleep.workMinutesMin` | number | `30` | Minimum work window (minutes). |
| `workSleep.workMinutesMax` | number | `60` | Maximum work window (≥ min). |
| `workSleep.sleepMinutesMin` | number | `15` | Minimum sleep window (minutes). |
| `workSleep.sleepMinutesMax` | number | `45` | Maximum sleep window (≥ min). |

Phase timing is stored in **`data/work-sleep-state.json`** (`phase`, `phaseEndsAt`). Manual GUI actions (**Run now**, **Send all**, single bonus buttons) are not blocked during sleep.

### Random micro-pauses (`microPause`)

Short random **strict stops** between automated scheduler runs. Unlike work/sleep, micro pauses do **not** close the browser — they only delay the next bonus or farm cycle.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `microPause.enabled` | boolean | `false` | Enable random micro-pauses. |
| `microPause.pauseMinutesMin` | number | `2` | Minimum pause length (minutes). |
| `microPause.pauseMinutesMax` | number | `5` | Maximum pause length (≥ min). |
| `microPause.intervalMinutesMin` | number | `20` | Minimum time between pauses (minutes). |
| `microPause.intervalMinutesMax` | number | `45` | Maximum interval (≥ min). |

State: **`data/micro-pause-state.json`**. **Run now** on bonus or farm scheduler bypasses the next micro pause once (same flag as work/sleep bypass).

### Daily schedule (`dailySchedule`)

Local-time **half-hour slots** (00:00–23:30). When enabled, bonus and farm schedulers run only in toggled slots. The GUI closes the browser outside active slots.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dailySchedule.enabled` | boolean | `false` | Master switch for slot gating. |
| `dailySchedule.hours` | object[] | `[]` | One entry per hour `0`–`23` (auto-filled if empty). |

Each hour object:

| Field | Type | Description |
|-------|------|-------------|
| `hour` | number | `0`–`23` |
| `half0` | boolean | Active for `:00`–`:29` |
| `half30` | boolean | Active for `:30`–`:59` |
| `proxyIndex` | number \| null | `null` = **Off** (direct connection during this slot); `0` = P1, `1` = P2, … from `proxy.servers` |

When daily schedule is **enabled** and the current slot is **active**, proxy choice comes from the hour row — not from global `proxy.rotation`. When daily schedule is **disabled**, global proxy settings apply as before.

**Run now** does **not** bypass daily off-hours; schedulers wait until the next active slot.

### Resource bonuses (`resourceBonuses`)

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `resourceBonuses.enabled` | boolean | `false` | When `true`, `npm run bonuses` and the scheduler include resource videos **only when due**. |
| `resourceBonuses.intervalHours` | number | `8` | Hours after a successful batch before the next scheduled resource pass. Minimum: **0.25**. |

**GUI and `npm run resources`** use `{ force: true }` and ignore the due timer (they still respect `enabled` only for automatic scheduler/menu paths unless forced).

## State files

All runtime state lives under **`data/`** (gitignored). On first run after an upgrade, files in the project root are moved into `data/` automatically.

### `data/resource-bonus-state.json`

Written by `resourceBonuses.js`. Example:

```json
{
  "lastAttemptAt": "2026-05-21T09:25:14.223Z",
  "lastClaimAt": "2026-05-14T14:30:43.853Z",
  "lastClaimedCount": 2,
  "nextRunAt": "2026-05-21T13:25:14.223Z",
  "intervalHours": 4,
  "perResource": {
    "Wood": { "lastClaimAt": "2026-05-21T10:28:37.185Z" }
  }
}
```

| Field | Meaning |
|-------|---------|
| `nextRunAt` | ISO time when `npm run bonuses` will try resources again (if enabled). |
| `lastClaimedCount` | Videos successfully watched in the last batch. |
| `perResource` | Optional per-resource `lastClaimAt` after a successful video. |

If no claimable videos were found, the bot may retry sooner (about **30 minutes**) instead of waiting the full interval.

### `data/schedule-state.json`

Updated by `scheduler.js` for the menu’s “next run” line. Safe to delete; it will be recreated.

### `data/farm-list-state.json`

Written by `farmList.js` / `farmListState.js` when the farm list runner is used. Tracks checked list count, send-all mode, `nextRunAt`, and last send for the GUI status line.

### `data/work-sleep-state.json`

Work/sleep phase (`work` | `sleep`) and `phaseEndsAt`. Safe to delete; a new work phase starts on next scheduler tick or when you re-enable work/sleep in the GUI.

### `data/micro-pause-state.json`

Next scheduled micro-pause time. Safe to delete.

## Menu settings (`npm start` → **S**)

The interactive menu can change the same fields and saves them back to `config.json`:

- Auto mode on/off  
- Headless on/off  
- Schedule enabled + interval hours  
- Resource bonuses enabled + interval hours  

Restart long-running processes (GUI, scheduler) after changing `headless` or credentials.
