'use strict';

const log = require('./logger');
const { getActiveControl } = require('./terminalControl');

function randomDelay() {
  const { loadConfig } = require('./auth');
  const cfg = loadConfig();
  const min = cfg.delay?.min ?? 500;
  const max = cfg.delay?.max ?? 1500;
  const ms  = Math.floor(Math.random() * (max - min + 1)) + min;
  const delay = new Promise(resolve => setTimeout(resolve, ms));
  const control = getActiveControl();
  return control ? control.race(delay) : delay;
}

function pause(ms) {
  const delay = new Promise(resolve => setTimeout(resolve, ms));
  const control = getActiveControl();
  return control ? control.race(delay) : delay;
}

/** True when Travian’s modal overlay is visible and intercepts clicks. */
async function isDialogBlocking(page) {
  return page.evaluate(() => {
    const overlay = document.querySelector('#dialogOverlay.dialogVisible, #dialogOverlay.enabled');
    if (!overlay) return false;
    const style = window.getComputedStyle(overlay);
    return style.display !== 'none' && style.visibility !== 'hidden' && parseFloat(style.opacity || '1') > 0.05;
  }).catch(() => false);
}

/**
 * Close Travian React dialogs (shop, videos, prompts) that block layout nav clicks.
 * @returns {Promise<boolean>} true when no blocking overlay remains
 */
async function dismissBlockingDialogs(page, options = {}) {
  const maxAttempts = options.maxAttempts ?? 8;
  const tag = options.tag || 'ui';
  /** When true, a visible shop/payment wizard counts as OK (overlay is expected). */
  const allowShopOverlay = options.allowShopOverlay === true;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const state = await page.evaluate(() => {
      const vis = el => {
        if (!el) return false;
        const r = el.getBoundingClientRect();
        const st = getComputedStyle(el);
        return r.width > 8 && r.height > 8 && st.display !== 'none' && st.visibility !== 'hidden';
      };
      const overlay = document.querySelector('#dialogOverlay.dialogVisible, #dialogOverlay.enabled');
      const overlayOn = overlay && vis(overlay);
      const shopWizard = document.querySelector(
        '.dialog.paymentShopV6, .paymentShopV6, .dialog.paymentShopV5, .paymentShopV5, .dialog.paymentWizardV3, .paymentWizardV3, .dialog.paymentWizardV2, .paymentWizardV2'
      );
      return {
        overlayOn,
        shopOpen: !!(shopWizard && vis(shopWizard)),
      };
    }).catch(() => ({ overlayOn: false, shopOpen: false }));

    if (!state.overlayOn) return true;
    if (allowShopOverlay && state.shopOpen) return true;

    const clicked = await page.evaluate(() => {
      const root = document.querySelector('#reactDialogWrapper') || document.body;
      const tryClick = el => {
        if (!el || el.disabled) return false;
        const r = el.getBoundingClientRect();
        if (r.width < 1 || r.height < 1) return false;
        el.click();
        return true;
      };

      const selectors = [
        'button.dialogButtonCancel',
        'button.dialogClose',
        '.dialogClose',
        '.closeButton',
        'button.iconClose',
        '.iconClose',
        '.iconButton.close',
        '.dialogTitle .close',
        '[class*="closeIcon"]',
        '[aria-label="Close"]',
        '[aria-label="close"]',
        '[data-testid="close"]',
        '.svgIcon.close',
      ];
      for (const sel of selectors) {
        const nodes = root.querySelectorAll(sel);
        for (const el of nodes) {
          if (tryClick(el)) return sel;
        }
      }

      const buttons = Array.from(root.querySelectorAll('button, a.button, [role="button"]'));
      for (const btn of buttons) {
        const t = (btn.innerText || btn.getAttribute('aria-label') || '').trim().toLowerCase();
        if (
          t === 'close' || t === 'cancel' || t === '×' || t === 'x'
          || t === 'schließen' || t === 'abbrechen' || t === 'fermer'
        ) {
          if (tryClick(btn)) return `text:${t}`;
        }
      }
      return null;
    }).catch(() => null);

    if (clicked) {
      log.info(tag, `Dismissed dialog via ${clicked}`);
      await pause(450);
      continue;
    }

    await page.keyboard.press('Escape').catch(() => {});
    await pause(200);
    await page.keyboard.press('Escape').catch(() => {});
    await pause(350);
  }

  const still = await isDialogBlocking(page);
  if (still && !(allowShopOverlay && await page.evaluate(() => {
    const w = document.querySelector(
      '.dialog.paymentShopV6, .paymentShopV6, .dialog.paymentShopV5, .paymentShopV5, .dialog.paymentWizardV2'
    );
    if (!w) return false;
    const r = w.getBoundingClientRect();
    return r.width > 50;
  }).catch(() => false))) {
    log.warn(tag, 'Dialog overlay still visible after dismiss attempts');
  }
  return !still;
}

