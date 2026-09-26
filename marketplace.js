'use strict';

/**
 * Marketplace offer hunter — reads the buy/offers table and accepts trades whose
 * ratio is at least `marketplace.minRatio` in our favour.
 *
 * The offers table is identified by its `ratio` column (`td.ratio`), which is the
 * one stable landmark across Travian Legends skins. Rows are tagged in the DOM
 * before clicking so an accept always targets the row we actually parsed.
 */

const log = require('./logger');
const { incrementMarketplaceAccept } = require('./totals');
const { loadConfig } = require('./auth');
const { randomDelay, pause, dismissBlockingDialogs, ensureGameShell } = require('./utils');
const {
  writeMarketplaceState,
  randomNextRunAt,
} = require('./marketplaceState');
const { marketplaceSettings } = require('./marketplaceConfig');
const { switchToVillage, loadVillages, currentVillageDid } = require('./villages');

const TAG = 'marketplace';

const ROW_ATTR = 'data-tbot-offer';
const MS_BETWEEN_ACCEPTS = 1_800;

const MARKETPLACE_URL_RE = /gid=17/i;
const MARKETPLACE_BUTTON_SELECTORS = [
  'a.layoutButton[data-load-tooltip-data*="Marketplace"]',
  'a[href*="gid=17"]',
  'a.layoutButton:has(svg.Marketplace)',
  'a.textButtonV2:has(svg.Marketplace)',
];

/** Offers tab, newest Legends layout first. */
const OFFER_TAB_PATHS = [
  'build.php?gid=17&t=1',
  'build.php?gid=17&tt=2',
  'build.php?gid=17',
];

const ACCEPT_SELECTORS = [
  'td.accept button',
  'button.accept',
  'a.accept',
  '.acceptOffer',
  'button[value="accept"]',
  'a[href*="accept"]',
  'button.textButtonV2',
  'button.textButtonV1',
  'button[type="submit"]',
  'button',
];

const CONFIRM_SELECTORS = [
  '.dialogWrapper button.ok',
  '.dialogWrapper button.accept',
  'button.confirmButton',
  '.dialog button.textButtonV1',
  'button#confirmButton',
];

function serverBase(cfg = loadConfig()) {
  return (cfg.url || '').replace(/\/+$/, '');
}

function isOnMarketplacePage(url) {
  return MARKETPLACE_URL_RE.test(url || '');
}

/** Wait until an offers table with a ratio column is on screen. */
async function waitForOffersTable(page) {
  try {
    await page.waitForFunction(() => {
      if (document.querySelector('td.ratio, th.ratio')) return true;
      if (document.querySelector('#offers, table.market, #market_offers')) return true;
      return false;
    }, { timeout: 15_000 });
    await pause(400);
    return true;
  } catch (err) {
    log.warn(TAG, `Marketplace offers table timeout: ${err.message}`);
    return false;
  }
}

/** Open the marketplace offers tab (gid=17). */
async function openMarketplaceOffersPage(page) {
  if (isOnMarketplacePage(page.url()) && await waitForOffersTable(page)) {
    return true;
  }

  if (!(await ensureGameShell(page, { tag: TAG }))) {
    log.warn(TAG, 'Game shell not reachable');
    return false;
  }
  await dismissBlockingDialogs(page, { tag: TAG });

  const base = serverBase();
  if (base) {
    for (const path of OFFER_TAB_PATHS) {
      const url = `${base}/${path}`;
      try {
        log.info(TAG, `Navigating to marketplace offers (${url})`);
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
        await dismissBlockingDialogs(page, { tag: TAG });
        if (await waitForOffersTable(page)) return true;
      } catch (err) {
        log.warn(TAG, `Marketplace navigation failed (${path}): ${err.message}`);
      }
    }
  }

  for (const sel of MARKETPLACE_BUTTON_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await loc.click({ timeout: 8_000 });
        log.info(TAG, `Opened marketplace via ${sel}`);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await randomDelay();
        if (await waitForOffersTable(page)) return true;
      }
    } catch {
      /* try next selector */
    }
  }

  return false;
}

/**
 * Parse every offer row on the current page.
 * Runs in the browser so the whole table is read in one pass.
 * @returns {Promise<Array<object>>}
 */
