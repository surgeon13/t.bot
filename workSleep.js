'use strict';

/**
 * Work / sleep rhythm — pauses automated tasks during sleep windows.
 * Durations are random between configured min/max (minutes).
 */

const fs = require('fs');
const log = require('./logger');
const { loadConfig } = require('./auth');
const { WORK_SLEEP_STATE_FILE: FILE } = require('./paths');
const { formatNextRunAt } = require('./scheduleState');

const TAG = 'workSleep';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampMinutes(value, fallback = 1) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.floor(n);
}

function workSleepSettings(cfg = loadConfig()) {
  const ws = cfg.workSleep || {};
  const workMinutesMin = clampMinutes(ws.workMinutesMin, 30);
  const workMinutesMax = Math.max(workMinutesMin, clampMinutes(ws.workMinutesMax, 60));
  const sleepMinutesMin = clampMinutes(ws.sleepMinutesMin, 15);
  const sleepMinutesMax = Math.max(sleepMinutesMin, clampMinutes(ws.sleepMinutesMax, 45));
  return {
    enabled: !!ws.enabled,
    workMinutesMin,
    workMinutesMax,
    sleepMinutesMin,
    sleepMinutesMax,
  };
}

function randomPhaseEndAt(minMinutes, maxMinutes) {
  const minMs = minMinutes * 60_000;
  const maxMs = maxMinutes * 60_000;
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Date(Date.now() + delay);
}

