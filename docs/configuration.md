# Configuration

All runtime options live in **`config.json`** at the project root. Never commit the real file.

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

Legacy: you may set `"proxy": "http://host:8080"` as a string instead of an object; it is treated as enabled with that server.

### Scheduler (`schedule`)

Used by **`npm run schedule`** and shown in the menu when enabled. See **[scheduler.md](scheduler.md)** for setup, terminal commands, and how it interacts with resource due times.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `schedule.enabled` | boolean | `false` | Must be `true` for the scheduler loop to run meaningful work. |
| `schedule.intervalHours` | number | `3` | Hours between full claim runs (`npm run bonuses` logic). Minimum enforced: **0.25** (15 minutes). |

The scheduler can wake **earlier** if `resourceBonuses` is enabled and `resource-bonus-state.json` says the next resource run is sooner.

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

## Menu settings (`npm start` → **S**)

The interactive menu can change the same fields and saves them back to `config.json`:

- Auto mode on/off  
- Headless on/off  
- Schedule enabled + interval hours  
- Resource bonuses enabled + interval hours  

Restart long-running processes (GUI, scheduler) after changing `headless` or credentials.
