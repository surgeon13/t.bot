'use strict';

/**
 * data/schedule-state.json is written by scheduler.js so the menu can show
 * when the next periodic run is expected (after a run ends + interval).
 */

const fs   = require('fs');
const path = require('path');

const { SCHEDULE_STATE_FILE: FILE } = require('./paths');

/**
 * @param {object} p
 * @param {string} [p.lastRunAt] ISO
 * @param {string} p.nextRunAt  ISO
 * @param {number} p.intervalHours
 */
function writeScheduleState(p) {
  const body = {
    lastRunAt:     p.lastRunAt ?? null,
    nextRunAt:     p.nextRunAt,
    intervalHours: p.intervalHours,
    updatedAt:     new Date().toISOString(),
  };
  fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
}

function readScheduleState() {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * One line for the main menu: human-readable next run, or a hint to start the scheduler.
 */
function formatNextRunAt(iso) {
  if (!iso) return null;
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return null;
  if (when.getTime() <= Date.now()) return 'now / overdue';
  return when.toLocaleString();
}

function nextRunMenuLine() {
  const st = readScheduleState();
  if (!st || !st.nextRunAt) {
    return '  Next run       : (unknown – run `npm run schedule` in a 2nd terminal; time updates after each run)';
  }
  const formatted = formatNextRunAt(st.nextRunAt);
  if (!formatted) {
    return '  Next run       : (invalid data in schedule-state.json)';
  }
  if (formatted === 'now / overdue') {
    return '  Next run       : now / overdue  (is `npm run schedule` still running?)';
  }
  return `  Next run       : ${formatted}`;
}

/**
 * Human-readable scheduler lines for the GUI (config + schedule-state.json).
 * @param {object} cfg loadConfig() shape
 * @param {object|null} [resourceState] resource-bonus-state.json contents
 */
/** @type {boolean} Set by gui.js when the embedded scheduler loop is active */
let embeddedSchedulerActive = false;

function setEmbeddedSchedulerActive(active) {
  embeddedSchedulerActive = !!active;
}

function scheduleGuiStatus(cfg, resourceState = null) {
  const sch = cfg.schedule || { enabled: false, intervalHours: 3 };
  const res = cfg.resourceBonuses || { enabled: false, intervalHours: 8 };
  const st = readScheduleState();

  let periodicLine;
  if (!sch.enabled) {
    periodicLine = 'Periodic claims OFF';
  } else if (!embeddedSchedulerActive) {
    periodicLine = 'Enabled but scheduler not running — restart GUI or Save again';
  } else if (!st?.nextRunAt) {
    periodicLine = 'Scheduler starting…';
  } else {
    const at = formatNextRunAt(st.nextRunAt);
    const last = st.lastRunAt ? new Date(st.lastRunAt).toLocaleString() : null;
    if (at === 'now / overdue') {
      periodicLine = last ? `Due now · last check ${last}` : 'Full bonus run due now';
    } else if (at) {
      periodicLine = last ? `Next check ${at} · last ${last}` : `Next full run: ${at}`;
    } else {
      periodicLine = 'Next run time invalid in schedule-state.json';
    }
  }

  let resourceLine;
  if (!res.enabled) {
    resourceLine = 'Resource auto-claim OFF';
  } else if (!resourceState?.nextRunAt) {
    resourceLine = 'Resources due now (no timer yet)';
  } else {
    const at = formatNextRunAt(resourceState.nextRunAt);
    if (at === 'now / overdue') resourceLine = 'Resource batch due now';
    else if (at) resourceLine = `Next resource batch: ${at}`;
    else resourceLine = 'Resource timer invalid';
  }

  return {
    periodicEnabled: !!sch.enabled,
    periodicIntervalHours: Math.max(0.25, Number(sch.intervalHours) || 3),
    resourceEnabled: !!res.enabled,
    resourceIntervalHours: Math.max(0.25, Number(res.intervalHours) || 8),
    periodicNextAt: st?.nextRunAt || null,
    periodicLine,
    resourceNextAt: resourceState?.nextRunAt || null,
    resourceLine,
    lastRunAt: st?.lastRunAt || null,
    schedulerRunning: embeddedSchedulerActive,
  };
}

module.exports = {
  writeScheduleState,
  readScheduleState,
  nextRunMenuLine,
  scheduleGuiStatus,
  setEmbeddedSchedulerActive,
  formatNextRunAt,
  STATE_FILE: FILE,
};
