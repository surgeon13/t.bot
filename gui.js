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
  proxyServersFromConfig,
  readRotationIndex,
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
  sendHeroOnAdventure,
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
const {
  farmListSettings,
  mergeFarmLists,
  normalizeFarmListsFromConfig,
  sendAllCheckedFarmLists,
  openFarmListPage,
  readFarmListEntriesOnPage,
  readFarmListsOnPage,
} = require('./farmList');
const {
  farmListGuiStatus,
  setEmbeddedFarmSchedulerActive,
  writeFarmListState,
  readFarmListState,
  randomNextRunAt,
} = require('./farmListState');
const { runFarmListSchedulerLoop } = require('./farmListScheduler');
const {
  workSleepConfigForApi,
  workSleepGuiStatus,
  applyWorkSleepConfigFromBody,
  waitForWorkPhase,
} = require('./workSleep');
const {
  microPauseConfigForApi,
  microPauseGuiStatus,
  applyMicroPauseConfigFromBody,
  waitForMicroPause,
} = require('./microPause');
const {
  dailyScheduleConfigForApi,
  dailyScheduleGuiStatus,
  applyDailyScheduleFromBody,
  proxyPickForNow,
  scheduledProxyKey,
} = require('./dailySchedule');
const {
  automationWindowAllowed,
  shouldKeepBrowserOpen,
  browserPauseStatusLine,
} = require('./sessionGate');

const TAG = 'gui';
const PORT = Number(process.env.PORT) || 3733;
const HOST = '127.0.0.1';
const DEV_RELOAD = process.env.DEV_RELOAD === '1';
const { ROOT, LOG_FILE, PACKAGE_FOLDER_NAME } = require('./paths');
const PUBLIC_DIR = path.join(ROOT, 'public');
const { version: PKG_VERSION } = require('./package.json');

/** Exposed on GET /api/health — add entries when the dashboard depends on new routes. */
const GUI_FEATURES = [
  'farm-list-discover',
  'farm-list-config',
  'farm-list-send',
  'farm-list-send-all',
  'adventures-send',
];

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
      syncBrowserSessionPolicy().catch(err => {
        log.warn(TAG, `Session policy after ${name}: ${err.message}`);
      });
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
/* Embedded farm list scheduler (all checked lists per cycle)             */
/* --------------------------------------------------------------------- */

/** @type {{ stop: boolean, runNow: boolean }|null} */
let embeddedFarmControl = null;
/** @type {Promise<{ reason: string }>|null} */
let embeddedFarmTask = null;
let embeddedFarmGen = 0;

async function runFarmListSendViaGui(options = {}) {
  return lock.run('farmListRun', async () => {
    try {
      if (!options.bypassSleep) {
        const wr = await waitForWorkPhase({});
        if (wr === 'stopped') {
          return { ok: false, status: 'skipped', message: 'Farm list send stopped' };
        }
      }
      await ensureSession();
      if (!loggedIn || !page || page.isClosed()) {
        log.warn(TAG, 'Farm list send skipped: not logged in');
        return { ok: false, message: 'Not logged in' };
      }
      if (!(await ensureGameShell(page, { tag: TAG }))) {
        loggedIn = false;
        return { ok: false, message: 'Game shell unreachable' };
      }
      return sendAllCheckedFarmLists(page);
    } catch (err) {
      log.error(TAG, `Farm list send failed: ${err.message}`);
      return { ok: false, status: 'failed', message: err.message };
    }
  });
}

function stopEmbeddedFarmScheduler() {
  if (embeddedFarmControl) embeddedFarmControl.stop = true;
}

