'use strict';

/**
 * Local web GUI for t.bot.
 *
 * Starts an Express server on http://localhost:3733, launches a Playwright
 * browser, logs in once, and exposes endpoints to claim each hero/resource
 * bonus on demand. The page itself is in ./public/.
 *
 * Run with: npm run gui
 * Dev (hot reload): npm run gui:dev
 *
 * When schedule.enabled is true, the scheduler loop runs in-process (no 2nd terminal).
 * Opt out: GUI_NO_SCHEDULER=1 and use npm run schedule separately.
 */

const path = require('path');
const fs = require('fs');
const { exec } = require('child_process');
const express = require('express');
const log = require('./logger');
const {
  launchBrowser,
  newGameContext,
  proxyLogLabel,
  proxySettings,
  normalizeProxyServer,
  parseProxyServerList,
  clearSessionProxy,
} = require('./browserLaunch');
const { loadConfig, saveConfig, login, hasLoggedInShell, networkErrorHint } = require('./auth');
const { readPlayerName, readPublicIp } = require('./accountInfo');
const {
  getProxyInfo,
  testProxyWithPage,
  proxyStatusWithoutSession,
} = require('./proxyStatus');
const {
  claimHeroBonus,
  handleAdventures,
  openAdventuresPage,
  readAdventurePageStatus,
  sendHeroOnShortestAdventure,
} = require('./adventures');
const {
  claimResourceBonus,
  claimResourceBonuses,
  cooldownTextToSeconds,
  pollResourceBonusesViaWizard,
  resourceBonusSettings,
  readResourceBonusState,
  nextResourceBonusRunLine,
  RESOURCES,
  __testInternals,
} = require('./resourceBonuses');
const { ensureGameShell } = require('./utils');
const { readHeroStats } = require('./heroStats');
const { getTotals } = require('./totals');
const { getLastCompletedBonus, getLastCompletedBonuses } = require('./runState');
const { scheduleGuiStatus, setEmbeddedSchedulerActive } = require('./scheduleState');
const { runSchedulerLoop } = require('./scheduler');

const TAG = 'gui';
const PORT = Number(process.env.PORT) || 3733;
const HOST = '127.0.0.1';
const DEV_RELOAD = process.env.DEV_RELOAD === '1';
const { ROOT, LOG_FILE, PACKAGE_FOLDER_NAME } = require('./paths');
const PUBLIC_DIR = path.join(ROOT, 'public');

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
/* Embedded scheduler (same process as GUI; uses GUI browser + lock)      */
/* --------------------------------------------------------------------- */

/** @type {{ stop: boolean, runNow: boolean }|null} */
let embeddedScheduleControl = null;
/** @type {Promise<{ reason: string }>|null} */
let embeddedScheduleTask = null;
let embeddedScheduleGen = 0;
let guiShuttingDown = false;

async function runScheduledClaimViaGui() {
  return lock.run('scheduleRun', async () => {
    try {
      await ensureSession();
      if (!loggedIn || !page || page.isClosed()) {
        log.warn(TAG, 'Scheduled run skipped: not logged in');
        return 1;
      }
      if (!(await ensureGameShell(page, { tag: TAG }))) {
        log.warn(TAG, 'Scheduled run skipped: game shell unreachable after re-login');
        loggedIn = false;
        return 1;
      }
      log.info(TAG, 'Scheduled run: claiming bonuses (hero videos only when buff expired / watch ready)');
      await handleAdventures(page);
      await claimResourceBonuses(page);
      return 0;
    } catch (err) {
      log.error(TAG, `Scheduled run failed: ${err.message}`);
      return 1;
    }
  });
}

function stopEmbeddedScheduler() {
  if (embeddedScheduleControl) embeddedScheduleControl.stop = true;
}

