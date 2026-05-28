'use strict';

const fs = require('fs');
const path = require('path');

const log = require('./logger');
const { loadConfig } = require('./auth');
const {
  randomDelay,
  dismissBlockingDialogs,
  ensureGameShell,
  openTravianPaymentWizard,
  SHOP_NAV_SELECTOR,
  pause,
} = require('./utils');
const { waitForVideoToFinish } = require('./videoAds');
const { isTaskInterrupted } = require('./terminalControl');
const { setLastCompletedBonus } = require('./runState');
const { incrementResourceBonus } = require('./totals');

const TAG = 'resources';
const { RESOURCE_BONUS_STATE_FILE: STATE_FILE } = require('./paths');
const DEFAULT_INTERVAL_HOURS = 8;
const RETRY_AFTER_EMPTY_MS = 30 * 60 * 1000;
const WIZARD_OPEN_TIMEOUT_MS = 10_000;

const SHOP_BUTTON = SHOP_NAV_SELECTOR;
// Travian rotates the shop dialog class (paymentWizardV2 → paymentShopV5 → …).
// Match any of the known wrappers; fall back to a generic visible dialog.
const WIZARD_PARTS = [
  '.dialog.paymentShopV6',
  '.paymentShopV6',
  '.dialog.paymentShopV5',
  '.paymentShopV5',
  '.dialog.paymentWizardV3',
  '.paymentWizardV3',
  '.dialog.paymentWizardV2',
  '.paymentWizardV2',
  '.dialog.paymentWizard',
  '.paymentWizard',
  '#reactDialogWrapper .dialog[class*="payment"]',
];
const WIZARD_SELECTOR = WIZARD_PARTS.join(', ');
const TAB_SELECTOR = [
  '.dialog a.tabItem',
  '.dialog .tabItem',
  '.paymentShopV6 a.tabItem',
  '.paymentShopV5 a.tabItem',
  '.paymentWizardV3 a.tabItem',
  '.paymentWizardV2 a.tabItem',
  '[data-tabname]',
].join(', ');
// Visible text of the Advantages tab in the shop wizard. Add localized labels when needed.
const ADVANTAGES_LABEL =
  /^(advantages?|pros|benefits?|vorteile?|avantages?|vantaggi|ventajas|vantagens|voordelen|zalety|korzyści|előnyök|avantajlar|vyhody|преимущества|выгоды)\b/i;
const BONUS_BOX_SELECTORS = ['.advantagesBonusBox', '.videoFeatureBonusBox'];
const RESOURCES = ['Wood', 'Clay', 'Iron', 'Crop'];

