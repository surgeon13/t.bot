'use strict';

/**
 * Farm list round-robin timer (independent from bonus schedule).
 * Waits a random interval between intervalMinutesMin and intervalMinutesMax.
 */

const log = require('./logger');
const { loadConfig } = require('./auth');
const { farmListSettings } = require('./farmList');
const {
  writeFarmListState,
  readFarmListState,
  randomNextRunAt,
} = require('./farmListState');

const TAG = 'farmSchedule';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function nextRunFromStateOrSoon() {
  const st = readFarmListState();
  if (st?.nextRunAt) {
    const at = new Date(st.nextRunAt);
    if (!Number.isNaN(at.getTime())) return at;
  }
  const s = farmListSettings();
  return randomNextRunAt(s.intervalMinutesMin, s.intervalMinutesMax);
}

/**
 * @param {Date} nextAt
 * @param {{ stop?: boolean, runNow?: boolean }} control
 */
async function waitUntilNextFarmRun(nextAt, control = {}) {
  while (nextAt.getTime() > Date.now()) {
    if (!farmListSettings().enabled) {
      log.info(TAG, 'farmList.enabled is false — stopping');
      return 'disabled';
    }
    if (control.stop) return 'stopped';
    if (control.runNow) {
      control.runNow = false;
      log.info(TAG, 'Starting farm list send now');
      return 'run';
    }
    const left = nextAt.getTime() - Date.now();
    await sleep(Math.min(60_000, Math.max(500, left)));
  }
  return 'due';
}

/**
 * @param {object} options
 * @param {() => Promise<object>} options.executeRun
 * @param {{ stop?: boolean, runNow?: boolean }} [options.control]
 */
async function runFarmListSchedulerLoop(options = {}) {
  const executeRun = options.executeRun;
  const control = options.control || {};

  if (!farmListSettings().enabled) return { reason: 'disabled' };
  if (!farmListSettings().lists.length) {
    log.warn(TAG, 'farmList.enabled but lists[] is empty');
    return { reason: 'disabled' };
  }

  const s = farmListSettings();
  let nextAt = nextRunFromStateOrSoon();
  if (!readFarmListState()?.lastRunAt) {
    nextAt = new Date();
  }

  for (;;) {
    if (!farmListSettings().enabled) return { reason: 'disabled' };
    if (!farmListSettings().lists.length) return { reason: 'disabled' };
    if (control.stop) return { reason: 'stopped' };

    const prev = readFarmListState();
    writeFarmListState({
      lastRunAt: prev?.lastRunAt ?? null,
      nextRunAt: nextAt.toISOString(),
      lastIndex: prev?.lastIndex ?? 0,
      lastListName: prev?.lastListName ?? null,
      intervalMinutesMin: s.intervalMinutesMin,
      intervalMinutesMax: s.intervalMinutesMax,
    });

    const waitResult = await waitUntilNextFarmRun(nextAt, control);
    if (waitResult === 'disabled') return { reason: 'disabled' };
    if (waitResult === 'stopped') return { reason: 'stopped' };

    await executeRun();
    if (control.stop) return { reason: 'stopped' };

    nextAt = nextRunFromStateOrSoon();
    const s2 = farmListSettings();
    Object.assign(s, s2);
  }
}

module.exports = {
  runFarmListSchedulerLoop,
  waitUntilNextFarmRun,
};