function syncEmbeddedScheduler() {
  embeddedScheduleGen += 1;
  const gen = embeddedScheduleGen;
  stopEmbeddedScheduler();

  const cfg = loadConfig();
  if (process.env.GUI_NO_SCHEDULER === '1') {
    log.info(TAG, 'Embedded scheduler disabled (GUI_NO_SCHEDULER=1)');
    embeddedScheduleControl = null;
    embeddedScheduleTask = null;
    setEmbeddedSchedulerActive(false);
    return;
  }
  if (!cfg.schedule?.enabled) {
    embeddedScheduleControl = null;
    embeddedScheduleTask = null;
    setEmbeddedSchedulerActive(false);
    return;
  }

  const control = { stop: false, runNow: false };
  embeddedScheduleControl = control;
  setEmbeddedSchedulerActive(true);
  log.info(TAG, `Embedded scheduler started (every ${Math.max(0.25, Number(cfg.schedule.intervalHours) || 3)}h)`);

  embeddedScheduleTask = runSchedulerLoop({
    attachStdin: false,
    control,
    executeRun: runScheduledClaimViaGui,
  })
    .then(result => {
      log.info(TAG, `Embedded scheduler stopped (${result.reason})`);
      return result;
    })
    .catch(err => {
      log.error(TAG, `Embedded scheduler error: ${err.message}`);
    })
    .finally(() => {
      if (gen !== embeddedScheduleGen) return;
      embeddedScheduleControl = null;
      embeddedScheduleTask = null;
      setEmbeddedSchedulerActive(false);
      if (!guiShuttingDown && loadConfig().schedule?.enabled && process.env.GUI_NO_SCHEDULER !== '1') {
        log.warn(TAG, 'Embedded scheduler exited unexpectedly — restarting in 2s');
        setTimeout(() => {
          if (gen === embeddedScheduleGen) syncEmbeddedScheduler();
        }, 2000);
      }
    });
}

/** Start or stop embedded scheduler only when ON/OFF changes or loop is not running. */
function syncEmbeddedSchedulerAfterConfigSave(wasEnabled) {
  const nowEnabled = !!loadConfig().schedule?.enabled;
  if (wasEnabled !== nowEnabled || !embeddedScheduleControl) {
    syncEmbeddedScheduler();
  }
}

/* --------------------------------------------------------------------- */
/* Browser session                                                        */
/* --------------------------------------------------------------------- */

let browser = null;
let context = null;
let page = null;
let loggedIn = false;
/** @type {object|null} Last proxy connectivity check for the GUI */
let proxyStatusCache = null;
/** @type {object|null} Player name + public IP for the GUI */
let accountCache = null;

function accountPayloadForApi() {
  const cfg = loadConfig();
  const base = accountCache || {
    loginUsername: cfg.username || '',
    serverUrl: cfg.url || '',
    playerName: null,
    publicIp: null,
    ipError: null,
    ipCheckedAt: null,
  };
  return { ...base, loggedIn: !!loggedIn };
}

async function refreshAccountInfo(targetPage = page) {
  const cfg = loadConfig();
  const base = {
    loginUsername: cfg.username || '',
    serverUrl: cfg.url || '',
    playerName: null,
    publicIp: null,
    ipError: null,
    ipCheckedAt: new Date().toISOString(),
    loggedIn: !!loggedIn,
  };

  if (!loggedIn || !targetPage || targetPage.isClosed() || !context) {
    accountCache = base;
    return accountCache;
  }

  const [playerName, ipResult] = await Promise.all([
    readPlayerName(targetPage).catch(err => {
      log.warn(TAG, `Player name read failed: ${err.message}`);
      return null;
    }),
    readPublicIp(context).catch(err => ({ ip: null, error: err.message })),
  ]);

  accountCache = {
    ...base,
    playerName: playerName || null,
    publicIp: ipResult.ip || null,
    ipError: ipResult.error || null,
    ipSource: ipResult.source || null,
    ipCheckedAt: new Date().toISOString(),
    loggedIn: true,
  };

  if (accountCache.publicIp) {
    log.info(TAG, `Public IP (browser): ${accountCache.publicIp}`);
  } else if (accountCache.ipError) {
    log.warn(TAG, `Public IP lookup failed: ${accountCache.ipError}`);
  }
  if (accountCache.playerName) {
    log.info(TAG, `Player name: ${accountCache.playerName}`);
  } else {
    log.warn(TAG, 'Player name not found in Travian UI — try Refresh on account bar');
  }

  return accountCache;
}