// Each resource's bonus row on the Advantages tab is wrapped in
//   <div class="advantagesBonusBox <RESOURCE>ProductionBonus">
// containing both a gold "Activate N" button (.bonusButton) and, when the
// 4h buff has expired, a video "Activate" button (.bonusVideo). We anchor
// on the outer box because it stays put even if the gold/video children
// are reshuffled.
const RESOURCE_BONUS_CLASS = {
  Wood: 'lumberProductionBonus',
  Clay: 'clayProductionBonus',
  Iron: 'ironProductionBonus',
  Crop: 'cropProductionBonus',
};
const BONUS_BOX_SELECTOR = BONUS_BOX_SELECTORS[0];
const RESOURCE_POLL_EVAL = ({ wizardParts, boxSelectors, resourceToBonusClass }) => {
  const isVisible = element => {
    if (!element) return false;
    const s = getComputedStyle(element);
    const b = element.getBoundingClientRect();
    return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
  };

  const isClickable = element => {
    if (!isVisible(element)) return false;
    if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
    if (element.classList.contains('disabled')) return false;
    const s = getComputedStyle(element);
    return s.pointerEvents !== 'none' && Number(s.opacity) > 0.05;
  };

  const findVisibleWizard = () => {
    for (const sel of wizardParts) {
      const nodes = document.querySelectorAll(sel);
      for (const el of nodes) {
        const b = el.getBoundingClientRect();
        if (isVisible(el) && b.width > 80 && b.height > 80) return el;
      }
    }
    for (const boxSel of boxSelectors) {
      const box = document.querySelector(`${boxSel}.lumberProductionBonus, ${boxSel}.cropProductionBonus`);
      if (!box) continue;
      const w = box.closest(
        '.dialog, [class*="paymentShop"], [class*="paymentWizard"], #reactDialogWrapper'
      );
      if (w && isVisible(w)) return w;
    }
    const wrapper = document.querySelector('#reactDialogWrapper');
    if (wrapper && isVisible(wrapper)) return wrapper;
    return document.body;
  };

  const isProductionBox = el => /ProductionBonus/i.test(el.className || '');

  const findResourceBox = (root, bonusClass) => {
    for (const boxSel of boxSelectors) {
      const direct = root.querySelector(`${boxSel}.${bonusClass}`);
      if (direct && (boxSel !== '.videoFeatureBonusBox' || isProductionBox(direct))) return direct;
      for (const el of root.querySelectorAll(boxSel)) {
        if (!el.classList.contains(bonusClass)) continue;
        if (boxSel === '.videoFeatureBonusBox' && !isProductionBox(el)) continue;
        return el;
      }
    }
    for (const boxSel of boxSelectors) {
      const global = document.querySelector(`${boxSel}.${bonusClass}`);
      if (global && isVisible(global)) return global;
    }
    const byClass = document.querySelector(`.${bonusClass}`);
    if (byClass) {
      return (
        byClass.closest(boxSelectors.join(', ')) || byClass
      );
    }
    return null;
  };

  const findVideoControl = box => {
    const video = box.querySelector('.bonusVideo, [class*="bonusVideo"]');
    if (!video) return null;

    const controls = [
      ...video.querySelectorAll('button'),
      ...video.querySelectorAll('a'),
      ...video.querySelectorAll('[role="button"]'),
    ];
    for (const el of controls) {
      if (isClickable(el)) return el;
    }

    if (video.querySelector('.videoIcon, i[class*="videoIcon"], i[class*="video"]') && isClickable(video)) {
      return video;
    }
    return null;
  };

  const root = findVisibleWizard();
  const out = {};
  for (const [resource, bonusClass] of Object.entries(resourceToBonusClass)) {
    const box = findResourceBox(root, bonusClass);
    if (!box) {
      out[resource] = { status: 'missing', claimable: false, cooldownText: null, bonusActive: false };
      continue;
    }

    const bonusActive = box.classList.contains('active');
    const timerEl = box.querySelector('.bonusDuration .timerReact, .timerReact');
    const cooldownText = timerEl ? (timerEl.innerText || timerEl.textContent || '').trim() : null;
    const videoControl = findVideoControl(box);
    const claimable = !!videoControl;

    let status;
    if (claimable) status = 'claimable';
    else if (bonusActive || cooldownText) status = 'active';
    else status = 'unavailable';

    out[resource] = { status, claimable, cooldownText, bonusActive };
  }
  return out;
};

