'use strict';

/**
 * Random short strict stops — pauses automation briefly from time to time.
 */

const fs = require('fs');
const log = require('./logger');
const { loadConfig } = require('./auth');
const { MICRO_PAUSE_STATE_FILE: FILE } = require('./paths');
const { formatNextRunAt } = require('./scheduleState');

const TAG = 'microPause';

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampMinutes(value, fallback = 1) {
  const n = Number(value);
  if (Number.isNaN(n) || n < 1) return fallback;
  return Math.floor(n);
}

function microPauseSettings(cfg = loadConfig()) {
  const mp = cfg.microPause || {};
  const pauseMinutesMin = clampMinutes(mp.pauseMinutesMin, 2);
  const pauseMinutesMax = Math.max(pauseMinutesMin, clampMinutes(mp.pauseMinutesMax, 5));
  const intervalMinutesMin = clampMinutes(mp.intervalMinutesMin, 20);
  const intervalMinutesMax = Math.max(intervalMinutesMin, clampMinutes(mp.intervalMinutesMax, 45));
  return {
    enabled: !!mp.enabled,
    pauseMinutesMin,
    pauseMinutesMax,
    intervalMinutesMin,
    intervalMinutesMax,
  };
}

function randomDelayEndAt(minMinutes, maxMinutes) {
  const minMs = minMinutes * 60_000;
  const maxMs = maxMinutes * 60_000;
  const delay = minMs + Math.random() * (maxMs - minMs);
  return new Date(Date.now() + delay);
}

