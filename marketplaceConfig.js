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

function marketplaceSettings(cfg = loadConfig()) {
  const mp = cfg.marketplace || {};
  const min = Math.max(1, Number(mp.intervalMinutesMin) || DEFAULTS.intervalMinutesMin);
  const max = Math.max(min, Number(mp.intervalMinutesMax) || DEFAULTS.intervalMinutesMax);
  const ratio = Number(mp.minRatio);
  const perRun = Math.floor(Number(mp.maxAcceptsPerRun));
  return {
    enabled: !!mp.enabled,
    // Dry run defaults ON: a missing flag must never mean "spend resources".
    dryRun: mp.dryRun === undefined ? DEFAULTS.dryRun : !!mp.dryRun,
    minRatio: Number.isFinite(ratio) && ratio > 0 ? ratio : DEFAULTS.minRatio,
    maxAcceptsPerRun: Number.isFinite(perRun) && perRun >= 1
      ? Math.min(25, perRun)
      : DEFAULTS.maxAcceptsPerRun,
    giveResources: normalizeGiveResources(mp.giveResources),
    intervalMinutesMin: min,
    intervalMinutesMax: max,
  };
}

/** Human-readable summary used in log lines and GUI hints. */
function describeMarketplaceSettings(s = marketplaceSettings()) {
  const give = s.giveResources.length === RESOURCES.length
    ? 'any resource'
    : s.giveResources.join('/');
  return `ratio ≥ ${s.minRatio}, give ${give}, up to ${s.maxAcceptsPerRun}/run, every ${s.intervalMinutesMin}–${s.intervalMinutesMax} min${s.dryRun ? ' (dry run)' : ''}`;
}

module.exports = {
  RESOURCES,
  DEFAULTS,
  marketplaceSettings,
  normalizeGiveResources,
  describeMarketplaceSettings,
};