function proxyConfigForApi() {
  const p = proxySettings(loadConfig());
  const servers = p.servers?.length ? p.servers : (p.server ? [p.server] : []);
  return {
    enabled: p.enabled,
    server: p.server,
    servers,
    serverCount: servers.length,
    serverIndex: p.serverIndex ?? 0,
    rotation: p.rotation || 'round-robin',
    username: p.username,
    bypass: p.bypass,
    hasPassword: !!p.password,
  };
}

function applyProxyConfigFromBody(cfg, body) {
  if (!cfg.proxy) {
    cfg.proxy = { enabled: false, server: '', servers: [], rotation: 'round-robin', username: '', password: '', bypass: '' };
  }
  if (typeof body.enabled === 'boolean') cfg.proxy.enabled = body.enabled;
  if (body.server != null || Array.isArray(body.servers)) {
    const list = Array.isArray(body.servers) && body.servers.length
      ? body.servers.map(s => normalizeProxyServer(s)).filter(Boolean)
      : parseProxyServerList(body.server, null);
    if (list.length > 1) {
      cfg.proxy.servers = list;
      cfg.proxy.server = list[0];
    } else if (list.length === 1) {
      cfg.proxy.server = list[0];
      delete cfg.proxy.servers;
    } else {
      cfg.proxy.server = '';
      delete cfg.proxy.servers;
    }
  }
  if (body.rotation != null) {
    const r = String(body.rotation).trim().toLowerCase();
    cfg.proxy.rotation = r || 'round-robin';
  }
  if (body.username != null) cfg.proxy.username = String(body.username).trim();
  if (body.bypass != null) cfg.proxy.bypass = String(body.bypass).trim();
  if (body.password != null && String(body.password).length > 0) {
    cfg.proxy.password = String(body.password);
  }
  return cfg;
}

function proxyPayloadForApi() {
  if (proxyStatusCache) return proxyStatusCache;
  return proxyStatusWithoutSession(loadConfig());
}

function scheduleConfigForApi(cfg = loadConfig()) {
  const sch = cfg.schedule || { enabled: false, intervalHours: 3 };
  const res = resourceBonusSettings(cfg);
  return {
    periodicEnabled: !!sch.enabled,
    intervalHours: Math.max(0.25, Number(sch.intervalHours) || 3),
    resourceEnabled: !!res.enabled,
    resourceIntervalHours: res.intervalHours,
  };
}

function applyScheduleConfigFromBody(cfg, body = {}) {
  if (!cfg.schedule) cfg.schedule = { enabled: false, intervalHours: 3 };
  if (!cfg.resourceBonuses) cfg.resourceBonuses = { enabled: false, intervalHours: 8 };

  if (typeof body.periodicEnabled === 'boolean') cfg.schedule.enabled = body.periodicEnabled;
  if (body.intervalHours != null) {
    const n = Number(body.intervalHours);
    if (!Number.isNaN(n) && n >= 0.25) cfg.schedule.intervalHours = n;
  }
  if (typeof body.resourceEnabled === 'boolean') cfg.resourceBonuses.enabled = body.resourceEnabled;
  if (body.resourceIntervalHours != null) {
    const n = Number(body.resourceIntervalHours);
    if (!Number.isNaN(n) && n >= 0.25) cfg.resourceBonuses.intervalHours = n;
  }
  return cfg;
}

async function refreshProxyStatus(targetPage = page) {
  const cfg = loadConfig();
  const info = getProxyInfo(cfg);
  if (!info.configured) {
    proxyStatusCache = proxyStatusWithoutSession(cfg);
    return proxyStatusCache;
  }
  if (!targetPage || targetPage.isClosed()) {
    proxyStatusCache = proxyStatusWithoutSession(cfg);
    return proxyStatusCache;
  }
  log.info(TAG, `Testing proxy: ${info.display}`);
  proxyStatusCache = await testProxyWithPage(targetPage, cfg);
  if (proxyStatusCache.working) {
    log.info(TAG, `Proxy OK (${proxyStatusCache.latencyMs}ms)`);
  } else {
    log.warn(TAG, `Proxy check failed: ${proxyStatusCache.message}`);
  }
  return proxyStatusCache;
}

