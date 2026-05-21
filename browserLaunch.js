'use strict';

const { chromium } = require('playwright');
const { loadConfig } = require('./auth');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Default headless unless config explicitly sets headless: false */
function headlessEnabled(cfg = loadConfig()) {
  return cfg.headless !== false;
}

/**
 * Launch Chromium/Chrome with settings that work better for Travian video ads
 * in headless mode (new headless, reduced automation signals).
 */
async function launchBrowser(options = {}) {
  const cfg = loadConfig();
  const headless = options.headless ?? headlessEnabled(cfg);
  const args = ['--disable-blink-features=AutomationControlled'];
  if (headless) args.push('--headless=new');

  const launchOpts = {
    headless,
    args,
    ignoreDefaultArgs: ['--enable-automation'],
  };

  if (cfg.browserChannel !== false) {
    try {
      return await chromium.launch({ ...launchOpts, channel: 'chrome' });
    } catch {
      /* bundled Chromium */
    }
  }
  return chromium.launch(launchOpts);
}

async function newGameContext(browser) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    userAgent: USER_AGENT,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => false });
  });
  return context;
}

/** Launch browser + isolated context + page (CLI one-shot jobs). */
async function launchWithPage(options = {}) {
  const browser = await launchBrowser(options);
  const context = await newGameContext(browser);
  const page = await context.newPage();
  return { browser, context, page };
}

module.exports = { launchBrowser, newGameContext, launchWithPage, headlessEnabled };
