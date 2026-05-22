'use strict';

const { chromium } = require('playwright');
const log = require('./logger');
const { loadConfig } = require('./auth');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/** Default headless unless config explicitly sets headless: false */
function headlessEnabled(cfg = loadConfig()) {
  return cfg.headless !== false;
}

/**
 * Normalise config.proxy (object or legacy string) into a single shape.
 * @param {object} cfg
 */
function proxySettings(cfg = loadConfig()) {
  const raw = cfg?.proxy;
  if (typeof raw === 'string' && raw.trim()) {
    return { enabled: true, server: raw.trim(), username: '', password: '', bypass: '' };
  }
  const p = raw && typeof raw === 'object' ? raw : {};
  return {
    enabled: p.enabled === true,
    server: String(p.server || '').trim(),
    username: String(p.username || '').trim(),
    password: p.password != null ? String(p.password) : '',
    bypass: String(p.bypass || '').trim(),
  };
}

/**
 * Playwright proxy options for browser.newContext(), or undefined when disabled.
 * @see https://playwright.dev/docs/network#http-proxy
 */
function buildPlaywrightProxy(cfg = loadConfig()) {
  const p = proxySettings(cfg);
  if (!p.enabled) return undefined;
  if (!p.server) {
    log.warn('browser', 'proxy.enabled is true but proxy.server is empty — not using a proxy');
    return undefined;
  }
  if (!/^https?:\/\/|^socks5:\/\//i.test(p.server)) {
    log.warn(
      'browser',
      `proxy.server must start with http://, https://, or socks5:// (got "${p.server}")`
    );
    return undefined;
  }

  const proxy = { server: p.server };
  if (p.username) proxy.username = p.username;
  if (p.password) proxy.password = p.password;
  if (p.bypass) proxy.bypass = p.bypass;
  return proxy;
}

/** Safe one-line label for logs (no password). */
function proxyLogLabel(cfg = loadConfig()) {
  const p = proxySettings(cfg);
  if (!p.enabled || !p.server) return 'off';
  if (p.username) return `${p.server} (auth)`;
  return p.server;
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

async function newGameContext(browser, cfg = loadConfig()) {
  const contextOpts = {
    viewport: { width: 1280, height: 900 },
    userAgent: USER_AGENT,
    locale: 'en-US',
    extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
  };

  const proxy = buildPlaywrightProxy(cfg);
  if (proxy) {
    contextOpts.proxy = proxy;
    log.info('browser', `Proxy enabled: ${proxyLogLabel(cfg)}`);
  }

  const context = await browser.newContext(contextOpts);
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

module.exports = {
  launchBrowser,
  newGameContext,
  launchWithPage,
  headlessEnabled,
  proxySettings,
  buildPlaywrightProxy,
  proxyLogLabel,
};