async function sessionStillLoggedIn(targetPage = page) {
  if (!targetPage || targetPage.isClosed()) return false;
  try {
    if (await hasLoggedInShell(targetPage)) return true;
    const cfg = loadConfig();
    const base = (cfg.url || '').replace(/\/+$/, '');
    if (!base) return false;
    log.info(TAG, 'Session check: not on game shell — opening village');
    await targetPage.goto(`${base}/dorf1.php`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    return await hasLoggedInShell(targetPage);
  } catch (err) {
    log.warn(TAG, `Session check failed: ${err.message}`);
    return false;
  }
}

async function ensureSession() {
  const cfg = loadConfig();
  if (browser && page && !page.isClosed() && loggedIn) {
    if (await sessionStillLoggedIn(page)) return;
    log.warn(TAG, 'Logged out or session expired — re-logging in');
    loggedIn = false;
  }
  try {
    if (!browser) {
      const headless = cfg.headless !== false;
      log.info(TAG, `Launching browser (headless=${headless}, proxy=${proxyLogLabel(cfg)})`);
      browser = await launchBrowser({ headless });
      context = await newGameContext(browser);
    }
    if (!page || page.isClosed()) {
      if (!context) context = await newGameContext(browser);
      page = await context.newPage();
    }
  } catch (err) {
    log.error(TAG, `Browser launch failed: ${networkErrorHint(err)}`);
    loggedIn = false;
    await closeSession().catch(() => {});
    return;
  }

  log.info(TAG, 'Logging in');
  try {
    loggedIn = await login(page);
  } catch (err) {
    log.error(TAG, `Login error: ${networkErrorHint(err)}`);
    loggedIn = false;
  }
  if (!loggedIn) {
    log.warn(TAG, 'Login failed');
    const cfgAfter = loadConfig();
    const info = getProxyInfo(cfgAfter);
    if (info.configured) {
      proxyStatusCache = {
        ...info,
        state: 'fail',
        working: false,
        message: login.lastError || 'Login failed — check proxy, credentials, and bot.log. Re-login tries the next proxy in round-robin.',
        latencyMs: null,
        checkedAt: new Date().toISOString(),
      };
    } else {
      proxyStatusCache = proxyStatusWithoutSession(cfgAfter);
    }
  } else {
    log.info(TAG, 'Logged in');
    await Promise.all([
      refreshProxyStatus(page).catch(err => log.warn(TAG, `Proxy check error: ${err.message}`)),
      refreshAccountInfo(page).catch(err => log.warn(TAG, `Account info error: ${err.message}`)),
    ]);
  }
}

async function closeSession() {
  loggedIn = false;
  proxyStatusCache = null;
  accountCache = null;
  clearSessionProxy();
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
    if (!(await ensureGameShell(page, { tag: TAG }))) {
      loggedIn = false;
      await ensureSession();
      if (!loggedIn) {
        return { ok: false, status: 'failed', message: 'Not logged in (game shell unreachable)' };
      }
    }
    try {
      return await fn(page);
    } catch (err) {
      log.error(TAG, `${name} crashed: ${err.message}`);
      loggedIn = false;
      try { await ensureSession(); } catch { /* logged in ensureSession */ }
      return { ok: false, status: 'failed', message: err.message };
    }
  });
}

/* --------------------------------------------------------------------- */
/* Express app                                                            */
/* --------------------------------------------------------------------- */

const app = express();
app.use(express.json());

/* ----- Dev hot reload (npm run gui:dev) ----- */
const devReloadClients = new Set();
let devReloadDebounce = null;

function broadcastPublicReload() {
  for (const res of devReloadClients) {
    try {
      res.write('event: reload\ndata: reload\n\n');
    } catch { /* client gone */ }
  }
}

function schedulePublicReload(fileName) {
  clearTimeout(devReloadDebounce);
  devReloadDebounce = setTimeout(() => {
    log.info(TAG, `Public changed — reloading browser (${fileName})`);
    broadcastPublicReload();
  }, 250);
}