function syncEmbeddedFarmScheduler() {
  embeddedFarmGen += 1;
  const gen = embeddedFarmGen;
  stopEmbeddedFarmScheduler();

  const cfg = loadConfig();
  const fl = farmListSettings(cfg);
  if (process.env.GUI_NO_SCHEDULER === '1') {
    embeddedFarmControl = null;
    embeddedFarmTask = null;
    setEmbeddedFarmSchedulerActive(false);
    return;
  }
  if (!fl.enabled || !farmListTargetCount(fl)) {
    embeddedFarmControl = null;
    embeddedFarmTask = null;
    setEmbeddedFarmSchedulerActive(false);
    return;
  }

  const control = { stop: false, runNow: false };
  embeddedFarmControl = control;
  setEmbeddedFarmSchedulerActive(true);
  log.info(
    TAG,
    fl.sendAllMode
      ? `Farm list scheduler started (Start all mode, ${fl.totalCount} total, ${fl.intervalMinutesMin}–${fl.intervalMinutesMax} min)`
      : `Farm list scheduler started (${fl.activeCount}/${fl.totalCount} checked, ${fl.intervalMinutesMin}–${fl.intervalMinutesMax} min)`,
  );

  const st = readFarmListState();
  if (!st?.nextRunAt || new Date(st.nextRunAt).getTime() > Date.now() + 60_000) {
    writeFarmListState({
      lastRunAt: st?.lastRunAt ?? null,
      nextRunAt: new Date().toISOString(),
      lastIndex: st?.lastIndex ?? 0,
      lastListName: st?.lastListName ?? null,
      intervalMinutesMin: fl.intervalMinutesMin,
      intervalMinutesMax: fl.intervalMinutesMax,
    });
  }

  embeddedFarmTask = runFarmListSchedulerLoop({
    control,
    executeRun: runFarmListSendViaGui,
  })
    .then(result => {
      log.info(TAG, `Farm list scheduler stopped (${result.reason})`);
      return result;
    })
    .catch(err => {
      log.error(TAG, `Farm list scheduler error: ${err.message}`);
    })
    .finally(() => {
      if (gen !== embeddedFarmGen) return;
      embeddedFarmControl = null;
      embeddedFarmTask = null;
      setEmbeddedFarmSchedulerActive(false);
      if (!guiShuttingDown && farmListSettings().enabled && farmListTargetCount(farmListSettings())
        && process.env.GUI_NO_SCHEDULER !== '1') {
        log.warn(TAG, 'Farm list scheduler exited unexpectedly — restarting in 2s');
        setTimeout(() => {
          if (gen === embeddedFarmGen) syncEmbeddedFarmScheduler();
        }, 2000);
      }
    });
}

function syncEmbeddedFarmSchedulerAfterConfigSave() {
  syncEmbeddedFarmScheduler();
}

function farmListConfigForApi(cfg = loadConfig()) {
  const st = readFarmListState();
  const fl = farmListSettings(cfg, { gameOrder: st?.gameOrder });
  return {
    enabled: fl.enabled,
    sendAllMode: fl.sendAllMode,
    lists: fl.allLists,
    activeCount: fl.activeCount,
    totalCount: fl.totalCount,
    intervalMinutesMin: fl.intervalMinutesMin,
    intervalMinutesMax: fl.intervalMinutesMax,
  };
}

function farmListStatusForApi(cfg = loadConfig()) {
  return {
    ...farmListGuiStatus(cfg, readFarmListState()),
    farmListSends: getTotals().farmListSends ?? 0,
  };
}

function applyFarmListConfigFromBody(cfg, body = {}) {
  if (!cfg.farmList) {
    cfg.farmList = { enabled: false, sendAllMode: false, lists: [], intervalMinutesMin: 5, intervalMinutesMax: 15 };
  }
  if (typeof body.enabled === 'boolean') cfg.farmList.enabled = body.enabled;
  if (typeof body.sendAllMode === 'boolean') cfg.farmList.sendAllMode = body.sendAllMode;

  if (Array.isArray(body.lists)) {
    cfg.farmList.lists = normalizeFarmListsFromConfig(body.lists);
  } else if (body.listsText != null) {
    const names = String(body.listsText).split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    cfg.farmList.lists = normalizeFarmListsFromConfig(names);
  }
  if (body.intervalMinutesMin != null) {
    const n = Number(body.intervalMinutesMin);
    if (!Number.isNaN(n) && n >= 1) cfg.farmList.intervalMinutesMin = n;
  }
  if (body.intervalMinutesMax != null) {
    const n = Number(body.intervalMinutesMax);
    if (!Number.isNaN(n) && n >= 1) cfg.farmList.intervalMinutesMax = n;
  }
  const min = Math.max(1, Number(cfg.farmList.intervalMinutesMin) || 5);
  const max = Math.max(min, Number(cfg.farmList.intervalMinutesMax) || 15);
  cfg.farmList.intervalMinutesMin = min;
  cfg.farmList.intervalMinutesMax = max;

  if (Array.isArray(cfg.farmList.lists) && cfg.farmList.lists.length) {
    const prev = readFarmListState();
    writeFarmListState({
      ...prev,
      gameOrder: cfg.farmList.lists.map(l => l.name),
      intervalMinutesMin: min,
      intervalMinutesMax: max,
    });
  }
  return cfg;
}

