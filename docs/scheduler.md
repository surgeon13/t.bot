# Scheduler (`npm run schedule`)

The scheduler runs **automatic bonus claims on a timer** in a long-lived terminal process. It is separate from the web GUI and from one-shot CLI commands.

## Command

```bash
npm run schedule
```

Runs `scheduler.js`, which loops forever (until you stop it or disable scheduling in config).

## Prerequisites

1. **`schedule.enabled`** must be `true` in `config.json` (or turn **Periodic claims** ON in menu **S**).
2. Valid **`url`**, **`username`**, and **`password`** in `config.json`.
3. Run in a **dedicated terminal** — the scheduler does not start automatically with `npm start` or `npm run gui`.

If `schedule.enabled` is `false`, the process prints a hint and exits immediately.

## What each run does

Every cycle calls the same logic as **`npm run bonuses`** (`claimJob.runClaimAllBonuses()`):

1. Launch browser (headless by default)  
2. Log in  
3. Claim **hero adventure** time and danger video bonuses  
4. Claim **resource** +15% videos **only if** `resourceBonuses.enabled` is `true` **and** the resource due timer says they are due  

Then the browser closes. The scheduler waits until the next run time, then repeats.

## Timing

| Setting | Default | Role |
|---------|---------|------|
| `schedule.intervalHours` | `3` | Base hours between runs after a cycle completes |
| Minimum interval | `0.25` (15 min) | Enforced in code — lower values are clamped |

**Earlier wake-up:** If `resourceBonuses.enabled` is `true` and `resource-bonus-state.json` has a `nextRunAt` **sooner** than the normal schedule interval, the scheduler sleeps until that resource due time instead (so resource videos are not missed).

After each run, **`schedule-state.json`** is updated with `lastRunAt`, `nextRunAt`, and `intervalHours`. The menu (`npm start`) reads this file to show **Next run**.

## Typical setup (two terminals)

| Terminal | Command | Purpose |
|----------|---------|---------|
| 1 | `npm start` | Optional: menu, settings, manual claims |
| 2 | `npm run schedule` | Automatic periodic claims |

Or use only terminal 2 if you do not need the menu.

The scheduler **does not** start on Windows login or as a service — you start it manually when you want automation.

## Terminal commands (while scheduler is running)

Type a command and press **Enter** in the **same** terminal as `npm run schedule`:

| Command | Aliases | Effect |
|---------|---------|--------|
| `status` | `s` | Print phase (running / waiting), next run time, last bonus |
| `stop` | `q`, `quit` | Stop after the current browser step finishes |
| `run` | `now` | Skip the wait and start the **next** cycle immediately |

These use `terminalControl.js` (same as long menu tasks).

## Stopping the scheduler

- Type **`stop`** (or `q` / `quit`) in the scheduler terminal, or  
- Press **Ctrl+C**, or  
- Set **`schedule.enabled`** to `false` in config — the loop exits on the next check (within about one minute while waiting).

## Configuration examples

**Hero bonuses every 3 hours, no automatic resources:**

```json
"schedule": { "enabled": true, "intervalHours": 3 },
"resourceBonuses": { "enabled": false, "intervalHours": 8 }
```

**Hero + resources on a shared schedule (resources also respect their own 8h due file):**

```json
"schedule": { "enabled": true, "intervalHours": 4 },
"resourceBonuses": { "enabled": true, "intervalHours": 8 }
```

Change settings in menu **(S)** or edit `config.json`, then **restart** `npm run schedule` if interval or enabled flag changed.

## Scheduler vs other commands

| Command | Long-running? | Hero bonuses | Resource bonuses |
|---------|---------------|--------------|------------------|
| `npm run schedule` | Yes (loop) | Every cycle | When enabled **and** due |
| `npm run bonuses` | No (one shot) | Once | When enabled **and** due |
| `npm run resources` | No | No | **Force** all claimable |
| `npm run gui` | Yes (server) | On button click | On button / claim-all |
| Menu **(1)** | No | Once | When enabled **and** due |
| Menu **(2)** | No | No | **Force** all claimable |

## Logs and state

- **`bot.log`** — scheduler lines tagged `[schedule]`  
- **`schedule-state.json`** — next/last run for the menu (gitignored locally)  
- **`resource-bonus-state.json`** — resource due times when resource bonuses are enabled  

## Troubleshooting

| Problem | What to check |
|---------|----------------|
| Exits immediately | `schedule.enabled` is `false` |
| “Next run: unknown” in menu | Scheduler never started, or no run completed yet |
| Resources never claimed | `resourceBonuses.enabled` is `false`, or not yet due |
| Old interval after edit | Restart `npm run schedule` |
| Two browsers fighting | Do not run `npm run schedule` and `npm run gui` claiming at the same time on one account |

See also [configuration.md](configuration.md) and [troubleshooting.md](troubleshooting.md).
