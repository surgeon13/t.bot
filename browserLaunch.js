'use strict';

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const log = require('./logger');
const { loadConfig } = require('./auth');

const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

const { PROXY_ROTATION_STATE_FILE: PROXY_ROTATION_FILE } = require('./paths');

/** Active proxy for the current browser context (set in newGameContext). */
let sessionProxyPick = null;

/** Default headless unless config explicitly sets headless: false */
function headlessEnabled(cfg = loadConfig()) {
  return cfg.headless !== false;
}

/**
 * Ensure proxy.server has a scheme Playwright accepts (defaults to http://).
 * @param {string} server
 * @returns {string}
 */
function normalizeProxyServer(server) {
  const s = String(server || '').trim();
  if (!s) return '';
  if (/^(https?|socks5):\/\//i.test(s)) return s;
  return `http://${s}`;
}

/**
 * Parse one or many proxy URLs from config fields.
 * @param {string} [server]
 * @param {string[]} [servers]
 */
function parseProxyServerList(server, servers) {
  if (Array.isArray(servers) && servers.length) {
    return [...new Set(servers.map(normalizeProxyServer).filter(Boolean))];
  }
  const s = String(server || '').trim();
  if (!s) return [];
  return [...new Set(
    s.split(/[\n,;]+/).map(part => normalizeProxyServer(part.trim())).filter(Boolean)
  )];
}

function rawProxyBlock(cfg = loadConfig()) {
  const raw = cfg?.proxy;
  if (typeof raw === 'string' && raw.trim()) {
    return { enabled: true, server: raw.trim(), servers: [], username: '', password: '', bypass: '', rotation: 'round-robin' };
  }
  return raw && typeof raw === 'object' ? raw : {};
}

function proxyServersFromConfig(cfg = loadConfig()) {
  const p = rawProxyBlock(cfg);
  return parseProxyServerList(p.server, p.servers);
}

function readRotationIndex() {
  try {
    if (!fs.existsSync(PROXY_ROTATION_FILE)) return 0;
    const data = JSON.parse(fs.readFileSync(PROXY_ROTATION_FILE, 'utf8'));
    const n = Number(data.index);
    return Number.isFinite(n) && n >= 0 ? n : 0;
  } catch {
    return 0;
  }
}

function writeRotationIndex(index) {
  try {
    fs.writeFileSync(PROXY_ROTATION_FILE, JSON.stringify({
      index,
      updatedAt: new Date().toISOString(),
    }, null, 2));
  } catch (err) {
    log.warn('browser', `Could not save proxy rotation state: ${err.message}`);
  }
}

function clearSessionProxy() {
  sessionProxyPick = null;
}

/**
 * Pick which proxy URL to use for the next browser context (round-robin / random / sticky).
 */
function selectProxyForSession(cfg = loadConfig()) {
  clearSessionProxy();
  const p = rawProxyBlock(cfg);
  if (!p.enabled) return null;

  const servers = proxyServersFromConfig(cfg);
  if (!servers.length) {
    log.warn('browser', 'proxy.enabled is true but no proxy servers are configured');
    return null;
  }

  const mode = String(p.rotation || 'round-robin').toLowerCase();
  let idx = 0;
  if (servers.length > 1) {
    if (mode === 'random') {
      idx = Math.floor(Math.random() * servers.length);
    } else if (mode === 'round-robin') {
      idx = readRotationIndex() % servers.length;
      writeRotationIndex((idx + 1) % servers.length);
    }
    // sticky / unknown → index 0
  }

  sessionProxyPick = {
    enabled: true,
    server: servers[idx],
    servers,
    serverIndex: idx,
    serverCount: servers.length,
    rotation: mode,
    username: String(p.username || '').trim(),
    password: p.password != null ? String(p.password) : '',
    bypass: String(p.bypass || '').trim(),
  };

  if (servers.length > 1) {
    log.info('browser', `Proxy ${idx + 1}/${servers.length}: ${sessionProxyPick.server} (${mode})`);
  }
  return sessionProxyPick;
}

/**
 * Normalise config.proxy (object or legacy string) into a single shape.
 * @param {object} cfg
 */
function proxySettings(cfg = loadConfig()) {
  const p = rawProxyBlock(cfg);
  const servers = proxyServersFromConfig(cfg);

  if (sessionProxyPick) {
    return { ...sessionProxyPick };
  }

  return {
    enabled: p.enabled === true && servers.length > 0,
    server: servers[0] || normalizeProxyServer(p.server),
    servers,
    serverIndex: 0,
    serverCount: servers.length,
    rotation: String(p.rotation || 'round-robin').toLowerCase(),
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
  const p = sessionProxyPick || proxySettings(cfg);
  if (!p.enabled) return undefined;
  if (!p.server) {
    log.warn('browser', 'proxy.enabled is true but proxy.server is empty — not using a proxy');
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
  const auth = p.username ? ' (auth)' : '';
  if (p.serverCount > 1) {
    return `${p.server}${auth} [${p.serverIndex + 1}/${p.serverCount}]`;
  }
  return `${p.server}${auth}`;
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
  selectProxyForSession(cfg);

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
  normalizeProxyServer,
  parseProxyServerList,
  proxyServersFromConfig,
  selectProxyForSession,
  clearSessionProxy,
  proxySettings,
  buildPlaywrightProxy,
  proxyLogLabel,
};
