'use strict';

/**
 * Marketplace offer settings — which offers count as good enough to accept.
 *
 * `minRatio` is compared against the ratio Travian prints in the offers table
 * (what you receive ÷ what you give), so 1.5 means "at least 50% more back".
 */

const { loadConfig } = require('./auth');

const RESOURCES = ['wood', 'clay', 'iron', 'crop'];

const DEFAULTS = {
  enabled: false,
  dryRun: true,
  minRatio: 1.5,
  maxAcceptsPerRun: 3,
  giveResources: [...RESOURCES],
  villages: [],
  intervalMinutesMin: 20,
  intervalMinutesMax: 45,
};

/** @param {unknown} raw @returns {string[]} lower-case resource names, always non-empty */
function normalizeGiveResources(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  for (const item of list) {
    const name = String(item || '').trim().toLowerCase();
    if (RESOURCES.includes(name) && !out.includes(name)) out.push(name);
  }
  // Giving nothing would match no offer at all — treat empty as "any resource".
  return out.length ? out : [...RESOURCES];
}

/**
 * One saved village entry.
 * `did` is Travian's village id (the `newdid` value) and is the identity; the
 * name is only for display, since players rename villages.
 * @param {{did?:string|number,name?:string,enabled?:boolean}|string|number} entry
 */
function normalizeVillageEntry(entry) {
  if (entry == null) return null;
  if (typeof entry === 'string' || typeof entry === 'number') {
    const did = String(entry).trim();
    return /^\d+$/.test(did) ? { did, name: '', enabled: true } : null;
  }
  if (typeof entry !== 'object') return null;
  const did = String(entry.did ?? '').trim();
  if (!/^\d+$/.test(did)) return null;
  return {
    did,
    name: String(entry.name || '').trim(),
    enabled: entry.enabled !== false,
    capital: !!entry.capital,
  };
}

/** @param {Array} raw */
function normalizeVillagesFromConfig(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const e = normalizeVillageEntry(item);
    if (!e || seen.has(e.did)) continue;
    seen.add(e.did);
    out.push(e);
  }
  return out;
}

/**
 * Merge villages discovered in game with what is saved (keeps the ticks).
 * Order follows the game's sidebar; saved-only villages trail at the end so a
 * village that was removed from the account is still visible to untick.
 * @param {Array} existing
 * @param {Array<{did:string,name:string,capital?:boolean}>} discovered
 */
function mergeVillages(existing, discovered) {
  const saved = new Map(normalizeVillagesFromConfig(existing).map(v => [v.did, v]));
  const found = Array.isArray(discovered) ? discovered : [];
  const out = [];
  const placed = new Set();

  for (const v of found) {
    const did = String(v?.did ?? '').trim();
    if (!/^\d+$/.test(did) || placed.has(did)) continue;
    const prev = saved.get(did);
    out.push({
      did,
      name: String(v.name || prev?.name || '').trim(),
      // A village the player has never seen in the picker starts unticked, so
      // discovery alone can never widen where the bot trades.
      enabled: prev ? prev.enabled : false,
      capital: !!v.capital,
    });
    placed.add(did);
  }
  for (const v of saved.values()) {
    if (!placed.has(v.did)) out.push(v);
  }
  return out;
}

function marketplaceSettings(cfg = loadConfig()) {
  const mp = cfg.marketplace || {};
  const min = Math.max(1, Number(mp.intervalMinutesMin) || DEFAULTS.intervalMinutesMin);
  const max = Math.max(min, Number(mp.intervalMinutesMax) || DEFAULTS.intervalMinutesMax);
  const ratio = Number(mp.minRatio);
  const perRun = Math.floor(Number(mp.maxAcceptsPerRun));
  const villages = normalizeVillagesFromConfig(mp.villages);
  const activeVillages = villages.filter(v => v.enabled);
  return {
    enabled: !!mp.enabled,
    // Dry run defaults ON: a missing flag must never mean "spend resources".
    dryRun: mp.dryRun === undefined ? DEFAULTS.dryRun : !!mp.dryRun,
    minRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULTS.minRatio,
    maxAcceptsPerRun: Number.isFinite(perRun) && perRun >= 1
      ? Math.min(25, perRun)
      : DEFAULTS.maxAcceptsPerRun,
    giveResources: normalizeGiveResources(mp.giveResources),
    villages,
    activeVillages,
    villageCount: villages.length,
    activeVillageCount: activeVillages.length,
    intervalMinutesMin: min,
    intervalMinutesMax: max,
  };
}

/** Human-readable summary used in log lines and GUI hints. */
function describeMarketplaceSettings(s = marketplaceSettings()) {
  const give = s.giveResources.length === RESOURCES.length
    ? 'any resource'
    : s.giveResources.join('/');
  const where = s.activeVillageCount
    ? (s.activeVillageCount === 1
      ? `in ${s.activeVillages[0].name || `village ${s.activeVillages[0].did}`}`
      : `across ${s.activeVillageCount} villages`)
    : 'in the current village';
  return `ratio ≥ ${s.minRatio}, give ${give}, ${where}, up to ${s.maxAcceptsPerRun}/run, every ${s.intervalMinutesMin}–${s.intervalMinutesMax} min${s.dryRun ? ' (dry run)' : ''}`;
}

module.exports = {
  RESOURCES,
  DEFAULTS,
  marketplaceSettings,
  normalizeGiveResources,
  normalizeVillageEntry,
  normalizeVillagesFromConfig,
  mergeVillages,
  describeMarketplaceSettings,
};