function readMicroPauseState() {
  try {
    if (!fs.existsSync(FILE)) return null;
    return JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch {
    return null;
  }
}

function writeMicroPauseState(body) {
  const prev = readMicroPauseState() || {};
  const out = {
    ...prev,
    ...body,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(FILE, JSON.stringify(out, null, 2));
  return out;
}

function armNextPause(settings) {
  const nextAt = randomDelayEndAt(settings.intervalMinutesMin, settings.intervalMinutesMax);
  const st = writeMicroPauseState({
    pauseEndsAt: null,
    nextPauseAt: nextAt.toISOString(),
  });
  log.info(TAG, `Next random stop ~${nextAt.toLocaleString()} (${settings.intervalMinutesMin}–${settings.intervalMinutesMax} min)`);
  return st;
}

/** Reset timer when feature is enabled from config. */
function startMicroPauseSchedule(cfg = loadConfig()) {
  const s = microPauseSettings(cfg);
  return armNextPause(s);
}

/**
 * @returns {{ allowed: boolean, inPause: boolean, pauseEndsAt: string|null, nextPauseAt: string|null, settings: object }}
 */
function syncMicroPause(cfg = loadConfig()) {
  const settings = microPauseSettings(cfg);
  if (!settings.enabled) {
    return {
      allowed: true,
      inPause: false,
      pauseEndsAt: null,
      nextPauseAt: null,
      settings,
    };
  }

  let st = readMicroPauseState() || {};
  const now = Date.now();

  if (st.pauseEndsAt) {
    const endMs = new Date(st.pauseEndsAt).getTime();
    if (!Number.isNaN(endMs) && endMs > now) {
      return {
        allowed: false,
        inPause: true,
        pauseEndsAt: st.pauseEndsAt,
        nextPauseAt: st.nextPauseAt || null,
        settings,
      };
    }
    st = armNextPause(settings);
    return {
      allowed: true,
      inPause: false,
      pauseEndsAt: null,
      nextPauseAt: st.nextPauseAt,
      settings,
    };
  }

  if (!st.nextPauseAt) {
    st = armNextPause(settings);
    return {
      allowed: true,
      inPause: false,
      pauseEndsAt: null,
      nextPauseAt: st.nextPauseAt,
      settings,
    };
  }

  const nextMs = new Date(st.nextPauseAt).getTime();
  if (Number.isNaN(nextMs)) {
    st = armNextPause(settings);
    return {
      allowed: true,
      inPause: false,
      pauseEndsAt: null,
      nextPauseAt: st.nextPauseAt,
      settings,
    };
  }

  if (now >= nextMs) {
    const pauseEndsAt = randomDelayEndAt(settings.pauseMinutesMin, settings.pauseMinutesMax);
    st = writeMicroPauseState({
      pauseEndsAt: pauseEndsAt.toISOString(),
      nextPauseAt: st.nextPauseAt,
    });
    log.info(
      TAG,
      `Random stop — automation paused until ${pauseEndsAt.toLocaleString()} `
      + `(${settings.pauseMinutesMin}–${settings.pauseMinutesMax} min)`,
    );
    return {
      allowed: false,
      inPause: true,
      pauseEndsAt: st.pauseEndsAt,
      nextPauseAt: st.nextPauseAt,
      settings,
    };
  }

  return {
    allowed: true,
    inPause: false,
    pauseEndsAt: null,
    nextPauseAt: st.nextPauseAt,
    settings,
  };
}

/**
 * Block until automation is allowed (not in a micro pause).
 * @returns {Promise<'ok'|'stopped'>}
 */
async function waitForMicroPause(control = {}, options = {}) {
  if (options.bypass) return 'ok';

  for (;;) {
    const sync = syncMicroPause();
    if (!sync.settings.enabled || sync.allowed) return 'ok';
    if (control.stop) return 'stopped';

    const ends = new Date(sync.pauseEndsAt);
    const left = ends.getTime() - Date.now();
    const mins = Math.max(1, Math.ceil(left / 60_000));
    log.info(TAG, `Random stop active — automation paused (~${mins} min left)`);
    await sleep(Math.min(30_000, Math.max(500, left)));
  }
}

function microPauseConfigForApi(cfg = loadConfig()) {
  const s = microPauseSettings(cfg);
  return {
    enabled: s.enabled,
    pauseMinutesMin: s.pauseMinutesMin,
    pauseMinutesMax: s.pauseMinutesMax,
    intervalMinutesMin: s.intervalMinutesMin,
    intervalMinutesMax: s.intervalMinutesMax,
  };
}

function microPauseGuiStatus(cfg = loadConfig()) {
  const settings = microPauseSettings(cfg);
  if (!settings.enabled) {
    return {
      enabled: false,
      inPause: false,
      pauseEndsAt: null,
      nextPauseAt: null,
      allowed: true,
      ...settings,
      statusLine: 'Random stops OFF',
    };
  }

  const sync = syncMicroPause(cfg);
  let statusLine;
  if (sync.inPause) {
    const until = formatNextRunAt(sync.pauseEndsAt);
    statusLine = until && until !== 'now / overdue'
      ? `Stopped · until ${until}`
      : 'Stopped · random pause';
  } else {
    const next = formatNextRunAt(sync.nextPauseAt);
    statusLine = next && next !== 'now / overdue'
      ? `Running · next stop ~${next}`
      : 'Running · next stop soon';
  }

  return {
    enabled: true,
    inPause: sync.inPause,
    pauseEndsAt: sync.pauseEndsAt,
    nextPauseAt: sync.nextPauseAt,
    allowed: sync.allowed,
    pauseMinutesMin: settings.pauseMinutesMin,
    pauseMinutesMax: settings.pauseMinutesMax,
    intervalMinutesMin: settings.intervalMinutesMin,
    intervalMinutesMax: settings.intervalMinutesMax,
    statusLine,
  };
}

function applyMicroPauseConfigFromBody(cfg, body = {}) {
  if (!cfg.microPause) {
    cfg.microPause = {
      enabled: false,
      pauseMinutesMin: 2,
      pauseMinutesMax: 5,
      intervalMinutesMin: 20,
      intervalMinutesMax: 45,
    };
  }
  if (typeof body.enabled === 'boolean') cfg.microPause.enabled = body.enabled;

  const fields = [
    'pauseMinutesMin',
    'pauseMinutesMax',
    'intervalMinutesMin',
    'intervalMinutesMax',
  ];
  for (const key of fields) {
    if (body[key] == null) continue;
    const n = Number(body[key]);
    if (!Number.isNaN(n) && n >= 1) cfg.microPause[key] = Math.floor(n);
  }

  const s = microPauseSettings(cfg);
  cfg.microPause.pauseMinutesMin = s.pauseMinutesMin;
  cfg.microPause.pauseMinutesMax = s.pauseMinutesMax;
  cfg.microPause.intervalMinutesMin = s.intervalMinutesMin;
  cfg.microPause.intervalMinutesMax = s.intervalMinutesMax;

  if (cfg.microPause.enabled) startMicroPauseSchedule(cfg);
  return cfg;
}

module.exports = {
  microPauseSettings,
  syncMicroPause,
  waitForMicroPause,
  startMicroPauseSchedule,
  microPauseConfigForApi,
  microPauseGuiStatus,
  applyMicroPauseConfigFromBody,
};
