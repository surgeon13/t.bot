# Granary watch

Polls the granary and, when crop is about to overflow, uses the **NPC merchant**
to re-split everything into 1:1:1 wood/clay/iron with the crop emptied.

> **The NPC costs gold.** It stays off until you tick **Use NPC (gold)**, on top
> of the dry run. With it off the watch still reports what it would have done.

## Why

The NPC does not create resources — it re-splits what is already in store, so the
total never changes. On a crop-heavy account that converts about-to-be-wasted crop
into materials and buys back granary room in one move.

## Dashboard panel

| Control | Meaning |
|---------|---------|
| **Watch ON** | Poll the granary on a timer |
| **Dry run** | Log what *would* be converted, spend nothing |
| **Use NPC (gold)** | Allow the conversion — **spends gold** |
| **Over … %** | Crop fill that triggers a conversion |
| **Leave … crop** | Crop to leave behind (0 empties it) |
| **Round-robin** | Check one village per cycle instead of all of them |
| **Villages** | Which villages to watch — **Load from game**, then tick |
| **Check now** | Read stocks and report — converts nothing, ever |
| **Run now** / **Run once** | Queue a cycle, or run one immediately |

## The split

Crop is taken down to `leaveCrop` and everything else spread evenly over
wood/clay/iron, with the rounding remainder going to wood so the plan sums to
**exactly** the current total — which is what the game's form requires.

Nothing may exceed the warehouse: anything that will not fit stays as crop. If
even the best split cannot fit, the run reports it instead of submitting.

| Stock (W/C/I/Cr) | Warehouse | Leave crop | Plan |
|---|---|---|---|
| 1000/1000/1000/9000 | — | 0 | 4000/4000/4000/0 |
| 0/0/0/3500 | — | 500 | 1000/1000/1000/500 |
| 0/0/0/12000 | 2000 | 0 | 2000/2000/2000/6000 |
| 0/0/0/10 | — | 0 | 4/3/3/0 |

## Configuration

```json
"granary": {
  "enabled": false,
  "dryRun": true,
  "npcEnabled": false,
  "cropPercentThreshold": 90,
  "leaveCrop": 0,
  "roundRobin": false,
  "villages": [],
  "intervalMinutesMin": 15,
  "intervalMinutesMax": 40
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `enabled` | `false` | Runs the timer inside the GUI process |
| `dryRun` | `true` | Log only; **missing also means true** |
| `npcEnabled` | `false` | Second, explicit yes before any gold is spent |
| `cropPercentThreshold` | `90` | Must be 1–100; anything else keeps the default |
| `leaveCrop` | `0` | Crop left after converting |
| `villages` | `[]` | Empty means "the current village" |

State lives in `data/granary-state.json`.

## API

| Route | Purpose |
|-------|---------|
| `GET /api/config/granary` | Current settings + status |
| `PUT /api/config/granary` | Save settings (restarts the timer) |
| `POST /api/granary/check` | Read-only: stocks and crop fill |
| `POST /api/granary/run-now` | Queue the next cycle on the runner |
| `POST /api/granary/run-once` | Run one cycle now; body `{"dryRun":true|false}` overrides the saved flag |
