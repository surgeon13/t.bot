# Marketplace offers

Scans the **marketplace offers tab** on a timer and accepts trades whose **ratio**
is at least the minimum you set — that is, offers that send you back more than
you give away.

> **Read the dry-run section before turning this loose.** Accepting a trade spends
> resources and cannot be undone.

## What it does

Each cycle the runner:

1. Opens the marketplace offers tab (`build.php?gid=17`).
2. **Sorts by the ratio column, best first.** The offers table runs to many pages;
   without this a good offer three pages deep is never seen. The header toggles, so
   the bot clicks and checks the order rather than assuming a direction. If sorting
   cannot be confirmed it reads the current page and says so in the status line.
3. Reads every row, plus free merchants and the page count.
4. Keeps rows where the ratio clears `minRatio`, the requested resource is one you
   allow under **Send away**, and the trade needs no more merchants than you have free.
5. Accepts up to `maxAcceptsPerRun` of them, re-reading the table *and the merchant
   count* between accepts (the game renumbers rows and each trade spends merchants).
6. Waits a random time between `intervalMinutesMin` and `intervalMinutesMax`.

### The ratio column is rounded — the bot is not

Travian prints the ratio to one decimal, **rounded up**: an offer of 11,250 crop for
9,000 clay is really **1.25** but the column shows **1.3**. Matching on the printed
number would accept trades below your threshold, so whenever both amounts parse the
bot computes `offered ÷ wanted` itself and judges on that. The panel shows the precise
ratio; hover it to see what the column said.

It pauses under the same gates as the farm list runner: **work/sleep**,
**daily schedule** off-hours, and **micro-pauses**.

## Dashboard panel

| Control | Meaning |
|---------|---------|
| **Runner ON** | Run the scan on a timer in the background |
| **Dry run** | Log what *would* be accepted, accept nothing |
| **Ratio ≥** | Minimum ratio in your favour (`1.5` = get 50% more than you send) |
| **Max … /run** | Most offers to accept in a single cycle (1–25) |
| **Every … – … min** | Random wait between cycles |
| **Send away** | Only accept offers that ask for these resources |
| **Scan now** | Read the table and list matches — accepts nothing |
| **Run now** | Queue the next cycle on the runner (Runner must be ON) |
| **Run once** | Run one cycle immediately (asks for confirmation when not a dry run) |

Matching offers are listed under the buttons as `×ratio — 2000 wood for 1000 crop`.

## Verify the ratio column before going live

`dryRun` defaults to **true**, and a missing `dryRun` key is also treated as true —
a half-written config can never start spending resources.

Travian skins differ, and the bot reads the ratio straight out of the table. Before
turning dry run off:

1. Click **Scan now** and compare the listed offers against the game in your browser.
2. Check that no row shows an orange **`column says ×N`** warning. Rounding alone
   never moves the ratio by more than 0.05, so a wider gap means the parser latched
   onto the wrong cells on your server's layout.
3. Once the list matches what you see in game, untick **Dry run** and **Save**.

If the scan finds nothing on a page that clearly has offers, the table on your
server does not use a `td.ratio` column — open an issue with the row HTML.

## Configuration

```json
"marketplace": {
  "enabled": false,
  "dryRun": true,
  "minRatio": 1.5,
  "maxAcceptsPerRun": 3,
  "giveResources": ["wood", "clay", "iron", "crop"],
  "intervalMinutesMin": 20,
  "intervalMinutesMax": 45
}
```

| Key | Default | Notes |
|-----|---------|-------|
| `enabled` | `false` | Runs the timer inside the GUI process |
| `dryRun` | `true` | Log matches only; **missing also means true** |
| `minRatio` | `1.5` | Values `≤ 0` are ignored and the default kept |
| `maxAcceptsPerRun` | `3` | Clamped to 1–25 |
| `giveResources` | all four | Empty or unrecognised entries fall back to all four |
| `intervalMinutesMin` | `20` | Minimum 1 |
| `intervalMinutesMax` | `45` | Raised to `intervalMinutesMin` when lower |

State lives in `data/marketplace-state.json`; lifetime accepts are counted in
`data/totals-state.json` as `marketplaceAccepts`.

## API

| Route | Purpose |
|-------|---------|
| `GET /api/config/marketplace` | Current settings + status |
| `PUT /api/config/marketplace` | Save settings (restarts the timer) |
| `POST /api/marketplace/scan` | Read-only preview of matches |
| `POST /api/marketplace/run-now` | Queue the next cycle on the runner |
| `POST /api/marketplace/accept-now` | Run one cycle now; body `{"dryRun":true|false}` overrides the saved flag |

## What it reads from the page

| Thing | Source |
|-------|--------|
| Offered / wanted resource | icon class on the cell — `lumber_small` → wood, plus `crop_small`, `clay_small`, `iron_small`, and the older `r1`–`r4` |
| Amounts | cell text, with `1,000` / `1.000` / `1 000` grouping and `1,5` decimals all handled |
| Ratio | `td.ratio`, used only when an amount fails to parse |
| Merchants needed | `td.merchants` |
| Merchants free | `.merchantsInformation .available` (e.g. `11/14`) |
| Pages | `.pagination .pageIndex` |
| Accept | `td.accept button` |

## Limits

- The bot does not create offers, only accepts existing ones.
- Your **resource stock** is not checked. A trade you cannot cover fails at the
  accept click and is reported rather than retried.
- `giveResources` filters on the resource the offer **asks you for**. A row whose
  requested resource cannot be read is only accepted when all four are allowed.
- Only the first page is read. That is enough when the ratio sort works, since the
  best offers are then on top; when it does not, the status line says how many pages
  went unread.
