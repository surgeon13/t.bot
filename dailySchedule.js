'use strict';

/**
 * Daily hour / half-hour schedule (local time).
 * Each hour has :00 and :30 toggles plus an optional proxy preference.
 */

const { loadConfig } = require('./auth');
const { proxyServersFromConfig } = require('./browserLaunch');

const HOURS = 24;

function defaultHour(hour) {
  return {
    hour,
    enabled: false,
    half0: false,
    half30: false,
    proxyIndex: null,
  };
}

/** @returns {number|null} null = Off/direct, 0+ = proxy pool index */
function normalizeProxyIndex(raw, proxyCount = 0) {
  if (raw?.proxyIndex != null && raw.proxyIndex !== '') {
    const pi = Number(raw.proxyIndex);
    if (!Number.isNaN(pi) && pi >= 0 && proxyCount > 0) {
      return Math.min(Math.floor(pi), proxyCount - 1);
    }
    if (!Number.isNaN(pi) && pi < 0) return null;
  }
  if (raw?.useProxy && proxyCount > 0) return 0;
  return null;
}

function defaultHours() {
  return Array.from({ length: HOURS }, (_, h) => defaultHour(h));
}

function normalizeHour(raw, hour, proxyCount = 0) {
  const h = Number(raw?.hour ?? hour);
  if (h < 0 || h > 23) return defaultHour(hour);
  const enabled = !!raw?.enabled;
  const half0 = raw?.half0 != null ? !!raw.half0 : enabled;
  const half30 = raw?.half30 != null ? !!raw.half30 : enabled;
  return {
    hour: h,
    enabled: enabled || half0 || half30,
    half0,
    half30,
    proxyIndex: normalizeProxyIndex(raw, proxyCount),
  };
}

function normalizeDailySchedule(cfg = loadConfig()) {
  const ds = cfg.dailySchedule || {};
  const proxyCount = proxyServersFromConfig(cfg).length;
  const byHour = new Map();
  for (const raw of Array.isArray(ds.hours) ? ds.hours : []) {
    const row = normalizeHour(raw, raw?.hour, proxyCount);
    byHour.set(row.hour, row);
  }
  const hours = Array.from({ length: HOURS }, (_, h) => byHour.get(h) || defaultHour(h));
  return {
    enabled: !!ds.enabled,
    hours,
  };
}

/** @param {Date} [now] */
function currentHalfKey(now = new Date()) {
  const h = now.getHours();
  const m = now.getMinutes() < 30 ? 0 : 30;
  return { hour: h, half: m };
}

function hourRow(settings, hour) {
  return settings.hours.find(x => x.hour === hour) || defaultHour(hour);
}

function isHalfActive(settings, hour, half, now = new Date()) {
  if (!settings.enabled) return true;
  const row = hourRow(settings, hour);
  return half === 0 ? !!row.half0 : !!row.half30;
}

function isNowActive(settings = normalizeDailySchedule(), now = new Date()) {
  if (!settings.enabled) return { active: true, reason: 'disabled' };
  const { hour, half } = currentHalfKey(now);
  const row = hourRow(settings, hour);
  const active = half === 0 ? row.half0 : row.half30;
  return {
    active,
    hour,
    half,
    proxyIndex: row.proxyIndex,
    reason: active ? 'active' : 'outside_slot',
  };
}

/**
 * Proxy for the current daily-schedule slot when enabled and active.
 * Off (null) → direct connection for this slot.
 * P1/P2 → force that pool index.
 * When daily schedule is off or slot inactive → {} (use global proxy settings).
 * @returns {{ forcedIndex?: number, forceDirect?: boolean }}
 */
function proxyPickForNow(cfg = loadConfig(), now = new Date()) {
  const settings = normalizeDailySchedule(cfg);
  if (!settings.enabled) return {};
  const nowInfo = isNowActive(settings, now);
  if (!nowInfo.active) return {};
  if (nowInfo.proxyIndex != null && nowInfo.proxyIndex >= 0) {
    return { forcedIndex: nowInfo.proxyIndex };
  }
  return { forceDirect: true };
}

/** Stable key for the scheduled proxy slot (active half-hour only). */
function scheduledProxyKey(cfg = loadConfig(), now = new Date()) {
  const pick = proxyPickForNow(cfg, now);
  if (pick.forcedIndex != null) return `p${pick.forcedIndex}`;
  if (pick.forceDirect) return 'direct';
  const settings = normalizeDailySchedule(cfg);
  if (settings.enabled && isNowActive(settings, now).active) return 'direct';
  return 'global';
}

