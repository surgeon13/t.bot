'use strict';

/**
 * When automation is allowed to run (work/sleep + daily schedule gates).
 */

const { loadConfig } = require('./auth');
const { syncWorkSleepPhase } = require('./workSleep');
const { normalizeDailySchedule, isNowActive } = require('./dailySchedule');

/**
 * @returns {{ allowed: boolean, reason: 'work-sleep'|'daily-schedule'|null, phase?: string }}
 */
function automationWindowAllowed(cfg = loadConfig()) {
  const ws = syncWorkSleepPhase(cfg);
  if (ws.settings.enabled && !ws.allowed) {
    return { allowed: false, reason: 'work-sleep', phase: ws.phase };
  }

  const daily = normalizeDailySchedule(cfg);
  if (daily.enabled && !isNowActive(daily).active) {
    return { allowed: false, reason: 'daily-schedule' };
  }

  return { allowed: true, reason: null };
}

function shouldKeepBrowserOpen(cfg = loadConfig()) {
  return automationWindowAllowed(cfg).allowed;
}

function browserPauseStatusLine(gate) {
  if (gate.allowed) return null;
  if (gate.reason === 'work-sleep') return 'Browser closed — work/sleep pause';
  if (gate.reason === 'daily-schedule') return 'Browser closed — daily schedule off-hours';
  return 'Browser closed — automation paused';
}

module.exports = {
  automationWindowAllowed,
  shouldKeepBrowserOpen,
  browserPauseStatusLine,
};
