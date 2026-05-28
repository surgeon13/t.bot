'use strict';

const { proxySettings, proxyLogLabel } = require('./browserLaunch');
const { networkErrorHint } = require('./auth');

const LOGGED_IN_HINT = 'a.layoutButton.adventure, input[name="name"], input[name="password"]';

/**
 * Proxy configuration for the GUI (no connectivity test).
 * @param {object} [cfg]
 */
function getProxyInfo(cfg) {
  const p = proxySettings(cfg);
  const missingServer = p.enabled && !p.server;
  const configured = p.enabled && !!p.server;

  const pool = p.serverCount > 1 ? ` [${(p.serverIndex ?? 0) + 1}/${p.serverCount}]` : '';

  let display = 'Off';
  if (configured) {
    const base = p.username ? `${p.server} (${p.username})` : p.server;
    display = `${base}${pool}`;
  } else if (missingServer) {
    display = 'Enabled — server not set';
  }

  return {
    enabled: p.enabled,
    configured,
    missingServer,
    server: p.server || '',
    servers: p.servers || [],
    serverCount: p.serverCount || 0,
    serverIndex: p.serverIndex ?? 0,
    rotation: p.rotation || 'round-robin',
    username: p.username || '',
    hasAuth: !!(p.username || p.password),
    bypass: p.bypass || '',
    display,
    label: proxyLogLabel(cfg),
  };
}

/**
 * Navigate to the game URL through the active browser context (uses proxy if configured).
 * @param {import('playwright').Page} page
 * @param {object} cfg
 */
async function testProxyWithPage(page, cfg) {
  const info = getProxyInfo(cfg);

  if (!info.configured) {
    return {
      ...info,
      state: 'off',
      working: null,
      message: info.missingServer ? 'Enable proxy.server in config.json' : 'Proxy disabled',
      latencyMs: null,
      checkedAt: new Date().toISOString(),
    };
  }

  const t0 = Date.now();
  const base = String(cfg.url || '').replace(/\/+$/, '');
  if (!base) {
    return {
      ...info,
      state: 'fail',
      working: false,
      message: 'config.url is empty',
      latencyMs: 0,
      checkedAt: new Date().toISOString(),
    };
  }

  try {
    // Use the Travian home URL so the test goes through the same proxy as gameplay.
    await page.goto(`${base}/`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    const url = page.url();
    const hasShell =
      /dorf\d|village|travian/i.test(url) ||
      !!(await page.$(LOGGED_IN_HINT).catch(() => null));

    const latencyMs = Date.now() - t0;
    if (hasShell) {
      return {
        ...info,
        state: 'ok',
        working: true,
        message: `Reached Travian (${Math.round(latencyMs / 1000)}s)`,
        latencyMs,
        checkedAt: new Date().toISOString(),
        finalUrl: url,
      };
    }

    return {
      ...info,
      state: 'fail',
      working: false,
      message: `Unexpected page: ${url.slice(0, 80)}`,
      latencyMs,
      checkedAt: new Date().toISOString(),
      finalUrl: url,
    };
  } catch (err) {
    return {
      ...info,
      state: 'fail',
      working: false,
      message: networkErrorHint(err),
      latencyMs: Date.now() - t0,
      checkedAt: new Date().toISOString(),
    };
  }
}

/** Status object when proxy is on but there is no browser page yet. */
function proxyStatusWithoutSession(cfg) {
  const info = getProxyInfo(cfg);
  if (!info.configured) {
    return { ...info, state: 'off', working: null, message: 'Proxy disabled' };
  }
  return {
    ...info,
    state: 'unknown',
    working: null,
    message: 'Log in to test proxy',
    latencyMs: null,
    checkedAt: null,
  };
}

module.exports = {
  getProxyInfo,
  testProxyWithPage,
  proxyStatusWithoutSession,
};