function farmListTargetCount(fl) {
  return fl.sendAllMode ? fl.totalCount : fl.activeCount;
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
/** Tracks daily-schedule proxy slot so browser restarts when it changes. */
let lastDailyProxyPickKey = null;

function dailyProxyPickKey(cfg = loadConfig()) {
  if (cfg?.dailySchedule?.enabled) return scheduledProxyKey(cfg);
  return 'global';
}

function shouldTryNextProxy(cfg, proxyOpts, attempt) {
  if (proxyOpts.forcedIndex != null || proxyOpts.forceDirect) return false;
  const raw = proxyRawBlock(cfg);
  if (!raw.enabled) return false;
  const servers = proxyServersFromConfig(cfg);
  if (servers.length <= 1) return false;
  const mode = String(raw.rotation || 'round-robin').toLowerCase();
  return mode === 'round-robin' && attempt + 1 < servers.length;
}

async function destroyContextOnly() {
  loggedIn = false;
  clearSessionProxy();
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  page = null;
  context = null;
}

async function openBrowserContext(cfg, proxyOpts) {
  if (!browser) {
    const headless = cfg.headless !== false;
    log.info(TAG, `Launching browser (headless=${headless})`);
    browser = await launchBrowser({ headless });
  }
  context = await newGameContext(browser, cfg, proxyOpts);
  lastDailyProxyPickKey = dailyProxyPickKey(cfg);
  page = await context.newPage();
  const label = proxyLogLabel(cfg);
  log.info(TAG, label === 'off' ? 'Browser context — direct (no proxy)' : `Browser context using proxy: ${label}`);
}

function proxyHostFromServer(server) {
  const s = String(server || '').trim();
  if (!s) return '';
  try {
    return new URL(s.includes('://') ? s : `http://${s}`).hostname;
  } catch {
    const m = s.match(/^(?:https?:\/\/)?([^:/]+)/i);
    return m ? m[1] : '';
  }
}

function enrichAccountWithProxy(account, cfg = loadConfig()) {
  const info = getProxyInfo(cfg);
  const proxyHost = proxyHostFromServer(info.server);
  const ip = account?.publicIp;
  const ipMatchesProxy = !!(
    info.configured
    && ip
    && proxyHost
    && (ip === proxyHost || ip.replace(/^\[|\]$/g, '') === proxyHost)
  );
  return {
    ...account,
    ipViaProxy: info.configured,
    activeProxyServer: info.server || '',
    activeProxyIndex: info.serverIndex ?? 0,
    activeProxyCount: info.serverCount || 0,
    activeProxyDisplay: info.display || '',
    ipMatchesProxy,
  };
}

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
  return enrichAccountWithProxy({ ...base, loggedIn: !!loggedIn }, cfg);
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

  accountCache = enrichAccountWithProxy({
    ...base,
    playerName: playerName || null,
    publicIp: ipResult.ip || null,
    ipError: ipResult.error || null,
    ipSource: ipResult.source || null,
    ipCheckedAt: new Date().toISOString(),
    loggedIn: true,
  }, cfg);

  if (accountCache.publicIp) {
    const via = accountCache.ipViaProxy
      ? `via proxy ${accountCache.activeProxyDisplay || accountCache.activeProxyServer}`
      : 'direct';
    log.info(TAG, `Outbound IP (${via}): ${accountCache.publicIp}`);
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

function proxyStoredInConfig(cfg = loadConfig()) {
  const raw = cfg?.proxy;
  if (!raw) return false;
  if (typeof raw === 'string' && raw.trim()) return true;
  const servers = parseProxyServerList(raw.server, raw.servers);
  if (servers.length) return true;
  if (String(raw.username || '').trim()) return true;
  if (raw.password != null && String(raw.password).length > 0) return true;
  if (String(raw.bypass || '').trim()) return true;
  return false;
}

function proxyRawBlock(cfg = loadConfig()) {
  const raw = cfg?.proxy;
  if (typeof raw === 'string' && raw.trim()) {
    return {
      enabled: true,
      server: raw.trim(),
      servers: [],
      rotation: 'round-robin',
      username: '',
      password: '',
      bypass: '',
    };
  }
  return raw && typeof raw === 'object' ? raw : {};
}

/** Proxy settings read from config.json (not the live browser session). */
function proxyConfigForApi() {
  const cfg = loadConfig();
  const raw = proxyRawBlock(cfg);
  const servers = proxyServersFromConfig(cfg);
  const serverIndex = servers.length > 1 ? readRotationIndex() % servers.length : 0;
  return {
    enabled: raw.enabled === true,
    server: servers[0] || normalizeProxyServer(String(raw.server || '').trim()),
    servers,
    serverCount: servers.length,
    serverIndex,
    rotation: String(raw.rotation || 'round-robin').toLowerCase(),
    username: String(raw.username || '').trim(),
    bypass: String(raw.bypass || '').trim(),
    hasPassword: raw.password != null && String(raw.password).length > 0,
    hasStored: proxyStoredInConfig(cfg),
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

async function ensureSession(options = {}) {
  const cfg = loadConfig();
  const proxyOpts = proxyPickForNow(cfg);
  const proxyKey = dailyProxyPickKey(cfg);
  const proxyAttempt = options.proxyAttempt || 0;

  if (options.freshContext && browser) {
    await destroyContextOnly();
  }

  if (browser && page && !page.isClosed() && loggedIn && !options.freshContext) {
    if (proxyKey !== lastDailyProxyPickKey) {
      log.info(TAG, `Daily schedule proxy changed (${lastDailyProxyPickKey} → ${proxyKey}) — reconnecting`);
      await destroyContextOnly();
    } else if (await sessionStillLoggedIn(page)) {
      return;
    } else {
      log.warn(TAG, 'Session expired — new context + proxy for re-login');
      await destroyContextOnly();
    }
  } else if (browser && proxyKey !== lastDailyProxyPickKey) {
    log.info(TAG, `Daily schedule proxy changed (${lastDailyProxyPickKey} → ${proxyKey}) — restarting browser`);
    await closeSession().catch(() => {});
  }

  try {
    if (!context || !page || page.isClosed()) {
      await openBrowserContext(cfg, proxyOpts);
    }
  } catch (err) {
    log.error(TAG, `Browser launch failed: ${networkErrorHint(err)}`);
    loggedIn = false;
    await closeSession().catch(() => {});
    return;
  }

  log.info(TAG, proxyAttempt > 0
    ? `Logging in (proxy attempt ${proxyAttempt + 1})`
    : 'Logging in');
  try {
    loggedIn = await login(page);
  } catch (err) {
    log.error(TAG, `Login error: ${networkErrorHint(err)}`);
    loggedIn = false;
  }

  if (!loggedIn && shouldTryNextProxy(cfg, proxyOpts, proxyAttempt)) {
    const total = proxyServersFromConfig(cfg).length;
    log.warn(TAG, `Login failed — rotating to next proxy (${proxyAttempt + 2}/${total})`);
    await destroyContextOnly();
    return ensureSession({ ...options, proxyAttempt: proxyAttempt + 1 });
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
  lastDailyProxyPickKey = null;
  clearSessionProxy();
  try { if (page && !page.isClosed()) await page.close(); } catch {}
  try { if (context) await context.close(); } catch {}
  try { if (browser) await browser.close(); } catch {}
  page = null;
  context = null;
  browser = null;
}

/** Close browser during pauses; reconnect when schedule proxy slot changes. */
async function syncBrowserSessionPolicy() {
  if (guiShuttingDown || lock.busy) return;

  const cfg = loadConfig();
  const proxyKey = dailyProxyPickKey(cfg);
  if (browser && lastDailyProxyPickKey != null && proxyKey !== lastDailyProxyPickKey) {
    log.info(TAG, `Daily schedule proxy changed (${lastDailyProxyPickKey} → ${proxyKey}) — closing browser`);
    clearBonusesPollCache();
    await closeSession();
    return;
  }

  const gate = automationWindowAllowed(cfg);
  if (gate.allowed || !browser) return;

  const msg = browserPauseStatusLine(gate);
  log.info(TAG, msg);
  clearBonusesPollCache();
  await closeSession();
}

function browserSessionForApi(cfg = loadConfig()) {
  const gate = automationWindowAllowed(cfg);
  const pauseLine = browserPauseStatusLine(gate);
  return {
    keepOpen: gate.allowed,
    pauseReason: gate.reason,
    statusLine: gate.allowed
      ? (loggedIn ? 'Connected' : 'Not logged in')
      : pauseLine,
  };
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
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return res.status(400).json({
      ok: false,
      message: 'Invalid JSON in request body. Hard-refresh the dashboard (Ctrl+F5) and click Save again.',
    });
  }
  next(err);
});

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
  res.json({
    ok: true,
    version: PKG_VERSION,
    features: GUI_FEATURES,
    busy: lock.busy,
    action: lock.current,
    loggedIn,
  });
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
    farmListConfig: farmListConfigForApi(cfg),
    farmListStatus: farmListStatusForApi(cfg),
    workSleepConfig: workSleepConfigForApi(cfg),
    workSleepStatus: workSleepGuiStatus(cfg),
    microPauseConfig: microPauseConfigForApi(cfg),
    microPauseStatus: microPauseGuiStatus(cfg),
    dailyScheduleConfig: dailyScheduleConfigForApi(cfg),
    dailyScheduleStatus: dailyScheduleGuiStatus(cfg),
    browserSession: browserSessionForApi(cfg),
  });
});