async function readMarketplaceOffersOnPage(page) {
  return page.evaluate(rowAttr => {
    const norm = s => (s || '')
      .replace(/[‎‏‪-‮]/g, '')
      .trim()
      .replace(/\s+/g, ' ');

    /** Travian prints "1 234", "1.234" or "1,234" — strip separators, keep one decimal mark. */
    const toNumber = raw => {
      let t = norm(raw).replace(/[^\d.,]/g, '');
      if (!t) return null;
      const lastDot = t.lastIndexOf('.');
      const lastComma = t.lastIndexOf(',');
      const decimalAt = Math.max(lastDot, lastComma);
      // A separator followed by 1-2 digits is a decimal mark; 3 digits is grouping.
      if (decimalAt >= 0 && t.length - decimalAt - 1 <= 2 && t.length - decimalAt - 1 > 0) {
        t = `${t.slice(0, decimalAt).replace(/[.,]/g, '')}.${t.slice(decimalAt + 1)}`;
      } else {
        t = t.replace(/[.,]/g, '');
      }
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };

    // Legends names wood "lumber" and suffixes icon classes with a size,
    // e.g. <i class="crop_small"> / <i class="lumber_small">.
    const RESOURCE_BY_CLASS = {
      r1: 'wood', r2: 'clay', r3: 'iron', r4: 'crop',
      lumber: 'wood', wood: 'wood', clay: 'clay', iron: 'iron', crop: 'crop',
    };

    const resourceFromClass = cls => {
      const key = String(cls || '').toLowerCase().replace(/_(small|medium|large|big)$/, '');
      return RESOURCE_BY_CLASS[key] || null;
    };

    /** Read the resource type from icon classes anywhere inside a cell. */
    const resourceIn = cell => {
      if (!cell) return null;
      const nodes = [cell, ...cell.querySelectorAll('*')];
      for (const node of nodes) {
        const classes = String(node.getAttribute?.('class') || '').split(/\s+/);
        for (const cls of classes) {
          const found = resourceFromClass(cls);
          if (found) return found;
        }
        const href = node.getAttribute?.('xlink:href') || node.getAttribute?.('href') || '';
        const m = /#?(r[1-4])\b/i.exec(href);
        if (m) return RESOURCE_BY_CLASS[m[1].toLowerCase()] || null;
      }
      return null;
    };

    const cellByClass = (row, names) => {
      for (const name of names) {
        const el = row.querySelector(`td.${name}, .${name}`);
        if (el) return el;
      }
      return null;
    };

    // Any table carrying a ratio column is an offers table.
    const ratioCells = Array.from(document.querySelectorAll('td.ratio, th.ratio'));
    const tables = [];
    for (const cell of ratioCells) {
      const table = cell.closest('table');
      if (table && !tables.includes(table)) tables.push(table);
    }
    if (!tables.length) return [];

    const offers = [];
    let index = 0;

    for (const table of tables) {
      for (const row of Array.from(table.querySelectorAll('tr'))) {
        const ratioCell = row.querySelector('td.ratio');
        if (!ratioCell) continue;                       // header rows use th, or have none
        const ratio = toNumber(ratioCell.textContent);
        if (ratio == null) continue;

        const offerCell = cellByClass(row, ['offer', 'give', 'offered']);
        const searchCell = cellByClass(row, ['search', 'want', 'wanted', 'request']);

        const offerAmount = toNumber(offerCell?.textContent);
        const wantAmount = toNumber(searchCell?.textContent);
        const offerResource = resourceIn(offerCell);
        const wantResource = resourceIn(searchCell);

        const merchantsCell = cellByClass(row, ['merchants', 'merchant']);
        const durationCell = cellByClass(row, ['duration', 'time', 'arrival']);
        const playerCell = cellByClass(row, ['player', 'alliance', 'playerName']);

        row.setAttribute(rowAttr, String(index));
        offers.push({
          index,
          ratio,
          offerResource,
          offerAmount,
          wantResource,
          wantAmount,
          // Independent check on the displayed ratio — surfaced in dry runs so the
          // direction of the column can be verified against the real table.
          computedRatio: (offerAmount && wantAmount) ? offerAmount / wantAmount : null,
          merchants: norm(merchantsCell?.textContent) || null,
          duration: norm(durationCell?.textContent) || null,
          player: norm(playerCell?.textContent) || null,
          rowText: norm(row.textContent).slice(0, 200),
        });
        index += 1;
      }
    }

    return offers;
  }, ROW_ATTR);
}

