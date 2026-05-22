'use strict';

/**
 * Read in-game account label and outbound IP as seen by the browser (through proxy if set).
 */

const PLAYER_NAME_SELECTORS = [
  '#userName',
  '.playerName',
  '.player-name',
  '.accountName',
  'a.playerName',
  '[data-player-name]',
  '.accountWrapper .name',
  '.topBarPlayerName',
];

async function readPlayerName(page) {
  if (!page || page.isClosed()) return null;

  return page.evaluate(selectors => {
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (!el) continue;
      const t = (el.getAttribute('title') || el.textContent || '').trim();
      if (t && t.length >= 2 && t.length <= 64 && !/^(log\s*out|logout|settings)$/i.test(t)) {
        return t;
      }
    }
    const title = document.title || '';
    const m = title.match(/^(.+?)\s*[-–|]\s*Travian/i);
    if (m && m[1].trim().length <= 64) return m[1].trim();
    return null;
  }, PLAYER_NAME_SELECTORS);
}

async function readPublicIp(page) {
  if (!page || page.isClosed()) {
    return { ip: null, source: null, error: 'No browser page' };
  }

  return page.evaluate(async () => {
    const endpoints = [
      { url: 'https://api.ipify.org?format=json', parse: async r => (await r.json()).ip },
      { url: 'https://api64.ipify.org?format=json', parse: async r => (await r.json()).ip },
      { url: 'https://ifconfig.me/ip', parse: async r => (await r.text()).trim() },
    ];
    let lastErr = 'All IP services failed';
    for (const { url, parse } of endpoints) {
      try {
        const res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const ip = await parse(res);
        if (ip && /^[\d.a-fA-F:]+$/.test(ip)) {
          return { ip, source: url, error: null };
        }
      } catch (e) {
        lastErr = e.message || String(e);
      }
    }
    return { ip: null, source: null, error: lastErr };
  });
}

module.exports = { readPlayerName, readPublicIp, PLAYER_NAME_SELECTORS };
