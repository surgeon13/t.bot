'use strict';

const log = require('./logger');
const { incrementFarmListSend } = require('./totals');
const { loadConfig } = require('./auth');
const { randomDelay, pause, dismissBlockingDialogs, ensureGameShell } = require('./utils');
const {
  readFarmListState,
  writeFarmListState,
  randomNextRunAt,
} = require('./farmListState');
const {
  farmListSettings,
  normalizeFarmListsFromConfig,
  mergeFarmLists,
} = require('./farmListConfig');

const TAG = 'farmList';

const FARM_LIST_URL_RE = /gid=16.*tt=99|tt=99.*gid=16/i;
const FARM_LIST_BUTTON_SELECTORS = [
  'a.layoutButton[data-load-tooltip-data*="RallyPointFarmList"]',
  'a[href*="gid=16"][href*="tt=99"]',
  'a.layoutButton:has(svg.RallyPointFarmList)',
  'a.textButtonV2:has(svg.RallyPointFarmList)',
];

const JUNK_NAME_RE = /^(start|send|raid|attack|edit|delete|ok|cancel|close|yes|no|all|none|\d+|—|-)$/i;

function serverBase(cfg = loadConfig()) {
  return (cfg.url || '').replace(/\/+$/, '');
}

function isOnFarmListPage(url) {
  return FARM_LIST_URL_RE.test(url || '');
}

function stripBidiMarks(text) {
  return String(text || '').replace(/[\u200e\u200f\u202a-\u202e]/g, '');
}

async function waitForFarmListContent(page) {
  try {
    await page.waitForFunction(() => {
      if (document.querySelector('#rallyPointFarmList .farmListWrapper')) return true;
      if (document.querySelector('.farmListWrapper .farmListName .name')) return true;
      if (/gid=16/.test(location.href) && /tt=99/.test(location.href)) {
        const body = document.body?.innerText || '';
        if (/farm\s*list|raiding|being raided/i.test(body)) return true;
      }
      return !!document.querySelector(
        '.farmListName .name, #rallyPointFarmList, table.farmList, #raidList'
      );
    }, { timeout: 15_000 });
    await pause(400);
    return true;
  } catch (err) {
    log.warn(TAG, `Farm list page content timeout: ${err.message}`);
    return false;
  }
}

/** Open rally point farm list tab (gid=16&tt=99). */
async function openFarmListPage(page) {
  if (isOnFarmListPage(page.url())) {
    return waitForFarmListContent(page);
  }

  if (!(await ensureGameShell(page, { tag: TAG }))) {
    log.warn(TAG, 'Game shell not reachable');
    return false;
  }
  await dismissBlockingDialogs(page, { tag: TAG });

  for (const sel of FARM_LIST_BUTTON_SELECTORS) {
    try {
      const loc = page.locator(sel).first();
      if (await loc.isVisible({ timeout: 2_000 }).catch(() => false)) {
        await loc.click({ timeout: 8_000 });
        log.info(TAG, `Opened farm list via ${sel}`);
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await randomDelay();
        if (await waitForFarmListContent(page)) return true;
      }
    } catch {
      /* try next selector */
    }
  }

  const base = serverBase();
  if (!base) return false;
  const url = `${base}/build.php?gid=16&tt=99`;
  log.info(TAG, `Navigating to farm list (${url})`);
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await dismissBlockingDialogs(page, { tag: TAG });
    return waitForFarmListContent(page);
  } catch (err) {
    log.warn(TAG, `Farm list navigation failed: ${err.message}`);
    return false;
  }
}

/**
 * Read farm list entries from the rally point farm list tab (Legends UI).
 * @returns {Promise<Array<{name:string,listId?:string,canSend?:boolean,village?:string}>>}
 */
