# Resource bonuses (+15% production)

Travian offers **+15%** lumber, clay, iron, or crop production for about **8 hours** after watching a short video ad. The bot finds these on:

**Shop** (`a.shop`) → wizard → **Advantages** tab → resource rows.

## DOM model (Legends, 2025–2026)

Each resource has a row:

```html
<div class="advantagesBonusBox lumberProductionBonus">
  <!-- claimable: -->
  <div class="bonusVideo">… Activate … <i class="videoIcon"></i></div>
  <!-- or active (+25% gold buff): -->
  <div class="bonusDuration"><span class="timerReact">…</span></div>
</div>
```

| Resource | CSS class suffix |
|----------|------------------|
| Wood | `lumberProductionBonus` |
| Clay | `clayProductionBonus` |
| Iron | `ironProductionBonus` |
| Crop | `cropProductionBonus` |

| UI state | Bot reads as |
|----------|----------------|
| `.bonusVideo` + purple Activate + `videoIcon` | **claimable** — video path (+15%) |
| `.active` on box, gold Extend, timer | **active** — buff running, skip |
| Neither | **unavailable** — cooldown or not offered |

## Video flow

1. Click the resource’s Activate in `.bonusVideo`.  
2. Info dialog: **Watch video** (`button.dialogButtonOk`).  
3. Player in iframe `#videoArea` (may need play click; headless may auto-play).  
4. Wait until video UI disappears (up to **2 minutes**).  

Implemented in `videoAds.js`, shared with hero adventure videos.

## Commands

| Entry | Behaviour |
|-------|-----------|
| `npm run resources` | Login → `claimResourceBonuses(page, { force: true })` → exit |
| `npm run bonuses` | Hero bonuses + resources **only if** `resourceBonuses.enabled` and **due** |
| GUI per-resource button | `claimResourceBonus(page, name)` — single resource, fail-fast shop open |
| GUI **Claim all available** | `claimResourceBonuses(page, { force: true })` — all claimable in one session |
| Menu **(2)** | Same as resources one-shot on the menu’s kept browser |

## Polling vs claiming

- **Poll** (`pollResourceBonusesViaWizard`) — opens shop, reads four boxes, closes shop. Used by GUI refresh and `/api/bonuses/status`.  
- **Claim batch** — opens shop once, loops `available` list, reopens shop if Travian closed the wizard after a video.  
- **Claim single** — opens shop, one resource, closes shop.

## Scheduling logic

When `resourceBonuses.enabled` is `true`:

1. `isResourceBonusDue()` compares `now` to `resource-bonus-state.json` → `nextRunAt`.  
2. After a run, `markResourceBonusRun(claimedCount, intervalHours)` sets the next due time.  
3. If **zero** videos were claimed, next attempt may be in **30 minutes** instead of the full interval.

`intervalHours` in config (default **8**) controls the spacing between successful batch runs.

## Totals

Each successful video increments the matching counter in the totals module (`woodBonuses`, `clayBonuses`, etc.) shown in the GUI totals strip.
