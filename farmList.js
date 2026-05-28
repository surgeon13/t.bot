'use strict';

const log = require('./logger');
const { loadConfig } = require('./auth');
const { randomDelay, pause, dismissBlockingDialogs, ensureGameShell } = require('./utils');
const {
  readFarmListState,
  writeFarmListState,
  randomNextRunAt,
} = require('./farmListState');

const TAG = 'farmList';

const FARM_LIST_URL_RE = /gid=16.*tt=99|tt=99.*gid=16/i;
const FARM_LIST_BUTTON_SELECTORS = [
  'a.layoutButton[data-load-tooltip-data*="RallyPointFarmList"]',
  'a[href*="gid=16"][href*="tt=99"]',
  'a.layoutButton:has(svg.RallyPointFarmList)',
  'a.textButtonV2:has(svg.RallyPointFarmList)',
];

function farmListSettings(cfg = loadConfig()) {
  const fl = cfg.farmList || {};
  const lists = Array.isArray(fl.lists)
    ? [...new Set(fl.lists.map(s => String(s).trim()).filter(Boolean))]
    : [];
  const min = Math.max(1, Number(fl.intervalMinutesMin) || 5);
  const max = Math.max(min, Number(fl.intervalMinutesMax) || 15);
  return {
    enabled: !!fl.enabled,
    lists,
    intervalMinutesMin: min,
    intervalMinutesMax: max,
  };
}

function serverBase(cfg = loadConfig()) {
  return (cfg.url || '').replace(/\/+$/, '');
}

function isOnFarmListPage(url) {
  return FARM_LIST_URL_RE.test(url || '');
}