async function readFarmListEntriesOnPage(page) {
  return page.evaluate(junkPattern => {
    const junk = new RegExp(junkPattern, 'i');
    const norm = s => (s || '')
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const entries = [];
    const seen = new Set();

    const add = (name, meta = {}) => {
      const n = norm(name);
      if (!n || n.length < 2 || n.length > 80 || junk.test(n)) return;
      const key = n.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      entries.push({
        name: n,
        listId: meta.listId || null,
        canSend: meta.canSend !== false,
        village: meta.village || null,
      });
    };

    const root = document.querySelector('#rallyPointFarmList') || document;
    const wrappers = root.querySelectorAll('.farmListWrapper');

    wrappers.forEach(wrapper => {
      const nameEl = wrapper.querySelector('.farmListName .name');
      const name = nameEl ? (nameEl.textContent || nameEl.innerText) : '';
      if (!name) return;

      const drag = wrapper.querySelector('.dragAndDrop[data-list]');
      const listId = drag?.getAttribute('data-list')
        || wrapper.querySelector('[data-farm-list-id]')?.getAttribute('data-farm-list-id')
        || null;

      const villageEl = wrapper.closest('.villageWrapper')?.querySelector('.villageName');
      const village = villageEl ? norm(villageEl.textContent || villageEl.innerText) : null;

      const btn = wrapper.querySelector('.farmListHeader button.startFarmList')
        || wrapper.querySelector('.farmListFooter button.startFarmList');
      const canSend = !!(btn
        && !btn.disabled
        && !btn.classList.contains('disabled')
        && !/disabled/i.test(btn.className));

      add(name, { listId, canSend, village });
    });

    if (!entries.length) {
      root.querySelectorAll('.farmListName .name').forEach(el => {
        add(el.textContent || el.innerText);
      });
    }

    return entries;
  }, JUNK_NAME_RE.source).catch(() => []);
}

/** Read all farm list names from the Travian farm list page. */
async function readFarmListsOnPage(page) {
  const entries = await readFarmListEntriesOnPage(page);
  return entries.map(e => e.name);
}

async function confirmSendDialog(page) {
  await pause(500);
  const confirmed = await page.evaluate(() => {
    const tryClick = el => {
      if (!el || el.disabled) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      el.click();
      return true;
    };
    const root = document.querySelector('#reactDialogWrapper') || document.body;
    const buttons = root.querySelectorAll('button, a.button, a.textButtonV2');
    for (const btn of buttons) {
      const t = (btn.innerText || btn.textContent || '').trim().toLowerCase();
      if (/^(ok|yes|confirm|send|start|raid|attack|los|starten|envoyer|go)$/.test(t)
        || /confirm|send|start raid/i.test(t)) {
        if (tryClick(btn)) return t;
      }
    }
    return null;
  }).catch(() => null);

  if (confirmed) {
    log.info(TAG, `Confirmed send dialog (${confirmed})`);
    await pause(600);
  }
  await dismissBlockingDialogs(page, { tag: TAG });
}

