# Farm list runner

Automatically open the Travian **farm list** (rally point, `build.php?gid=16&tt=99`) and press **Start** for **every checked** list each cycle, then wait a random interval before the next cycle.

## Configuration (`config.json`)

```json
"farmList": {
  "enabled": false,
  "sendAllMode": false,
  "lists": [
    { "name": "Farm 1", "enabled": true },
    { "name": "Farm 2", "enabled": false }
  ],
  "intervalMinutesMin": 5,
  "intervalMinutesMax": 15
}
```

| Key | Meaning |
|-----|---------|
| `enabled` | When `true`, the GUI runs a background timer (same process as the dashboard). |
| `sendAllMode` | When `true`, the bot clicks Travian's global **Start all farm lists** button each cycle. |
| `lists` | All farm lists known to the bot. Each entry has `name` (exact Travian label) and `enabled` (sent each cycle when `true`). |
| `intervalMinutesMin` | Minimum wait before the **next cycle** (minutes). |
| `intervalMinutesMax` | Maximum wait before the next cycle; actual delay is **random** between min and max. |

Older configs may use plain strings in `lists`; those are treated as `{ "name": "…", "enabled": true }`.

State is stored in `data/farm-list-state.json` (`nextRunAt`, `lastListName`, `gameOrder` from the last discover/send). Each cycle sends **all checked** lists in the **same order as on the Travian farm list page** (village blocks top-to-bottom, lists within each village), about 2.5s between lists.

## GUI

Open **Farm lists** on the dashboard (under the proxy panel):

| Control | Action |
|---------|--------|
| **Runner ON** | Enable the timer |
| **Send all mode** | Use Travian's global **Start all farm lists** button (ignores per-list checkboxes) |
| **Min / Max min** | Random delay range between **cycles** (after all checked lists are sent) |
| **Load from game** | Open the farm list page and load every list name into the panel |
| **All / None** | Check or uncheck every list |
| Per-list checkbox | Include that list in each send cycle when checked |
| **Save** | Write `config.json` and start/restart the timer |
| **Run now** | Send all checked lists as soon as possible (timer must be ON) |
| **Send all** | Send all checked lists now without waiting for the timer |

The bot opens rally point **Farm List** (`build.php?gid=16&tt=99`, `#rallyPointFarmList`):

- **`sendAllMode=false`**: clicks each checked list’s own green **`button.startFarmList`** in `.farmListHeader` (footer fallback).
- **`sendAllMode=true`**: clicks global **`button.startAllFarmLists`** (`Start all farm lists`) once per cycle.

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config/farm-list` | Current settings + status (`lists` as `{name, enabled}[]`) |
| `PUT` | `/api/config/farm-list` | Save settings (`lists` array in body) |
| `POST` | `/api/farm-list/run-now` | Trigger a full send cycle via timer |
| `POST` | `/api/farm-list/send-all` | Send all checked lists immediately (one button) |
| `POST` | `/api/farm-list/send-once` | Alias of `send-all` |
| `GET` | `/api/farm-list/discover` | Read lists from game; merges with saved enabled flags |

## Notes

- Uses the same browser session and action lock as bonus claims (only one Playwright task at a time).
- Disabled when `GUI_NO_SCHEDULER=1` (same as the embedded bonus scheduler).
- List names must match the Travian UI; use **Load from game** to populate the panel and refresh order after you rearrange lists in Travian.
- Unchecked lists are skipped each cycle but remain in config for next time.
- During **daily schedule off-hours**, the runner waits for the next active slot; the dashboard shows **Off-hours · next slot ~N min** (not “Due now”).
- If login fails, the next run is postponed and “not logged in” is logged at most once per minute.
- If one list fails to send, the bot continues with the rest and still schedules the next cycle.
- Each successful **Start** increments `farmListSends` in `data/totals-state.json`, logs `[farmList]` and `[totals]`, and updates the dashboard (farm list panel + Lifetime totals).