async function waitForFarmListContent(page) {
  try {
    await page.waitForFunction(() => {
      if (/gid=16/.test(location.href) && /tt=99/.test(location.href)) {
        const body = document.body?.innerText || '';
        if (/farm\s*list|raiding|raid|list/i.test(body)) return true;
        if (document.querySelector(
          '.farmList, .farmListName, .listName, [class*="farmList"], table.farmList, #raidList'
        )) return true;
      }
      return !!document.querySelector(
        '.farmList, .farmListName, .listName, [class*="farmList"], table.farmList, #raidList, .raidList'
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

/** Names visible on the current farm list page. */
async function readFarmListsOnPage(page) {
  return page.evaluate(() => {
    const norm = s => (s || '').trim().replace(/\s+/g, ' ');
    const names = new Set();

    const nameSelectors = [
      '.farmListName',
      '.listName',
      '.name',
      '[class*="farmList"] .name',
      '[class*="FarmList"] .name',
      'h3', 'h4',
    ];
    for (const sel of nameSelectors) {
      for (const el of document.querySelectorAll(sel)) {
        const t = norm(el.innerText || el.textContent);
        if (t && t.length >= 2 && t.length < 80) names.add(t);
      }
    }

    for (const row of document.querySelectorAll('tr, li, .farmList, [class*="farmList"]')) {
      const t = norm(row.innerText || '');
      if (t.length > 2 && t.length < 120) {
        const firstLine = t.split('\n')[0].trim();
        if (firstLine.length >= 2 && firstLine.length < 60) names.add(firstLine);
      }
    }

    return Array.from(names).slice(0, 40);
  }).catch(() => []);
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
 * Click Start/Send for a farm list matched by name (substring, case-insensitive).
 * @returns {Promise<{ ok: boolean, message: string }>}
 */
async function clickSendForListName(page, listName) {
  const result = await page.evaluate(targetName => {
    const norm = s => (s || '').trim().toLowerCase();
    const target = norm(targetName);
    if (!target) return { ok: false, message: 'Empty list name' };

    const isSendLabel = t => /start|send|raid|attack|los|starten|envoyer|go|losgehen/i.test(t);
    const isVisible = el => {
      if (!el || el.disabled) return false;
      const s = getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 4 && r.height > 4;
    };

    const trySendInRoot = root => {
      if (!root) return null;
      const labelEl = root.querySelector('.farmListName, .listName, .name, h3, h4, caption, th');
      const label = norm(labelEl?.innerText || root.getAttribute('data-list-name') || '');
      const rootText = norm(root.innerText || '').slice(0, 200);
      const matches = (label && (label === target || label.includes(target) || target.includes(label)))
        || (rootText.includes(target) && rootText.length < 250);
      if (!matches) return null;

      const buttons = root.querySelectorAll('button, a.button, a.textButtonV2, input[type="button"], input[type="submit"]');
      for (const btn of buttons) {
        if (!isVisible(btn)) continue;
        const t = norm(btn.innerText || btn.value || btn.getAttribute('aria-label') || '');
        if (isSendLabel(t)) {
          btn.click();
          return { ok: true, message: `Send clicked for "${listName}"` };
        }
      }
      return null;
    };

    const roots = document.querySelectorAll(
      '.farmList, .farmListBlock, .farmListEntry, [class*="farmList"], [class*="FarmList"], tr, li'
    );
    for (const root of roots) {
      const hit = trySendInRoot(root);
      if (hit) return hit;
    }

    const allButtons = document.querySelectorAll('button, a.textButtonV2, a.button');
    for (const btn of allButtons) {
      if (!isVisible(btn)) continue;
      const t = norm(btn.innerText || btn.textContent || '');
      if (!isSendLabel(t)) continue;
      let node = btn.parentElement;
      for (let i = 0; i < 8 && node; i++) {
        const blockText = norm(node.innerText || '').slice(0, 200);
        if (blockText.includes(target)) {
          btn.click();
          return { ok: true, message: `Send clicked near "${listName}"` };
        }
        node = node.parentElement;
      }
    }

    return { ok: false, message: `List "${listName}" not found or no send button` };
  }, listName);

  if (result.ok) {
    await confirmSendDialog(page);
  }
  return result;
}

/**
 * Send the next list in round-robin order.
 * @returns {Promise<{ ok: boolean, status: string, message: string, listName?: string, nextRunAt?: string }>}
 */
async function sendNextFarmList(page, options = {}) {
  const settings = farmListSettings();
  if (!settings.lists.length) {
    return { ok: false, status: 'skipped', message: 'No farm lists configured' };
  }

  const state = readFarmListState();
  let index = Number(state?.lastIndex);
  if (!Number.isFinite(index) || index < 0) index = 0;
  if (options.forceIndex != null) index = Number(options.forceIndex) % settings.lists.length;

  const listName = settings.lists[index % settings.lists.length];
  log.info(TAG, `Round-robin send: "${listName}" (${index + 1}/${settings.lists.length})`);

  if (!(await openFarmListPage(page))) {
    return { ok: false, status: 'failed', message: 'Farm list page not reachable', listName };
  }

  const onPage = await readFarmListsOnPage(page);
  if (onPage.length) {
    log.info(TAG, `Lists on page: ${onPage.slice(0, 8).join(', ')}${onPage.length > 8 ? '…' : ''}`);
  }

  const clickResult = await clickSendForListName(page, listName);
  const now = new Date();
  const nextAt = randomNextRunAt(settings.intervalMinutesMin, settings.intervalMinutesMax);
  const nextIndex = (index + 1) % settings.lists.length;

  writeFarmListState({
    lastRunAt: now.toISOString(),
    nextRunAt: nextAt.toISOString(),
    lastListName: listName,
    lastIndex: index,
    intervalMinutesMin: settings.intervalMinutesMin,
    intervalMinutesMax: settings.intervalMinutesMax,
  });

  if (!clickResult.ok) {
    log.warn(TAG, clickResult.message);
    return {
      ok: false,
      status: 'failed',
      message: clickResult.message,
      listName,
      listsOnPage: onPage,
      nextRunAt: nextAt.toISOString(),
      nextListName: settings.lists[nextIndex],
    };
  }

  log.info(TAG, `${clickResult.message}; next send after ${settings.intervalMinutesMin}–${settings.intervalMinutesMax} min`);
  return {
    ok: true,
    status: 'sent',
    message: clickResult.message,
    listName,
    listsOnPage: onPage,
    nextRunAt: nextAt.toISOString(),
    nextListName: settings.lists[nextIndex],
  };
}

module.exports = {
  farmListSettings,
  openFarmListPage,
  readFarmListsOnPage,
  sendNextFarmList,
  FARM_LIST_BUTTON_SELECTORS,
};
