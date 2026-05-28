'use strict';

/**
 * Runs bonus claims on a timer (schedule.intervalHours).
 * Resource bonuses can pull the next run earlier via resource-bonus-state.json.
 *
 * CLI: npm run schedule
 * GUI: started automatically when schedule.enabled is true (see gui.js).
 */

const log = require('./logger');
const { loadConfig } = require('./auth');
const { runClaimAllBonuses } = require('./claimJob');
const { writeScheduleState } = require('./scheduleState');
const { readResourceBonusState, resourceBonusSettings } = require('./resourceBonuses');
const { createTerminalControl, isTaskInterrupted } = require('./terminalControl');
const { getLastCompletedBonus } = require('./runState');

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const TAG = 'schedule';

function intervalHours() {
  return Math.max(0.25, Number(loadConfig().schedule?.intervalHours) || 3);
}

function nextResourceRunAt() {
  const cfg = loadConfig();
  if (!resourceBonusSettings(cfg).enabled) return null;

  const state = readResourceBonusState();
  if (!state?.nextRunAt) return null;

  const next = new Date(state.nextRunAt);
  return Number.isNaN(next.getTime()) ? null : next;
}

function nextSchedulerRunAt(h) {
  const normal = new Date(Date.now() + h * 60 * 60 * 1000);
  const resource = nextResourceRunAt();
  if (resource && resource.getTime() < normal.getTime()) return resource;
  return normal;
}

/**
 * @param {Date} nextAt
 * @param {{ stop?: boolean, runNow?: boolean, terminal?: object }} control
 * @returns {Promise<'due'|'run'|'disabled'|'stopped'>}
 */
async function waitUntilNextRun(nextAt, control = {}) {
  while (nextAt.getTime() > Date.now()) {
    if (!loadConfig().schedule?.enabled) {
      log.info(TAG, 'schedule.enabled is false - stopping scheduler');
      return 'disabled';
    }
    if (control.stop) return 'stopped';
    if (control.runNow) {
      control.runNow = false;
      log.info(TAG, 'Starting next run now');
      return 'run';
    }

    const left = nextAt.getTime() - Date.now();
    const step = Math.min(60_000, left);
    if (control.terminal) {
      const result = await control.terminal.wait(step);
      if (result === 'run') {
        log.info(TAG, 'Starting next run now');
        return 'run';
      }
      if (control.stop || control.terminal.stopRequested) return 'stopped';
    } else {
      await sleep(step);
    }
  }
  return 'due';
}

/**
 * @param {object} [options]
 * @param {() => Promise<number>} [options.executeRun] Defaults to runClaimAllBonuses (own browser).
 * @param {{ stop?: boolean, runNow?: boolean, terminal?: object }} [options.control]
 * @param {boolean} [options.attachStdin] Attach terminal commands (CLI only).
 * @returns {Promise<{ reason: string }>}
 */
async function runSchedulerLoop(options = {}) {
  const executeRun = options.executeRun || runClaimAllBonuses;
  const control = options.control || {};
  const attachStdin = options.attachStdin !== false && !options.control?.terminal;

  if (!loadConfig().schedule?.enabled) {
    return { reason: 'disabled' };
  }

  const h0 = intervalHours();
  let phase = 'starting';
  let nextAtForStatus = null;
  let terminal = control.terminal;
  let detachControl = () => {};

  if (attachStdin) {
    terminal = createTerminalControl({
      tag: TAG,
      allowRunNow: true,
      status: () => {
        if (phase === 'waiting' && nextAtForStatus) {
          return [
            'STATUS MODE',
            '-------------',
            `Scheduler is ${phase}.`,
            `Next run at: ${nextAtForStatus?.toLocaleString() ?? 'N/A'}`,
            `Last completed bonus: ${getLastCompletedBonus()}`,
            '',
            'Type stop to exit, run/now to trigger the next run immediately.',
          ];
        }
        return [
          'STATUS MODE',
          '-------------',
          `Scheduler is ${phase}.`,
          `Last completed bonus: ${getLastCompletedBonus()}`,
          '',
          'Type stop to exit, run/now to trigger the next run immediately.',
        ];
      },
    });
    control.terminal = terminal;
    detachControl = terminal.attachStdin();
  }

  try {
    writeScheduleState({
      lastRunAt: null,
      nextRunAt: new Date().toISOString(),
      intervalHours: h0,
    });

    for (;;) {
      if (!loadConfig().schedule?.enabled) {
        log.info(TAG, 'schedule disabled - stopping');
        return { reason: 'disabled' };
      }
      if (control.stop) return { reason: 'stopped' };

      const h = intervalHours();
      phase = 'running';
      nextAtForStatus = null;
      await executeRun();
      if (control.stop || terminal?.stopRequested) return { reason: 'stopped' };

      const nextAt = nextSchedulerRunAt(h);
      phase = 'waiting';
      nextAtForStatus = nextAt;
      writeScheduleState({
        lastRunAt: new Date().toISOString(),
        nextRunAt: nextAt.toISOString(),
        intervalHours: h,
      });

      const waitResult = await waitUntilNextRun(nextAt, control);
      if (waitResult === 'disabled') return { reason: 'disabled' };
      if (waitResult === 'stopped') return { reason: 'stopped' };
    }
  } catch (err) {
    if (!isTaskInterrupted(err)) throw err;
    return { reason: 'stopped' };
  } finally {
    detachControl();
  }
}

async function main() {
  const initial = loadConfig();
  if (!initial.schedule?.enabled) {
    log.info(TAG, 'schedule.enabled is false - turn it on in Settings (S), or set schedule.enabled in config.json');
    log.info(TAG, 'Then run: npm run schedule  (or use npm run gui with periodic claims ON)');
    process.exit(0);
  }

  const result = await runSchedulerLoop({ attachStdin: true });
  if (result.reason === 'disabled' || result.reason === 'stopped') {
    process.exit(0);
  }
}

if (require.main === module) {
  main().catch(err => {
    log.error(TAG, err.message);
    process.exit(1);
  });
}

module.exports = {
  runSchedulerLoop,
  intervalHours,
  nextSchedulerRunAt,
  waitUntilNextRun,
};
