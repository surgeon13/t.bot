# Troop training

Keeps each training building's queue topped up to a depth you choose, so the
barracks never sits idle while you are away.

Barracks and **great** barracks are separate buildings with separate queues, as
are stable and great stable — so the same unit trains in both at once. Each is
configured on its own row.

## Dashboard panel

| Control | Meaning |
|---------|---------|
| **Runner ON** | Check the queues on a timer |
| **Dry run** | Log what *would* be queued, train nothing |
| **Round-robin** | Visit one village per cycle instead of all of them |
| **Every … – … min** | Random wait between checks |
| **Villages** | Which villages to train in — **Load from game**, then tick |
| Per building: tick | Include this building in the cycle |
| Per building: troop | The unit to train, spelled as the game shows it |
| Per building: **keep … h** | Keep the queue at least this many hours deep |
| Per building: **max** | Most units to queue in one go — `0` for no cap of our own |
| Per building: **Inspect** | Open the building and list the unit rows the bot can see |
| **Run now** | Queue the next cycle on the runner |
| **Run once** | Run one cycle immediately (asks to confirm when not a dry run) |

## How much it queues

Each building is topped up to the target depth and no further:

```
units = ceil((target hours − queue already running) ÷ seconds per unit)
```

then capped by what the game says you can afford, and by your **max** if set.
A queue already at or past the target is left alone. When the per-unit training
time cannot be read, it falls back to filling what you can afford — the depth
check still stops it running away.

## A worked example

An Egyptian account training Khopesh warriors and Resheph chariots:

| Building | Troop | keep | max |
|----------|-------|------|-----|
| Barracks | Khopesh warrior | 8 h | 0 |
| Great barracks | Khopesh warrior | 8 h | 0 |
| Stable | Resheph chariot | 8 h | 50 |
| Great stable | Resheph chariot | 8 h | 0 |
| Workshop | Ram | 12 h | 5 |

With **Round-robin** on and two villages ticked, each cycle visits one village
and walks its five buildings, then the next cycle takes the other village.

## Configuration

```json
"training": {
  "enabled": false,
  "dryRun": true,
  "roundRobin": false,
  "villages": [],
  "buildings": [
    { "key": "barracks", "enabled": true, "troop": "Khopesh warrior", "targetQueueHours": 8, "maxPerBatch": 0 }
  ],
  "intervalMinutesMin": 20,
  "intervalMinutesMax": 45
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `enabled` | `false` | Runs the timer inside the GUI process |
| `dryRun` | `true` | Log only; **missing also means true** |
| `roundRobin` | `false` | One village per cycle instead of all |
| `villages` | `[]` | Empty means "the current village" |
| `buildings[].key` | — | `barracks`, `greatBarracks`, `stable`, `greatStable`, `workshop` |
| `buildings[].troop` | `""` | A building with no troop name is skipped |
| `buildings[].targetQueueHours` | `8` | Clamped to 1–72 |
| `buildings[].maxPerBatch` | `0` | `0` = no cap beyond what you can afford |

State lives in `data/training-state.json`, including where round-robin got to.

## When a unit is not found

Servers differ. If a cycle reports `"Khopesh warrior" not on the page`, the
message lists the unit names it *did* read — press **Inspect** on that row to see
the same list plus the current queue depth. If the names look wrong or empty, the
page markup differs from what the reader expects; open an issue with the row HTML.

## API

| Route | Purpose |
|-------|---------|
| `GET /api/config/training` | Current settings + status |
| `PUT /api/config/training` | Save settings (restarts the timer) |
| `POST /api/training/run-now` | Queue the next cycle on the runner |
| `POST /api/training/run-once` | Run one cycle now; body `{"dryRun":true|false}` overrides the saved flag |
| `POST /api/training/inspect` | Read-only dump of one building; body `{"key":"barracks"}` |