function readWorkSleepState() {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeWorkSleepState(body) {
  const prev = readWorkSleepState() || {};
  const out = {
    ...prev,
    ...body,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
  return out;
}

/** Start (or restart) a work phase with a fresh random duration. */
function startWorkPhase(cfg = loadConfig()) {
  const s = workSleepSettings(cfg);
  const ends = randomPhaseEndAt(s.workMinutesMin, s.workMinutesMax);
  const st = writeWorkSleepState({
    phase: 'work',
    phaseEndsAt: ends.toISOString(),
  });
  log.info(TAG, `Work phase until ${ends.toLocaleString()} (${s.workMinutesMin}–${s.workMinutesMax} min)`);
  return st;
}

/**
 * Advance phase if the current window expired; persist state.
 * @returns {{ phase: 'work'|'sleep', phaseEndsAt: string|null, allowed: boolean, settings: object }}
 */
function syncWorkSleepPhase(cfg = loadConfig()) {
  const settings = workSleepSettings(cfg);
  if (!settings.enabled) {
    return { phase: 'work', phaseEndsAt: null, allowed: true, settings };
  }

  let st = readWorkSleepState();
  const now = Date.now();

  if (!st?.phase || !st.phaseEndsAt) {
    st = startWorkPhase(cfg);
    return {
      phase: st.phase,
      phaseEndsAt: st.phaseEndsAt,
      allowed: true,
      settings,
    };
  }

  let phase = st.phase === 'sleep' ? 'sleep' : 'work';
  let phaseEndsAt = st.phaseEndsAt;

  for (let guard = 0; guard < 24; guard++) {
    const ends = new Date(phaseEndsAt);
    if (Number.isNaN(ends.getTime())) {
      st = startWorkPhase(cfg);
      return {
        phase: st.phase,
        phaseEndsAt: st.phaseEndsAt,
        allowed: true,
        settings,
      };
    }
    if (ends.getTime() > now) break;

    if (phase === 'work') {
      phase = 'sleep';
      const next = randomPhaseEndAt(settings.sleepMinutesMin, settings.sleepMinutesMax);
      phaseEndsAt = next.toISOString();
      log.info(
        TAG,
        `Work ended — sleep until ${next.toLocaleString()} (${settings.sleepMinutesMin}–${settings.sleepMinutesMax} min)`,
      );
    } else {
      phase = 'work';
      const next = randomPhaseEndAt(settings.workMinutesMin, settings.workMinutesMax);
      phaseEndsAt = next.toISOString();
      log.info(
        TAG,
        `Sleep ended — work until ${next.toLocaleString()} (${settings.workMinutesMin}–${settings.workMinutesMax} min)`,
      );
    }
  }

  if (phase !== st.phase || phaseEndsAt !== st.phaseEndsAt) {
    writeWorkSleepState({ phase, phaseEndsAt });
  }

  return {
    phase,
    phaseEndsAt,
    allowed: phase === 'work',
    settings,
  };
}

/**
 * Block until automation is allowed (work phase), or return early on stop.
 * @param {{ stop?: boolean }} [control]
 * @param {{ bypass?: boolean }} [options] Manual actions may bypass sleep.
 * @returns {Promise<'work'|'stopped'>}
 */
async function waitForWorkPhase(control = {}, options = {}) {
  if (options.bypass) return 'work';

  for (;;) {
    const sync = syncWorkSleepPhase();
    if (!sync.settings.enabled || sync.allowed) return 'work';
    if (control.stop) return 'stopped';

    const ends = new Date(sync.phaseEndsAt);
    const left = ends.getTime() - Date.now();
    const mins = Math.max(1, Math.ceil(left / 60_000));
    log.info(TAG, `Sleeping — automation paused (~${mins} min left)`);
    await sleep(Math.min(60_000, Math.max(500, left)));
  }
}

function workSleepConfigForApi(cfg = loadConfig()) {
  const s = workSleepSettings(cfg);
  return {
    enabled: s.enabled,
    workMinutesMin: s.workMinutesMin,
    workMinutesMax: s.workMinutesMax,
    sleepMinutesMin: s.sleepMinutesMin,
    sleepMinutesMax: s.sleepMinutesMax,
  };
}

function workSleepGuiStatus(cfg = loadConfig()) {
  const settings = workSleepSettings(cfg);
  if (!settings.enabled) {
    return {
      enabled: false,
      phase: null,
      phaseEndsAt: null,
      allowed: true,
      ...settings,
      statusLine: 'Work/sleep OFF',
    };
  }

  const sync = syncWorkSleepPhase(cfg);
  const until = formatNextRunAt(sync.phaseEndsAt);
  const statusLine = sync.phase === 'work'
    ? (until && until !== 'now / overdue'
      ? `Working · until ${until}`
      : 'Working')
    : (until && until !== 'now / overdue'
      ? `Sleeping · automation paused · until ${until}`
      : 'Sleeping · automation paused');

  return {
    enabled: true,
    phase: sync.phase,
    phaseEndsAt: sync.phaseEndsAt,
    allowed: sync.allowed,
    workMinutesMin: settings.workMinutesMin,
    workMinutesMax: settings.workMinutesMax,
    sleepMinutesMin: settings.sleepMinutesMin,
    sleepMinutesMax: settings.sleepMinutesMax,
    statusLine,
  };
}

function applyWorkSleepConfigFromBody(cfg, body = {}) {
  if (!cfg.workSleep) {
    cfg.workSleep = {
      enabled: false,
      workMinutesMin: 30,
      workMinutesMax: 60,
      sleepMinutesMin: 15,
      sleepMinutesMax: 45,
    };
  }
  if (typeof body.enabled === 'boolean') cfg.workSleep.enabled = body.enabled;

  const fields = [
    'workMinutesMin',
    'workMinutesMax',
    'sleepMinutesMin',
    'sleepMinutesMax',
  ];
  for (const key of fields) {
    if (body[key] == null) continue;
    const n = Number(body[key]);
    if (!Number.isNaN(n) && n >= 1) cfg.workSleep[key] = Math.floor(n);
  }

  const s = workSleepSettings(cfg);
  cfg.workSleep.workMinutesMin = s.workMinutesMin;
  cfg.workSleep.workMinutesMax = s.workMinutesMax;
  cfg.workSleep.sleepMinutesMin = s.sleepMinutesMin;
  cfg.workSleep.sleepMinutesMax = s.sleepMinutesMax;

  if (cfg.workSleep.enabled) startWorkPhase(cfg);
  return cfg;
}

module.exports = {
  workSleepSettings,
  syncWorkSleepPhase,
  waitForWorkPhase,
  startWorkPhase,
  readWorkSleepState,
  writeWorkSleepState,
  workSleepConfigForApi,
  workSleepGuiStatus,
  applyWorkSleepConfigFromBody,
};
