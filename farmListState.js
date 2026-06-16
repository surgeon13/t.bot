'use strict';

const fs = require('fs');
const { FARM_LIST_STATE_FILE: FILE } = require('./paths');
const { loadConfig } = require('./auth');
const { formatNextRunAt } = require('./scheduleState');
const { farmListSettings } = require('./farmListConfig');
const { automationWindowAllowed } = require('./sessionGate');
const { normalizeDailySchedule, nextActiveAt } = require('./dailySchedule');

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
  const prev = readFarmListState() || {};
  const body = {
    lastRunAt: p.lastRunAt !== undefined ? p.lastRunAt : (prev.lastRunAt ?? null),
    nextRunAt: p.nextRunAt !== undefined ? p.nextRunAt : prev.nextRunAt,
    lastListName: p.lastListName !== undefined ? p.lastListName : (prev.lastListName ?? null),
    lastIndex: p.lastIndex !== undefined ? p.lastIndex : (prev.lastIndex ?? 0),
    intervalMinutesMin: p.intervalMinutesMin !== undefined
      ? p.intervalMinutesMin
      : prev.intervalMinutesMin,
    intervalMinutesMax: p.intervalMinutesMax !== undefined
      ? p.intervalMinutesMax
      : prev.intervalMinutesMax,
    gameOrder: p.gameOrder !== undefined ? p.gameOrder : prev.gameOrder,
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

/** Push next farm run into the future (e.g. after login skip). Returns the new Date. */
function postponeFarmListRun(minMinutes, maxMinutes, cfg = loadConfig()) {
  const settings = farmListSettings(cfg);
  const min = minMinutes != null ? minMinutes : settings.intervalMinutesMin;
  const max = maxMinutes != null ? maxMinutes : settings.intervalMinutesMax;
  const nextAt = randomNextRunAt(min, max);
  const prev = readFarmListState() || {};
  writeFarmListState({
    lastRunAt: prev.lastRunAt ?? null,
    nextRunAt: nextAt.toISOString(),
    lastIndex: prev.lastIndex ?? 0,
    lastListName: prev.lastListName ?? null,
    intervalMinutesMin: settings.intervalMinutesMin,
    intervalMinutesMax: settings.intervalMinutesMax,
    gameOrder: prev.gameOrder,
  });
  return nextAt;
}

function farmListGuiStatus(cfg, state = readFarmListState()) {
  const settings = farmListSettings(cfg, { gameOrder: state?.gameOrder });
  const { enabled, sendAllMode, allLists, lists: activeNames, activeCount, totalCount } = settings;
  const targetCount = sendAllMode ? totalCount : activeCount;
  const min = settings.intervalMinutesMin;
  const max = settings.intervalMinutesMax;

  let statusLine;
  if (!enabled) {
    statusLine = 'Farm list runner OFF';
  } else if (!totalCount) {
    statusLine = 'Enabled — load lists from game';
  } else if (!targetCount) {
    statusLine = sendAllMode
      ? 'Enabled — load lists from game'
      : `Enabled — 0/${totalCount} checked`;
  } else if (!embeddedFarmSchedulerActive) {
    statusLine = sendAllMode
      ? `Enabled — Start all mode (${totalCount} total) · timer not running`
      : `Enabled — ${activeCount}/${totalCount} checked · timer not running`;
  } else if (!state?.nextRunAt) {
    statusLine = 'Starting…';
  } else {
    const gate = automationWindowAllowed(cfg);
    const last = state.lastListName
      ? `last: ${state.lastListName}`
      : (state.lastRunAt ? `last run ${new Date(state.lastRunAt).toLocaleString()}` : '');
    if (!gate.allowed && gate.reason === 'daily-schedule') {
      const next = nextActiveAt(normalizeDailySchedule(cfg));
      if (next) {
        const mins = Math.max(0, Math.round((next.getTime() - Date.now()) / 60_000));
        const slot = next.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
        statusLine = mins <= 0
          ? (last ? `Waiting for schedule slot · ${last}` : 'Waiting for daily schedule slot')
          : (last ? `Off-hours · next slot ~${mins} min (${slot}) · ${last}` : `Off-hours · next slot ~${mins} min (${slot})`);
      } else {
        statusLine = last ? `Off-hours (no slots) · ${last}` : 'Off-hours — no daily schedule slots enabled';
      }
    } else if (!gate.allowed && gate.reason === 'work-sleep') {
      statusLine = last ? `Work/sleep pause · ${last}` : 'Paused — work/sleep rest';
    } else {
      const at = formatNextRunAt(state.nextRunAt);
      if (at === 'now / overdue') {
        statusLine = last ? `Due now · ${last}` : 'Next send due now';
      } else if (at) {
        statusLine = last ? `Next send ${at} · ${last}` : `Next send: ${at}`;
      } else {
        statusLine = 'Next send time invalid';
      }
    }
  }

  const nextListName = sendAllMode
    ? (totalCount ? `all ${totalCount} lists` : null)
    : (activeCount > 1 ? `all ${activeCount} checked` : (activeNames[0] || null));

  const gate = automationWindowAllowed(cfg);
  const scheduleResumeAt = (!gate.allowed && gate.reason === 'daily-schedule')
    ? (nextActiveAt(normalizeDailySchedule(cfg))?.toISOString() ?? null)
    : null;

  return {
    enabled,
    sendAllMode,
    listCount: targetCount,
    activeCount,
    totalCount,
    lists: allLists,
    intervalMinutesMin: min,
    intervalMinutesMax: max,
    nextRunAt: state?.nextRunAt || null,
    lastRunAt: state?.lastRunAt || null,
    lastListName: state?.lastListName || null,
    nextListName,
    nextIndex: 0,
    statusLine,
    schedulerRunning: embeddedFarmSchedulerActive,
    pauseReason: gate.allowed ? null : gate.reason,
    scheduleResumeAt,
  };
}

module.exports = {
  readFarmListState,
  writeFarmListState,
  randomNextRunAt,
  postponeFarmListRun,
  farmListGuiStatus,
  setEmbeddedFarmSchedulerActive,
  STATE_FILE: FILE,
};