/**
 * Next local time when a half-hour slot becomes active.
 * @returns {Date|null}
 */
function slotIndex(hour, half) {
  return hour * 2 + (half === 30 ? 1 : 0);
}

function indexToSlot(idx) {
  const hour = Math.floor(idx / 2) % 24;
  const half = idx % 2 === 0 ? 0 : 30;
  return { hour, half };
}

function dateForSlot(hour, half, from = new Date()) {
  const d = new Date(from);
  d.setSeconds(0, 0);
  d.setMilliseconds(0);
  d.setHours(hour, half, 0, 0);
  if (d.getTime() < from.getTime()) d.setDate(d.getDate() + 1);
  return d;
}

function nextActiveAt(settings = normalizeDailySchedule(), from = new Date()) {
  if (!settings.enabled) return null;
  const { hour, half } = currentHalfKey(from);
  const startIdx = slotIndex(hour, half);
  for (let n = 1; n <= 48; n++) {
    const { hour: h, half: hf } = indexToSlot(startIdx + n);
    const row = hourRow(settings, h);
    const on = hf === 0 ? row.half0 : row.half30;
    if (on) return dateForSlot(h, hf, from);
  }
  return null;
}

function formatSlotLabel(hour, half) {
  const hh = String(hour).padStart(2, '0');
  return half === 0 ? `${hh}:00` : `${hh}:30`;
}

function dailyScheduleConfigForApi(cfg = loadConfig()) {
  const s = normalizeDailySchedule(cfg);
  return {
    enabled: s.enabled,
    hours: s.hours,
    proxyCount: proxyServersFromConfig(cfg).length,
  };
}

function dailyScheduleGuiStatus(cfg = loadConfig()) {
  const settings = normalizeDailySchedule(cfg);
  const nowInfo = isNowActive(settings);
  const next = nextActiveAt(settings);
  let statusLine;
  if (!settings.enabled) {
    statusLine = 'Daily schedule OFF';
  } else if (nowInfo.active) {
    const slot = formatSlotLabel(nowInfo.hour, nowInfo.half);
    const proxyPart = nowInfo.proxyIndex != null && nowInfo.proxyIndex >= 0
      ? ` · Proxy ${nowInfo.proxyIndex + 1}`
      : ' · direct';
    statusLine = `Active now · ${slot}${proxyPart}`;
  } else if (next) {
    const mins = Math.max(0, Math.round((next.getTime() - Date.now()) / 60_000));
    statusLine = mins <= 0
      ? 'Next slot due now'
      : `Inactive · next ~${mins} min (${formatSlotLabel(next.getHours(), next.getMinutes() < 30 ? 0 : 30)})`;
  } else {
    statusLine = 'Inactive · no slots enabled today';
  }
  return {
    enabled: settings.enabled,
    activeNow: nowInfo.active,
    currentHour: nowInfo.hour,
    currentHalf: nowInfo.half,
    proxyIndexNow: nowInfo.proxyIndex,
    nextActiveAt: next ? next.toISOString() : null,
    statusLine,
  };
}

function applyDailyScheduleFromBody(cfg, body = {}) {
  if (!cfg.dailySchedule) {
    cfg.dailySchedule = { enabled: false, hours: defaultHours() };
  }
  if (typeof body.enabled === 'boolean') cfg.dailySchedule.enabled = body.enabled;
  if (Array.isArray(body.hours)) {
    const proxyCount = proxyServersFromConfig(cfg).length;
    cfg.dailySchedule.hours = body.hours.map((raw, i) => normalizeHour(raw, raw?.hour ?? i, proxyCount));
  }
  const norm = normalizeDailySchedule(cfg);
  cfg.dailySchedule.enabled = norm.enabled;
  cfg.dailySchedule.hours = norm.hours;
  return cfg;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Block until current half-hour slot is active (or return if schedule disabled).
 * @param {{ stop?: boolean }} [control]
 */
async function waitForDailyScheduleActive(control = {}) {
  for (;;) {
    const sync = isNowActive();
    if (!normalizeDailySchedule().enabled || sync.active) {
      return {
        active: sync.active,
        proxyIndex: sync.proxyIndex,
      };
    }
    if (control.stop) return { active: false, stopped: true };
    await sleep(Math.min(60_000, 15_000));
  }
}

module.exports = {
  normalizeDailySchedule,
  dailyScheduleConfigForApi,
  dailyScheduleGuiStatus,
  applyDailyScheduleFromBody,
  isNowActive,
  nextActiveAt,
  waitForDailyScheduleActive,
  proxyPickForNow,
  scheduledProxyKey,
  formatSlotLabel,
  defaultHours,
};
