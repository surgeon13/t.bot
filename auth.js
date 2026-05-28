'use strict';

const fs   = require('fs');
const path = require('path');
const log  = require('./logger');
const { randomDelay } = require('./utils');

const {
  CONFIG_PATH,
  CONFIG_EXAMPLE_PATH,
  DEBUG_DIR,
} = require('./paths');

const DEFAULT_CONFIG = {
  url: 'https://YOUR_SERVER.travian.com/',
  username: 'your@email.com',
  password: 'your_password',
  delay: { min: 500, max: 1500 },
  autoMode: false,
  headless: true,
  browserChannel: true,
  schedule: { enabled: false, intervalHours: 3 },
  resourceBonuses: { enabled: false, intervalHours: 8 },
  farmList: {
    enabled: false,
    lists: [],
    intervalMinutesMin: 5,
    intervalMinutesMax: 15,
  },
  proxy: { enabled: false, server: '', servers: [], rotation: 'round-robin', username: '', password: '', bypass: '' },
};
const LOGIN_FORM_SELECTOR = 'input[name="name"], input[name="password"]';
const LOGIN_SUBMIT_SELECTOR = 'button.textButtonV2[type="submit"], button[type="submit"]';
const LOGGED_IN_SELECTOR = 'a.layoutButton.adventure';

const USERNAME_FIELD = 'input[name="name"]';
const PASSWORD_FIELD = 'input[name="password"]';

// Common GDPR / cookie banners that can intercept clicks on Travian's login.
const COOKIE_ACCEPT_SELECTORS = [
  '#cmpwelcomebtnyes',
  '#cmpbntyestxt',
  'button#onetrust-accept-btn-handler',
  'button.iubenda-cs-accept-btn',
  'button:has-text("Accept all")',
  'button:has-text("I agree")',
  'button:has-text("Accept")',
  '.cmpboxbtnyes',
];

function isLoggedInUrl(value) {
  const url = typeof value === 'string' ? value : value.href;
  return /dorf\d/.test(url) || url.includes('village');
}

async function hasLoggedInShell(page) {
  if (isLoggedInUrl(page.url())) return true;
  const nav = await page.$(LOGGED_IN_SELECTOR);
  if (!nav) return false;
  return nav.isVisible().catch(() => false);
}

async function waitForLoginPageReady(page) {
  await Promise.any([
    page.waitForSelector(LOGIN_FORM_SELECTOR, { state: 'visible', timeout: 30_000 }),
    page.waitForSelector(LOGGED_IN_SELECTOR, { state: 'visible', timeout: 30_000 }),
  ]).catch(() => {});
}

async function waitForLoggedIn(page) {
  await Promise.any([
    page.waitForURL(isLoggedInUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 }),
    page.waitForSelector(LOGGED_IN_SELECTOR, { state: 'visible', timeout: 30_000 }),
  ]).catch(() => {});
}

function readDefaultConfigTemplate() {
  if (fs.existsSync(CONFIG_EXAMPLE_PATH)) {
    try {
      return JSON.parse(fs.readFileSync(CONFIG_EXAMPLE_PATH, 'utf8'));
    } catch (err) {
      log.warn('config', `Could not read config.example.json: ${err.message} — using built-in defaults`);
    }
  }
  return { ...DEFAULT_CONFIG };
}

/** Create config.json from example/defaults when missing. Returns true if a new file was written. */
function ensureConfigFile() {
  if (fs.existsSync(CONFIG_PATH)) return false;

  const template = readDefaultConfigTemplate();
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(template, null, 2) + '\n');

  const source = fs.existsSync(CONFIG_EXAMPLE_PATH) ? 'config.example.json' : 'built-in defaults';
  log.info('config', `Created config.json from ${source} — edit url, username, and password before logging in`);
  return true;
}

function loadConfig() {
  ensureConfigFile();
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (err) {
    log.error('config', `Invalid config.json: ${err.message}`);
    throw err;
  }
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
  log.info('config', 'Settings saved');
}

async function dismissCookieBanner(page) {
  for (const sel of COOKIE_ACCEPT_SELECTORS) {
    try {
      const el = await page.$(sel);
      if (el && await el.isVisible().catch(() => false)) {
        log.info('auth', `Dismissing cookie banner via ${sel}`);
        await el.click({ timeout: 3_000 }).catch(() => {});
        await randomDelay();
        return true;
      }
    } catch {
      // continue
    }
  }
  return false;
}

