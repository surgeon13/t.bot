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
 * Reorder list entries to match the game page (village → list DOM order).
 * Lists only in config are appended at the end in their previous order.
 * @param {Array<{name:string,enabled?:boolean}>} lists
 * @param {string[]} gameOrderNames
 */
function orderFarmListsByGame(lists, gameOrderNames) {
  const items = normalizeFarmListsFromConfig(lists);
  const order = (gameOrderNames || [])
    .map(n => String(n || '').trim())
    .filter(Boolean);
  if (!order.length) return items;

  const byKey = new Map(items.map(e => [e.name.toLowerCase(), e]));
  const out = [];
  const placed = new Set();

  for (const name of order) {
    const key = name.toLowerCase();
    if (!byKey.has(key) || placed.has(key)) continue;
    out.push(byKey.get(key));
    placed.add(key);
  }
  for (const entry of items) {
    const key = entry.name.toLowerCase();
    if (!placed.has(key)) out.push(entry);
  }
  return out;
}

/**
 * Merge lists from game discovery with saved config (keeps enabled flags).
 * Result order matches the game page; config-only lists stay at the end.
 * @param {Array<string|{name:string,enabled?:boolean}>} existing
 * @param {string[]} discoveredNames
 */
function mergeFarmLists(existing, discoveredNames) {
  const byKey = new Map();
  for (const entry of normalizeFarmListsFromConfig(existing)) {
    byKey.set(entry.name.toLowerCase(), { ...entry });
  }
  const discovered = (discoveredNames || [])
    .map(n => String(n || '').trim())
    .filter(Boolean);
  const out = [];
  for (const name of discovered) {
    const key = name.toLowerCase();
    if (byKey.has(key)) {
      out.push(byKey.get(key));
    } else {
      out.push({ name, enabled: true });
    }
  }
  for (const entry of byKey.values()) {
    const key = entry.name.toLowerCase();
    if (!discovered.some(n => n.toLowerCase() === key)) out.push(entry);
  }
  return out;
}

/** @param {string[]} activeNames @param {string[]} gameOrderNames */
function orderActiveNamesByGame(activeNames, gameOrderNames) {
  const names = (activeNames || []).map(n => String(n || '').trim()).filter(Boolean);
  const order = (gameOrderNames || []).map(n => String(n || '').trim()).filter(Boolean);
  if (!order.length) return names;
  const want = new Set(names.map(n => n.toLowerCase()));
  const out = [];
  const placed = new Set();
  for (const name of order) {
    const key = name.toLowerCase();
    if (!want.has(key) || placed.has(key)) continue;
    const exact = names.find(n => n.toLowerCase() === key);
    if (exact) {
      out.push(exact);
      placed.add(key);
    }
  }
  for (const name of names) {
    const key = name.toLowerCase();
    if (!placed.has(key)) out.push(name);
  }
  return out;
}

function farmListSettings(cfg = loadConfig(), options = {}) {
  const fl = cfg.farmList || {};
  let allLists = normalizeFarmListsFromConfig(fl.lists);
  if (options.gameOrder?.length) {
    allLists = orderFarmListsByGame(allLists, options.gameOrder);
  }
  const activeLists = allLists.filter(l => l.enabled).map(l => l.name);
  const min = Math.max(1, Number(fl.intervalMinutesMin) || 5);
  const max = Math.max(min, Number(fl.intervalMinutesMax) || 15);
  return {
    enabled: !!fl.enabled,
    sendAllMode: !!fl.sendAllMode,
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
  orderFarmListsByGame,
  orderActiveNamesByGame,
};
