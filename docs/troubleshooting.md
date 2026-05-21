# Troubleshooting

## Login fails or times out

**Symptoms:** `Login failed`, password field timeout, GUI shows “Not logged in”.

**Checks:**

1. `url` must match your server exactly (including `https://` and region subdomain).  
2. `username` / `password` in `config.json` — no extra spaces.  
3. Run once with `"headless": false` to see cookie banners or captcha.  
4. Inspect `debug/login-*.png` and `debug/login-*.json` if present (written by `auth.js` on failure).

**Re-login in GUI:** click **↻ Re-login** (closes page context and logs in again).

## Video does not play or claim fails

**Symptoms:** Log shows `Play button not found`, `Timed out after 120s`, resource status stays claimable.

**Try in order:**

1. Set `"headless": false` in `config.json` and restart the GUI or CLI job.  
2. Install **Google Chrome** so `browserLaunch.js` can use `channel: 'chrome'`.  
3. Ensure `"browserChannel": true` (default) or remove the key.  
4. Run a single resource from the GUI to isolate one video.  
5. Open `debug/video-*.json` — lists iframe URLs and dialog HTML at failure time.

**Headless notes:** Travian’s ad network sometimes serves empty iframes in headless Chromium. Chrome + `--headless=new` + the bot’s “Watch video” two-step flow fixes most cases; if ads still fail, headed mode is the reliable fallback.

## Shop or Advantages tab not found

**Symptoms:** `Shop unreachable`, `Advantages tab did not appear`.

**Causes:** Travian UI changed, or the shop button is hidden (small viewport, overlay).

**Checks:**

1. `GET http://127.0.0.1:3733/api/debug/shop` while GUI is logged in — returns candidate selectors and snippets.  
2. `GET /api/debug/advantages` — lists `available: ["Wood", …]`.  
3. Widen viewport (bot uses 1280×900).  
4. Update selectors in `resourceBonuses.js` (`WIZARD_SELECTOR`, `ADVANTAGES_LABEL`, `RESOURCE_BONUS_CLASS`).

## GUI port already in use

```
Error: listen EADDRINUSE 127.0.0.1:3733
```

Another `npm run gui` is still running. Stop it or use `PORT=3734 npm run gui`.

## Scheduler does not run resource bonuses

1. Set `resourceBonuses.enabled` to `true` in `config.json`.  
2. Check `resource-bonus-state.json` → `nextRunAt` — may still be in the future.  
3. Use `npm run resources` to force a run and reset timing after claims.  
4. Scheduler must be started separately: `npm run schedule` (second terminal).

## Old code still running

Node keeps modules in memory. After pulling updates, **stop and restart** `npm run gui`, `npm run schedule`, or `npm start`.

## Terminal commands during long tasks

While `npm run schedule` or menu bonus runs are active, type in that terminal:

| Command | Effect |
|---------|--------|
| `status` / `s` | Print current task state |
| `stop` / `q` / `quit` | Stop after the current browser step |
| `run` / `now` | (scheduler only) trigger next run immediately |

## Getting help with selectors

1. Enable headed mode.  
2. Run GUI → **Refresh all bonuses** or hit debug endpoints.  
3. Compare `debug/` output with live DevTools on the Advantages tab.  
4. Adjust `resourceBonuses.js` / `videoAds.js` and restart.
