'use strict';

/**
 * The wait loop shared by the timed runners (marketplace, troop training,
 * granary): wait a random interval, honour the work/sleep, daily-schedule and
 * micro-pause gates, then run one cycle.
 *
 * The bonus and farm list schedulers predate this and keep their own copies.
 */

const log = require('./logger');
const { waitForWorkPhase, syncWorkSleepPhase } = require('./workSleep');
const { waitForMicroPause, syncMicroPause } = require('./microPause');
const { waitForDailyScheduleActive, isNowActive, normalizeDailySchedule } = require('./dailySchedule');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** @type {Map<string, number>} tag -> last "waiting for slot" log time */
const lastDailyWaitLogAt = new Map();

function logDailyWaitOnce(tag, label) {
  const now = Date.now();
  if (now - (lastDailyWaitLogAt.get(tag) || 0) < 60_000) return;
  lastDailyWaitLogAt.set(tag, now);
  log.info(tag, `${label} waiting for daily schedule active slot`);
}

/**
 * @param {object} o
 * @param {string} o.tag log tag
 * @param {string} o.label human name used in log lines
 * @param {Date} o.nextAt
 * @param {{stop?:boolean,runNow?:boolean}} o.control
 * @param {() => {enabled:boolean}} o.getSettings
 * @returns {Promise<'disabled'|'stopped'|'run'|'due'>}
 */
async function waitUntilNextRun({ tag, label, nextAt, control = {}, getSettings, options = {} }) {
  for (;;) {
    if (!getSettings().enabled) {
      log.info(tag, `${label} disabled — stopping`);
      return 'disabled';
    }
    if (control.stop) return 'stopped';
    if (control.runNow) {
      control.runNow = false;
      log.info(tag, `Starting ${label} now`);
      return 'run';
    }

    const ws = syncWorkSleepPhase();
    if (ws.settings.enabled && !ws.allowed) {
      if (await waitForWorkPhase(control, { bypass: options.bypassSleep }) === 'stopped') return 'stopped';
      continue;
    }

    const daily = normalizeDailySchedule();
    if (daily.enabled && !isNowActive(daily).active) {
      logDailyWaitOnce(tag, label);
      if ((await waitForDailyScheduleActive(control)).stopped) return 'stopped';
      continue;
    }

    const mp = syncMicroPause();
    if (mp.settings.enabled && !mp.allowed) {
      if (await waitForMicroPause(control, { bypass: options.bypassMicroPause }) === 'stopped') return 'stopped';
      continue;
    }

    if (nextAt.getTime() <= Date.now()) return 'due';
    await sleep(Math.min(60_000, Math.max(500, nextAt.getTime() - Date.now())));
  }
}

/**
 * Run `executeRun` on a random min–max minute interval until stopped or disabled.
 *
 * @param {object} o
 * @param {string} o.tag
 * @param {string} o.label
 * @param {{stop?:boolean,runNow?:boolean,bypassSleepOnce?:boolean}} [o.control]
 * @param {(opts:object) => Promise<any>} o.executeRun
 * @param {() => {enabled:boolean,intervalMinutesMin:number,intervalMinutesMax:number}} o.getSettings
 * @param {() => ({nextRunAt?:string,lastRunAt?:string}|null)} o.readState
 * @param {(p:object) => void} o.writeState
 * @param {() => Date} o.postpone
 * @param {(min:number,max:number) => Date} o.randomNextRunAt
 */
async function runIntervalSchedulerLoop(o) {
  const { tag, label, executeRun, getSettings, readState, writeState, postpone, randomNextRunAt } = o;
  const control = o.control || {};

  if (!getSettings().enabled) return { reason: 'disabled' };

  const fromStateOrSoon = () => {
    const st = readState();
    if (st?.nextRunAt) {
      const at = new Date(st.nextRunAt);
      if (!Number.isNaN(at.getTime())) return at;
    }
    const s = getSettings();
    return randomNextRunAt(s.intervalMinutesMin, s.intervalMinutesMax);
  };

  let nextAt = fromStateOrSoon();
  if (!readState()?.lastRunAt) nextAt = new Date();

  for (;;) {
    const cur = getSettings();
    if (!cur.enabled) return { reason: 'disabled' };
    if (control.stop) return { reason: 'stopped' };

    writeState({
      nextRunAt: nextAt.toISOString(),
      intervalMinutesMin: cur.intervalMinutesMin,
      intervalMinutesMax: cur.intervalMinutesMax,
    });

    const waited = await waitUntilNextRun({ tag, label, nextAt, control, getSettings });
    if (waited === 'disabled') return { reason: 'disabled' };
    if (waited === 'stopped') return { reason: 'stopped' };

    // A GUI "Run now" sets bypassSleepOnce — honour it for this cycle so an
    // explicitly requested run is not swallowed by a pause.
    let bypassSleep = false;
    if (control.bypassSleepOnce) {
      bypassSleep = true;
      control.bypassSleepOnce = false;
    }

    await executeRun({ bypassSleep, bypassAutomationGate: bypassSleep });
    if (control.stop) return { reason: 'stopped' };

    nextAt = fromStateOrSoon();
    if (nextAt.getTime() <= Date.now()) nextAt = postpone();
  }
}

module.exports = {
  runIntervalSchedulerLoop,
  waitUntilNextRun,
};
