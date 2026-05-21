'use strict';

/**
 * Local web GUI for t.bot.
 *
 * Starts an Express server on http://localhost:3733, launches a Playwright
 * browser, logs in once, and exposes endpoints to claim each hero/resource
 * bonus on demand. The page itself is in ./public/.
 *
 * Run with: npm run gui
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const log = require('./logger');
const { launchBrowser, newGameContext } = require('./browserLaunch');
const { loadConfig, login } = require('./auth');
const { claimHeroBonus, openAdventuresPage, readAdventurePageStatus } = require('./adventures');
const {
  claimResourceBonus,
  claimResourceBonuses,
  pollResourceBonusesViaWizard,
  resourceBonusSettings,
  readResourceBonusState,
  nextResourceBonusRunLine,
  RESOURCES,
  __testInternals,
} = require('./resourceBonuses');
const { readHeroStats } = require('./heroStats');
const { getTotals } = require('./totals');
const { getLastCompletedBonus, getLastCompletedBonuses } = require('./runState');

const TAG = 'gui';
const PORT = Number(process.env.PORT) || 3733;
const HOST = '127.0.0.1';

/* --------------------------------------------------------------------- */
/* Single-flight mutex for browser actions                                */
/* --------------------------------------------------------------------- */

class ActionLock {
  constructor() {
    this.queue = Promise.resolve();
    this.busy = false;
    this.current = null;
  }

  /** Run fn with exclusive access to the Playwright page. */
  async run(name, fn) {
    const previous = this.queue;
    let release;
    this.queue = new Promise(resolve => { release = resolve; });
    await previous;
    this.busy = true;
    this.current = name;
    try {
      return await fn();
    } finally {
      this.busy = false;
      this.current = null;
      release();
    }
  }

  status() {
    return { busy: this.busy, action: this.current };
  }
}

const lock = new ActionLock();

/* --------------------------------------------------------------------- */
/* Browser session                                                        */
/* --------------------------------------------------------------------- */

let browser = null;
let context = null;
let page = null;
let loggedIn = false;

async function ensureSession() {
  if (browser && page && loggedIn) return;
  const cfg = loadConfig();
  if (!browser) {
    const headless = cfg.headless !== false;
    log.info(TAG, `Launching browser (headless=${headless})`);
    browser = await launchBrowser({ headless });
    context = await newGameContext(browser);
  }
  if (!page || page.isClosed()) {
    if (!context) context = await newGameContext(browser);
    page = await context.newPage();
  }
  log.info(TAG, 'Logging in');
  loggedIn = await login(page);
  if (!loggedIn) {
    log.warn(TAG, 'Login failed');
  } else {
    log.info(TAG, 'Logged in');
  }
}

async function closeSession() {
  loggedIn = false;
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  page = null;
  context = null;
  browser = null;
}

/* --------------------------------------------------------------------- */
/* Action wrappers                                                        */
/* --------------------------------------------------------------------- */

async function withSession(name, fn) {
  return lock.run(name, async () => {
    await ensureSession();
    if (!loggedIn) {
      return { ok: false, status: 'failed', message: 'Not logged in' };
    }
    try {
      return await fn(page);
    } catch (err) {
      log.error(TAG, `${name} crashed: ${err.message}`);
      try { loggedIn = false; await ensureSession(); } catch {}
      return { ok: false, status: 'failed', message: err.message };
    }
  });
}

/* --------------------------------------------------------------------- */
/* Express app                                                            */
/* --------------------------------------------------------------------- */

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, busy: lock.busy, action: lock.current, loggedIn });
});

app.get('/api/status', async (_req, res) => {
  const cfg = loadConfig();
  const totals = getTotals();
  const resourceState = readResourceBonusState();
  res.json({
    loggedIn,
    busy: lock.busy,
    action: lock.current,
    serverUrl: cfg.url,
    username: cfg.username,
    schedule: cfg.schedule || null,
    resourceBonuses: resourceBonusSettings(cfg),
    nextResourceBonusLine: nextResourceBonusRunLine(),
    resourceState,
    totals,
    lastBonus: getLastCompletedBonus(),
    recentBonuses: getLastCompletedBonuses(8),
  });
});

app.get('/api/hero', async (req, res) => {
  const deep = req.query.deep !== '0';
  const result = await withSession('readHeroStats', p => readHeroStats(p, { deep }));
  res.json(result);
});

