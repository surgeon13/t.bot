'use strict';

/**
 * Granary watch settings and the NPC conversion plan.
 *
 * A crop-heavy account overflows the granary and wastes production. The NPC
 * merchant re-splits whatever is in store without changing the total, so moving
 * crop into wood/clay/iron buys back room. It costs gold, which is why it sits
 * behind its own switch on top of the dry run.
 */

const { loadConfig } = require('./auth');
const { normalizeVillagesFromConfig } = require('./villageSelection');

const DEFAULTS = {
  enabled: false,
  dryRun: true,
  npcEnabled: false,
  cropPercentThreshold: 90,
  leaveCrop: 0,
  roundRobin: false,
  intervalMinutesMin: 15,
  intervalMinutesMax: 40,
};

function granarySettings(cfg = loadConfig()) {
  const g = cfg.granary || {};
  const min = Math.max(1, Number(g.intervalMinutesMin) || DEFAULTS.intervalMinutesMin);
  const max = Math.max(min, Number(g.intervalMinutesMax) || DEFAULTS.intervalMinutesMax);
  const pct = Number(g.cropPercentThreshold);
  const leave = Math.floor(Number(g.leaveCrop));
  const villages = normalizeVillagesFromConfig(g.villages);
  const activeVillages = villages.filter(v => v.enabled);

  return {
    enabled: !!g.enabled,
    // Dry run defaults ON, and the NPC needs a second explicit yes: it spends gold.
    dryRun: g.dryRun === undefined ? DEFAULTS.dryRun : !!g.dryRun,
    npcEnabled: !!g.npcEnabled,
    cropPercentThreshold: Number.isFinite(pct) && pct > 0 && pct <= 100
      ? pct
      : DEFAULTS.cropPercentThreshold,
    leaveCrop: Number.isFinite(leave) && leave >= 0 ? leave : DEFAULTS.leaveCrop,
    roundRobin: !!g.roundRobin,
    villages,
    activeVillages,
    activeVillageCount: activeVillages.length,
    intervalMinutesMin: min,
    intervalMinutesMax: max,
  };
}

/**
 * Where the NPC should leave each resource.
 *
 * The total is fixed — the NPC only re-splits what is already in store — so the
 * plan always sums to exactly the current total, which is what the game's form
 * demands. Crop is emptied down to `leaveCrop` and the rest spread evenly over
 * wood/clay/iron, except that nothing may exceed the warehouse: anything that
 * will not fit has to stay as crop.
 *
 * Pure, so the arithmetic is testable without a browser.
 *
 * @param {{wood:number,clay:number,iron:number,crop:number,warehouseCapacity?:number,granaryCapacity?:number}} stocks
 * @param {{leaveCrop?:number}} [opts]
 */
function planNpcDistribution(stocks, opts = {}) {
  const num = v => (Number.isFinite(Number(v)) ? Math.max(0, Math.floor(Number(v))) : 0);
  const wood = num(stocks.wood);
  const clay = num(stocks.clay);
  const iron = num(stocks.iron);
  const crop = num(stocks.crop);
  const total = wood + clay + iron + crop;

  const whCap = Number.isFinite(Number(stocks.warehouseCapacity)) && stocks.warehouseCapacity > 0
    ? Math.floor(Number(stocks.warehouseCapacity))
    : Infinity;
  const grCap = Number.isFinite(Number(stocks.granaryCapacity)) && stocks.granaryCapacity > 0
    ? Math.floor(Number(stocks.granaryCapacity))
    : Infinity;

  const wantCrop = Math.max(0, Math.min(num(opts.leaveCrop ?? DEFAULTS.leaveCrop), total));

  // Spread everything except the crop we are keeping over the three materials,
  // giving the rounding remainder to wood.
  const pool = total - wantCrop;
  const each = Math.floor(pool / 3);
  let target = {
    wood: each + (pool - each * 3),
    clay: each,
    iron: each,
    crop: wantCrop,
  };

  // Nothing may exceed the warehouse; what will not fit falls back to crop.
  let overflow = 0;
  for (const key of ['wood', 'clay', 'iron']) {
    if (target[key] > whCap) {
      overflow += target[key] - whCap;
      target[key] = whCap;
    }
  }
  target.crop += overflow;

  // Overflow may have re-filled the materials' headroom; push back what fits so
  // crop is not left higher than it needs to be.
  if (overflow > 0) {
    for (const key of ['wood', 'clay', 'iron']) {
      if (target.crop <= wantCrop) break;
      const room = whCap - target[key];
      if (room <= 0) continue;
      const move = Math.min(room, target.crop - wantCrop);
      target[key] += move;
      target.crop -= move;
    }
  }

  const sum = target.wood + target.clay + target.iron + target.crop;
  const feasible = target.crop <= grCap
    && target.wood <= whCap && target.clay <= whCap && target.iron <= whCap;
  const changed = target.wood !== wood || target.clay !== clay
    || target.iron !== iron || target.crop !== crop;

  return {
    target,
    total,
    sum,
    // The form is rejected unless the split adds up to what is in store.
    balanced: sum === total,
    feasible,
    changed,
    message: !changed
      ? 'Already at the target split'
      : feasible
        ? `${wood}/${clay}/${iron}/${crop} → ${target.wood}/${target.clay}/${target.iron}/${target.crop}`
        : `Stock exceeds storage — best split leaves ${target.crop} crop (granary ${grCap})`,
  };
}

/** @param {{crop:number,granaryCapacity?:number}} stocks */
function cropPercent(stocks) {
  const cap = Number(stocks?.granaryCapacity);
  const crop = Number(stocks?.crop);
  if (!Number.isFinite(cap) || cap <= 0 || !Number.isFinite(crop)) return null;
  return Math.max(0, Math.min(100, (crop / cap) * 100));
}

function describeGranarySettings(s = granarySettings()) {
  const where = s.activeVillageCount
    ? (s.roundRobin
      ? `round-robin over ${s.activeVillageCount} village(s)`
      : `${s.activeVillageCount} village(s) each cycle`)
    : 'the current village';
  const action = s.npcEnabled ? `NPC to 1:1:1 leaving ${s.leaveCrop} crop` : 'watch only (NPC off)';
  return `over ${s.cropPercentThreshold}% crop → ${action}, ${where}, every ${s.intervalMinutesMin}–${s.intervalMinutesMax} min${s.dryRun ? ' (dry run)' : ''}`;
}

module.exports = {
  DEFAULTS,
  granarySettings,
  planNpcDistribution,
  cropPercent,
  describeGranarySettings,
};
