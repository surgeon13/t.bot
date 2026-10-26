'use strict';

const fs = require('fs');
const { TRAINING_STATE_FILE: FILE } = require('./paths');
const { loadConfig } = require('./auth');
const { formatNextRunAt } = require('./scheduleState');
const { trainingSettings } = require('./troopsConfig');
const { automationWindowAllowed } = require('./sessionGate');
const { normalizeDailySchedule, nextActiveAt } = require('./dailySchedule');

let embeddedActive = false;

function setEmbeddedTrainingSchedulerActive(active) {
  embeddedActive = !!active;
}

function readTrainingState() {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeTrainingState(p = {}) {
  const prev = readTrainingState() || {};
  const keep = (k, d) => (p[k] !== undefined ? p[k] : (prev[k] ?? d));
  fs.writeFileSync(FILE, JSON.stringify({
    lastRunAt: keep('lastRunAt', null),
    nextRunAt: p.nextRunAt !== undefined ? p.nextRunAt : prev.nextRunAt,
    lastQueued: keep('lastQueued', 0),
    lastMessage: keep('lastMessage', null),
    lastVillages: keep('lastVillages', []),
    // Where round-robin got to, so the next cycle takes the following village.
    lastVillageDid: keep('lastVillageDid', null),
    intervalMinutesMin: keep('intervalMinutesMin', undefined),
    intervalMinutesMax: keep('intervalMinutesMax', undefined),
    updatedAt: new Date().toISOString(),
  }, null, 2));
}

function randomNextRunAt(minMinutes, maxMinutes) {
  const min = Math.max(1, Number(minMinutes) || 1);
  const max = Math.max(min, Number(maxMinutes) || min);
  return new Date(Date.now() + min * 60_000 + Math.random() * (max - min) * 60_000);
}

function postponeTrainingRun(cfg = loadConfig()) {
  const s = trainingSettings(cfg);
  const nextAt = randomNextRunAt(s.intervalMinutesMin, s.intervalMinutesMax);
  writeTrainingState({
    nextRunAt: nextAt.toISOString(),
    intervalMinutesMin: s.intervalMinutesMin,
    intervalMinutesMax: s.intervalMinutesMax,
  });
  return nextAt;
}

function trainingGuiStatus(cfg = loadConfig(), state = readTrainingState()) {
  const s = trainingSettings(cfg);
  const gate = automationWindowAllowed(cfg);
  const last = state?.lastMessage ? `last: ${state.lastMessage}` : '';

  let statusLine;
  if (!s.enabled) {
    statusLine = 'Training runner OFF';
  } else if (!s.activeBuildingCount) {
    statusLine = 'Enabled — no building has a troop name';
  } else if (!embeddedActive) {
    statusLine = `Enabled — ${s.activeBuildingCount} building(s) · timer not running`;
  } else if (!state?.nextRunAt) {
    statusLine = 'Starting…';
  } else if (!gate.allowed && gate.reason === 'daily-schedule') {
    const next = nextActiveAt(normalizeDailySchedule(cfg));
    const mins = next ? Math.max(0, Math.round((next.getTime() - Date.now()) / 60_000)) : null;
    statusLine = mins == null ? 'Off-hours — no daily schedule slots enabled'
      : `Off-hours · next slot ~${mins} min${last ? ` · ${last}` : ''}`;
  } else if (!gate.allowed && gate.reason === 'work-sleep') {
    statusLine = last ? `Work/sleep pause · ${last}` : 'Paused — work/sleep rest';
  } else {
    const at = formatNextRunAt(state.nextRunAt);
    statusLine = at === 'now / overdue'
      ? (last ? `Due now · ${last}` : 'Next check due now')
      : (last ? `Next check ${at} · ${last}` : `Next check: ${at}`);
  }

  return {
    enabled: s.enabled,
    dryRun: s.dryRun,
    roundRobin: s.roundRobin,
    villages: s.villages,
    activeVillageCount: s.activeVillageCount,
    buildings: s.buildings,
    activeBuildingCount: s.activeBuildingCount,
    intervalMinutesMin: s.intervalMinutesMin,
    intervalMinutesMax: s.intervalMinutesMax,
    nextRunAt: state?.nextRunAt || null,
    lastRunAt: state?.lastRunAt || null,
    lastQueued: state?.lastQueued ?? 0,
    lastMessage: state?.lastMessage || null,
    lastVillages: Array.isArray(state?.lastVillages) ? state.lastVillages : [],
    lastVillageDid: state?.lastVillageDid ?? null,
    statusLine,
    schedulerRunning: embeddedActive,
    pauseReason: gate.allowed ? null : gate.reason,
    scheduleResumeAt: (!gate.allowed && gate.reason === 'daily-schedule')
      ? (nextActiveAt(normalizeDailySchedule(cfg))?.toISOString() ?? null)
      : null,
  };
}

module.exports = {
  readTrainingState,
  writeTrainingState,
  randomNextRunAt,
  postponeTrainingRun,
  trainingGuiStatus,
  setEmbeddedTrainingSchedulerActive,
  STATE_FILE: FILE,
};
