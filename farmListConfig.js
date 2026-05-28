'use strict';

const { loadConfig } = require('./auth');

/** @param {string|{name:string,enabled?:boolean}} entry */
function normalizeFarmListEntry(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { name, enabled: true } : null;
  }
  if (entry && typeof entry === 'object') {
    const name = String(entry.name || '').trim();
    if (!name) return null;
    return { name, enabled: entry.enabled !== false };
  }
  return null;
}

/** @param {Array<string|{name:string,enabled?:boolean}>} raw */
function normalizeFarmListsFromConfig(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const e = normalizeFarmListEntry(item);
    if (!e) continue;
    const key = e.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out;
}

/**
 * Merge lists from game discovery with saved config (keeps enabled flags).
 * @param {Array<string|{name:string,enabled?:boolean}>} existing
 * @param {string[]} discoveredNames
 */
function mergeFarmLists(existing, discoveredNames) {
  const byKey = new Map();
  for (const entry of normalizeFarmListsFromConfig(existing)) {
    byKey.set(entry.name.toLowerCase(), { ...entry });
  }
  for (const rawName of discoveredNames || []) {
    const name = String(rawName || '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (!byKey.has(key)) {
      byKey.set(key, { name, enabled: true });
    }
  }
  return Array.from(byKey.values());
}

function farmListSettings(cfg = loadConfig()) {
  const fl = cfg.farmList || {};
  const allLists = normalizeFarmListsFromConfig(fl.lists);
  const activeLists = allLists.filter(l => l.enabled).map(l => l.name);
  const min = Math.max(1, Number(fl.intervalMinutesMin) || 5);
  const max = Math.max(min, Number(fl.intervalMinutesMax) || 15);
  return {
    enabled: !!fl.enabled,
    allLists,
    lists: activeLists,
    activeCount: activeLists.length,
    totalCount: allLists.length,
    intervalMinutesMin: min,
    intervalMinutesMax: max,
  };
}

module.exports = {
  farmListSettings,
  normalizeFarmListEntry,
  normalizeFarmListsFromConfig,
  mergeFarmLists,
};