if (DEV_RELOAD) {
  log.info(TAG, 'Dev hot reload: edit public/ → browser refresh; edit *.js → server restart (nodemon)');
  app.get('/api/dev/reload', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    if (typeof res.flushHeaders === 'function') res.flushHeaders();
    res.write(': connected\n\n');
    devReloadClients.add(res);
    req.on('close', () => devReloadClients.delete(res));
  });
  try {
    fs.watch(PUBLIC_DIR, { recursive: true }, (_event, name) => {
      if (!name || !/\.(html|css|js)$/i.test(name)) return;
      schedulePublicReload(name);
    });
  } catch (err) {
    log.warn(TAG, `Could not watch public/ for hot reload: ${err.message}`);
  }
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, busy: lock.busy, action: lock.current, loggedIn });
});

app.get('/api/status', async (_req, res) => {
  const cfg = loadConfig();
  const resourceState = readResourceBonusState();
  res.json({
    loggedIn,
    busy: lock.busy,
    action: lock.current,
    serverUrl: cfg.url,
    username: cfg.username,
    schedule: cfg.schedule || null,
    resourceBonuses: resourceBonusSettings(cfg),
    scheduleConfig: scheduleConfigForApi(cfg),
    scheduleStatus: scheduleGuiStatus(cfg, resourceState),
    nextResourceBonusLine: nextResourceBonusRunLine(),
    resourceState,
    totals: getTotals(),
    lastBonus: getLastCompletedBonus(),
    recentBonuses: getLastCompletedBonuses(8),
    proxy: proxyPayloadForApi(),
    account: accountPayloadForApi(),
    proxyConfig: proxyConfigForApi(),
  });
});

app.get('/api/config/proxy', (_req, res) => {
  res.json({ ok: true, proxy: proxyConfigForApi() });
});

