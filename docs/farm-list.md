# Farm list round-robin

Automatically open the Travian **farm list** (rally point, `build.php?gid=16&tt=99`) and press **Start** for each configured list in turn.

## Configuration (`config.json`)

```json
"farmList": {
  "enabled": false,
  "lists": ["Farm 1", "Farm 2"],
  "intervalMinutesMin": 5,
  "intervalMinutesMax": 15
}
```

| Key | Meaning |
|-----|---------|
| `enabled` | When `true`, the GUI runs a background timer (same process as the dashboard). |
| `lists` | Farm list names **exactly as shown in Travian** (one per line in the GUI). |
| `intervalMinutesMin` | Minimum wait before the next send (minutes). |
| `intervalMinutesMax` | Maximum wait; actual delay is **random** between min and max. |

State is stored in `data/farm-list-state.json` (`lastIndex`, `nextRunAt`, `lastListName`).

## GUI

Open **Farm lists** on the dashboard (below Gather bonuses):

| Control | Action |
|---------|--------|
| **Runner ON** | Enable the timer |
| **Min / Max min** | Random delay range between sends |
| **List names** | One farm list name per line |
| **Discover** | Log in, open the farm list page, and copy visible names into the textarea |
| **Save** | Write `config.json` and start/restart the timer |
| **Run now** | Queue the next send immediately (timer must be ON) |
| **Send next** | Send one list now without waiting for the timer |

The bot clicks the green village **farm list** quick link (`RallyPointFarmList` / `gid=16&tt=99`), finds the row whose name matches your config, and clicks the Start/Send button.

## HTTP API

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/api/config/farm-list` | Current settings + status |
| `PUT` | `/api/config/farm-list` | Save settings |
| `POST` | `/api/farm-list/run-now` | Trigger next send via timer |
| `POST` | `/api/farm-list/send-once` | Send next list immediately |
| `GET` | `/api/farm-list/discover` | Read list names from the open farm list page |

## Notes

- Uses the same browser session and action lock as bonus claims (only one Playwright task at a time).
- Disabled when `GUI_NO_SCHEDULER=1` (same as the embedded bonus scheduler).
- List names must match the Travian UI; use **Discover** once to help fill the textarea.
- If a send button is not found, the bot logs a warning and still schedules the next run.