/**
 * Click the per-list green Start button (`.farmListHeader button.startFarmList`) for one farm list.
 * @param {import('playwright').Page} page
 * @param {string} listName
 * @param {{ listId?: string }} [options]
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function clickSendForListName(page, listName, options = {}) {
  const result = await page.evaluate(({ targetName, listId, junkPattern }) => {
    const norm = s => (s || '')
      .replace(/[\u200e\u200f\u202a-\u202e]/g, '')
      .trim()
      .replace(/\s+/g, ' ');
    const target = norm(targetName).toLowerCase();
    if (!target) return { ok: false, message: 'Empty list name' };

    const root = document.querySelector('#rallyPointFarmList') || document;
    const wrappers = [...root.querySelectorAll('.farmListWrapper')];

    const wrapperListId = wrapper => {
      const drag = wrapper.querySelector('.farmListHeader .dragAndDrop[data-list], .dragAndDrop[data-list]');
      return drag?.getAttribute('data-list') || null;
    };

    const wrapperName = wrapper => {
      const nameEl = wrapper.querySelector('.farmListName .name');
      return nameEl ? norm(nameEl.textContent || nameEl.innerText) : '';
    };

    const nameMatches = (pageName, mode) => {
      const n = norm(pageName).toLowerCase();
      if (!n || !target) return false;
      if (mode === 'exact') return n === target;
      return n === target || n.includes(target) || target.includes(n);
    };

    const wrapperMatches = (wrapper, mode) => {
      if (listId && wrapperListId(wrapper) === String(listId)) return true;
      return nameMatches(wrapperName(wrapper), mode);
    };

    const isPerListStartButton = btn => {
      if (!btn?.classList.contains('startFarmList')) return false;
      if (btn.disabled || btn.classList.contains('disabled')) return false;
      const chrome = btn.closest('.farmListHeader') || btn.closest('.farmListFooter');
      if (!chrome || !btn.closest('.farmListWrapper')) return false;
      const s = getComputedStyle(btn);
      const r = btn.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 4 && r.height > 4;
    };

    const pickStartButton = wrapper => {
      const headerBtn = wrapper.querySelector('.farmListHeader button.startFarmList');
      if (headerBtn && isPerListStartButton(headerBtn)) {
        return { btn: headerBtn, where: 'header' };
      }
      const footerBtn = wrapper.querySelector('.farmListFooter button.startFarmList');
      if (footerBtn && isPerListStartButton(footerBtn)) {
        return { btn: footerBtn, where: 'footer' };
      }
      return null;
    };

    const expandWrapperIfCollapsed = wrapper => {
      if (!wrapper.classList.contains('collapsed')) return;
      const toggle = wrapper.querySelector('.farmListHeader a.expandCollapse');
      toggle?.click();
    };

    const clickInWrapper = wrapper => {
      const pageName = wrapperName(wrapper);
      expandWrapperIfCollapsed(wrapper);
      const picked = pickStartButton(wrapper);
      if (!picked) {
        return {
          ok: false,
          message: pageName
            ? `List "${pageName}" found but its Start button is disabled or missing`
            : 'Farm list wrapper has no name',
        };
      }
      const label = norm(picked.btn.innerText || picked.btn.textContent || 'Start');
      picked.btn.click();
      return {
        ok: true,
        message: `Started farm list "${pageName}" via ${picked.where} (${label})`,
      };
    };

    let matched = wrappers.filter(w => wrapperMatches(w, 'exact'));
    if (!matched.length) {
      matched = wrappers.filter(w => wrapperMatches(w, 'fuzzy'));
      if (matched.length > 1) {
        const names = matched.map(wrapperName).join(', ');
        return {
          ok: false,
          message: `List "${targetName}" is ambiguous (${names}) — rename or use Load from game`,
        };
      }
    }

    if (matched.length === 1) {
      return clickInWrapper(matched[0]);
    }

    return { ok: false, message: `List "${targetName}" not found on farm list page` };
  }, {
    targetName: listName,
    listId: options.listId || null,
    junkPattern: JUNK_NAME_RE.source,
  });

  if (result.ok) {
    await confirmSendDialog(page);
  }
  return result;
}

const MS_BETWEEN_LIST_SENDS = 2500;

/**
 * Send every checked farm list in one cycle, then schedule the next cycle.
 * @returns {Promise<{ ok: boolean, status: string, message: string, listName?: string, sentLists?: string[], nextRunAt?: string }>}
 */
