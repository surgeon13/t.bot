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
    const stripBidi = s => String(s || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '');
    const norm = s => stripBidi(s).trim().replace(/\s+/g, ' ');

    /** Coordinates print as "(55" and "−26)" — with U+2212, not a hyphen. */
    const toInt = s => {
      const t = stripBidi(s)
        .replace(/[\u2212\u2013\u2014\u2012]/g, '-')
        .replace(/[^\d-]/g, '');
      const m = /-?\d+/.exec(t);
      return m ? Number(m[0]) : null;
    };

    const out = [];
    const seen = new Set();

    const add = (did, entry, extraClasses = '') => {
      const id = String(did || '').trim();
      if (!/^\d+$/.test(id) || seen.has(id)) return;

      const nameEl = entry.querySelector('.name');
      const name = norm(nameEl ? nameEl.textContent : entry.textContent);
      if (!name) return;

      const xEl = entry.querySelector('.coordinateX');
      const yEl = entry.querySelector('.coordinateY');

      // "active" sits on the entry on some skins and on the inner link on others.
      const classes = `${entry.className || ''} ${extraClasses} `
        + `${entry.querySelector('a')?.className || ''}`;
      const lc = classes.toLowerCase();

      seen.add(id);
      out.push({
        did: id,
        name,
        x: xEl ? toInt(xEl.textContent) : null,
        y: yEl ? toInt(yEl.textContent) : null,
        active: /(^|\s)active(\s|$)/.test(lc),
        // Not every server marks the capital in this list; absent just means no star.
        capital: /capital/.test(lc) || !!entry.querySelector('[class*="capital" i]'),
      });
    };

    // Primary: the Legends village list. Entries carry the village id in
    // data-did and navigate by script, so their links are plain "#".
    for (const entry of Array.from(document.querySelectorAll(
      '.villageList .listEntry[data-did], #sidebarBoxVillagelist [data-did], .listEntry.village[data-did]',
    ))) {
      add(entry.getAttribute('data-did'), entry);
    }

    // Fallback: older skins that put ?newdid= straight in the href.
    if (!out.length) {
      for (const link of Array.from(document.querySelectorAll('a[href*="newdid="]'))) {
        const m = /[?&]newdid=(\d+)/.exec(link.getAttribute('href') || '');
        if (!m) continue;
        const entry = link.closest('[data-did], .dropContainer, li, div') || link;
        add(m[1], entry, link.className || '');
      }
    }

    // Last resort: any element tagged with a village id at all.
    if (!out.length) {
      for (const el of Array.from(document.querySelectorAll('[data-did]'))) {
        add(el.getAttribute('data-did'), el);
      }
    }

    return out;
  });
}

/** The did of the village the game is currently showing, if it can be read. */
async function currentVillageDid(page) {
  return page.evaluate(() => {
    // The list entry marked active is what the game actually switched to. The URL
    // only says what was asked for — request a village that is not yours and the
    // game keeps you where you were while newdid still sits in the address.
    const activeEntry = document.querySelector(
      '.villageList .listEntry.active[data-did], #sidebarBoxVillagelist .active[data-did], .listEntry.village.active[data-did]',
    );
    if (activeEntry) {
      const did = activeEntry.getAttribute('data-did');
      if (/^\d+$/.test(String(did))) return String(did);
    }

    // Some skins mark the inner link instead of the entry.
    const activeLink = document.querySelector('.villageList a.active, #sidebarBoxVillagelist a.active');
    if (activeLink) {
      const owner = activeLink.closest('[data-did]');
      const did = owner?.getAttribute('data-did');
      if (/^\d+$/.test(String(did))) return String(did);
      const m = /[?&]newdid=(\d+)/.exec(activeLink.getAttribute('href') || '');
      if (m) return m[1];
    }

    // Legends exposes it as a global on most pages.
    const g = window.Travian?.Game?.activeVillageId ?? window.activeVillageId;
    if (g != null && /^\d+$/.test(String(g))) return String(g);

    // A village list with nothing marked active means "unknown", not "whatever
    // the address bar says" — ?newdid= reflects what was requested, and a
    // village that is not ours leaves it in the URL while the game ignores it.
    if (document.querySelector('.villageList, #sidebarBoxVillagelist, .listEntry[data-did]')) {
      return null;
    }

    const fromUrl = /[?&]newdid=(\d+)/.exec(location.search);
    return fromUrl ? fromUrl[1] : null;
  }).catch(() => null);
}

/** True when the page shows a village list we could have read an answer from. */
async function hasVillageList(page) {
  return page.evaluate(
    () => !!document.querySelector('.villageList, #sidebarBoxVillagelist, .listEntry[data-did]'),
  ).catch(() => false);
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

  let now = await currentVillageDid(page);

  // The village list navigates by script on current Legends skins (its links are
  // plain "#"), so if the URL form did not take, click the entry itself.
  if (now !== want) {
    const entry = page.locator(`.listEntry[data-did="${want}"] a, [data-did="${want}"] a`).first();
    if (await entry.count().catch(() => 0)) {
      try {
        await entry.click({ timeout: 8_000 });
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await dismissBlockingDialogs(page, { tag: TAG });
        await pause(600);
        now = await currentVillageDid(page);
      } catch (err) {
        log.warn(TAG, `Village list click failed for ${want}: ${err.message}`);
      }
    }
  }
  if (now == null) {
    if (await hasVillageList(page)) {
      // The list was readable and did not mark this village active, so the switch
      // did not take. Trading here would use the wrong village's merchants.
      return { ok: false, message: `Village ${want} did not become active` };
    }
    // No list at all (unfamiliar skin) — proceed, but say it is unverified.
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
  hasVillageList,
  loadVillages,
  switchToVillage,
};