/**
 * Free merchants and how many pages of offers there are.
 * @returns {Promise<{merchantsAvailable:number|null,merchantsTotal:number|null,pagesTotal:number|null}>}
 */
async function readMarketplaceInfoOnPage(page) {
  return page.evaluate(() => {
    const clean = s => String(s || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '').trim();

    let merchantsAvailable = null;
    let merchantsTotal = null;
    const avail = document.querySelector('.merchantsInformation .available .value');
    if (avail) {
      // Rendered as "11/14" once the bidi wrappers are stripped.
      const m = /(\d[\d.,\s]*)\s*\/\s*(\d[\d.,\s]*)/.exec(clean(avail.textContent));
      if (m) {
        merchantsAvailable = Number(m[1].replace(/[^\d]/g, ''));
        merchantsTotal = Number(m[2].replace(/[^\d]/g, ''));
      }
    }

    let pagesTotal = null;
    const pages = Array.from(document.querySelectorAll('.pagination .pageIndex'))
      .map(el => Number(clean(el.textContent)))
      .filter(Number.isFinite);
    if (pages.length) pagesTotal = Math.max(...pages);

    return { merchantsAvailable, merchantsTotal, pagesTotal };
  });
}

/** Ratios currently in the table, top row first. */
async function readRatioColumnOnPage(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('td.ratio'))
    .map(td => {
      const t = String(td.textContent || '')
        .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
        .replace(/[^\d.,]/g, '')
        .replace(',', '.');
      const n = Number(t);
      return Number.isFinite(n) && t !== '' ? n : null;
    })
    .filter(n => n != null));
}

function isDescending(values) {
  for (let i = 1; i < values.length; i++) {
    if (values[i] > values[i - 1] + 1e-9) return false;
  }
  return true;
}

/**
 * Sort the table by the ratio column, best first, so the offers worth taking sit
 * on page one. The table spans many pages, and without this a good offer three
 * pages deep is never seen.
 *
 * The header toggles, so click and check rather than assuming a direction.
 * Best effort: a failure just leaves the natural order.
 * @returns {Promise<{sorted:boolean}>}
 */
async function sortOffersByRatioDesc(page) {
  const header = page.locator('td.ratio.sortable').first();
  if (!(await header.count().catch(() => 0))) return { sorted: false };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await header.click({ timeout: 8_000 });
    } catch (err) {
      log.warn(TAG, `Ratio sort click failed: ${err.message}`);
      return { sorted: false };
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await pause(700);

    const ratios = await readRatioColumnOnPage(page).catch(() => []);
    if (ratios.length < 2) return { sorted: ratios.length === 1 };
    if (isDescending(ratios)) {
      log.info(TAG, `Sorted offers by ratio, best first (top ${ratios[0]})`);
      return { sorted: true };
    }
  }

  log.warn(TAG, 'Could not sort offers by ratio — reading the page in its natural order');
  return { sorted: false };
}

/**
 * The ratio to judge an offer by.
 *
 * Travian rounds the ratio column to one decimal and rounds up, so a real 1.25
 * prints as 1.3. Matching on the printed value would accept trades below the
 * threshold, so the amounts win whenever both parsed.
 */
function effectiveRatio(offer) {
  if (Number.isFinite(offer.computedRatio) && offer.computedRatio > 0) return offer.computedRatio;
  return Number.isFinite(offer.ratio) ? offer.ratio : NaN;
}

/**
 * @param {object} offer
 * @param {{minRatio:number,giveResources:string[]}} settings
 * @param {{merchantsAvailable?:number}} [context] free merchants right now
 */