function readResourceBonusState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return null;
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeResourceBonusState(p) {
  const previous = readResourceBonusState() || {};
  const body = {
    ...previous,
    ...p,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(STATE_FILE, JSON.stringify(body, null, 2));
}

function resourceBonusSettings(cfg = loadConfig()) {
  const raw = cfg.resourceBonuses || {};
  return {
    enabled: raw.enabled ?? false,
    intervalHours: Math.max(0.25, Number(raw.intervalHours) || DEFAULT_INTERVAL_HOURS),
  };
}

function isResourceBonusDue(cfg = loadConfig(), state = readResourceBonusState()) {
  const settings = resourceBonusSettings(cfg);
  if (!settings.enabled) return false;
  if (!state?.nextRunAt) return true;

  const next = new Date(state.nextRunAt);
  if (Number.isNaN(next.getTime())) return true;
  return next.getTime() <= Date.now();
}

function nextResourceBonusRunLine() {
  const settings = resourceBonusSettings();
  if (!settings.enabled) return '  Resource bonus : OFF';

  const state = readResourceBonusState();
  if (!state?.nextRunAt) return '  Resource bonus : due now';

  const when = new Date(state.nextRunAt);
  if (Number.isNaN(when.getTime())) return '  Resource bonus : due now (invalid state)';
  if (when.getTime() <= Date.now()) return '  Resource bonus : due now / overdue';
  return `  Resource bonus : next ${when.toLocaleString()}`;
}

async function isShopWizardVisible(page) {
  return page.evaluate(sel => {
    const parts = sel.split(',').map(s => s.trim());
    for (const part of parts) {
      const el = document.querySelector(part);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      const st = getComputedStyle(el);
      if (r.width > 40 && r.height > 40 && st.display !== 'none' && st.visibility !== 'hidden') return true;
    }
    return false;
  }, WIZARD_SELECTOR).catch(() => false);
}

async function ensureShopWizardOpen(page, timeout = WIZARD_OPEN_TIMEOUT_MS) {
  if (await isShopWizardVisible(page)) {
    log.info(TAG, 'Shop wizard already open');
    return true;
  }

  await dismissBlockingDialogs(page, { tag: TAG, maxAttempts: 8 });

  if (await openTravianPaymentWizard(page, { tag: TAG })) {
    try {
      await page.waitForSelector(WIZARD_SELECTOR, { state: 'visible', timeout });
      return true;
    } catch {
      log.warn(TAG, 'Payment wizard API called but wizard not visible yet');
    }
  }

  await dismissBlockingDialogs(page, { tag: TAG, maxAttempts: 4, allowShopOverlay: true });

  const shop = page.locator(SHOP_BUTTON).first();
  try {
    await shop.click({ timeout: 6_000 });
  } catch (err) {
    log.warn(TAG, `Shop link click blocked (${err.message}) — using Travian API`);
    if (!(await openTravianPaymentWizard(page, { tag: TAG }))) {
      try {
        await shop.click({ force: true, timeout: 6_000 });
      } catch (err2) {
        log.warn(TAG, `Shop button still not reachable: ${err2.message}`);
        return false;
      }
    }
  }

  try {
    await page.waitForSelector(WIZARD_SELECTOR, { state: 'visible', timeout });
    return true;
  } catch {
    log.warn(TAG, `Shop wizard did not open within ${timeout}ms`);
    return false;
  }
}

async function openResourceBonusTab(page, options = {}) {
  const timeout = options.timeout ?? WIZARD_OPEN_TIMEOUT_MS;
  log.info(TAG, 'Opening shop wizard');

  if (!(await ensureGameShell(page, { tag: TAG, needShop: true }))) {
    log.warn(TAG, 'Game shell not ready — shop button unavailable');
    return false;
  }

  if (!(await ensureShopWizardOpen(page, timeout))) {
    return false;
  }
  await randomDelay();

  log.info(TAG, 'Selecting Advantages tab');
  const tabResult = await page.evaluate(({ tabSel, source }) => {
    const re = new RegExp(source, 'i');
    const isVisible = el => {
      if (!el) return false;
      const s = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
    };

    const tabs = Array.from(document.querySelectorAll(tabSel)).filter(isVisible);
    let target = tabs.find(t => re.test((t.innerText || t.textContent || '').trim()));
    if (!target) {
      target = document.querySelector(
        '[data-tabname="advantages"], [data-tabname="Advantages"], [data-tabname="pros"], [data-tabname="benefits"]'
      );
    }
    if (!target) {
      target = tabs.find(t => /advant|vorteil|vantag|benefit|bonus|vyhod|korzy/i.test((t.innerText || t.textContent || '').trim()));
    }
    if (!target) return { ok: false };
    target.click();
    return { ok: true };
  }, { tabSel: TAB_SELECTOR, source: ADVANTAGES_LABEL.source });

  if (!tabResult?.ok) {
    log.warn(TAG, 'Could not locate the Advantages tab inside the shop wizard');
    return false;
  }

  await page.waitForFunction(
    ({ boxSelectors }) => boxSelectors.some(sel => document.querySelector(`${sel}.lumberProductionBonus`)),
    { boxSelectors: BONUS_BOX_SELECTORS },
    { timeout: 8_000 }
  ).catch(() => {});

  await page.waitForFunction(({ tabSel, source }) => {
    const re = new RegExp(source, 'i');
    const tabs = Array.from(document.querySelectorAll(tabSel));
    return tabs.some(t => /\bactive\b/.test(t.className) && re.test((t.innerText || t.textContent || '').trim()));
  }, { tabSel: TAB_SELECTOR, source: ADVANTAGES_LABEL.source }, { timeout: 5_000 }).catch(() => {});

  await randomDelay();
  return true;
}

function cooldownTextToSeconds(text) {
  if (!text) return null;
  const m = String(text).match(/(\d+):(\d+):(\d+)/);
  if (!m) return null;
  return (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]);
}

