'use strict';

/**
 * schedule-state.json is written by scheduler.js so the menu can show
 * when the next periodic run is expected (after a run ends + interval).
 */

const fs   = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'schedule-state.json');

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
function nextRunMenuLine() {
  const st = readScheduleState();
  if (!st || !st.nextRunAt) {
    return '  Next run       : (unknown – run `npm run schedule` in a 2nd terminal; time updates after each run)';
  }
  const when = new Date(st.nextRunAt);
  if (Number.isNaN(when.getTime())) {
    return '  Next run       : (invalid data in schedule-state.json)';
  }
  const now = new Date();
  if (when.getTime() <= now.getTime()) {
    return '  Next run       : now / overdue  (is `npm run schedule` still running?)';
  }
  return `  Next run       : ${when.toLocaleString()}`;
}

module.exports = { writeScheduleState, readScheduleState, nextRunMenuLine, STATE_FILE: FILE };
