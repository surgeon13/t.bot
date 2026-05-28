'use strict';

const fs = require('fs');
const { FARM_LIST_STATE_FILE: FILE } = require('./paths');
const { formatNextRunAt } = require('./scheduleState');

/** @type {boolean} */
let embeddedFarmSchedulerActive = false;

function setEmbeddedFarmSchedulerActive(active) {
  embeddedFarmSchedulerActive = !!active;
}

function readFarmListState() {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} p
 * @param {string} [p.lastRunAt]
 * @param {string} p.nextRunAt
 * @param {string} [p.lastListName]
 * @param {number} [p.lastIndex]
 * @param {number} p.intervalMinutesMin
 * @param {number} p.intervalMinutesMax
 */
function writeFarmListState(p) {
  const body = {
    lastRunAt: p.lastRunAt ?? null,
    nextRunAt: p.nextRunAt,
    lastListName: p.lastListName ?? null,
    lastIndex: p.lastIndex ?? 0,
    intervalMinutesMin: p.intervalMinutesMin,
    intervalMinutesMax: p.intervalMinutesMax,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(FILE, JSON.stringify(body, null, 2));
}

/** Random delay between min and max minutes (inclusive). */
function randomNextRunAt(minMinutes, maxMinutes) {
  const min = Math.max(1, Number(minMinutes) || 1);
  const max = Math.max(min, Number(maxMinutes) || min);
  const minMs = min * 60_000;
  const maxMs = max * 60_000;
  return new Date(Date.now() + minMs + Math.random() * (maxMs - minMs));
}

function farmListGuiStatus(cfg, state = readFarmListState()) {
  const fl = cfg.farmList || {};
  const enabled = !!fl.enabled;
  const lists = Array.isArray(fl.lists) ? fl.lists.filter(Boolean) : [];
  const min = Math.max(1, Number(fl.intervalMinutesMin) || 5);
  const max = Math.max(min, Number(fl.intervalMinutesMax) || 15);

  let statusLine;
  if (!enabled) {
    statusLine = 'Farm list runner OFF';
  } else if (!lists.length) {
    statusLine = 'Enabled — add at least one list name';
  } else if (!embeddedFarmSchedulerActive) {
    statusLine = 'Enabled — timer not running (Save or restart GUI)';
  } else if (!state?.nextRunAt) {
    statusLine = 'Starting…';
  } else {
    const at = formatNextRunAt(state.nextRunAt);
    const last = state.lastListName
      ? `last: ${state.lastListName}`
      : (state.lastRunAt ? `last run ${new Date(state.lastRunAt).toLocaleString()}` : '');
    if (at === 'now / overdue') {
      statusLine = last ? `Due now · ${last}` : 'Next send due now';
    } else if (at) {
      statusLine = last ? `Next send ${at} · ${last}` : `Next send: ${at}`;
    } else {
      statusLine = 'Next send time invalid';
    }
  }

  const nextIndex = state?.lastIndex != null && lists.length
    ? (Number(state.lastIndex) + 1) % lists.length
    : 0;

  return {
    enabled,
    listCount: lists.length,
    lists,
    intervalMinutesMin: min,
    intervalMinutesMax: max,
    nextRunAt: state?.nextRunAt || null,
    lastRunAt: state?.lastRunAt || null,
    lastListName: state?.lastListName || null,
    nextListName: lists[nextIndex] || null,
    nextIndex,
    statusLine,
    schedulerRunning: embeddedFarmSchedulerActive,
  };
}

module.exports = {
  readFarmListState,
  writeFarmListState,
  randomNextRunAt,
  farmListGuiStatus,
  setEmbeddedFarmSchedulerActive,
  STATE_FILE: FILE,
};
