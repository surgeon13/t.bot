'use strict';

/**
 * Read in-game account label and outbound IP as seen by the browser (through proxy if set).
 */

const { ensureGameShell } = require('./utils');

const PLAYER_NAME_SELECTORS = [
  '#playerName',
  '#userName',
  '#topBarPlayerName',
  '.topBarPlayerName',
  '.playerName',
  '.player-name',
  '.accountName',
  'a.playerName',
  '[data-player-name]',
  '.accountWrapper .name',
  'a.layoutButton.player .content',
  '.playerButton .content',
  '#topBar .playerName',
  '.menuContainer .playerName',
  '.playerNameAndTribe',
  '.account .name',
];

const IP_ENDPOINTS = [
  { url: 'https://api.ipify.org?format=json', json: true },
  { url: 'https://api64.ipify.org?format=json', json: true },
  { url: 'https://ifconfig.me/ip', json: false },
];

async function readPlayerNameFromDom(page) {
  return page.evaluate(selectors => {
    const pick = t => {
      const s = (t || '').trim();
      if (!s || s.length < 2 || s.length > 64) return null;
      if (/^(log\s*out|logout|settings|profile|options|help|player|account)$/i.test(s)) return null;
      return s;
    };

    try {
      const g =
        window.Travian?.Game?.player?.name
        || window.Travian?.player?.name
        || window.Travian?.Player?.name;
      const fromGlobal = pick(g);
      if (fromGlobal) return fromGlobal;
    } catch {
      /* ignore */
    }

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = pick(el.getAttribute('title') || el.textContent);
      if (t) return t;
    }

    for (const el of document.querySelectorAll('#topBar a, .topBar a, #navigation a, header a')) {
      const href = el.getAttribute('href') || '';
      if (!/player|spieler|profile|account|options/i.test(href)) continue;
      const t = pick(el.textContent);
      if (t) return t;
    }

    const title = document.title || '';
    const m = title.match(/^(.+?)\s*[-–|]\s*Travian/i);
    if (m) return pick(m[1]);

    return null;
  }, PLAYER_NAME_SELECTORS);
}

/**
 * @param {import('playwright').Page} page
 * @param {{ ensureShell?: boolean }} [options]
 */
async function readPlayerName(page, options = {}) {
  if (!page || page.isClosed()) return null;

  if (options.ensureShell !== false) {
    await ensureGameShell(page, { tag: 'account' }).catch(() => {});
  }

  let name = await readPlayerNameFromDom(page).catch(() => null);
  if (name) return name;

  // One reload of the village shell — player label often missing on /hero/* routes.
  const base = await page.evaluate(() => {
    const m = location.href.match(/^(https?:\/\/[^/]+)/i);
    return m ? m[1] : null;
  }).catch(() => null);

  if (base) {
    try {
      await page.goto(`${base}/dorf1.php`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      name = await readPlayerNameFromDom(page).catch(() => null);
    } catch {
      /* keep null */
    }
  }

  return name || null;
}

/**
 * Outbound IP via Playwright APIRequest (same proxy as the browser context).
 * In-page fetch from travian.com is often blocked by CSP.
 *
 * @param {import('playwright').BrowserContext} context
 */
async function readPublicIp(context) {
  if (!context) {
    return { ip: null, source: null, error: 'No browser context' };
  }

  let lastErr = 'All IP services failed';
  for (const ep of IP_ENDPOINTS) {
    try {
      const res = await context.request.get(ep.url, { timeout: 12_000 });
      if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
      let ip;
      if (ep.json) ip = (await res.json()).ip;
      else ip = (await res.text()).trim();
      if (ip && /^[\d.a-fA-F:]+$/.test(ip)) {
        return { ip, source: ep.url, error: null };
      }
    } catch (e) {
      lastErr = e.message || String(e);
    }
  }
  return { ip: null, source: null, error: lastErr };
}

module.exports = { readPlayerName, readPublicIp, PLAYER_NAME_SELECTORS };