app.get('/api/config/proxy', (_req, res) => {
  try {
    res.json({ ok: true, proxy: proxyConfigForApi() });
  } catch (err) {
    log.error(TAG, `Proxy config read failed: ${err.message}`);
    res.status(500).json({
      ok: false,
      message: `Could not read config.json: ${err.message}`,
    });
  }
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

app.get('/api/config/daily-schedule', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    dailySchedule: dailyScheduleConfigForApi(cfg),
    dailyScheduleStatus: dailyScheduleGuiStatus(cfg),
  });
});

app.put('/api/config/daily-schedule', (req, res) => {
  try {
    const cfg = applyDailyScheduleFromBody(loadConfig(), req.body || {});
    saveConfig(cfg);
    syncBrowserSessionPolicy().catch(() => {});
    res.json({
      ok: true,
      dailySchedule: dailyScheduleConfigForApi(cfg),
      dailyScheduleStatus: dailyScheduleGuiStatus(cfg),
      message: cfg.dailySchedule?.enabled
        ? 'Daily schedule saved — farm list and bonus timers run only in enabled slots'
        : 'Daily schedule is off',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/config/work-sleep', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    workSleep: workSleepConfigForApi(cfg),
    workSleepStatus: workSleepGuiStatus(cfg),
  });
});

app.put('/api/config/work-sleep', (req, res) => {
  try {
    const cfg = applyWorkSleepConfigFromBody(loadConfig(), req.body || {});
    saveConfig(cfg);
    syncBrowserSessionPolicy().catch(() => {});
    res.json({
      ok: true,
      workSleep: workSleepConfigForApi(cfg),
      workSleepStatus: workSleepGuiStatus(cfg),
      message: cfg.workSleep?.enabled
        ? `Work/sleep ON — work ${cfg.workSleep.workMinutesMin}–${cfg.workSleep.workMinutesMax} min, sleep ${cfg.workSleep.sleepMinutesMin}–${cfg.workSleep.sleepMinutesMax} min`
        : 'Work/sleep rhythm is off',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.get('/api/config/micro-pause', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    microPause: microPauseConfigForApi(cfg),
    microPauseStatus: microPauseGuiStatus(cfg),
  });
});

app.put('/api/config/micro-pause', (req, res) => {
  try {
    const cfg = applyMicroPauseConfigFromBody(loadConfig(), req.body || {});
    saveConfig(cfg);
    res.json({
      ok: true,
      microPause: microPauseConfigForApi(cfg),
      microPauseStatus: microPauseGuiStatus(cfg),
      message: cfg.microPause?.enabled
        ? `Random stops ON — pause ${cfg.microPause.pauseMinutesMin}–${cfg.microPause.pauseMinutesMax} min every ${cfg.microPause.intervalMinutesMin}–${cfg.microPause.intervalMinutesMax} min`
        : 'Random stops off',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
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

app.get('/api/config/farm-list', (_req, res) => {
  const cfg = loadConfig();
  res.json({
    ok: true,
    farmList: farmListConfigForApi(cfg),
    farmListStatus: farmListStatusForApi(cfg),
  });
});

app.put('/api/config/farm-list', (req, res) => {
  if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
    return res.status(400).json({
      ok: false,
      message: 'Expected JSON object in request body. Hard-refresh the dashboard (Ctrl+F5) and try Save again.',
    });
  }
  try {
    const cfg = applyFarmListConfigFromBody(loadConfig(), req.body);
    saveConfig(cfg);
    syncEmbeddedFarmSchedulerAfterConfigSave();
    const fl = farmListSettings(cfg);
    const targets = farmListTargetCount(fl);
    res.json({
      ok: true,
      farmList: farmListConfigForApi(cfg),
      farmListStatus: farmListStatusForApi(cfg),
      message: fl.enabled && targets
        ? fl.sendAllMode
          ? `Farm list saved. Uses "Start all farm lists" (${fl.totalCount} total) each cycle, every ${fl.intervalMinutesMin}–${fl.intervalMinutesMax} min.`
          : `Farm list saved. Sends all ${fl.activeCount} checked list(s) each cycle (${fl.totalCount} total), every ${fl.intervalMinutesMin}–${fl.intervalMinutesMax} min.`
        : fl.enabled && fl.totalCount
          ? (fl.sendAllMode ? 'Farm list enabled — Start all mode will send every list on page.' : 'Farm list enabled — check at least one list and Save.')
          : fl.enabled
            ? 'Farm list enabled — load lists from game first.'
            : 'Farm list runner is off.',
    });
  } catch (err) {
    res.status(500).json({ ok: false, message: err.message });
  }
});

app.post('/api/farm-list/run-now', (_req, res) => {
  const cfg = loadConfig();
  const fl = farmListSettings(cfg);
  const targets = farmListTargetCount(fl);
  if (!fl.enabled) {
    return res.status(400).json({ ok: false, message: 'Turn on Farm list runner and Save first.' });
  }
  if (!targets) {
    return res.status(400).json({
      ok: false,
      message: fl.totalCount
        ? (fl.sendAllMode ? 'Load farm lists from game and Save.' : 'Check at least one farm list and Save.')
        : 'Load farm lists from game, check lists to include, and Save.',
    });
  }
  if (process.env.GUI_NO_SCHEDULER === '1') {
    return res.status(400).json({
      ok: false,
      message: 'Embedded schedulers disabled (GUI_NO_SCHEDULER=1). Use Send all once.',
    });
  }
  if (!embeddedFarmControl) syncEmbeddedFarmScheduler();
  if (!embeddedFarmControl) {
    return res.status(503).json({ ok: false, message: 'Farm list scheduler could not start. Check bot.log.' });
  }
  embeddedFarmControl.runNow = true;
  embeddedFarmControl.bypassSleepOnce = true;
  log.info(TAG, 'Farm list run-now requested from GUI');
  res.json({
    ok: true,
    message: 'Farm list send requested — starting as soon as possible.',
    farmListStatus: farmListStatusForApi(cfg),
  });
});

async function handleFarmListSendAll(_req, res) {
  const fl = farmListSettings();
  const targets = farmListTargetCount(fl);
  if (!targets) {
    return res.status(400).json({
      ok: false,
      message: fl.totalCount
        ? (fl.sendAllMode ? 'Load farm lists from game and Save.' : 'Check at least one farm list and Save.')
        : 'Load farm lists from game, check lists to include, and Save.',
    });
  }
  log.info(TAG, `Farm list send-all requested (${fl.sendAllMode ? `${fl.totalCount} total (start-all mode)` : `${fl.activeCount} checked`})`);
  const result = await runFarmListSendViaGui({ bypassSleep: true });
  res.json({
    ...result,
    farmListStatus: farmListStatusForApi(),
    workSleepStatus: workSleepGuiStatus(),
    totals: getTotals(),
  });
}

app.post('/api/farm-list/send-all', handleFarmListSendAll);
app.post('/api/farm-list/send-once', handleFarmListSendAll);

app.get('/api/farm-list/discover', async (_req, res) => {
  const result = await withSession('farmListDiscover', async (p) => {
    if (!(await openFarmListPage(p))) {
      return { ok: false, message: 'Farm list page not reachable' };
    }
    const entries = await readFarmListEntriesOnPage(p);
    const discovered = entries.map(e => e.name);
    const cfg = loadConfig();
    const lists = mergeFarmLists(cfg.farmList?.lists || [], discovered);
    const sendableCount = entries.filter(e => e.canSend).length;
    const prev = readFarmListState();
    writeFarmListState({
      ...prev,
      gameOrder: discovered,
      intervalMinutesMin: farmListSettings(cfg).intervalMinutesMin,
      intervalMinutesMax: farmListSettings(cfg).intervalMinutesMax,
    });
    return {
      ok: true,
      lists,
      entries,
      discoveredCount: discovered.length,
      sendableCount,
    };
  });
  res.json(result);
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
  embeddedScheduleControl.bypassSleepOnce = true;
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

app.post('/api/adventures/send', async (req, res) => {
  const index = req.body?.index;
  if (index == null || Number.isNaN(Number(index))) {
    return res.status(400).json({ ok: false, message: 'Missing adventure index' });
  }
  clearBonusesPollCache();
  const result = await withSession('sendAdventure', p => sendHeroOnAdventure(p, Number(index)));
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
      await ensureSession({ freshContext: true });
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
  const startupGate = automationWindowAllowed(loadConfig());
  if (startupGate.allowed) {
    try {
      await ensureSession();
    } catch (err) {
      log.error(TAG, `Startup login failed: ${err.message}`);
    }
  } else {
    log.info(TAG, browserPauseStatusLine(startupGate));
  }
  syncEmbeddedScheduler();
  syncEmbeddedFarmScheduler();
  if (process.env.OPEN_BROWSER !== '0') {
    openInBrowser(`http://${HOST}:${PORT}`);
  }
});

const SESSION_POLICY_MS = 30 * 1000;
setInterval(() => {
  if (guiShuttingDown) return;
  syncBrowserSessionPolicy().catch(err => {
    log.warn(TAG, `Session policy check: ${err.message}`);
  });
}, SESSION_POLICY_MS);

const SESSION_RECHECK_MS = 3 * 60 * 1000;
setInterval(() => {
  if (guiShuttingDown || lock.busy || !page || page.isClosed()) return;
  if (!shouldKeepBrowserOpen(loadConfig())) return;
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
  stopEmbeddedFarmScheduler();
  if (embeddedScheduleTask) {
    try { await embeddedScheduleTask; } catch { /* already logged */ }
  }
  if (embeddedFarmTask) {
    try { await embeddedFarmTask; } catch { /* already logged */ }
  }
  try { server.close(); } catch {}
  await closeSession();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