/**
 * Inspect the current Advantages tab and return per-resource status.
 * Resolves to an object keyed by 'Wood'/'Clay'/'Iron'/'Crop':
 *
 *   {
 *     status: 'claimable' | 'active' | 'unavailable' | 'missing',
 *     claimable: boolean,
 *     cooldownText: '00:34:04' | null,
 *     cooldownSeconds: 2044 | null,
 *     bonusActive: boolean,
 *   }
 */
async function pollResourceBonuses(page) {
  const raw = await page.evaluate(RESOURCE_POLL_EVAL, {
    wizardParts: WIZARD_PARTS,
    boxSelectors: BONUS_BOX_SELECTORS,
    resourceToBonusClass: RESOURCE_BONUS_CLASS,
  });

  for (const r of Object.keys(raw)) {
    raw[r].cooldownSeconds = cooldownTextToSeconds(raw[r].cooldownText);
  }

  const claimable = Object.entries(raw).filter(([, v]) => v.claimable).map(([k]) => k);
  const summary = Object.entries(raw).map(([k, v]) => `${k}:${v.status}`).join(', ');
  log.info(TAG, `Resource poll — ${summary}${claimable.length ? ` (claimable: ${claimable.join(', ')})` : ''}`);

  return raw;
}

/**
 * Thin wrapper kept for the batch claim path: just the list of resources that
 * are currently offering a video bonus.
 */
async function listAvailableResourceVideos(page) {
  const poll = await pollResourceBonuses(page);
  return Object.entries(poll).filter(([, v]) => v.claimable).map(([k]) => k);
}

/**
 * Return the video button for a specific resource on the Advantages tab,
 * or null if it isn't currently claimable.
 */