app.put('/api/config/proxy', async (req, res) => {
  try {
    const cfg = applyProxyConfigFromBody(loadConfig(), req.body || {});
    saveConfig(cfg);
    proxyStatusCache = null;
    await closeSession();
    res.json({
      ok: true,
      proxy: proxyConfigForApi(),
      proxyStatus: proxyStatusWithoutSession(cfg),
      message: 'Proxy saved to config.json. Session closed — click Re-login to apply.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/config/schedule', (_req, res) => {
  const cfg = loadConfig();
  const resourceState = readResourceBonusState();
  res.json({
    ok: true,
    schedule: scheduleConfigForApi(cfg),
    scheduleStatus: scheduleGuiStatus(cfg, resourceState),
  });
});

app.put('/api/config/schedule', (req, res) => {
  try {
    const wasEnabled = !!loadConfig().schedule?.enabled;
    const cfg = applyScheduleConfigFromBody(loadConfig(), req.body || {});
    saveConfig(cfg);
    syncEmbeddedSchedulerAfterConfigSave(wasEnabled);
    const resourceState = readResourceBonusState();
    res.json({
      ok: true,
      schedule: scheduleConfigForApi(cfg),
      scheduleStatus: scheduleGuiStatus(cfg, resourceState),
      message: cfg.schedule?.enabled
        ? 'Schedule saved. Timer runs in the background; hero videos are claimed only when not already active (~8h buff).'
        : 'Schedule saved. Periodic claims are off.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/schedule/run-now', (_req, res) => {
  const cfg = loadConfig();
  if (!cfg.schedule?.enabled) {
    return res.status(400).json({
      ok: false,
      message: 'Turn on All bonuses and Save first.',
    });
  }
  if (process.env.GUI_NO_SCHEDULER === '1') {
    return res.status(400).json({
      ok: false,
      message: 'Embedded scheduler is disabled (GUI_NO_SCHEDULER=1). Use npm run schedule in a terminal.',
    });
  }

  if (!embeddedScheduleControl) syncEmbeddedScheduler();
  if (!embeddedScheduleControl) {
    return res.status(503).json({
      ok: false,
      message: 'Scheduler could not start. Check bot.log.',
    });
  }

  embeddedScheduleControl.runNow = true;
  log.info(TAG, 'Scheduler run-now requested from GUI');
  res.json({
    ok: true,
    message: 'Scheduled claim run requested — starting as soon as possible.',
    scheduleStatus: scheduleGuiStatus(cfg, readResourceBonusState()),
  });
});

app.post('/api/account/refresh', async (_req, res) => {
  const result = await lock.run('accountRefresh', async () => {
    await ensureSession();
    if (!loggedIn || !page || page.isClosed()) {
      return { ok: false, account: accountPayloadForApi(), message: 'Not logged in' };
    }
    const account = await refreshAccountInfo(page);
    return { ok: true, account };
  });
  res.json(result);
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

function heroBonusFromPage(active, videoReady, cooldownText = null) {
  const cooldownSeconds = cooldownTextToSeconds(cooldownText);
  if (active) {
    return { status: 'active', claimable: false, cooldownText, cooldownSeconds };
  }
  if (videoReady) return { status: 'claimable', claimable: true, cooldownText: null, cooldownSeconds: null };
  return { status: 'unavailable', claimable: false, cooldownText: null, cooldownSeconds: null };
}

let bonusesPollCache = { at: 0, payload: null };
const BONUSES_POLL_CACHE_MS = 30_000;

function clearBonusesPollCache() {
  bonusesPollCache = { at: 0, payload: null };
}

/**
 * Poll bonus button states.
 * Query scope: all (default) | hero | resources
 * — hero: adventures page only (no shop wizard)
 * — resources: Advantages tab only
 */
app.get('/api/bonuses/status', async (req, res) => {
  const force = req.query.force === '1';
  const scopeRaw = String(req.query.scope || 'all').toLowerCase();
  const scope = scopeRaw === 'hero' || scopeRaw === 'resources' ? scopeRaw : 'all';

  if (
    scope === 'all'
    && !force
    && bonusesPollCache.payload
    && Date.now() - bonusesPollCache.at < BONUSES_POLL_CACHE_MS
  ) {
    return res.json(bonusesPollCache.payload);
  }

  const sessionName = scope === 'hero' ? 'pollHeroBonuses'
    : scope === 'resources' ? 'pollResourceBonuses'
    : 'pollAllBonuses';

  const result = await withSession(sessionName, async (p) => {
    let hero = null;
    let resourcePoll = null;

    if (scope === 'all' || scope === 'hero') {
      hero = { ok: false, time: null, danger: null };
      if (await openAdventuresPage(p)) {
        const s = await readAdventurePageStatus(p);
        hero = {
          ok: true,
          time: heroBonusFromPage(s.timeBonusActive, s.timeVideoReady, s.timeCooldownText),
          danger: heroBonusFromPage(s.dangerBonusActive, s.dangerVideoReady, s.dangerCooldownText),
          adventureCount: s.adventureCount,
        };
      }
    }

    if (scope === 'all' || scope === 'resources') {
      resourcePoll = await pollResourceBonusesViaWizard(p);
    }

    const heroOk = hero?.ok === true;
    const resourceOk = resourcePoll?.ok === true;
    const ok = scope === 'hero' ? heroOk
      : scope === 'resources' ? resourceOk
      : resourceOk || heroOk;

    const payload = { ok, scope };
    if (hero) payload.hero = hero;
    if (resourcePoll) payload.resources = resourcePoll;
    return payload;
  });

  if (scope === 'all' && result && (result.ok || result.resources || result.hero)) {
    bonusesPollCache = { at: Date.now(), payload: result };
  }
  res.json(result);
});

app.get('/api/adventures', async (_req, res) => {
  const result = await withSession('readAdventures', async (p) => {
    if (!(await openAdventuresPage(p))) {
      return { ok: false, message: 'Adventures page unreachable' };
    }
    const status = await readAdventurePageStatus(p);
    return {
      ok: true,
      status,
      adventures: status.adventures,
      heroAway: status.heroAway,
      shortestIndex: status.shortestIndex,
    };
  });
  res.json(result);
});

app.post('/api/adventures/send-shortest', async (_req, res) => {
  clearBonusesPollCache();
  const result = await withSession('sendShortestAdventure', p => sendHeroOnShortestAdventure(p));
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
  try {
    await lock.run('relogin', async () => {
      await closeSession();
      await ensureSession();
    });
    res.json({
      ok: loggedIn,
      message: loggedIn ? 'Logged in' : (proxyStatusCache?.message || 'Login failed — check proxy and credentials'),
      proxy: proxyPayloadForApi(),
      account: accountPayloadForApi(),
    });
  } catch (err) {
    log.error(TAG, `Re-login failed: ${networkErrorHint(err)}`);
    res.status(500).json({
      ok: false,
      message: networkErrorHint(err),
      proxy: proxyPayloadForApi(),
      account: accountPayloadForApi(),
    });
  }
});

app.post('/api/quit', (_req, res) => {
  if (guiShuttingDown) {
    return res.json({ ok: true, message: 'Shutdown already in progress.' });
  }
  res.json({ ok: true, message: 'Shutting down GUI and bot process...' });
  setTimeout(() => {
    shutdown().catch(err => {
      log.error(TAG, `Shutdown via API failed: ${err.message}`);
      process.exit(1);
    });
  }, 10);
});

app.post('/api/proxy/test', async (_req, res) => {
  const cfg = loadConfig();
  const info = getProxyInfo(cfg);
  if (!info.configured) {
    proxyStatusCache = proxyStatusWithoutSession(cfg);
    return res.json({ ok: true, proxy: proxyStatusCache });
  }

  const result = await lock.run('proxyTest', async () => {
    await ensureSession();
    if (!loggedIn || !page || page.isClosed()) {
      proxyStatusCache = {
        ...info,
        state: 'fail',
        working: false,
        message: 'Not logged in — cannot test proxy',
        checkedAt: new Date().toISOString(),
      };
      return { ok: false, proxy: proxyStatusCache };
    }
    const proxy = await refreshProxyStatus(page);
    return { ok: proxy.working === true, proxy };
  });

  res.json(result);
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

/** JSON 404 for unknown /api/* (avoids HTML error pages in the dashboard). */
app.use('/api', (req, res) => {
  res.status(404).json({
    ok: false,
    message: `Unknown API: ${req.method} ${req.originalUrl}. Restart npm run gui if you added features recently.`,
  });
});

app.use(express.static(PUBLIC_DIR, {
  setHeaders(res, filePath) {
    if (DEV_RELOAD && /\.(html|css|js)$/i.test(filePath)) {
      res.setHeader('Cache-Control', 'no-store');
    }
  },
}));

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

process.on('unhandledRejection', err => {
  log.error(TAG, `Unhandled error (GUI kept running): ${networkErrorHint(err)}`);
});

const server = app.listen(PORT, HOST, async () => {
  log.info(TAG, `GUI listening on http://${HOST}:${PORT}`);
  try {
    await ensureSession();
  } catch (err) {
    log.error(TAG, `Startup login failed: ${err.message}`);
  }
  syncEmbeddedScheduler();
  if (process.env.OPEN_BROWSER !== '0') {
    openInBrowser(`http://${HOST}:${PORT}`);
  }
});

const SESSION_RECHECK_MS = 3 * 60 * 1000;
setInterval(() => {
  if (guiShuttingDown || lock.busy || !page || page.isClosed()) return;
  sessionStillLoggedIn(page).then(ok => {
    if (!ok && loggedIn) {
      log.warn(TAG, 'Background session check: logged out — will re-login on next action');
      loggedIn = false;
      clearBonusesPollCache();
    }
  }).catch(() => {
    if (loggedIn) loggedIn = false;
  });
}, SESSION_RECHECK_MS);

server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n  Port ${PORT} is already in use (another t.bot GUI may be running).`);
    console.error(`  • Open http://${HOST}:${PORT} in your browser, or`);
    console.error(`  • Stop the other process, or run:  set PORT=3734 && npm run gui\n`);
    process.exit(1);
  }
  log.error(TAG, err.message);
  process.exit(1);
});

async function shutdown() {
  guiShuttingDown = true;
  log.info(TAG, 'Shutting down GUI');
  stopEmbeddedScheduler();
  if (embeddedScheduleTask) {
    try { await embeddedScheduleTask; } catch { /* already logged */ }
  }
  try { server.close(); } catch {}
  await closeSession();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