async function dumpLoginDebug(page, label) {
  try {
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const pngPath  = path.join(DEBUG_DIR, `login-${label}-${stamp}.png`);
    const htmlPath = path.join(DEBUG_DIR, `login-${label}-${stamp}.html`);
    await page.screenshot({ path: pngPath, fullPage: true }).catch(() => {});
    const html = await page.content().catch(() => '');
    if (html) fs.writeFileSync(htmlPath, html);
    log.warn('auth', `Saved login debug snapshot: ${pngPath}`);
  } catch (err) {
    log.warn('auth', `Could not write debug snapshot: ${err.message}`);
  }
}

async function describePage(page) {
  const url = page.url();
  const title = await page.title().catch(() => '');
  const hasUser = !!(await page.$(USERNAME_FIELD));
  const hasPass = !!(await page.$(PASSWORD_FIELD));
  const hasLoggedIn = !!(await page.$(LOGGED_IN_SELECTOR));
  return { url, title, hasUser, hasPass, hasLoggedIn };
}

/** Short user-facing hint for Playwright navigation / proxy errors. */
function networkErrorHint(err) {
  const msg = String(err?.message || err || 'Unknown error');
  if (/ERR_TUNNEL_CONNECTION_FAILED/i.test(msg)) {
    return 'Proxy tunnel failed — check proxy host, port, and credentials, or try another proxy in the pool (Re-login rotates round-robin).';
  }
  if (/ERR_PROXY_CONNECTION_FAILED/i.test(msg)) {
    return 'Proxy connection failed — proxy unreachable or misconfigured.';
  }
  if (/ERR_CONNECTION_REFUSED|ERR_CONNECTION_RESET|ERR_CONNECTION_TIMED_OUT/i.test(msg)) {
    return 'Connection failed — server or proxy refused the connection.';
  }
  if (/ERR_NAME_NOT_RESOLVED/i.test(msg)) {
    return 'DNS failed — check the Travian URL and proxy settings.';
  }
  return msg.split('\n')[0].slice(0, 200);
}

async function login(page) {
  const cfg = loadConfig();
  log.info('auth', `Navigating to ${cfg.url}`);
  try {
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  } catch (err) {
    const hint = networkErrorHint(err);
    log.error('auth', `Navigation failed: ${hint}`);
    login.lastError = hint;
    return false;
  }
  await waitForLoginPageReady(page);
  await randomDelay();

  if (await hasLoggedInShell(page)) {
    log.info('auth', 'Already logged in - reusing session');
    return true;
  }

  await dismissCookieBanner(page);

  const before = await describePage(page);
  log.info('auth', `At ${before.url} ("${before.title}") — user:${before.hasUser} pass:${before.hasPass}`);

  // Wait explicitly for both fields. Travian occasionally renders the form
  // in a second pass after some JS runs; the OR-style wait above can resolve
  // before the password field is present.
  try {
    await page.waitForSelector(USERNAME_FIELD, { state: 'visible', timeout: 15_000 });
  } catch {
    log.warn('auth', 'Username field never became visible');
    await dumpLoginDebug(page, 'no-username');
    return false;
  }
  try {
    await page.waitForSelector(PASSWORD_FIELD, { state: 'visible', timeout: 15_000 });
  } catch {
    log.warn('auth', 'Password field never became visible');
    await dumpLoginDebug(page, 'no-password');
    return false;
  }

  await page.fill(USERNAME_FIELD, cfg.username);
  await randomDelay();
  await page.fill(PASSWORD_FIELD, cfg.password);
  await randomDelay();

  const loginWait = waitForLoggedIn(page);
  try {
    await page.click(LOGIN_SUBMIT_SELECTOR, { timeout: 10_000 });
  } catch (err) {
    log.warn('auth', `Submit button not clickable: ${err.message}`);
    await page.press(PASSWORD_FIELD, 'Enter').catch(() => {});
  }
  await loginWait;
  await randomDelay();

  const ok = isLoggedInUrl(page.url()) || await hasLoggedInShell(page);
  if (!ok) {
    const after = await describePage(page);
    log.warn('auth', `Login did not land on game shell. Now at ${after.url} ("${after.title}")`);
    await dumpLoginDebug(page, 'no-shell');
    login.lastError = 'Login form submitted but game shell did not load';
  } else {
    login.lastError = null;
  }
  return ok;
}

module.exports = {
  loadConfig,
  saveConfig,
  login,
  networkErrorHint,
  ensureConfigFile,
  CONFIG_PATH,
  hasLoggedInShell,
  isLoggedInUrl,
  LOGGED_IN_SELECTOR,
};