app.get('/api/resources/status', async (_req, res) => {
  const result = await withSession('pollResources', p => pollResourceBonusesViaWizard(p));
  res.json(result);
});

function heroBonusFromPage(active, videoReady) {
  if (active) return { status: 'active', claimable: false };
  if (videoReady) return { status: 'claimable', claimable: true };
  return { status: 'unavailable', claimable: false };
}

let bonusesPollCache = { at: 0, payload: null };
const BONUSES_POLL_CACHE_MS = 30_000;

function clearBonusesPollCache() {
  bonusesPollCache = { at: 0, payload: null };
}

/** Poll hero (adventures page) + all four resource boxes (one Advantages tab visit). */
app.get('/api/bonuses/status', async (req, res) => {
  const force = req.query.force === '1';
  if (!force && bonusesPollCache.payload && Date.now() - bonusesPollCache.at < BONUSES_POLL_CACHE_MS) {
    return res.json(bonusesPollCache.payload);
  }

  const result = await withSession('pollAllBonuses', async (p) => {
    let hero = { ok: false, time: null, danger: null };
    if (await openAdventuresPage(p)) {
      const s = await readAdventurePageStatus(p);
      hero = {
        ok: true,
        time: heroBonusFromPage(s.timeBonusActive, s.timeVideoReady),
        danger: heroBonusFromPage(s.dangerBonusActive, s.dangerVideoReady),
        adventureCount: s.adventureCount,
      };
    }

    // All four resource bonuses live on the same Advantages tab — one shop open.
    const resourcePoll = await pollResourceBonusesViaWizard(p);

    return {
      ok: resourcePoll.ok || hero.ok,
      resources: resourcePoll,
      hero,
    };
  });

  if (result && (result.ok || result.resources || result.hero)) {
    bonusesPollCache = { at: Date.now(), payload: result };
  }
  res.json(result);
});

app.get('/api/adventures', async (_req, res) => {
  const result = await withSession('readAdventures', async (p) => {
    if (!(await openAdventuresPage(p))) {
      return { ok: false, message: 'Adventures page unreachable' };
    }
    return { ok: true, status: await readAdventurePageStatus(p) };
  });
  res.json(result);
});

app.post('/api/bonus/time', async (_req, res) => {
  clearBonusesPollCache();
  const result = await withSession('heroTimeBonus', p => claimHeroBonus(p, 'time'));
  res.json(result);
});

app.post('/api/bonus/danger', async (_req, res) => {
  clearBonusesPollCache();
  const result = await withSession('heroDangerBonus', p => claimHeroBonus(p, 'danger'));
  res.json(result);
});

app.post('/api/bonus/resource/:resource', async (req, res) => {
  const resource = req.params.resource;
  const canonical = RESOURCES.find(r => r.toLowerCase() === String(resource).toLowerCase());
  if (!canonical) {
    return res.status(400).json({ ok: false, status: 'failed', message: `Unknown resource: ${resource}` });
  }
  clearBonusesPollCache();
  const result = await withSession(`resource:${canonical}`, p => claimResourceBonus(p, canonical));
  res.json(result);
});

/** Poll shop once and watch every claimable resource video (GUI batch button). */
app.post('/api/bonus/resources/claim-all', async (_req, res) => {
  clearBonusesPollCache();
  const result = await withSession('resourceClaimAll', async p => {
    const out = await claimResourceBonuses(p, { force: true });
    if (out.skipped) {
      return { ok: false, status: 'skipped', message: 'Resource bonuses disabled or not due', ...out };
    }
    return { ok: out.ok !== false, status: out.claimedCount > 0 ? 'claimed' : 'unavailable', ...out };
  });
  res.json(result);
});

/**
 * One-shot DOM introspection helper. Used to tune selectors without having to
 * relaunch Playwright. Returns small HTML snippets and a list of candidate
 * elements found near the hero panel. Safe to leave in place - read only.
 */