function offerMatches(offer, settings, context = {}) {
  const ratio = effectiveRatio(offer);
  if (!Number.isFinite(ratio) || ratio < settings.minRatio) return false;
  // Unknown requested resource: only accept when every resource is allowed anyway.
  if (offer.wantResource && !settings.giveResources.includes(offer.wantResource)) return false;
  if (!offer.wantResource && settings.giveResources.length < 4) return false;

  // An offer needing more merchants than we have free cannot be sent.
  // Guard on null explicitly: Number(null) is 0, which is finite, so an
  // unreadable merchant count would otherwise reject every offer silently.
  if (context.merchantsAvailable != null) {
    const free = Number(context.merchantsAvailable);
    const needed = Number(offer.merchants);
    if (Number.isFinite(free) && Number.isFinite(needed) && needed > free) return false;
  }
  return true;
}

function describeOffer(offer) {
  const get = offer.offerAmount != null
    ? `${offer.offerAmount} ${offer.offerResource || '?'}`
    : (offer.offerResource || '?');
  const give = offer.wantAmount != null
    ? `${offer.wantAmount} ${offer.wantResource || '?'}`
    : (offer.wantResource || '?');
  const ratio = effectiveRatio(offer);
  const shown = Number.isFinite(ratio) ? Number(ratio.toFixed(3)) : '?';
  return `${get} for ${give} (ratio ${shown})`;
}

