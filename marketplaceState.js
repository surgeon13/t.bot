'use strict';

const fs = require('fs');
const { MARKETPLACE_STATE_FILE: FILE } = require('./paths');
const { loadConfig } = require('./auth');
const { formatNextRunAt } = require('./scheduleState');
const { marketplaceSettings } = require('./marketplaceConfig');
const { automationWindowAllowed } = require('./sessionGate');
const { normalizeDailySchedule, nextActiveAt } = require('./dailySchedule');

/** @type {boolean} */
let embeddedMarketplaceSchedulerActive = false;

function setEmbeddedMarketplaceSchedulerActive(active) {
  embeddedMarketplaceSchedulerActive = !!active;
}

function readMarketplaceState() {
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
 * @param {number} [p.lastScanned]
 * @param {number} [p.lastMatched]
 * @param {number} [p.lastAccepted]
 * @param {Array<object>} [p.lastOffers]
 * @param {string} [p.lastMessage]
 * @param {number} p.intervalMinutesMin
 * @param {number} p.intervalMinutesMax
 */
function writeMarketplaceState(p) {
  const prev = readMarketplaceState() || {};
  const keep = (key, fallback) => (p[key] !== undefined ? p[key] : (prev[key] ?? fallback));
  const body = {
    lastRunAt: keep('lastRunAt', null),
    nextRunAt: p.nextRunAt !== undefined ? p.nextRunAt : prev.nextRunAt,
    lastScanned: keep('lastScanned', 0),
    lastMatched: keep('lastMatched', 0),
    lastAccepted: keep('lastAccepted', 0),
    lastOffers: keep('lastOffers', []),
    lastMessage: keep('lastMessage', null),
    intervalMinutesMin: keep('intervalMinutesMin', undefined),
    intervalMinutesMax: keep('intervalMinutesMax', undefined),
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

/** Push the next scan into the future (e.g. after a login skip). Returns the new Date. */
function postponeMarketplaceRun(minMinutes, maxMinutes, cfg = loadConfig()) {
  const settings = marketplaceSettings(cfg);
  const min = minMinutes != null ? minMinutes : settings.intervalMinutesMin;
  const max = maxMinutes != null ? maxMinutes : settings.intervalMinutesMax;
  const nextAt = randomNextRunAt(min, max);
  writeMarketplaceState({
    nextRunAt: nextAt.toISOString(),
    intervalMinutesMin: settings.intervalMinutesMin,
    intervalMinutesMax: settings.intervalMinutesMax,
  });
  return nextAt;
}

function lastRunSummary(state) {
  if (!state?.lastRunAt) return '';
  const accepted = Number(state.lastAccepted) || 0;
  const matched = Number(state.lastMatched) || 0;
  if (accepted) return `last: accepted ${accepted}`;
  if (matched) return `last: ${matched} match${matched === 1 ? '' : 'es'}, none accepted`;
  return `last scan ${new Date(state.lastRunAt).toLocaleString()} — no match`;
}

function marketplaceGuiStatus(cfg = loadConfig(), state = readMarketplaceState()) {
  const settings = marketplaceSettings(cfg);
  const { enabled, dryRun, minRatio } = settings;

  let statusLine;
  if (!enabled) {
    statusLine = 'Marketplace runner OFF';
  } else if (!embeddedMarketplaceSchedulerActive) {
    statusLine = `Enabled — ratio ≥ ${minRatio} · timer not running`;
  } else if (!state?.nextRunAt) {
    statusLine = 'Starting…';
  } else {
    const gate = automationWindowAllowed(cfg);
    const last = lastRunSummary(state);
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
        statusLine = last ? `Due now · ${last}` : 'Next scan due now';
      } else if (at) {
        statusLine = last ? `Next scan ${at} · ${last}` : `Next scan: ${at}`;
      } else {
        statusLine = 'Next scan time invalid';
      }
    }
  }

  const gate = automationWindowAllowed(cfg);
  const scheduleResumeAt = (!gate.allowed && gate.reason === 'daily-schedule')
    ? (nextActiveAt(normalizeDailySchedule(cfg))?.toISOString() ?? null)
    : null;

  return {
    enabled,
    dryRun,
    minRatio,
    maxAcceptsPerRun: settings.maxAcceptsPerRun,
    giveResources: settings.giveResources,
    intervalMinutesMin: settings.intervalMinutesMin,
    intervalMinutesMax: settings.intervalMinutesMax,
    nextRunAt: state?.nextRunAt || null,
    lastRunAt: state?.lastRunAt || null,
    lastScanned: state?.lastScanned ?? 0,
    lastMatched: state?.lastMatched ?? 0,
    lastAccepted: state?.lastAccepted ?? 0,
    lastOffers: Array.isArray(state?.lastOffers) ? state.lastOffers : [],
    lastMessage: state?.lastMessage || null,
    statusLine,
    schedulerRunning: embeddedMarketplaceSchedulerActive,
    pauseReason: gate.allowed ? null : gate.reason,
    scheduleResumeAt,
  };
}

module.exports = {
  readMarketplaceState,
  writeMarketplaceState,
  randomNextRunAt,
  postponeMarketplaceRun,
  marketplaceGuiStatus,
  setEmbeddedMarketplaceSchedulerActive,
  STATE_FILE: FILE,
};