app.get('/api/debug/dom', async (_req, res) => {
  const result = await withSession('debugDom', async (p) => {
    try {
      const cfg = loadConfig();
      const base = cfg.url.replace(/\/+$/, '');
      await p.goto(`${base}/hero/attributes`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      // SPA: wait for #heroV2 to have populated content.
      await p.waitForFunction(() => {
        const root = document.querySelector('#heroV2');
        return !!(root && root.children.length > 0 && root.innerText && root.innerText.length > 50);
      }, { timeout: 15_000 }).catch(() => {});
    } catch (err) {
      return { ok: false, error: err.message };
    }

    return p.evaluate(() => {
      const pickup = (sel, limit = 1) => {
        const out = [];
        const all = document.querySelectorAll(sel);
        for (let i = 0; i < all.length && i < limit; i++) {
          const el = all[i];
          out.push({
            tag: el.tagName.toLowerCase(),
            class: typeof el.className === 'string' ? el.className : (el.getAttribute('class') || ''),
            id: el.id || null,
            text: (el.innerText || '').slice(0, 200),
            html: (el.outerHTML || '').slice(0, 1500),
          });
        }
        return out;
      };

      const root = document.querySelector('#heroV2') || document.body;
      const inputs = Array.from(root.querySelectorAll('input')).slice(0, 30).map(i => ({
        name: i.name, value: i.value, type: i.type, class: i.className,
      }));
      const labels = Array.from(root.querySelectorAll('label, h1, h2, h3, .attributeName, .attributeValue, .heroAttribute, [class*="attribute" i]'))
        .slice(0, 40)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          class: el.className,
          text: (el.innerText || '').trim().slice(0, 120),
        }));

      const candidates = [
        '#heroV2', '#heroV2 > div', '#topBarHero',
        '.heroStatus', '.heroStatusMessage', '.heroName',
        '.attribute', '.heroAttribute', '.statusGroup',
        '.power', '.fightingStrength', '.offBonus', '.defBonus', '.resourceProduction',
        '.experience .points', '.health .value',
        '.heroProduction', '.heroProductionInfo',
        '.heroLevel', '.heroSpeed', '.heroRegeneration',
        'svg.health', 'svg.experience',
      ];
      const dump = {};
      for (const sel of candidates) dump[sel] = pickup(sel, 1);

      return {
        url: location.href,
        title: document.title,
        rootInnerTextSample: (root.innerText || '').slice(0, 2000),
        inputs,
        labels,
        candidates: dump,
      };
    });
  });
  res.json(result);
});

/**
 * Open the shop wizard and dump its DOM so we can identify the current
 * Advantages-tab / video-button selectors when Travian updates its UI.
 */
app.get('/api/debug/shop', async (_req, res) => {
  const result = await withSession('debugShop', async (p) => {
    try {
      await p.locator('a.shop').click({ timeout: 10_000 });
    } catch (err) {
      return { ok: false, where: 'shop-click', error: err.message };
    }
    await p.waitForTimeout(2500);

    // Click "Advantages" tab so we can capture its real contents.
    await p.evaluate(() => {
      const tabs = Array.from(document.querySelectorAll('.dialog a.tabItem, .dialog .tabItem'));
      const re = /^(advantages|pros|vorteile|avantages|vantaggi|ventajas|преимущества|выгоды)\b/i;
      const t = tabs.find(t => re.test((t.innerText || t.textContent || '').trim()));
      if (t) t.click();
    }).catch(() => {});
    await p.waitForTimeout(2500);

    const dump = await p.evaluate(() => {
      const visible = (el) => {
        const s = getComputedStyle(el);
        const b = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
      };

      const wizard =
           document.querySelector('.paymentWizardV2')
        || document.querySelector('.paymentWizard')
        || document.querySelector('.dialog.shop')
        || document.querySelector('[class*="shop" i].dialog')
        || document.querySelector('.dialogWrapper:not([style*="display: none"]) .dialog')
        || document.body;

      const wizardClass = wizard.className || wizard.tagName;

      const dataTabnames = Array.from(document.querySelectorAll('[data-tabname]'))
        .filter(visible)
        .slice(0, 30)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          class: el.className,
          dataTabname: el.getAttribute('data-tabname'),
          text: (el.innerText || '').trim().slice(0, 60),
        }));

      const tabLikely = Array.from(wizard.querySelectorAll('a, button, li, div'))
        .filter(visible)
        .filter(el => /tab/i.test(el.className || '') || /tab/i.test(el.getAttribute('role') || ''))
        .slice(0, 40)
        .map(el => ({
          tag: el.tagName.toLowerCase(),
          class: el.className,
          role: el.getAttribute('role'),
          dataTabname: el.getAttribute('data-tabname'),
          text: (el.innerText || '').trim().slice(0, 60),
        }));

      const buttonsWithVideo = Array.from(wizard.querySelectorAll('button'))
        .filter(visible)
        .filter(b => b.querySelector('i.videoIcon') || /video|watch|activate|start|play/i.test(b.innerText || ''))
        .slice(0, 20)
        .map(b => {
          const block = b.closest('.proItem, .videoFeatureBonusBox, .item, li, .row, .bonusItem') || b.parentElement || b;
          return {
            class: b.className,
            disabled: b.disabled,
            text: (b.innerText || '').trim().slice(0, 80),
            parentClass: (b.parentElement?.className || '').slice(0, 120),
            blockClass: (block.className || '').slice(0, 200),
            blockText: (block.innerText || '').trim().slice(0, 220),
            blockHtmlSample: (block.outerHTML || '').slice(0, 800),
          };
        });

      const activeTabHtml = (() => {
        const active = document.querySelector('.dialog a.tabItem.active, .dialog .tabItem.active');
        if (!active) return null;
        const panel = wizard.querySelector('.tabContent, .tabPanel, .content') || wizard;
        return {
          activeTabText: (active.innerText || '').trim(),
          panelTextSample: (panel.innerText || '').slice(0, 1000),
          panelHtmlSample: (panel.outerHTML || '').slice(0, 4000),
        };
      })();

      return {
        wizardClass,
        wizardHtmlSample: (wizard.outerHTML || '').slice(0, 4000),
        dataTabnames,
        tabLikely,
        buttonsWithVideo,
        activeTabHtml,
      };
    });

    await p.keyboard.press('Escape').catch(() => {});
    return { ok: true, dump };
  });
  res.json(result);
});

