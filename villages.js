'use strict';

/**
 * Village list + switching.
 *
 * Travian scopes almost everything to the *active* village — marketplace offers
 * and merchants included — and the active village is changed with `?newdid=<id>`.
 * Discovery reads the sidebar village list, which is the one place every village
 * and its id appear together.
 */

const log = require('./logger');
const { loadConfig } = require('./auth');
const { pause, dismissBlockingDialogs, ensureGameShell } = require('./utils');

const TAG = 'villages';

function serverBase(cfg = loadConfig()) {
  return (cfg.url || '').replace(/\/+$/, '');
}

/**
 * Every village on the account, as shown in the sidebar list.
 * @returns {Promise<Array<{did:string,name:string,x:number|null,y:number|null,active:boolean,capital:boolean}>>}
 */
async function readVillagesOnPage(page) {
  return page.evaluate(() => {
    const norm = s => String(s || '')
      .replace(/[‎‏‪-‮]/g, '')
      .trim()
      .replace(/\s+/g, ' ');

    const toInt = s => {
      const n = Number(String(s || '').replace(/[^\d-]/g, ''));
      return Number.isFinite(n) ? n : null;
    };

    const out = [];
    const seen = new Set();

    for (const link of Array.from(document.querySelectorAll('a[href*="newdid="]'))) {
      const href = link.getAttribute('href') || '';
      const m = /[?&]newdid=(\d+)/.exec(href);
      if (!m) continue;
      const did = m[1];
      if (seen.has(did)) continue;

      const entry = link.closest('[data-did], .dropContainer, li, div') || link;

      const nameEl = link.querySelector('.name') || entry.querySelector('.name');
      const name = norm(nameEl ? nameEl.textContent : link.textContent);
      if (!name) continue;

      const xEl = entry.querySelector('.coordinateX');
      const yEl = entry.querySelector('.coordinateY');

      // Class lives on the link on some skins, on the wrapper on others.
      const classes = `${link.className || ''} ${entry.className || ''}`.toLowerCase();
      const capital = /capital/.test(classes)
        || !!entry.querySelector('[class*="capital" i]');

      seen.add(did);
      out.push({
        did,
        name,
        x: xEl ? toInt(xEl.textContent) : null,
        y: yEl ? toInt(yEl.textContent) : null,
        active: /(^|\s)active(\s|$)/.test(classes),
        capital,
      });
    }

    return out;
  });
}

/** The did of the village the game is currently showing, if it can be read. */
async function currentVillageDid(page) {
  return page.evaluate(() => {
    // The sidebar's active entry is what the game actually switched to. The URL
    // only says what was asked for — request a village that is not yours and the
    // game keeps you where you were while `newdid` still sits in the address.
    const active = document.querySelector(
      '.villageList .active[href*="newdid="], #sidebarBoxVillagelist .active[href*="newdid="]',
    );
    if (active) {
      const m = /[?&]newdid=(\d+)/.exec(active.getAttribute('href') || '');
      if (m) return m[1];
    }

    const activeWrapper = document.querySelector('.villageList .active[data-did], [data-did].active');
    if (activeWrapper) {
      const did = activeWrapper.getAttribute('data-did');
      if (/^\d+$/.test(String(did))) return String(did);
    }

    // Legends exposes it as a global on most pages.
    const g = window.Travian?.Game?.activeVillageId ?? window.activeVillageId;
    if (g != null && /^\d+$/.test(String(g))) return String(g);

    const fromUrl = /[?&]newdid=(\d+)/.exec(location.search);
    return fromUrl ? fromUrl[1] : null;
  }).catch(() => null);
}

/** Open the village list (sidebar is present on the normal game shell). */
async function loadVillages(page) {
  if (!(await ensureGameShell(page, { tag: TAG }))) {
    log.warn(TAG, 'Game shell not reachable — cannot read villages');
    return [];
  }
  await dismissBlockingDialogs(page, { tag: TAG });

  let villages = await readVillagesOnPage(page);
  if (!villages.length) {
    // Some layouts only render the list on the resource overview.
    const base = serverBase();
    if (base) {
      try {
        await page.goto(`${base}/dorf1.php`, { waitUntil: 'domcontentloaded', timeout: 20_000 });
        await dismissBlockingDialogs(page, { tag: TAG });
        await pause(400);
        villages = await readVillagesOnPage(page);
      } catch (err) {
        log.warn(TAG, `Village list navigation failed: ${err.message}`);
      }
    }
  }

  log.info(TAG, villages.length
    ? `Found ${villages.length} village(s): ${villages.map(v => v.name).join(', ')}`
    : 'No villages found in the sidebar list');
  return villages;
}

/**
 * Make `did` the active village.
 * @returns {Promise<{ok:boolean,message:string}>}
 */
async function switchToVillage(page, did, options = {}) {
  const want = String(did || '').trim();
  if (!/^\d+$/.test(want)) return { ok: false, message: `Invalid village id "${did}"` };

  if (!options.force && (await currentVillageDid(page)) === want) {
    return { ok: true, message: 'Already in that village' };
  }

  const base = serverBase();
  if (!base) return { ok: false, message: 'No config.url — cannot switch village' };

  const url = `${base}/dorf1.php?newdid=${want}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await dismissBlockingDialogs(page, { tag: TAG });
    await pause(500);
  } catch (err) {
    return { ok: false, message: `Village switch failed: ${err.message}` };
  }

  const now = await currentVillageDid(page);
  if (now == null) {
    // No sidebar to confirm against — treat as reachable but say so, rather than
    // trading in a village we cannot name.
    log.warn(TAG, `Could not confirm the active village after switching to ${want}`);
    return { ok: true, message: `Switched to village ${want} (unconfirmed)`, confirmed: false };
  }
  if (now !== want) {
    // A did that is not ours leaves the game on the previous village.
    return { ok: false, message: `Village ${want} did not become active (still ${now})` };
  }
  return { ok: true, message: `Switched to village ${want}`, confirmed: true };
}

module.exports = {
  readVillagesOnPage,
  currentVillageDid,
  loadVillages,
  switchToVillage,
};