/**
 * Open Travian shop/payment wizard without a pointer click (works when #dialogOverlay blocks the shop link).
 * @returns {Promise<boolean>}
 */
async function openTravianPaymentWizard(page, options = {}) {
  const tag = options.tag || 'ui';
  const via = await page.evaluate(() => {
    try {
      if (typeof Travian !== 'undefined' && Travian.React && typeof Travian.React.openPaymentWizard === 'function') {
        Travian.React.openPaymentWizard({});
        return 'Travian.React.openPaymentWizard';
      }
    } catch {
      /* fall through */
    }
    const shop = document.querySelector('a.shop');
    if (!shop) return null;
    if (typeof shop.onclick === 'function') {
      shop.onclick.call(shop, {
        preventDefault() {},
        stopPropagation() {},
        type: 'click',
      });
      return 'a.shop onclick';
    }
    shop.click();
    return 'a.shop click';
  }).catch(() => null);

  if (via) {
    log.info(tag, `Opened payment wizard via ${via}`);
    await pause(600);
    return true;
  }
  log.warn(tag, 'Could not invoke Travian payment wizard');
  return false;
}

const SHOP_NAV_SELECTOR = 'a.shop, a.layoutButton.shop, a.layoutButton.buttonFramed.shop';
const GAME_SHELL_SELECTOR = 'a.layoutButton.adventure, a.shop, a.layoutButton.shop, #topBarHero, #navigation';

/**
 * Return to the main Travian shell (village top bar with shop / hero nav).
 * Required after /hero/* SPA routes before clicking layout buttons like a.shop.
 */
async function ensureGameShell(page, options = {}) {
  const tag = options.tag || 'ui';
  const needShop = options.needShop === true;
  await dismissBlockingDialogs(page, { tag });

  async function shellReady() {
    return page.evaluate(({ shopSel, shellSel, needShop: shopRequired }) => {
      if (shopRequired) return !!document.querySelector(shopSel);
      return !!(document.querySelector(shopSel) || document.querySelector(shellSel));
    }, { shopSel: SHOP_NAV_SELECTOR, shellSel: GAME_SHELL_SELECTOR, needShop }).catch(() => false);
  }

  if (await shellReady()) return true;

  const { loadConfig } = require('./auth');
  const base = (loadConfig().url || '').replace(/\/+$/, '');
  if (!base) {
    log.warn(tag, 'No config.url — cannot navigate to game shell');
    return false;
  }

  const urls = [`${base}/dorf1.php`, `${base}/`, base];
  for (const url of urls) {
    try {
      log.info(tag, `Navigating to game shell (${url})`);
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await dismissBlockingDialogs(page, { tag });
      await page.waitForFunction(({ shopSel, shellSel, needShop }) => {
        if (needShop) return !!document.querySelector(shopSel);
        return !!(document.querySelector(shopSel) || document.querySelector(shellSel));
      }, { shopSel: SHOP_NAV_SELECTOR, shellSel: GAME_SHELL_SELECTOR, needShop }, { timeout: 12_000 });
      return true;
    } catch (err) {
      log.warn(tag, `Game shell not ready at ${url}: ${err.message}`);
    }
  }
  return false;
}

module.exports = {
  randomDelay,
  pause,
  isDialogBlocking,
  dismissBlockingDialogs,
  openTravianPaymentWizard,
  ensureGameShell,
  SHOP_NAV_SELECTOR,
  GAME_SHELL_SELECTOR,
};
