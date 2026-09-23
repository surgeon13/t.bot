'use strict';

/**
 * Marketplace timer — scans the offers table each cycle, independent of the bonus
 * schedule. Waits a random interval between intervalMinutesMin and intervalMinutesMax,
 * and honours the same work/sleep, daily-schedule and micro-pause gates as the
 * farm list runner.
 */

const log = require('./logger');
const { marketplaceSettings } = require('./marketplaceConfig');
const {
  writeMarketplaceState,
  readMarketplaceState,
  randomNextRunAt,
  postponeMarketplaceRun,
} = require('./marketplaceState');
const { waitForWorkPhase, syncWorkSleepPhase } = require('./workSleep');
const { waitForMicroPause, syncMicroPause } = require('./microPause');
const { waitForDailyScheduleActive, isNowActive, normalizeDailySchedule } = require('./dailySchedule');

const TAG = 'marketSchedule';
let lastDailyWaitLogAt = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function logDailyWaitOnce() {
  const now = Date.now();
  if (now - lastDailyWaitLogAt < 60_000) return;
  lastDailyWaitLogAt = now;
  log.info(TAG, 'Marketplace waiting for daily schedule active slot');
}

function nextRunFromStateOrSoon() {
  const st = readMarketplaceState();
  if (st?.nextRunAt) {
    const at = new Date(st.nextRunAt);
    if (!Number.isNaN(at.getTime())) return at;
  }
  const s = marketplaceSettings();
  return randomNextRunAt(s.intervalMinutesMin, s.intervalMinutesMax);
}

/**
 * @param {Date} nextAt
 * @param {{ stop?: boolean, runNow?: boolean }} control
 * @returns {Promise<'disabled'|'stopped'|'run'|'due'>}
 */
async function waitUntilNextMarketplaceRun(nextAt, control = {}, options = {}) {
  for (;;) {
    if (!marketplaceSettings().enabled) {
      log.info(TAG, 'marketplace.enabled is false — stopping');
      return 'disabled';
    }
    if (control.stop) return 'stopped';
    if (control.runNow) {
      control.runNow = false;
      log.info(TAG, 'Starting marketplace scan now');
      return 'run';
    }

    const sync = syncWorkSleepPhase();
    if (sync.settings.enabled && !sync.allowed) {
      const wr = await waitForWorkPhase(control, { bypass: options.bypassSleep });
      if (wr === 'stopped') return 'stopped';
      continue;
    }

    const daily = normalizeDailySchedule();
    if (daily.enabled && !isNowActive(daily).active) {
      logDailyWaitOnce();
      const dr = await waitForDailyScheduleActive(control);
      if (dr.stopped) return 'stopped';
      continue;
    }

    const mp = syncMicroPause();
    if (mp.settings.enabled && !mp.allowed) {
      const mr = await waitForMicroPause(control, { bypass: options.bypassMicroPause });
      if (mr === 'stopped') return 'stopped';
      continue;
    }

    if (nextAt.getTime() <= Date.now()) return 'due';

    const left = nextAt.getTime() - Date.now();
    await sleep(Math.min(60_000, Math.max(500, left)));
  }
}

/**
 * @param {object} options
 * @param {() => Promise<object>} options.executeRun
 * @param {{ stop?: boolean, runNow?: boolean }} [options.control]
 */
async function runMarketplaceSchedulerLoop(options = {}) {
  const executeRun = options.executeRun;
  const control = options.control || {};

  const settings = marketplaceSettings();
  if (!settings.enabled) return { reason: 'disabled' };

  let nextAt = nextRunFromStateOrSoon();
  if (!readMarketplaceState()?.lastRunAt) {
    nextAt = new Date();
  }

  for (;;) {
    const cur = marketplaceSettings();
    if (!cur.enabled) return { reason: 'disabled' };
    if (control.stop) return { reason: 'stopped' };

    writeMarketplaceState({
      nextRunAt: nextAt.toISOString(),
      intervalMinutesMin: cur.intervalMinutesMin,
      intervalMinutesMax: cur.intervalMinutesMax,
    });

    const waitResult = await waitUntilNextMarketplaceRun(nextAt, control);
    if (waitResult === 'disabled') return { reason: 'disabled' };
    if (waitResult === 'stopped') return { reason: 'stopped' };

    // A GUI "Run now" sets bypassSleepOnce — honour it for this one cycle so an
    // explicitly requested scan is not swallowed by a work/sleep or off-hours pause.
    let bypassSleep = false;
    if (control.bypassSleepOnce) {
      bypassSleep = true;
      control.bypassSleepOnce = false;
    }

    await executeRun({ bypassSleep, bypassAutomationGate: bypassSleep });
    if (control.stop) return { reason: 'stopped' };

    nextAt = nextRunFromStateOrSoon();
    if (nextAt.getTime() <= Date.now()) {
      nextAt = postponeMarketplaceRun();
    }
  }
}

module.exports = {
  runMarketplaceSchedulerLoop,
  waitUntilNextMarketplaceRun,
};
