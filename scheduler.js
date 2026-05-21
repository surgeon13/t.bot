'use strict';

/**
 * Runs runClaimAllBonuses() in a loop, waiting schedule.intervalHours between runs.
 * Resource bonuses keep a separate due time and can pull the next run earlier.
 * Start with: npm run schedule
 * Enable / change interval in config (or menu [S]) - schedule.enabled and schedule.intervalHours
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
 * Wait for the next run, checking config and terminal commands along the way.
 */
async function waitUntilNextRun(nextAt, control) {
  while (nextAt.getTime() > Date.now()) {
    if (!loadConfig().schedule?.enabled) {
      log.info(TAG, 'schedule.enabled is false - stopping scheduler');
      process.exit(0);
    }

    const left = nextAt.getTime() - Date.now();
    const step = Math.min(60_000, left);
    const result = control ? await control.wait(step) : await sleep(step);
    if (result === 'run') {
      log.info(TAG, 'Starting next run now');
      return;
    }
  }
}

async function main() {
  const initial = loadConfig();
  if (!initial.schedule?.enabled) {
    log.info(TAG, 'schedule.enabled is false - turn it on in Settings (S), or set schedule.enabled in config.json');
    log.info(TAG, 'Then run: npm run schedule');
    process.exit(0);
  }

  const h0 = intervalHours();
  let phase = 'starting';
  let nextAtForStatus = null;
  const control = createTerminalControl({
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
  const detachControl = control.attachStdin();

  try {
    writeScheduleState({
      lastRunAt: null,
      nextRunAt: new Date().toISOString(),
      intervalHours: h0,
    });

    for (;;) {
      if (!loadConfig().schedule?.enabled) {
        log.info(TAG, 'schedule disabled - stopping');
        process.exit(0);
      }

      const h = intervalHours();
      phase = 'running';
      nextAtForStatus = null;
      await runClaimAllBonuses();
      if (control.stopRequested) break;

      const nextAt = nextSchedulerRunAt(h);
      phase = 'waiting';
      nextAtForStatus = nextAt;
      writeScheduleState({
        lastRunAt: new Date().toISOString(),
        nextRunAt: nextAt.toISOString(),
        intervalHours: h,
      });
      await waitUntilNextRun(nextAt, control);
      if (control.stopRequested) break;
    }
  } catch (err) {
    if (!isTaskInterrupted(err)) throw err;
    process.exit(0);
  } finally {
    detachControl();
  }
}

main().catch(err => {
  log.error(TAG, err.message);
  process.exit(1);
});