async function sendAllCheckedFarmLists(page, options = {}) {
  const settings = farmListSettings();
  let active = settings.lists;

  if (options.onlyOne && options.forceIndex != null) {
    const i = Number(options.forceIndex) % Math.max(active.length, 1);
    active = active.length ? [active[i]] : [];
  }

  if (!active.length) {
    return {
      ok: false,
      status: 'skipped',
      message: settings.totalCount
        ? 'No farm lists checked — enable at least one list in the dashboard'
        : 'No farm lists — load from game and check lists to include',
    };
  }

  log.info(TAG, `Sending ${active.length} checked farm list(s): ${active.join(', ')}`);

  if (!(await openFarmListPage(page))) {
    return { ok: false, status: 'failed', message: 'Farm list page not reachable' };
  }

  let entries = await readFarmListEntriesOnPage(page);
  if (entries.length) {
    const preview = entries.slice(0, 12).map(e => e.name).join(', ');
    log.info(TAG, `Lists on page: ${preview}${entries.length > 12 ? '…' : ''}`);
  }

  const entriesByName = new Map(
    entries.map(e => [String(e.name || '').toLowerCase(), e]),
  );

  const results = [];
  for (let i = 0; i < active.length; i++) {
    const listName = active[i];
    log.info(TAG, `Send ${i + 1}/${active.length}: "${listName}"`);

    if (i > 0) {
      await pause(MS_BETWEEN_LIST_SENDS);
      if (!(await openFarmListPage(page))) {
        results.push({
          listName,
          ok: false,
          message: 'Farm list page not reachable',
        });
        break;
      }
      entries.length = 0;
      const refreshed = await readFarmListEntriesOnPage(page);
      entries.push(...refreshed);
      for (const e of refreshed) {
        entriesByName.set(String(e.name || '').toLowerCase(), e);
      }
    }

    const clickResult = await clickSendForListName(page, listName, {
      listId: entriesByName.get(listName.toLowerCase())?.listId || undefined,
    });
    results.push({ listName, ...clickResult });
    if (!clickResult.ok) {
      log.warn(TAG, `${listName}: ${clickResult.message}`);
    } else {
      incrementFarmListSend(listName);
      log.info(TAG, clickResult.message);
    }
  }

  const sent = results.filter(r => r.ok).map(r => r.listName);
  const failed = results.filter(r => !r.ok);
  const now = new Date();
  const nextAt = randomNextRunAt(settings.intervalMinutesMin, settings.intervalMinutesMax);

  writeFarmListState({
    lastRunAt: now.toISOString(),
    nextRunAt: nextAt.toISOString(),
    lastListName: sent.length ? sent.join(', ') : (failed[0]?.listName || null),
    lastIndex: 0,
    intervalMinutesMin: settings.intervalMinutesMin,
    intervalMinutesMax: settings.intervalMinutesMax,
  });

  const listsOnPage = entries.map(e => e.name);
  const base = {
    listsOnPage,
    sentLists: sent,
    failedLists: failed.map(f => ({ name: f.listName, message: f.message })),
    nextRunAt: nextAt.toISOString(),
    nextListName: active.length > 1 ? `all ${active.length} checked` : active[0],
    activeCount: active.length,
    listName: sent[0] || active[0],
  };

  if (!sent.length) {
    const detail = failed.map(f => `${f.listName}: ${f.message}`).join('; ');
    return {
      ok: false,
      status: 'failed',
      message: detail || 'No farm lists could be sent',
      ...base,
    };
  }

  if (failed.length) {
    log.warn(TAG, `Sent ${sent.length}/${active.length}; failed: ${failed.map(f => f.listName).join(', ')}`);
    return {
      ok: true,
      status: 'partial',
      message: `Sent ${sent.length}/${active.length} checked list(s); ${failed.length} failed`,
      ...base,
    };
  }

  log.info(
    TAG,
    `Sent all ${sent.length} checked list(s); next cycle after ${settings.intervalMinutesMin}–${settings.intervalMinutesMax} min`,
  );
  return {
    ok: true,
    status: 'sent',
    message: sent.length === 1
      ? `Sent "${sent[0]}"`
      : `Sent all ${sent.length} checked lists`,
    ...base,
  };
}

/** @deprecated name kept for callers — sends every checked list each cycle. */
async function sendNextFarmList(page, options = {}) {
  return sendAllCheckedFarmLists(page, options);
}

module.exports = {
  ...require('./farmListConfig'),
  openFarmListPage,
  readFarmListEntriesOnPage,
  readFarmListsOnPage,
  sendAllCheckedFarmLists,
  sendNextFarmList,
  stripBidiMarks,
  FARM_LIST_BUTTON_SELECTORS,
};