/** Click accept on one tagged row and clear any confirmation dialog. */
async function acceptOfferRow(page, index) {
  const rowSel = `[${ROW_ATTR}="${index}"]`;
  const row = page.locator(rowSel).first();
  if (!(await row.count())) {
    return { ok: false, message: 'Offer row no longer on page' };
  }

  for (const sel of ACCEPT_SELECTORS) {
    const btn = row.locator(sel).first();
    if (!(await btn.count())) continue;
    if (!(await btn.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    if (await btn.isDisabled().catch(() => false)) continue;

    try {
      await btn.click({ timeout: 8_000 });
    } catch (err) {
      log.warn(TAG, `Accept click failed via ${sel}: ${err.message}`);
      continue;
    }

    await pause(700);
    for (const confirmSel of CONFIRM_SELECTORS) {
      const confirm = page.locator(confirmSel).first();
      if (await confirm.isVisible({ timeout: 1_200 }).catch(() => false)) {
        await confirm.click({ timeout: 5_000 }).catch(() => {});
        break;
      }
    }
    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await randomDelay();
    return { ok: true, message: `Accepted via ${sel}` };
  }

  return { ok: false, message: 'No accept button in offer row' };
}

/**
 * Read the offers table without accepting anything.
 * @returns {Promise<{ok:boolean,message:string,offers:Array<object>,matched:Array<object>}>}
 */
async function scanMarketplaceOffers(page, options = {}) {
  const settings = options.settings || marketplaceSettings();
  if (!(await openMarketplaceOffersPage(page))) {
    return {
      ok: false,
      message: 'Marketplace offers page not reachable',
      offers: [],
      matched: [],
      merchantsAvailable: null,
      pagesTotal: null,
      sorted: false,
    };
  }

  const { sorted } = options.skipSort ? { sorted: false } : await sortOffersByRatioDesc(page);
  const info = await readMarketplaceInfoOnPage(page).catch(() => ({
    merchantsAvailable: null, merchantsTotal: null, pagesTotal: null,
  }));

  // Tag rows only after sorting — a re-sort renumbers them.
  const offers = await readMarketplaceOffersOnPage(page);
  const context = { merchantsAvailable: info.merchantsAvailable };
  const matched = offers.filter(o => offerMatches(o, settings, context));

  const best = offers.reduce((acc, o) => {
    const r = effectiveRatio(o);
    return Number.isFinite(r) && r > acc ? r : acc;
  }, 0);

  log.info(
    TAG,
    `Scanned ${offers.length} offer(s); ${matched.length} at ratio ≥ ${settings.minRatio}`
    + (best ? ` (best on page ${Number(best.toFixed(3))})` : '')
    + (info.merchantsAvailable != null ? `; ${info.merchantsAvailable} merchant(s) free` : ''),
  );

  const parts = [];
  if (!offers.length) {
    parts.push('No offers on the marketplace page');
  } else {
    parts.push(`${offers.length} offer(s) read, ${matched.length} at ratio ≥ ${settings.minRatio}`);
    if (best) parts.push(`best on page ${Number(best.toFixed(3))}`);
    if (info.merchantsAvailable != null) parts.push(`${info.merchantsAvailable} merchant(s) free`);
    // Without a working sort the good offers may simply be on another page.
    if (!sorted && info.pagesTotal > 1) {
      parts.push(`only this page of ${info.pagesTotal} was read (ratio sort unavailable)`);
    }
  }

  return {
    ok: true,
    message: parts.join(' · '),
    offers,
    matched,
    merchantsAvailable: info.merchantsAvailable,
    merchantsTotal: info.merchantsTotal,
    pagesTotal: info.pagesTotal,
    sorted,
  };
}

/**
 * One full cycle: scan, then accept matching offers (unless dry run).
 * Writes marketplace state and returns a GUI-shaped result.
 */
/**
 * Read-only preview across the selected villages (or the current one when none
 * are selected). Accepts nothing.
 */
async function scanMarketplaceAcrossVillages(page, options = {}) {
  const settings = options.settings || marketplaceSettings();
  const targets = settings.activeVillages || [];

  if (!targets.length) {
    const one = await scanMarketplaceOffers(page, { settings });
    return { ...one, villages: [], villagesRun: 0 };
  }

  const startedAt = await currentVillageDid(page).catch(() => null);
  const perVillage = [];
  const offers = [];
  const matched = [];

  for (const village of targets) {
    const label = village.name || `village ${village.did}`;
    const switched = await switchToVillage(page, village.did);
    if (!switched.ok) {
      perVillage.push({ did: village.did, name: village.name, ok: false, message: switched.message });
      continue;
    }
    const scan = await scanMarketplaceOffers(page, { settings });
    perVillage.push({
      did: village.did,
      name: village.name,
      ok: scan.ok,
      message: scan.message,
      scanned: scan.offers.length,
      matched: scan.matched.length,
      merchantsAvailable: scan.merchantsAvailable,
      pagesTotal: scan.pagesTotal,
      sorted: scan.sorted,
    });
    offers.push(...scan.offers.map(o => ({ ...o, village: label })));
    matched.push(...scan.matched.map(o => ({ ...o, village: label })));
  }

  if (startedAt && startedAt !== (await currentVillageDid(page).catch(() => null))) {
    await switchToVillage(page, startedAt).catch(() => {});
  }

  const reached = perVillage.filter(v => v.ok !== false);
  const message = reached.length
    ? perVillage
      .map(v => (v.ok === false
        ? `${v.name || v.did}: ${v.message}`
        : `${v.name || v.did}: ${v.matched}/${v.scanned} match(es)`))
      .join(' · ')
    : 'No selected village could be reached';

  return {
    ok: reached.length > 0,
    message,
    offers,
    matched,
    villages: perVillage,
    villagesRun: perVillage.length,
    merchantsAvailable: null,
    pagesTotal: null,
    sorted: perVillage.every(v => v.sorted),
  };
}

/**
 * One marketplace cycle in whichever village is currently active.
 * Pure with respect to state: the caller decides what to persist.
 * @returns {Promise<object>} the same shape runMarketplaceOffers returns, minus nextRunAt
 */
async function runMarketplaceCycleHere(page, settings, dryRun) {
  const finish = (extra = {}) => ({
    ok: extra.ok !== false,
    status: extra.status || 'done',
    message: extra.message || '',
    dryRun,
    scanned: extra.scanned ?? 0,
    matched: extra.matched ?? 0,
    accepted: extra.accepted ?? 0,
    offers: extra.offers || [],
    acceptedOffers: extra.acceptedOffers || [],
    merchantsAvailable: extra.merchantsAvailable ?? null,
    pagesTotal: extra.pagesTotal ?? null,
    sorted: extra.sorted ?? false,
  });

  const scan = await scanMarketplaceOffers(page, { settings });
  const scanContext = {
    merchantsAvailable: scan.merchantsAvailable,
    pagesTotal: scan.pagesTotal,
    sorted: scan.sorted,
  };
  if (!scan.ok) {
    return finish({ ok: false, status: 'failed', message: scan.message, ...scanContext });
  }

  if (!scan.matched.length) {
    return finish({
      status: 'no-match',
      message: scan.offers.length
        ? `No offer at ratio ≥ ${settings.minRatio} (${scan.offers.length} scanned)`
        : 'No offers on the marketplace page',
      scanned: scan.offers.length,
      offers: scan.matched,
      ...scanContext,
    });
  }

  if (dryRun) {
    const preview = scan.matched.slice(0, settings.maxAcceptsPerRun);
    log.info(TAG, `Dry run — would accept: ${preview.map(describeOffer).join('; ')}`);
    return finish({
      status: 'dry-run',
      message: `Dry run — ${scan.matched.length} match(es), would accept ${preview.length}: ${preview.map(describeOffer).join('; ')}`,
      scanned: scan.offers.length,
      matched: scan.matched.length,
      offers: scan.matched,
      ...scanContext,
    });
  }

  const acceptedOffers = [];
  const failures = [];
  let remaining = Math.min(settings.maxAcceptsPerRun, scan.matched.length);
  let pending = scan.matched;

  while (remaining > 0 && pending.length) {
    const offer = pending[0];
    const result = await acceptOfferRow(page, offer.index);
    if (result.ok) {
      incrementMarketplaceAccept(describeOffer(offer));
      acceptedOffers.push({ ...offer, summary: describeOffer(offer) });
      remaining -= 1;
    } else {
      failures.push({ summary: describeOffer(offer), message: result.message });
      log.warn(TAG, `Could not accept ${describeOffer(offer)}: ${result.message}`);
    }

    if (remaining <= 0) break;
    await pause(MS_BETWEEN_ACCEPTS);

    // Accepting reloads the table and renumbers rows, so re-read before the next
    // one. Merchants are re-read too: the last accept just spent some.
    if (!(await openMarketplaceOffersPage(page))) break;
    const freshInfo = await readMarketplaceInfoOnPage(page).catch(() => ({ merchantsAvailable: null }));
    const fresh = await readMarketplaceOffersOnPage(page);
    const stillMatching = fresh.filter(
      o => offerMatches(o, settings, { merchantsAvailable: freshInfo.merchantsAvailable }),
    );
    if (!result.ok) {
      // Drop the row we just failed on so a bad row cannot loop forever.
      const failedKey = describeOffer(offer);
      pending = stillMatching.filter(o => describeOffer(o) !== failedKey);
    } else {
      pending = stillMatching;
    }
  }

  const scanned = scan.offers.length;
  const matchedCount = scan.matched.length;

  if (!acceptedOffers.length) {
    const detail = failures.map(f => `${f.summary}: ${f.message}`).join('; ');
    return finish({
      ok: false,
      status: 'failed',
      message: detail || `Found ${matchedCount} match(es) but accepted none`,
      scanned,
      matched: matchedCount,
      offers: scan.matched,
      ...scanContext,
    });
  }

  const summary = acceptedOffers.map(o => o.summary).join('; ');
  log.info(TAG, `Accepted ${acceptedOffers.length} offer(s): ${summary}`);
  return finish({
    status: failures.length ? 'partial' : 'accepted',
    message: failures.length
      ? `Accepted ${acceptedOffers.length}/${matchedCount}; ${failures.length} failed`
      : `Accepted ${acceptedOffers.length} offer(s): ${summary}`,
    scanned,
    matched: matchedCount,
    accepted: acceptedOffers.length,
    offers: scan.matched,
    acceptedOffers,
    ...scanContext,
  });
}

/**
 * One full run: a cycle in every village selected under `marketplace.villages`,
 * or in whatever village is active when none are selected.
 *
 * Each village has its own marketplace and its own merchants, so a village is a
 * complete cycle of its own — switch, sort, scan, accept — and the results are
 * summed. One village failing does not stop the rest.
 */
async function runMarketplaceOffers(page, options = {}) {
  const settings = options.settings || marketplaceSettings();
  const dryRun = options.dryRun !== undefined ? !!options.dryRun : settings.dryRun;
  const now = new Date();
  const nextAt = randomNextRunAt(settings.intervalMinutesMin, settings.intervalMinutesMax);

  const persist = result => {
    writeMarketplaceState({
      lastRunAt: now.toISOString(),
      nextRunAt: nextAt.toISOString(),
      lastScanned: result.scanned ?? 0,
      lastMatched: result.matched ?? 0,
      lastAccepted: result.accepted ?? 0,
      lastOffers: (result.offers || []).slice(0, 10),
      lastMessage: result.message || null,
      lastVillages: (result.villages || []).map(v => ({
        did: v.did,
        name: v.name,
        status: v.status,
        scanned: v.scanned,
        matched: v.matched,
        accepted: v.accepted,
        message: v.message,
      })),
      intervalMinutesMin: settings.intervalMinutesMin,
      intervalMinutesMax: settings.intervalMinutesMax,
    });
    return { ...result, nextRunAt: nextAt.toISOString() };
  };

  const targets = settings.activeVillages || [];

  // No selection: behave as before and trade wherever the browser already is.
  if (!targets.length) {
    const single = await runMarketplaceCycleHere(page, settings, dryRun);
    return persist({ ...single, villages: [], villagesRun: 0 });
  }

  const startedAt = await currentVillageDid(page).catch(() => null);
  const results = [];

  for (const village of targets) {
    const label = village.name || `village ${village.did}`;
    const switched = await switchToVillage(page, village.did);
    if (!switched.ok) {
      log.warn(TAG, `${label}: ${switched.message}`);
      results.push({
        did: village.did,
        name: village.name,
        ok: false,
        status: 'failed',
        message: switched.message,
        scanned: 0,
        matched: 0,
        accepted: 0,
        offers: [],
        acceptedOffers: [],
      });
      continue;
    }

    log.info(TAG, `Marketplace cycle in ${label}`);
    let cycle;
    try {
      cycle = await runMarketplaceCycleHere(page, settings, dryRun);
    } catch (err) {
      log.error(TAG, `${label}: cycle failed — ${err.message}`);
      cycle = {
        ok: false, status: 'failed', message: err.message,
        scanned: 0, matched: 0, accepted: 0, offers: [], acceptedOffers: [],
      };
    }
    results.push({ did: village.did, name: village.name, ...cycle });
  }

  // Leave the browser where it started so other runners are not surprised.
  if (startedAt && startedAt !== (await currentVillageDid(page).catch(() => null))) {
    await switchToVillage(page, startedAt).catch(() => {});
  }

  const sum = key => results.reduce((n, r) => n + (Number(r[key]) || 0), 0);
  const accepted = sum('accepted');
  const matched = sum('matched');
  const scanned = sum('scanned');
  const acceptedOffers = results.flatMap(r => (r.acceptedOffers || [])
    .map(o => ({ ...o, village: r.name || r.did })));
  const offers = results.flatMap(r => (r.offers || [])
    .map(o => ({ ...o, village: r.name || r.did })));
  const failed = results.filter(r => r.ok === false);

  const per = results
    .map(r => `${r.name || r.did}: ${r.accepted ? `accepted ${r.accepted}` : (r.matched ? `${r.matched} match(es)` : 'no match')}`)
    .join(' · ');

  let status = 'no-match';
  if (accepted) status = failed.length ? 'partial' : 'accepted';
  else if (dryRun && matched) status = 'dry-run';
  else if (failed.length === results.length) status = 'failed';
  else if (failed.length) status = 'partial';

  const headline = dryRun && matched
    ? `Dry run across ${results.length} village(s) — ${matched} match(es): ${per}`
    : `${results.length} village(s) — ${accepted} accepted, ${matched} match(es): ${per}`;

  log.info(TAG, headline);

  return persist({
    ok: failed.length < results.length,
    status,
    message: headline,
    dryRun,
    scanned,
    matched,
    accepted,
    offers,
    acceptedOffers,
    villages: results,
    villagesRun: results.length,
    merchantsAvailable: null,
    pagesTotal: null,
    sorted: results.every(r => r.sorted),
  });
}

module.exports = {
  ...require('./marketplaceConfig'),
  openMarketplaceOffersPage,
  readMarketplaceOffersOnPage,
  readMarketplaceInfoOnPage,
  sortOffersByRatioDesc,
  effectiveRatio,
  scanMarketplaceOffers,
  scanMarketplaceAcrossVillages,
  runMarketplaceCycleHere,
  runMarketplaceOffers,
  offerMatches,
  describeOffer,
  MARKETPLACE_BUTTON_SELECTORS,
};
