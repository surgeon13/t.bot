'use strict';

/**
 * Picking which villages a runner acts in.
 *
 * `did` is Travian's village id (the `data-did` / `newdid` value) and is the
 * identity throughout: players rename villages, so names are display only.
 */

/** @param {{did?:string|number,name?:string,enabled?:boolean}|string|number} entry */
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
      // discovery alone can never widen where a runner acts.
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

/**
 * Which villages a cycle should visit.
 * In round-robin only one village runs per cycle, advancing from the last one.
 * @param {Array<{did:string}>} active villages the user ticked
 * @param {{roundRobin?:boolean, lastDid?:string|null}} opts
 */
function villagesForCycle(active, opts = {}) {
  const list = Array.isArray(active) ? active.filter(Boolean) : [];
  if (!opts.roundRobin || list.length <= 1) return list;

  const at = list.findIndex(v => String(v.did) === String(opts.lastDid ?? ''));
  const start = at >= 0 ? (at + 1) % list.length : 0;
  return [list[start]];
}

module.exports = {
  normalizeVillageEntry,
  normalizeVillagesFromConfig,
  mergeVillages,
  villagesForCycle,
};
