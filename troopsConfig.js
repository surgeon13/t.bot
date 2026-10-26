'use strict';

/**
 * Troop training settings.
 *
 * One entry per training building. Travian gives each building a `gid`, and a
 * village can hold both the normal and the "great" variant, each with its own
 * queue — so Khopesh warriors can be trained in barracks *and* great barracks
 * at the same time, which is the point of listing them separately.
 */

const { loadConfig } = require('./auth');
const { normalizeVillagesFromConfig } = require('./villageSelection');

/** gid -> building, in the order a cycle visits them. */
const BUILDINGS = [
  { key: 'barracks', gid: 19, label: 'Barracks' },
  { key: 'greatBarracks', gid: 29, label: 'Great barracks' },
  { key: 'stable', gid: 20, label: 'Stable' },
  { key: 'greatStable', gid: 30, label: 'Great stable' },
  { key: 'workshop', gid: 21, label: 'Workshop' },
];

const BUILDING_BY_KEY = new Map(BUILDINGS.map(b => [b.key, b]));

const DEFAULTS = {
  enabled: false,
  dryRun: true,
  roundRobin: false,
  targetQueueHours: 8,
  maxPerBatch: 0,
  intervalMinutesMin: 20,
  intervalMinutesMax: 45,
};

/**
 * @param {{key?:string,troop?:string,enabled?:boolean,targetQueueHours?:number,maxPerBatch?:number}} entry
 */
function normalizeBuildingEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const key = String(entry.key || '').trim();
  const building = BUILDING_BY_KEY.get(key);
  if (!building) return null;

  const hours = Number(entry.targetQueueHours);
  const batch = Math.floor(Number(entry.maxPerBatch));
  return {
    key,
    gid: building.gid,
    label: building.label,
    troop: String(entry.troop || '').trim(),
    enabled: entry.enabled !== false,
    // How deep to keep the queue. 0 would mean "never top up", so fall back.
    targetQueueHours: Number.isFinite(hours) && hours > 0
      ? Math.min(72, hours)
      : DEFAULTS.targetQueueHours,
    // 0 means "no cap of our own" — the game's own max still applies.
    maxPerBatch: Number.isFinite(batch) && batch > 0 ? batch : 0,
  };
}

function normalizeBuildingsFromConfig(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const e = normalizeBuildingEntry(item);
    if (!e || seen.has(e.key)) continue;
    seen.add(e.key);
    out.push(e);
  }
  // Keep the canonical order regardless of how config listed them.
  return BUILDINGS.map(b => out.find(e => e.key === b.key)).filter(Boolean);
}

/** Every building, with saved settings merged in — what the GUI renders. */
function buildingRowsForApi(raw) {
  const saved = new Map(normalizeBuildingsFromConfig(raw).map(e => [e.key, e]));
  return BUILDINGS.map(b => saved.get(b.key) || {
    key: b.key,
    gid: b.gid,
    label: b.label,
    troop: '',
    enabled: false,
    targetQueueHours: DEFAULTS.targetQueueHours,
    maxPerBatch: 0,
  });
}

function trainingSettings(cfg = loadConfig()) {
  const t = cfg.training || {};
  const min = Math.max(1, Number(t.intervalMinutesMin) || DEFAULTS.intervalMinutesMin);
  const max = Math.max(min, Number(t.intervalMinutesMax) || DEFAULTS.intervalMinutesMax);
  const villages = normalizeVillagesFromConfig(t.villages);
  const buildings = normalizeBuildingsFromConfig(t.buildings);
  // A building with no troop name cannot be acted on.
  const activeBuildings = buildings.filter(b => b.enabled && b.troop);
  const activeVillages = villages.filter(v => v.enabled);

  return {
    enabled: !!t.enabled,
    // Dry run defaults ON: a missing flag must never mean "spend resources".
    dryRun: t.dryRun === undefined ? DEFAULTS.dryRun : !!t.dryRun,
    roundRobin: !!t.roundRobin,
    villages,
    activeVillages,
    activeVillageCount: activeVillages.length,
    buildings,
    activeBuildings,
    activeBuildingCount: activeBuildings.length,
    intervalMinutesMin: min,
    intervalMinutesMax: max,
  };
}

/**
 * How many units to queue so the queue reaches `targetQueueHours`.
 *
 * Pure so the decision can be tested without a browser.
 *
 * @param {object} o
 * @param {number} o.queueSeconds how much training is already queued
 * @param {number} o.targetQueueHours how deep the queue should be
 * @param {number} o.secondsPerUnit training time for one unit
 * @param {number} o.maxAffordable what the game says we can pay for right now
 * @param {number} [o.maxPerBatch] our own cap, 0 for none
 * @returns {{amount:number, reason:string}}
 */
function unitsToQueue(o) {
  const queueSeconds = Math.max(0, Number(o.queueSeconds) || 0);
  const targetSeconds = Math.max(0, (Number(o.targetQueueHours) || 0) * 3600);
  const perUnit = Number(o.secondsPerUnit);
  const affordable = Math.max(0, Math.floor(Number(o.maxAffordable) || 0));
  const cap = Math.max(0, Math.floor(Number(o.maxPerBatch) || 0));

  if (!affordable) return { amount: 0, reason: 'cannot afford any' };
  if (queueSeconds >= targetSeconds) {
    return { amount: 0, reason: `queue already ${Math.round(queueSeconds / 60)} min deep` };
  }

  // Without a per-unit time we cannot size the batch, so fall back to filling
  // what we can afford — the queue depth check above still gates it.
  if (!Number.isFinite(perUnit) || perUnit <= 0) {
    const amount = cap ? Math.min(affordable, cap) : affordable;
    return { amount, reason: 'unit training time unknown — filling to affordable' };
  }

  const needed = Math.ceil((targetSeconds - queueSeconds) / perUnit);
  let amount = Math.min(needed, affordable);
  if (cap) amount = Math.min(amount, cap);

  if (amount <= 0) return { amount: 0, reason: 'nothing needed' };
  const limit = amount === cap ? 'batch cap'
    : amount === affordable ? 'resources'
      : 'queue target';
  return { amount, reason: `top up by ${amount} (limited by ${limit})` };
}

function describeTrainingSettings(s = trainingSettings()) {
  const where = s.activeVillageCount
    ? (s.roundRobin
      ? `round-robin over ${s.activeVillageCount} village(s)`
      : `${s.activeVillageCount} village(s) each cycle`)
    : 'the current village';
  const what = s.activeBuildingCount
    ? s.activeBuildings.map(b => `${b.label}: ${b.troop}`).join(', ')
    : 'nothing enabled';
  return `${what} — ${where}, every ${s.intervalMinutesMin}–${s.intervalMinutesMax} min${s.dryRun ? ' (dry run)' : ''}`;
}

module.exports = {
  BUILDINGS,
  DEFAULTS,
  trainingSettings,
  normalizeBuildingEntry,
  normalizeBuildingsFromConfig,
  buildingRowsForApi,
  unitsToQueue,
  describeTrainingSettings,
};