async function findResourceVideoButton(page, resource) {
  const bonusClass = RESOURCE_BONUS_CLASS[resource];
  if (!bonusClass) return null;

  const handle = await page.evaluateHandle(
    ({ wizardParts, boxSelectors, resourceToBonusClass, targetResource }) => {
      const isVisible = element => {
        if (!element) return false;
        const s = getComputedStyle(element);
        const b = element.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
      };
      const isClickable = element => {
        if (!isVisible(element)) return false;
        if (element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
        if (element.classList.contains('disabled')) return false;
        const s = getComputedStyle(element);
        return s.pointerEvents !== 'none' && Number(s.opacity) > 0.05;
      };

      const findVisibleWizard = () => {
        for (const sel of wizardParts) {
          for (const el of document.querySelectorAll(sel)) {
            const b = el.getBoundingClientRect();
            if (isVisible(el) && b.width > 80 && b.height > 80) return el;
          }
        }
        for (const boxSel of boxSelectors) {
          const box = document.querySelector(`${boxSel}.lumberProductionBonus`);
          if (!box) continue;
          const w = box.closest('.dialog, [class*="paymentShop"], [class*="paymentWizard"], #reactDialogWrapper');
          if (w && isVisible(w)) return w;
        }
        return document.body;
      };

      const bonusCls = resourceToBonusClass[targetResource];
      const root = findVisibleWizard();
      let box = null;
      for (const boxSel of boxSelectors) {
        box = root.querySelector(`${boxSel}.${bonusCls}`);
        if (box) break;
        for (const el of root.querySelectorAll(boxSel)) {
          if (el.classList.contains(bonusCls)) {
            box = el;
            break;
          }
        }
        if (box) break;
      }
      if (!box) {
        const global = document.querySelector(`${boxSelectors[0]}.${bonusCls}`);
        if (global && isVisible(global)) box = global;
      }
      if (!box) return null;

      const video = box.querySelector('.bonusVideo, [class*="bonusVideo"]');
      if (!video) return null;
      const controls = [
        ...video.querySelectorAll('button'),
        ...video.querySelectorAll('a'),
        ...video.querySelectorAll('[role="button"]'),
      ];
      for (const el of controls) {
        if (isClickable(el)) return el;
      }
      if (video.querySelector('.videoIcon, i[class*="videoIcon"]') && isClickable(video)) return video;
      return null;
    },
    {
      wizardParts: WIZARD_PARTS,
      boxSelectors: BONUS_BOX_SELECTORS,
      resourceToBonusClass: RESOURCE_BONUS_CLASS,
      targetResource: resource,
    }
  );

  const button = handle.asElement();
  if (!button) await handle.dispose();
  return button;
}

async function clickResourceVideoButton(page, button, resource) {
  try {
    await button.scrollIntoViewIfNeeded().catch(() => {});
    await button.click({ force: true, timeout: 10_000 });
  } catch (err) {
    log.warn(TAG, `${resource} video button click failed: ${err.message}`);
    return false;
  } finally {
    await button.dispose().catch(() => {});
  }
  await pause(700);
  return true;
}

async function closeResourceBonusTab(page) {
  const { dismissBlockingDialogs } = require('./utils');
  await page.keyboard.press('Escape').catch(() => {});
  await dismissBlockingDialogs(page, { tag: 'resources' });
}

function markResourceBonusRun(claimedCount, intervalHours, extras = {}) {
  const now = new Date();
  const nextMs = claimedCount > 0
    ? intervalHours * 60 * 60 * 1000
    : RETRY_AFTER_EMPTY_MS;

  writeResourceBonusState({
    lastAttemptAt: now.toISOString(),
    lastClaimAt: claimedCount > 0 ? now.toISOString() : readResourceBonusState()?.lastClaimAt ?? null,
    lastClaimedCount: claimedCount,
    nextRunAt: new Date(now.getTime() + nextMs).toISOString(),
    intervalHours,
    ...extras,
  });
}

function markSingleResourceClaim(resource) {
  const prev = readResourceBonusState() || {};
  const perResource = { ...(prev.perResource || {}) };
  perResource[resource] = { lastClaimAt: new Date().toISOString() };
  writeResourceBonusState({ perResource });
}

async function claimResourceBonuses(page, options = {}) {
  const force = options.force ?? false;
  const cfg = loadConfig();
  const settings = resourceBonusSettings(cfg);

  if (!force && !settings.enabled) {
    log.info(TAG, 'Resource video bonuses disabled - skipping');
    return { skipped: true, claimedCount: 0 };
  }

  if (!force && !isResourceBonusDue(cfg)) {
    const state = readResourceBonusState();
    log.info(TAG, `Resource video bonuses not due yet - next ${new Date(state.nextRunAt).toLocaleString()}`);
    return { skipped: true, claimedCount: 0 };
  }

  let claimedCount = 0;
  const claimed = [];
  const failed = [];
  let available = [];
  let interrupted = false;
  log.info(TAG, 'Starting 15% resource bonus routine');

  try {
    const tabOpen = await openResourceBonusTab(page);
    if (!tabOpen) {
      return { ok: false, skipped: false, claimedCount: 0, available: [], claimed, failed, message: 'Shop unreachable' };
    }

    available = await listAvailableResourceVideos(page);
    if (available.length === 0) {
      await pause(1200);
      available = await listAvailableResourceVideos(page);
    }
    log.info(TAG, `Available resource videos: ${available.length ? available.join(', ') : 'none'}`);

    for (let i = 0; i < available.length; i++) {
      const resource = available[i];
      if (i > 0) {
        const tabStillOpen = await page
          .locator(TAB_SELECTOR)
          .filter({ hasText: ADVANTAGES_LABEL })
          .first()
          .isVisible()
          .catch(() => false);
        if (!tabStillOpen) {
          const reopened = await openResourceBonusTab(page);
          if (!reopened) {
            log.warn(TAG, 'Shop closed after video - stopping batch');
            failed.push(resource);
            break;
          }
        }
      }

      const button = await findResourceVideoButton(page, resource);
      if (!button) {
        log.warn(TAG, `${resource} button disappeared between poll and claim - skipping`);
        failed.push(resource);
        continue;
      }

      log.info(TAG, `Claiming ${resource} video bonus`);
      if (!(await clickResourceVideoButton(page, button, resource))) {
        failed.push(resource);
        continue;
      }
      const videoFinished = await waitForVideoToFinish(page);
      if (videoFinished) {
        log.info(TAG, `${resource} bonus video watched successfully`);
        claimedCount++;
        claimed.push(resource);
        setLastCompletedBonus(`${resource} bonus completed`);
        incrementResourceBonus(resource);
        markSingleResourceClaim(resource);
      } else {
        log.warn(TAG, `${resource} bonus video failed or timed out`);
        failed.push(resource);
      }
      await randomDelay();
    }

    if (claimedCount === 0) {
      log.info(TAG, 'No available resource video bonuses found');
    } else {
      log.info(TAG, `Resource bonus routine complete - watched ${claimedCount} video(s)`);
    }
  } catch (err) {
    if (isTaskInterrupted(err)) {
      interrupted = true;
      throw err;
    }
    log.warn(TAG, `Resource bonus routine failed: ${err.message}`);
  } finally {
    if (!interrupted) markResourceBonusRun(claimedCount, settings.intervalHours);
    await closeResourceBonusTab(page);
  }

  return {
    ok: true,
    skipped: false,
    claimedCount,
    available,
    claimed,
    failed,
    message:
      claimedCount > 0
        ? `Claimed ${claimed.join(', ')}`
        : failed.length
          ? `Failed: ${failed.join(', ')}`
          : 'No claimable resource videos',
  };
}

/**
 * Claim a single resource bonus on demand (e.g. from the GUI).
 * Opens the shop/Advantages tab with a short, fail-fast timeout, then looks
 * for the button belonging to the requested resource.
 *
 * @param {import('playwright').Page} page
 * @param {'Wood'|'Clay'|'Iron'|'Crop'} resource
 * @returns {Promise<{ok: boolean, status: 'claimed'|'unavailable'|'failed', message: string}>}
 */
async function claimResourceBonus(page, resource) {
  if (!RESOURCES.includes(resource)) {
    return { ok: false, status: 'failed', message: `Unknown resource: ${resource}` };
  }

  log.info(TAG, `Single-bonus request: ${resource}`);
  let opened = false;
  try {
    opened = await openResourceBonusTab(page);
    if (!opened) {
      return { ok: false, status: 'unavailable', message: `${resource} bonus not reachable (Advantages tab missing)` };
    }

    const button = await findResourceVideoButton(page, resource);
    if (!button) {
      log.info(TAG, `${resource} video button not visible right now`);
      return { ok: false, status: 'unavailable', message: `${resource} bonus not available right now` };
    }

    log.info(TAG, `Claiming ${resource} video bonus`);
    if (!(await clickResourceVideoButton(page, button, resource))) {
      return { ok: false, status: 'failed', message: `${resource} video button could not be clicked` };
    }

    const videoFinished = await waitForVideoToFinish(page);
    if (!videoFinished) {
      log.warn(TAG, `${resource} bonus video failed or timed out`);
      return { ok: false, status: 'failed', message: `${resource} video failed or timed out` };
    }

    log.info(TAG, `${resource} bonus video watched successfully`);
    setLastCompletedBonus(`${resource} bonus completed`);
    incrementResourceBonus(resource);
    markSingleResourceClaim(resource);
    return { ok: true, status: 'claimed', message: `${resource} bonus claimed` };
  } catch (err) {
    if (isTaskInterrupted(err)) throw err;
    log.warn(TAG, `${resource} bonus routine failed: ${err.message}`);
    return { ok: false, status: 'failed', message: err.message };
  } finally {
    if (opened) await closeResourceBonusTab(page);
  }
}

/**
 * High-level helper used by the GUI: open the wizard, switch to Advantages,
 * snapshot per-resource status, then close. No bonus is claimed.
 */
async function pollResourceBonusesViaWizard(page) {
  const opened = await openResourceBonusTab(page);
  if (!opened) {
    return { ok: false, opened: false, statuses: null };
  }
  try {
    const statuses = await pollResourceBonuses(page);
    return { ok: true, opened: true, statuses };
  } finally {
    await closeResourceBonusTab(page);
  }
}

module.exports = {
  claimResourceBonuses,
  claimResourceBonus,
  cooldownTextToSeconds,
  pollResourceBonusesViaWizard,
  isResourceBonusDue,
  nextResourceBonusRunLine,
  readResourceBonusState,
  resourceBonusSettings,
  RESOURCES,
  STATE_FILE,
  // Exposed for the GUI's /api/debug/advantages dry-run endpoint.
  __testInternals: {
    openResourceBonusTab,
    closeResourceBonusTab,
    listAvailableResourceVideos,
    pollResourceBonuses,
  },
};