/**
 * Dry-run the new resource-bonus flow: open the shop wizard, click Advantages,
 * list which resource videos are currently claimable, then close. No ad is
 * watched, no bonus is consumed.
 */
app.get('/api/debug/advantages', async (_req, res) => {
  const result = await withSession('debugAdvantages', async (p) => {
    const opened = await __testInternals.openResourceBonusTab(p);
    if (!opened) {
      return { ok: false, opened: false };
    }
    const available = await __testInternals.listAvailableResourceVideos(p);
    await __testInternals.closeResourceBonusTab(p);
    return { ok: true, opened: true, available };
  });
  res.json(result);
});

app.post('/api/relogin', async (_req, res) => {
  await lock.run('relogin', async () => {
    await closeSession();
    await ensureSession();
  });
  res.json({ ok: loggedIn });
});

/* --------------------------------------------------------------------- */
/* Server-sent events: live log stream                                    */
/* --------------------------------------------------------------------- */

app.get('/api/log/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  // Replay last few lines of bot.log so the GUI doesn't open empty.
  try {
    const LOG_FILE = path.join(__dirname, 'bot.log');
    if (fs.existsSync(LOG_FILE)) {
      const lines = fs.readFileSync(LOG_FILE, 'utf8').trim().split(/\r?\n/).slice(-30);
      for (const line of lines) {
        res.write(`data: ${JSON.stringify({ replay: true, line })}\n\n`);
      }
    }
  } catch {}

  const unsubscribe = log.subscribe(entry => {
    res.write(`data: ${JSON.stringify(entry)}\n\n`);
  });

  req.on('close', () => unsubscribe());
});

/* --------------------------------------------------------------------- */
/* Boot                                                                   */
/* --------------------------------------------------------------------- */

function openInBrowser(url) {
  const platform = process.platform;
  const cmd = platform === 'win32' ? `start "" "${url}"`
            : platform === 'darwin' ? `open "${url}"`
            : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const server = app.listen(PORT, HOST, async () => {
  log.info(TAG, `GUI listening on http://${HOST}:${PORT}`);
  try {
    await ensureSession();
  } catch (err) {
    log.error(TAG, `Startup login failed: ${err.message}`);
  }
  if (process.env.OPEN_BROWSER !== '0') {
    openInBrowser(`http://${HOST}:${PORT}`);
  }
});

async function shutdown() {
  log.info(TAG, 'Shutting down GUI');
  try { server.close(); } catch {}
  await closeSession();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
