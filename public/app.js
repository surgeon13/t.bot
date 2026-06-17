'use strict';

/* ----- DOM helpers ----- */
const $ = sel => document.querySelector(sel);
const $$ = sel => Array.from(document.querySelectorAll(sel));

function setText(sel, value) {
  const el = $(sel);
  if (!el) return;
  el.textContent = value == null || value === '' ? '—' : value;
}

function setBar(sel, percent) {
  const el = $(sel);
  if (!el) return;
  const p = (percent == null || isNaN(percent)) ? 0 : Math.max(0, Math.min(100, percent));
  el.style.width = `${p}%`;
}

function pct(n) {
  return (n == null || isNaN(n)) ? '—' : `${Math.round(n)}%`;
}

/** Routes the dashboard expects on GET /api/health `features`. */
const REQUIRED_GUI_FEATURES = ['farm-list-discover'];

let guiCapabilitiesOk = true;

function setFarmListStaleBanner(show, message) {
  const banner = $('#farm-list-stale-banner');
  const discover = $('#farm-list-discover');
  if (banner) {
    banner.hidden = !show;
    if (show && message) banner.textContent = message;
  }
  guiCapabilitiesOk = !show;
  if (discover) discover.disabled = show;
  updateFarmListSendAllButtonFromForm();
}

async function checkGuiServerCapabilities() {
  try {
    const res = await fetch('/api/health');
    const data = await parseApiJson(res);
    const features = Array.isArray(data.features) ? data.features : [];
    const missing = REQUIRED_GUI_FEATURES.filter(f => !features.includes(f));
    if (missing.length) {
      const ver = data.version ? ` (running server reports v${data.version})` : '';
      setFarmListStaleBanner(
        true,
        `Farm lists need a newer GUI process${ver}. In the terminal where t.bot runs, press Ctrl+C, then start again with npm run gui. If port 3733 was already in use, you may still be viewing the old server — stop every t.bot GUI window first.`,
      );
      return false;
    }
    setFarmListStaleBanner(false);
    return true;
  } catch {
    return guiCapabilitiesOk;
  }
}

function staleGuiRestartMessage(serverMessage) {
  if (serverMessage && /Unknown API/i.test(serverMessage)) {
    return 'GUI server is out of date. Press Ctrl+C in its terminal, then run npm run gui again (stop any older copy still on port 3733).';
  }
  return serverMessage;
}

/** Parse JSON from API responses; surface HTML/404 pages as a clear error. */
async function parseApiJson(res) {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    if (/^\s*</.test(text)) {
      if (/SyntaxError/i.test(text) && /JSON/i.test(text)) {
        throw new Error(
          'Server could not read the save request (invalid JSON). Hard-refresh the page (Ctrl+F5) and try Save again.',
        );
      }
      throw new Error(
        'Server returned a web page instead of JSON. Stop the GUI (Ctrl+C) and start it again with npm run gui.',
      );
    }
    throw new Error(`Invalid server response (${res.status})`);
  }
}

function farmListNameFromDataset(el) {
  const raw = el?.dataset?.name || '';
  if (!raw) return '';
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function setFarmListDatasetName(el, name) {
  el.dataset.name = encodeURIComponent(String(name || '').trim());
}

function farmListJsonBody(payload) {
  let body;
  try {
    body = JSON.stringify(payload);
    JSON.parse(body);
  } catch {
    throw new Error('Could not encode farm list settings for save.');
  }
  return body;
}

/* ----- Status + Hero refresh ----- */

async function fetchStatus() {
  try {
    const res = await fetch('/api/status');
    const s = await res.json();
    paintStatus(s);
  } catch {
    /* server might be restarting */
  }
}

function paintStatus(s) {
  const dot = $('#session-dot');
  const txt = $('#session-text');
  if (s.busy) {
    dot.className = 'dot busy';
    txt.textContent = `Working: ${s.action || ''}`;
  } else if (s.loggedIn) {
    dot.className = 'dot ok';
    txt.textContent = `Connected — ${s.username || ''}`;
  } else if (s.browserSession?.pauseReason) {
    dot.className = 'dot warn';
    txt.textContent = s.browserSession.statusLine || 'Browser closed — paused';
    bonusesSynced = false;
  } else {
    dot.className = 'dot bad';
    txt.textContent = 'Not logged in';
    bonusesSynced = false;
  }

  if (s.nextResourceBonusLine) {
    const bonusNext = $('#bonus-next');
    if (bonusNext) {
      bonusNext.textContent = s.nextResourceBonusLine.replace(/^\s*Resource bonus\s*:\s*/, '');
    }
  }

  if (s.scheduleStatus) paintScheduleStatus(s.scheduleStatus);
  if (s.scheduleConfig && !scheduleFormDirty) fillScheduleForm(s.scheduleConfig);
  if (s.workSleepStatus) paintWorkSleepStatus(s.workSleepStatus);
  if (s.workSleepConfig && !workSleepFormDirty) fillWorkSleepForm(s.workSleepConfig);
  if (s.microPauseStatus) paintMicroPauseStatus(s.microPauseStatus);
  if (s.microPauseConfig && !microPauseFormDirty) fillMicroPauseForm(s.microPauseConfig);
  if (s.proxyConfig && !proxyFormDirty) fillProxyForm(s.proxyConfig);
  if (s.dailyScheduleStatus) paintDailyScheduleStatus(s.dailyScheduleStatus);
  if (s.dailyScheduleConfig && !dailyScheduleFormDirty) fillDailyScheduleForm(s.dailyScheduleConfig);
  if (s.farmListStatus) paintFarmListStatus(s.farmListStatus);
  if (s.farmListConfig && !farmListFormDirty) fillFarmListForm(s.farmListConfig);

  if (s.totals) paintLifetimeTotals(s.totals);

  if (s.lastBonus) {
    setText('#last-bonus', `Last completed: ${s.lastBonus}`);
  } else {
    setText('#last-bonus', 'Last completed: none yet');
  }

  if (s.proxy) paintProxy(s.proxy);
  if (s.account) paintAccount(s.account);
  maybeRefreshAccountInfo(s);
  if (s.proxyConfig && proxyFormDirty) {
    paintProxyListMarkers(s.proxyConfig, s.proxy);
    updateProxyReloadButton(s.proxyConfig);
  } else if (s.proxy) paintProxyListMarkers(null, s.proxy);
}

let proxyFormDirty = false;
let scheduleFormDirty = false;
let workSleepFormDirty = false;
let microPauseFormDirty = false;
let dailyScheduleFormDirty = false;
let dailyScheduleProxyCount = 0;
/** @type {string[]} */
let dailyScheduleProxyServers = [];
let dailyScheduleStatusCache = null;
let lastDailyNowScrollKey = '';
let farmListFormDirty = false;
let accountAutoRefreshTimer = null;
let accountAutoRefreshAttempts = 0;

/** Re-fetch player/IP once or twice after login when the first read missed (SPA / CSP). */
function maybeRefreshAccountInfo(s) {
  if (!s.loggedIn || accountAutoRefreshTimer || accountAutoRefreshAttempts >= 2) return;
  const a = s.account;
  if (!a) return;
  if (a.playerName && a.publicIp) {
    accountAutoRefreshAttempts = 0;
    return;
  }
  accountAutoRefreshTimer = setTimeout(async () => {
    accountAutoRefreshTimer = null;
    accountAutoRefreshAttempts += 1;
    await refreshAccount();
  }, 2500);
}

let lastScheduleStatus = null;
let lastWorkSleepStatus = null;

/** Amber dot when periodic run is due or work/sleep is in sleep phase. */
function applyScheduleDotExtras() {
  const dot = $('#schedule-dot');
  if (!dot || !lastScheduleStatus) return;
  if (lastWorkSleepStatus?.enabled && lastWorkSleepStatus.phase === 'sleep') {
    dot.className = 'schedule-dot warn';
    return;
  }
  if (lastScheduleStatus.periodicEnabled && lastScheduleStatus.periodicNextAt) {
    const due = new Date(lastScheduleStatus.periodicNextAt).getTime() <= Date.now();
    if (due) dot.className = 'schedule-dot warn';
  }
}

function paintScheduleStatus(st) {
  lastScheduleStatus = st;
  const dot = $('#schedule-dot');
  const txt = $('#schedule-status-text');
  const periodicLine = $('#schedule-periodic-line');
  const resourceLine = $('#schedule-resource-line');
  if (!dot || !txt) return;

  if (st.periodicEnabled) {
    dot.className = st.schedulerRunning ? 'schedule-dot on' : 'schedule-dot warn';
    txt.textContent = st.schedulerRunning
      ? 'Periodic claims ON'
      : 'Periodic ON — scheduler not running';
  } else {
    dot.className = 'schedule-dot off';
    txt.textContent = 'Periodic claims OFF';
  }

  if (periodicLine) periodicLine.textContent = st.periodicLine || '—';
  if (resourceLine) resourceLine.textContent = st.resourceLine || '—';

  if (st.periodicEnabled && st.periodicNextAt) {
    const due = new Date(st.periodicNextAt).getTime() <= Date.now();
    if (due) dot.className = 'schedule-dot warn';
  }

  updateScheduleRunNowButton(st);
  applyScheduleDotExtras();
}

function updateScheduleRunNowButton(st) {
  const btn = $('#schedule-run-now');
  if (!btn) return;
  const on = !!st?.periodicEnabled;
  btn.disabled = !on;
  btn.title = on
    ? 'Start the next full bonus claim cycle now (hero + due resources)'
    : 'Turn on All bonuses and Save first';
}

function fillScheduleForm(cfg) {
  if (!cfg) return;
  const periodic = $('#schedule-enabled');
  const interval = $('#schedule-interval');
  const resOn = $('#resource-sched-enabled');
  const resH = $('#resource-sched-interval');
  if (periodic) periodic.checked = !!cfg.periodicEnabled;
  if (interval) interval.value = String(cfg.intervalHours ?? 3);
  if (resOn) resOn.checked = !!cfg.resourceEnabled;
  if (resH) resH.value = String(cfg.resourceIntervalHours ?? 8);
}

function collectScheduleForm() {
  return {
    periodicEnabled: !!$('#schedule-enabled')?.checked,
    intervalHours: Number($('#schedule-interval')?.value) || 3,
    resourceEnabled: !!$('#resource-sched-enabled')?.checked,
    resourceIntervalHours: Number($('#resource-sched-interval')?.value) || 8,
  };
}

async function saveScheduleForm(ev) {
  ev.preventDefault();
  const hint = $('#schedule-save-hint');
  const btn = $('#schedule-form')?.querySelector('.schedule-save');
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'schedule-hint muted';
    hint.textContent = 'Saving…';
  }

  try {
    const res = await fetch('/api/config/schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectScheduleForm()),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || 'Save failed');

    scheduleFormDirty = false;
    if (data.schedule) fillScheduleForm(data.schedule);
    if (data.scheduleStatus) paintScheduleStatus(data.scheduleStatus);
    if (hint) {
      hint.className = 'schedule-hint ok';
      hint.textContent = data.message || 'Schedule saved to config.json';
    }
    fetchStatus();
  } catch (err) {
    if (hint) {
      hint.className = 'schedule-hint fail';
      hint.textContent = err.message || 'Could not save schedule';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runSchedulerNow() {
  const btn = $('#schedule-run-now');
  const hint = $('#schedule-save-hint');
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'schedule-hint muted';
    hint.textContent = 'Starting scheduled run…';
  }

  try {
    const res = await fetch('/api/schedule/run-now', { method: 'POST' });
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) throw new Error(data.message || `Run now failed (${res.status})`);
    if (data.scheduleStatus) paintScheduleStatus(data.scheduleStatus);
    if (hint) {
      hint.className = 'schedule-hint ok';
      hint.textContent = data.message || 'Scheduled run requested';
    }
    fetchStatus();
  } catch (err) {
    if (hint) {
      hint.className = 'schedule-hint fail';
      hint.textContent = err.message || 'Could not start scheduled run';
    }
    loadScheduleForm();
  } finally {
    const st = { periodicEnabled: !!$('#schedule-enabled')?.checked };
    updateScheduleRunNowButton(st);
  }
}

async function loadScheduleForm() {
  try {
    const res = await fetch('/api/config/schedule');
    const data = await res.json();
    if (data.schedule && !scheduleFormDirty) fillScheduleForm(data.schedule);
    if (data.scheduleStatus) paintScheduleStatus(data.scheduleStatus);
  } catch {
    /* server starting */
  }
}

function fillWorkSleepForm(cfg) {
  if (!cfg) return;
  const en = $('#work-sleep-enabled');
  if (en) en.checked = !!cfg.enabled;
  const map = [
    ['#work-sleep-work-min', cfg.workMinutesMin],
    ['#work-sleep-work-max', cfg.workMinutesMax],
    ['#work-sleep-sleep-min', cfg.sleepMinutesMin],
    ['#work-sleep-sleep-max', cfg.sleepMinutesMax],
  ];
  for (const [sel, val] of map) {
    const el = $(sel);
    if (el && val != null) el.value = String(val);
  }
}

function paintWorkSleepStatus(st) {
  lastWorkSleepStatus = st;
  const line = $('#work-sleep-status-line');
  if (line) {
    if (st?.enabled) {
      line.hidden = false;
      line.textContent = st.statusLine || '—';
    } else {
      line.hidden = true;
      line.textContent = '';
    }
  }
  applyScheduleDotExtras();
}

function collectWorkSleepPayload() {
  return {
    enabled: !!$('#work-sleep-enabled')?.checked,
    workMinutesMin: Number($('#work-sleep-work-min')?.value) || 30,
    workMinutesMax: Number($('#work-sleep-work-max')?.value) || 60,
    sleepMinutesMin: Number($('#work-sleep-sleep-min')?.value) || 15,
    sleepMinutesMax: Number($('#work-sleep-sleep-max')?.value) || 45,
  };
}

async function saveWorkSleepForm() {
  const hint = $('#work-sleep-save-hint');
  const btn = $('#work-sleep-save');
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'schedule-hint muted';
    hint.textContent = 'Saving…';
  }
  try {
    const res = await fetch('/api/config/work-sleep', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectWorkSleepPayload()),
    });
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) throw new Error(data.message || 'Save failed');
    workSleepFormDirty = false;
    if (data.workSleep) fillWorkSleepForm(data.workSleep);
    if (data.workSleepStatus) paintWorkSleepStatus(data.workSleepStatus);
    if (hint) {
      hint.className = 'schedule-hint ok';
      hint.textContent = data.message || 'Work/sleep saved';
    }
  } catch (err) {
    if (hint) {
      hint.className = 'schedule-hint fail';
      hint.textContent = err.message || 'Could not save work/sleep';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadWorkSleepForm() {
  try {
    const res = await fetch('/api/config/work-sleep');
    const data = await parseApiJson(res);
    if (data.workSleep && !workSleepFormDirty) fillWorkSleepForm(data.workSleep);
    if (data.workSleepStatus) paintWorkSleepStatus(data.workSleepStatus);
  } catch {
    /* server starting */
  }
}

function fillMicroPauseForm(cfg) {
  if (!cfg) return;
  const en = $('#micro-pause-enabled');
  if (en) en.checked = !!cfg.enabled;
  const map = [
    ['#micro-pause-min', cfg.pauseMinutesMin],
    ['#micro-pause-max', cfg.pauseMinutesMax],
    ['#micro-pause-interval-min', cfg.intervalMinutesMin],
    ['#micro-pause-interval-max', cfg.intervalMinutesMax],
  ];
  for (const [sel, val] of map) {
    const el = $(sel);
    if (el && val != null) el.value = String(val);
  }
}

function paintMicroPauseStatus(st) {
  const line = $('#micro-pause-status-line');
  if (!line) return;
  if (st?.enabled) {
    line.hidden = false;
    line.textContent = st.statusLine || '—';
  } else {
    line.hidden = true;
    line.textContent = '';
  }
}

function collectMicroPausePayload() {
  return {
    enabled: !!$('#micro-pause-enabled')?.checked,
    pauseMinutesMin: Number($('#micro-pause-min')?.value) || 2,
    pauseMinutesMax: Number($('#micro-pause-max')?.value) || 5,
    intervalMinutesMin: Number($('#micro-pause-interval-min')?.value) || 20,
    intervalMinutesMax: Number($('#micro-pause-interval-max')?.value) || 45,
  };
}

async function saveMicroPauseForm() {
  const hint = $('#micro-pause-save-hint');
  const btn = $('#micro-pause-save');
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'schedule-hint muted';
    hint.textContent = 'Saving…';
  }
  try {
    const res = await fetch('/api/config/micro-pause', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectMicroPausePayload()),
    });
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) throw new Error(data.message || 'Save failed');
    microPauseFormDirty = false;
    if (data.microPause) fillMicroPauseForm(data.microPause);
    if (data.microPauseStatus) paintMicroPauseStatus(data.microPauseStatus);
    if (hint) {
      hint.className = 'schedule-hint ok';
      hint.textContent = data.message || 'Random stops saved';
    }
  } catch (err) {
    if (hint) {
      hint.className = 'schedule-hint fail';
      hint.textContent = err.message || 'Could not save random stops';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadMicroPauseForm() {
  try {
    const res = await fetch('/api/config/micro-pause');
    const data = await parseApiJson(res);
    if (data.microPause && !microPauseFormDirty) fillMicroPauseForm(data.microPause);
    if (data.microPauseStatus) paintMicroPauseStatus(data.microPauseStatus);
  } catch {
    /* server starting */
  }
}

function dailyHourFromDom(hour) {
  const cell = $(`.daily-hour-cell[data-hour="${hour}"]`);
  if (!cell) return { hour, enabled: false, half0: false, half30: false, proxyIndex: null };
  const half0 = cell.querySelector('.daily-half-0')?.checked ?? false;
  const half30 = cell.querySelector('.daily-half-30')?.checked ?? false;
  const sel = cell.querySelector('.daily-hour-proxy');
  let proxyIndex = null;
  if (sel && sel.value !== '') {
    const n = Number(sel.value);
    if (!Number.isNaN(n) && n >= 0) proxyIndex = n;
  }
  return {
    hour,
    enabled: half0 || half30,
    half0,
    half30,
    proxyIndex,
  };
}

function updateDailyHourCellVisual(hour) {
  const cell = $(`.daily-hour-cell[data-hour="${hour}"]`);
  if (!cell) return;
  const half0 = cell.querySelector('.daily-half-0')?.checked;
  const half30 = cell.querySelector('.daily-half-30')?.checked;
  cell.classList.toggle('active', !!(half0 || half30));
}

function proxyScheduleOptionLabel(i, addr) {
  const masked = addr ? maskProxyDisplay(addr) : '';
  if (!masked) return `P${i + 1}`;
  const host = masked.replace(/^https?:\/\//i, '').split('@').pop() || masked;
  const short = host.length > 24 ? `${host.slice(0, 22)}…` : host;
  return `P${i + 1} · ${short}`;
}

/** Refresh daily schedule proxy dropdowns after the proxy pool changes. */
function syncDailyScheduleProxyPool(servers) {
  dailyScheduleProxyServers = Array.isArray(servers) ? servers.filter(Boolean) : collectProxyServersFromDom();
  dailyScheduleProxyCount = dailyScheduleProxyServers.length;
  updateDailyScheduleProxyToggleLabel();

  const grid = $('#daily-schedule-grid');
  if (!grid?.children.length) return;
  const hours = Array.from({ length: 24 }, (_, h) => dailyHourFromDom(h));
  renderDailyScheduleGrid(hours);
}

function renderDailyScheduleGrid(hours) {
  const grid = $('#daily-schedule-grid');
  if (!grid) return;
  grid.replaceChildren();
  const proxyCount = dailyScheduleProxyCount || 0;
  const rows = Array.isArray(hours) && hours.length === 24
    ? hours
    : Array.from({ length: 24 }, (_, h) => ({ hour: h, half0: false, half30: false, proxyIndex: null }));

  const frag = document.createDocumentFragment();
  for (const row of rows) {
    const h = Number(row.hour);
    if (h < 0 || h > 23) continue;
    const cell = document.createElement('div');
    cell.className = 'daily-hour-cell';
    cell.dataset.hour = String(h);
    if (row.half0 || row.half30) cell.classList.add('active');

    const label = document.createElement('button');
    label.type = 'button';
    label.className = 'daily-hour-label';
    label.textContent = String(h).padStart(2, '0');
    label.title = `Toggle full hour ${String(h).padStart(2, '0')}`;
    label.addEventListener('click', () => {
      const half0 = cell.querySelector('.daily-half-0');
      const half30 = cell.querySelector('.daily-half-30');
      const any = half0?.checked || half30?.checked;
      const next = !any;
      if (half0) half0.checked = next;
      if (half30) half30.checked = next;
      updateDailyHourCellVisual(h);
      dailyScheduleFormDirty = true;
    });

    const mkHalf = (cls, text, checked) => {
      const lbl = document.createElement('label');
      lbl.className = 'daily-hour-toggle';
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.className = cls;
      cb.checked = !!checked;
      cb.addEventListener('change', () => {
        updateDailyHourCellVisual(h);
        dailyScheduleFormDirty = true;
      });
      const span = document.createElement('span');
      span.textContent = text;
      lbl.append(cb, span);
      return lbl;
    };

    const proxySel = document.createElement('select');
    proxySel.className = 'daily-hour-proxy';
    proxySel.title = proxyCount > 0
      ? 'Proxy for active slots in this hour (Off = direct)'
      : 'Add proxies in the Proxy panel and Save';
    const offOpt = document.createElement('option');
    offOpt.value = '';
    offOpt.textContent = 'Off';
    proxySel.append(offOpt);
    for (let i = 0; i < proxyCount; i++) {
      const opt = document.createElement('option');
      opt.value = String(i);
      const addr = dailyScheduleProxyServers[i];
      opt.textContent = proxyScheduleOptionLabel(i, addr);
      if (addr) opt.title = maskProxyDisplay(addr);
      proxySel.append(opt);
    }
    let pi = row.proxyIndex;
    if ((pi == null || pi < 0) && row.useProxy) pi = 0;
    if (pi != null && pi >= 0 && pi < proxyCount) proxySel.value = String(pi);
    else proxySel.value = '';
    proxySel.disabled = proxyCount === 0;
    proxySel.addEventListener('change', () => { dailyScheduleFormDirty = true; });

    cell.append(
      label,
      mkHalf('daily-half-0', ':00', row.half0),
      mkHalf('daily-half-30', ':30', row.half30),
      proxySel,
    );
    frag.append(cell);
  }
  grid.append(frag);
  updateDailyScheduleProxyToggleLabel();
  applyDailyScheduleNowHighlight();
}

function fillDailyScheduleForm(cfg) {
  if (!cfg) return;
  if (Array.isArray(cfg.proxyServers) && cfg.proxyServers.length) {
    dailyScheduleProxyServers = cfg.proxyServers.slice();
    dailyScheduleProxyCount = cfg.proxyServers.length;
  } else {
    if (cfg.proxyCount != null) dailyScheduleProxyCount = Number(cfg.proxyCount) || 0;
    const domServers = collectProxyServersFromDom();
    if (domServers.length) dailyScheduleProxyServers = domServers;
  }
  const en = $('#daily-schedule-enabled');
  if (en) en.checked = !!cfg.enabled;
  renderDailyScheduleGrid(cfg.hours || []);
  updateDailyScheduleProxyToggleLabel();
}

function collectDailySchedulePayload() {
  const hours = [];
  for (let h = 0; h < 24; h++) hours.push(dailyHourFromDom(h));
  return {
    enabled: !!$('#daily-schedule-enabled')?.checked,
    hours,
  };
}

function localScheduleNow() {
  const d = new Date();
  return { hour: d.getHours(), half: d.getMinutes() < 30 ? 0 : 30 };
}

function applyDailyScheduleNowHighlight(st = dailyScheduleStatusCache) {
  const { hour, half } = localScheduleNow();
  const scheduleOn = !!st?.enabled;
  const activeNow = scheduleOn && !!st?.activeNow;

  $$('.daily-hour-cell').forEach(cell => {
    cell.classList.remove('now', 'now-active-slot', 'now-idle-slot');
    cell.querySelectorAll('.daily-hour-toggle').forEach(t => t.classList.remove('now-half'));
  });

  const cell = $(`.daily-hour-cell[data-hour="${hour}"]`);
  if (!cell) return;

  cell.classList.add('now');
  if (scheduleOn) {
    cell.classList.add(activeNow ? 'now-active-slot' : 'now-idle-slot');
  }

  const halfInput = cell.querySelector(half === 0 ? '.daily-half-0' : '.daily-half-30');
  const halfToggle = halfInput?.closest('.daily-hour-toggle');
  if (halfToggle) halfToggle.classList.add('now-half');

  const scrollKey = `${hour}:${half}`;
  if (scrollKey !== lastDailyNowScrollKey) {
    lastDailyNowScrollKey = scrollKey;
    cell.scrollIntoView({ inline: 'center', block: 'nearest', behavior: 'smooth' });
  }
}

function paintDailyScheduleStatus(st) {
  dailyScheduleStatusCache = st || null;
  const dot = $('#daily-schedule-dot');
  const txt = $('#daily-schedule-status-text');
  if (!dot || !txt) return;
  if (!st?.enabled) {
    dot.className = 'daily-schedule-dot off';
    txt.textContent = st?.statusLine || 'Daily schedule OFF';
  } else if (st.activeNow) {
    dot.className = 'daily-schedule-dot on';
    txt.textContent = st.statusLine || '—';
  } else {
    dot.className = 'daily-schedule-dot warn';
    txt.textContent = st.statusLine || '—';
  }
  applyDailyScheduleNowHighlight(st);
}

function randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function randHours(min, max) {
  const step = 0.25;
  const n = randInt(Math.ceil(min / step), Math.floor(max / step));
  return (n * step).toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

function updateSchedulerProxyButtons() {
  const on = !!$('#proxy-enabled')?.checked;
  $$('.scheduler-proxy-btn').forEach(btn => {
    btn.textContent = on ? 'Proxy on' : 'Proxy off';
    btn.classList.toggle('on', on);
    btn.title = on ? 'Turn global proxy off and save' : 'Turn global proxy on and save';
  });
  updateDailyScheduleProxyToggleLabel();
}

async function toggleGlobalProxy() {
  const cb = $('#proxy-enabled');
  if (!cb) return;
  cb.checked = !cb.checked;
  proxyFormDirty = true;
  updateSchedulerProxyButtons();
  await saveProxyForm({ preventDefault() {} });
}

function clearBonusSchedulerForm() {
  const periodic = $('#schedule-enabled');
  const resOn = $('#resource-sched-enabled');
  const interval = $('#schedule-interval');
  const resH = $('#resource-sched-interval');
  if (periodic) periodic.checked = false;
  if (resOn) resOn.checked = false;
  if (interval) interval.value = '3';
  if (resH) resH.value = '8';
  scheduleFormDirty = true;
  const hint = $('#schedule-save-hint');
  if (hint) {
    hint.className = 'schedule-hint muted';
    hint.textContent = 'Cleared — click Save to apply';
  }
}

function generateBonusSchedulerForm() {
  const periodic = $('#schedule-enabled');
  const resOn = $('#resource-sched-enabled');
  const interval = $('#schedule-interval');
  const resH = $('#resource-sched-interval');
  if (periodic) periodic.checked = true;
  if (resOn) resOn.checked = Math.random() < 0.75;
  if (interval) interval.value = randHours(2, 6);
  if (resH) resH.value = randHours(4, 12);
  scheduleFormDirty = true;
  const hint = $('#schedule-save-hint');
  if (hint) {
    hint.className = 'schedule-hint muted';
    hint.textContent = 'New random intervals — click Save to apply';
  }
}

function clearWorkSleepFormUi() {
  const en = $('#work-sleep-enabled');
  if (en) en.checked = false;
  fillWorkSleepForm({
    enabled: false,
    workMinutesMin: 30,
    workMinutesMax: 60,
    sleepMinutesMin: 15,
    sleepMinutesMax: 45,
  });
  workSleepFormDirty = true;
  saveWorkSleepForm().catch(() => {});
}

async function generateWorkSleepForm() {
  const workMin = randInt(15, 45);
  const workMax = workMin + randInt(15, 45);
  const sleepMin = randInt(10, 30);
  const sleepMax = sleepMin + randInt(10, 40);
  const en = $('#work-sleep-enabled');
  if (en) en.checked = true;
  $('#work-sleep-work-min').value = String(workMin);
  $('#work-sleep-work-max').value = String(workMax);
  $('#work-sleep-sleep-min').value = String(sleepMin);
  $('#work-sleep-sleep-max').value = String(sleepMax);
  workSleepFormDirty = true;
  await saveWorkSleepForm();
}

function clearMicroPauseFormUi() {
  const en = $('#micro-pause-enabled');
  if (en) en.checked = false;
  fillMicroPauseForm({
    enabled: false,
    pauseMinutesMin: 2,
    pauseMinutesMax: 5,
    intervalMinutesMin: 20,
    intervalMinutesMax: 45,
  });
  microPauseFormDirty = true;
  saveMicroPauseForm().catch(() => {});
}

async function generateMicroPauseForm() {
  const pauseMin = randInt(1, 4);
  const pauseMax = pauseMin + randInt(1, 6);
  const intMin = randInt(15, 35);
  const intMax = intMin + randInt(10, 40);
  const en = $('#micro-pause-enabled');
  if (en) en.checked = true;
  $('#micro-pause-min').value = String(pauseMin);
  $('#micro-pause-max').value = String(pauseMax);
  $('#micro-pause-interval-min').value = String(intMin);
  $('#micro-pause-interval-max').value = String(intMax);
  microPauseFormDirty = true;
  await saveMicroPauseForm();
}

function clearDailyScheduleGrid() {
  renderDailyScheduleGrid(Array.from({ length: 24 }, (_, h) => ({
    hour: h,
    half0: false,
    half30: false,
    proxyIndex: null,
  })));
  dailyScheduleFormDirty = true;
  const hint = $('#daily-schedule-save-hint');
  if (hint) {
    hint.className = 'daily-schedule-hint muted';
    hint.textContent = 'All slots cleared — click Save to apply';
  }
  updateDailyScheduleProxyToggleLabel();
}

function generateDailyScheduleGrid() {
  const proxyCount = dailyScheduleProxyCount || 0;
  const hours = [];
  for (let h = 0; h < 24; h++) {
    const dayBias = h >= 7 && h <= 22 ? 0.72 : 0.2;
    const half0 = Math.random() < dayBias;
    const half30 = Math.random() < dayBias;
    let proxyIndex = null;
    if ((half0 || half30) && proxyCount > 0 && Math.random() < 0.55) {
      proxyIndex = proxyCount > 1 ? h % proxyCount : 0;
    }
    hours.push({ hour: h, half0, half30, proxyIndex });
  }
  renderDailyScheduleGrid(hours);
  dailyScheduleFormDirty = true;
  const hint = $('#daily-schedule-save-hint');
  if (hint) {
    hint.className = 'daily-schedule-hint muted';
    hint.textContent = 'New random schedule — click Save to apply';
  }
  updateDailyScheduleProxyToggleLabel();
}

function dailyScheduleProxyOn() {
  return $$('.daily-hour-proxy').some(sel => sel.value !== '');
}

function updateDailyScheduleProxyToggleLabel() {
  const btn = $('#daily-schedule-proxy-toggle');
  if (!btn) return;
  const proxyCount = dailyScheduleProxyCount || 0;
  if (!proxyCount) {
    btn.textContent = 'Proxy';
    btn.title = 'Configure proxies in the Proxy panel first';
    btn.disabled = true;
    return;
  }
  btn.disabled = false;
  const on = dailyScheduleProxyOn();
  btn.textContent = on ? 'Proxy on' : 'Proxy off';
  btn.classList.toggle('on', on);
  btn.title = on
    ? 'Set all hours to direct (Off)'
    : `Assign P1–P${proxyCount} to active hours`;
}

function toggleDailyScheduleProxy() {
  const proxyCount = dailyScheduleProxyCount || 0;
  if (!proxyCount) return;
  const turnOn = !dailyScheduleProxyOn();
  $$('.daily-hour-cell').forEach(cell => {
    const sel = cell.querySelector('.daily-hour-proxy');
    if (!sel) return;
    const half0 = cell.querySelector('.daily-half-0')?.checked;
    const half30 = cell.querySelector('.daily-half-30')?.checked;
    if (!turnOn) {
      sel.value = '';
      return;
    }
    if (!half0 && !half30) return;
    const h = Number(cell.dataset.hour) || 0;
    sel.value = proxyCount > 1 ? String(h % proxyCount) : '0';
  });
  dailyScheduleFormDirty = true;
  updateDailyScheduleProxyToggleLabel();
  const hint = $('#daily-schedule-save-hint');
  if (hint) {
    hint.className = 'daily-schedule-hint muted';
    hint.textContent = turnOn ? 'Proxy enabled on active hours — click Save' : 'Proxy off on all hours — click Save';
  }
}

async function saveDailyScheduleForm() {
  const hint = $('#daily-schedule-save-hint');
  const btn = $('#daily-schedule-save');
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'daily-schedule-hint muted';
    hint.textContent = 'Saving…';
  }
  try {
    const res = await fetch('/api/config/daily-schedule', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(collectDailySchedulePayload()),
    });
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) throw new Error(data.message || 'Save failed');
    dailyScheduleFormDirty = false;
    if (data.dailySchedule) fillDailyScheduleForm(data.dailySchedule);
    if (data.dailyScheduleStatus) paintDailyScheduleStatus(data.dailyScheduleStatus);
    if (hint) {
      hint.className = 'daily-schedule-hint ok';
      hint.textContent = data.message || 'Daily schedule saved';
    }
    fetchStatus();
  } catch (err) {
    if (hint) {
      hint.className = 'daily-schedule-hint fail';
      hint.textContent = err.message || 'Could not save daily schedule';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function loadDailyScheduleForm() {
  try {
    const res = await fetch('/api/config/daily-schedule');
    const data = await parseApiJson(res);
    if (data.dailySchedule && !dailyScheduleFormDirty) fillDailyScheduleForm(data.dailySchedule);
    if (data.dailyScheduleStatus) paintDailyScheduleStatus(data.dailyScheduleStatus);
  } catch {
    /* server starting */
  }
}

function paintLifetimeTotals(totals) {
  if (!totals) return;
  setText('#t-time', totals.heroTimeBonuses);
  setText('#t-danger', totals.heroDangerBonuses);
  setText('#t-Wood', totals.woodBonuses);
  setText('#t-Clay', totals.clayBonuses);
  setText('#t-Iron', totals.ironBonuses);
  setText('#t-Crop', totals.cropBonuses);
  setText('#t-farm-list', totals.farmListSends ?? 0);
  paintFarmListSendTotal(totals.farmListSends ?? 0);
}

function paintFarmListSendTotal(count) {
  const el = $('#farm-list-send-total');
  if (!el) return;
  const n = Number(count) || 0;
  el.textContent = `${n} send${n === 1 ? '' : 's'}`;
}

function paintFarmListStatus(st) {
  const dot = $('#farm-list-dot');
  const txt = $('#farm-list-status-text');
  const line = $('#farm-list-next-line');
  const nextApprox = $('#farm-list-next-approx');
  if (!dot || !txt) return;

  if (st.farmListSends != null) paintFarmListSendTotal(st.farmListSends);

  if (st.enabled && st.schedulerRunning) {
    dot.className = 'farm-list-dot on';
    const n = st.activeCount ?? st.listCount ?? 0;
    const t = st.totalCount ?? n;
    if (st.sendAllMode) {
      txt.textContent = t
        ? `Runner ON · Start all mode · ${t} total`
        : 'Runner ON · Start all mode — load lists';
    } else {
      txt.textContent = n
        ? `Runner ON · ${n}/${t} checked`
        : (t ? 'Runner ON — check lists' : 'Runner ON — load lists');
    }
  } else if (st.enabled) {
    dot.className = 'farm-list-dot warn';
    txt.textContent = st.sendAllMode
      ? 'Runner ON · Start all mode — timer not running'
      : 'Runner ON — timer not running';
  } else {
    dot.className = 'farm-list-dot off';
    txt.textContent = 'Runner OFF';
  }

  if (line) {
    if (st.nextListName) {
      line.textContent = st.statusLine
        ? `${st.statusLine} · next: "${st.nextListName}"`
        : `Next list: "${st.nextListName}"`;
    } else {
      line.textContent = st.statusLine || '—';
    }
  }
  if (nextApprox) {
    const resumeTs = st?.scheduleResumeAt ? new Date(st.scheduleResumeAt).getTime() : NaN;
    if (st?.pauseReason === 'daily-schedule' && Number.isFinite(resumeTs)) {
      const mins = Math.max(0, Math.round((resumeTs - Date.now()) / 60000));
      if (mins <= 0) {
        nextApprox.textContent = 'Next send approx: when schedule slot opens';
      } else if (mins === 1) {
        nextApprox.textContent = 'Next send approx: ~1 min (schedule slot)';
      } else {
        nextApprox.textContent = `Next send approx: ~${mins} min (schedule slot)`;
      }
    } else if (st?.pauseReason === 'work-sleep') {
      nextApprox.textContent = 'Next send approx: after work/sleep resumes';
    } else {
      const nextTs = st?.nextRunAt ? new Date(st.nextRunAt).getTime() : NaN;
      if (!Number.isFinite(nextTs)) {
        nextApprox.textContent = 'Next send approx: —';
      } else {
        const mins = Math.max(0, Math.round((nextTs - Date.now()) / 60000));
        if (mins <= 0) {
          nextApprox.textContent = 'Next send approx: now';
        } else if (mins === 1) {
          nextApprox.textContent = 'Next send approx: ~1 min';
        } else {
          nextApprox.textContent = `Next send approx: ~${mins} min`;
        }
      }
    }
  }

  updateFarmListRunNowButton(st);
  updateFarmListSendAllButton(st);
}

function updateFarmListRunNowButton(st) {
  const btn = $('#farm-list-run-now');
  if (!btn) return;
  const sendAllMode = !!st?.sendAllMode;
  const active = sendAllMode
    ? (st?.totalCount ?? st?.listCount ?? 0)
    : (st?.activeCount ?? st?.listCount ?? 0);
  const on = !!st?.enabled && active > 0;
  btn.disabled = !on;
  btn.title = on
    ? (sendAllMode
      ? 'Queue the next cycle using global Start all farm lists'
      : 'Queue the next full cycle on the runner timer')
    : (sendAllMode
      ? 'Turn on Runner, load lists from game, and Save first'
      : 'Turn on Runner, check at least one list, and Save first');
}

function updateFarmListSendAllButton(st) {
  const btn = $('#farm-list-send-all');
  if (!btn) return;
  const sendAllMode = !!st?.sendAllMode;
  const active = sendAllMode
    ? (st?.totalCount ?? st?.listCount ?? 0)
    : (st?.activeCount ?? st?.listCount ?? 0);
  const can = active > 0 && guiCapabilitiesOk;
  btn.disabled = !can;
  btn.title = can
    ? (sendAllMode
      ? `Send all ${active} farm list(s) now via global Start all button`
      : `Send all ${active} checked farm list(s) now (one click)`)
    : !guiCapabilitiesOk
      ? 'Restart npm run gui and refresh the page'
      : (sendAllMode
        ? 'Load lists from game, then Save or Send all'
        : 'Check at least one list, then Save or Send all');
}

function updateFarmListSendAllButtonFromForm() {
  const items = collectFarmListItemsFromDom();
  const sendAllMode = !!$('#farm-list-send-all-mode')?.checked;
  updateFarmListSendAllButton({
    sendAllMode,
    activeCount: items.filter(l => l.enabled).length,
    totalCount: items.length,
  });
}

function normalizeFarmListItem(entry) {
  if (typeof entry === 'string') {
    const name = entry.trim();
    return name ? { name, enabled: true } : null;
  }
  if (entry && typeof entry === 'object') {
    const name = String(entry.name || '').trim();
    if (!name) return null;
    return {
      name,
      enabled: entry.enabled !== false,
      village: entry.village || null,
      canSendOnPage: entry.canSendOnPage,
    };
  }
  return null;
}

function renderFarmListItems(lists) {
  const container = $('#farm-list-items');
  const empty = $('#farm-list-items-empty');
  if (!container) return;

  const items = [];
  for (const raw of lists || []) {
    const e = normalizeFarmListItem(raw);
    if (e) items.push(e);
  }

  container.replaceChildren();
  if (!items.length) {
    if (empty) empty.hidden = false;
    updateFarmListRunNowButtonFromForm();
    updateFarmListSendAllButtonFromForm();
    return;
  }
  if (empty) empty.hidden = true;

  const frag = document.createDocumentFragment();
  for (const item of items) {
    const label = document.createElement('label');
    label.className = 'farm-list-item';
    if (item.canSendOnPage === false) label.classList.add('farm-list-item--no-start');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.className = 'farm-list-item-cb';
    cb.checked = item.enabled;
    setFarmListDatasetName(cb, item.name);
    const span = document.createElement('span');
    span.className = 'farm-list-item-name';
    let labelText = item.name;
    if (item.village) labelText += ` · ${item.village}`;
    if (item.canSendOnPage === false) labelText += ' (Start disabled)';
    span.textContent = labelText;
    span.title = labelText;
    label.append(cb, span);
    frag.append(label);
  }
  container.append(frag);
  updateFarmListRunNowButtonFromForm();
  updateFarmListSendAllButtonFromForm();
}

function collectFarmListItemsFromDom() {
  return $$('#farm-list-items .farm-list-item-cb').map(cb => ({
    name: farmListNameFromDataset(cb),
    enabled: cb.checked,
  })).filter(x => x.name);
}

function updateFarmListRunNowButtonFromForm() {
  const items = collectFarmListItemsFromDom();
  const sendAllMode = !!$('#farm-list-send-all-mode')?.checked;
  updateFarmListRunNowButton({
    sendAllMode,
    enabled: !!$('#farm-list-enabled')?.checked,
    activeCount: items.filter(l => l.enabled).length,
    listCount: items.filter(l => l.enabled).length,
    totalCount: items.length,
  });
}

function setAllFarmListChecks(checked) {
  $$('#farm-list-items .farm-list-item-cb').forEach(cb => { cb.checked = checked; });
  farmListFormDirty = true;
  updateFarmListRunNowButtonFromForm();
  updateFarmListSendAllButtonFromForm();
}

function fillFarmListForm(cfg) {
  if (!cfg) return;
  const en = $('#farm-list-enabled');
  const sendAllMode = $('#farm-list-send-all-mode');
  const min = $('#farm-list-min');
  const max = $('#farm-list-max');
  if (en) en.checked = !!cfg.enabled;
  if (sendAllMode) sendAllMode.checked = !!cfg.sendAllMode;
  if (min) min.value = String(cfg.intervalMinutesMin ?? 5);
  if (max) max.value = String(cfg.intervalMinutesMax ?? 15);
  renderFarmListItems(cfg.lists || []);
}

function collectFarmListForm() {
  return {
    enabled: !!$('#farm-list-enabled')?.checked,
    sendAllMode: !!$('#farm-list-send-all-mode')?.checked,
    lists: collectFarmListItemsFromDom(),
    intervalMinutesMin: Number($('#farm-list-min')?.value) || 5,
    intervalMinutesMax: Number($('#farm-list-max')?.value) || 15,
  };
}

async function saveFarmListForm(ev) {
  ev?.preventDefault();
  const hint = $('#farm-list-save-hint');
  const btn = $('#farm-list-save');
  await checkGuiServerCapabilities();
  if (!guiCapabilitiesOk) {
    if (hint) {
      hint.className = 'farm-list-hint fail';
      hint.textContent = 'GUI was restarted but this tab is stale — refresh the page (Ctrl+F5), or follow the banner above.';
    }
    return;
  }
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'farm-list-hint muted';
    hint.textContent = 'Saving…';
  }

  try {
    const payload = collectFarmListForm();
    const res = await fetch('/api/config/farm-list', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: farmListJsonBody(payload),
    });
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) throw new Error(data.message || `Save failed (${res.status})`);

    farmListFormDirty = false;
    if (data.farmList) fillFarmListForm(data.farmList);
    if (data.farmListStatus) paintFarmListStatus(data.farmListStatus);
    if (hint) {
      hint.className = 'farm-list-hint ok';
      hint.textContent = data.message || 'Farm list settings saved';
    }
    fetchStatus();
  } catch (err) {
    if (hint) {
      hint.className = 'farm-list-hint fail';
      hint.textContent = err.message || 'Could not save farm list settings';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function runFarmListNow() {
  const btn = $('#farm-list-run-now');
  const hint = $('#farm-list-save-hint');
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'farm-list-hint muted';
    hint.textContent = 'Queueing farm list send…';
  }

  try {
    const res = await fetch('/api/farm-list/run-now', { method: 'POST' });
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) throw new Error(data.message || 'Run now failed');
    if (data.farmListStatus) paintFarmListStatus(data.farmListStatus);
    if (hint) {
      hint.className = 'farm-list-hint ok';
      hint.textContent = data.message || 'Farm list send requested';
    }
    fetchStatus();
  } catch (err) {
    if (hint) {
      hint.className = 'farm-list-hint fail';
      hint.textContent = err.message || 'Could not queue farm list send';
    }
    loadFarmListForm();
  } finally {
    updateFarmListRunNowButtonFromForm();
  }
}

async function sendAllFarmListsNow() {
  const btn = $('#farm-list-send-all');
  const hint = $('#farm-list-save-hint');
  if (!guiCapabilitiesOk) {
    await checkGuiServerCapabilities();
    if (!guiCapabilitiesOk) return;
  }
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'farm-list-hint muted';
    hint.textContent = 'Sending all checked farm lists…';
  }

  try {
    const res = await fetch('/api/farm-list/send-all', { method: 'POST' });
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) throw new Error(data.message || 'Send all failed');
    if (data.totals) paintLifetimeTotals(data.totals);
    if (data.farmListStatus) paintFarmListStatus(data.farmListStatus);
    if (hint) {
      hint.className = 'farm-list-hint ok';
      const sent = data.sentLists?.length;
      hint.textContent = data.message
        || (sent ? `Sent ${sent} list(s)` : 'All checked farm lists sent');
    }
    fetchStatus();
  } catch (err) {
    if (hint) {
      hint.className = 'farm-list-hint fail';
      hint.textContent = err.message || 'Send all failed';
    }
  } finally {
    updateFarmListSendAllButtonFromForm();
  }
}

async function discoverFarmLists() {
  const btn = $('#farm-list-discover');
  const hint = $('#farm-list-save-hint');
  if (!guiCapabilitiesOk) return;
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'farm-list-hint muted';
    hint.textContent = 'Opening farm list page…';
  }

  try {
    const res = await fetch('/api/farm-list/discover');
    const data = await parseApiJson(res);
    if (!res.ok || !data.ok) {
      const msg = staleGuiRestartMessage(data.message) || 'Discover failed';
      if (/Unknown API/i.test(data.message || '')) await checkGuiServerCapabilities();
      throw new Error(msg);
    }
    const entries = data.entries || [];
    const lists = data.lists || [];
    if (lists.length) {
      const byName = new Map(entries.map(e => [String(e.name || '').toLowerCase(), e]));
      const gameOrder = entries.length
        ? entries.map(e => e.name)
        : lists.map(raw => normalizeFarmListItem(raw)?.name).filter(Boolean);
      const listByKey = new Map();
      for (const raw of lists) {
        const base = normalizeFarmListItem(raw);
        if (base) listByKey.set(base.name.toLowerCase(), base);
      }
      const enriched = [];
      for (const name of gameOrder) {
        const base = listByKey.get(String(name || '').toLowerCase());
        if (!base) continue;
        const meta = byName.get(base.name.toLowerCase());
        enriched.push(meta ? {
          ...base,
          village: meta.village || base.village,
          canSendOnPage: meta.canSend,
        } : base);
      }
      for (const raw of lists) {
        const base = normalizeFarmListItem(raw);
        if (!base) continue;
        if (!enriched.some(e => e.name.toLowerCase() === base.name.toLowerCase())) {
          enriched.push(base);
        }
      }
      renderFarmListItems(enriched);
      farmListFormDirty = true;
    }
    if (hint) {
      hint.className = 'farm-list-hint ok';
      const n = data.discoveredCount ?? lists.length;
      const sendable = data.sendableCount;
      hint.textContent = lists.length
        ? `Loaded ${lists.length} list(s)${sendable != null ? `, ${sendable} with Start` : ''} — check which to include and Save`
        : 'No farm lists found — open rally point → Farm List tab first';
    }
  } catch (err) {
    if (hint) {
      hint.className = 'farm-list-hint fail';
      hint.textContent = err.message || 'Discover failed';
    }
  } finally {
    if (btn) btn.disabled = !guiCapabilitiesOk;
  }
}

async function loadFarmListForm() {
  try {
    const res = await fetch('/api/config/farm-list');
    const data = await res.json();
    if (res.ok) await checkGuiServerCapabilities();
    if (data.farmList && !farmListFormDirty) fillFarmListForm(data.farmList);
    if (data.farmListStatus) paintFarmListStatus(data.farmListStatus);
  } catch {
    /* server starting */
  }
}

function proxyServersFromCfg(cfg) {
  if (!cfg) return [];
  if (cfg.servers && cfg.servers.length) return cfg.servers.slice();
  if (cfg.server) return [cfg.server];
  return [];
}

function maskProxyDisplay(addr) {
  const s = String(addr || '').trim();
  if (!s) return '';
  try {
    const u = new URL(s.includes('://') ? s : `http://${s}`);
    if (u.username || u.password) {
      return `${u.protocol}//${decodeURIComponent(u.username || '')}:***@${u.host}`;
    }
    return `${u.protocol}//${u.host}`;
  } catch {
    return s.replace(/:([^:@/]+)@/, ':***@');
  }
}

function collectProxyServersFromDom() {
  return $$('#proxy-list .proxy-item').map(li => li.dataset.address || '').filter(Boolean);
}

function renderProxyList(servers, meta = {}) {
  const ul = $('#proxy-list');
  const metaEl = $('#proxy-pool-meta');
  if (!ul) return;

  ul.innerHTML = '';
  const list = servers.length ? servers : [];
  const activeIdx = meta.serverIndex ?? 0;
  const rotation = meta.rotation || 'round-robin';
  const count = list.length;
  const nextIdx = count > 1 && rotation === 'round-robin'
    ? (activeIdx + 1) % count
    : -1;

  list.forEach((addr, i) => {
    const li = document.createElement('li');
    li.className = 'proxy-item';
    li.dataset.address = addr;

    const idx = document.createElement('span');
    idx.className = 'proxy-item-idx';
    idx.textContent = String(i + 1);

    const address = document.createElement('span');
    address.className = 'proxy-item-addr';
    address.textContent = maskProxyDisplay(addr);
    address.title = maskProxyDisplay(addr);

    const tag = document.createElement('span');
    tag.className = 'proxy-item-tag';
    if (count > 1 && i === activeIdx) {
      li.classList.add('active');
      tag.textContent = 'Active';
    } else if (count > 1 && i === nextIdx) {
      tag.classList.add('next');
      tag.textContent = 'Next';
    } else {
      tag.hidden = true;
    }

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'proxy-item-remove';
    remove.title = 'Remove proxy';
    remove.setAttribute('aria-label', `Remove ${addr}`);
    remove.textContent = '×';
    remove.addEventListener('click', () => {
      li.remove();
      proxyFormDirty = true;
      updateProxyPoolMeta();
      if (!ul.children.length) ul.dispatchEvent(new Event('proxy-empty'));
    });

    li.append(idx, address, tag, remove);
    ul.appendChild(li);
  });

  if (metaEl) {
    if (!count) metaEl.textContent = 'None — add below';
    else metaEl.textContent = `${count} proxy${count === 1 ? '' : 'ies'} · ${rotation}`;
  }
}

function updateProxyPoolMeta() {
  const metaEl = $('#proxy-pool-meta');
  const rot = $('#proxy-rotation');
  if (!metaEl) return;
  const servers = collectProxyServersFromDom();
  const n = servers.length;
  const rotation = rot?.value || 'round-robin';
  metaEl.textContent = n
    ? `${n} proxy${n === 1 ? '' : 'ies'} · ${rotation}`
    : 'None — add below';
  syncDailyScheduleProxyPool(servers);
}

function paintProxyListMarkers(cfg, status) {
  const ul = $('#proxy-list');
  if (!ul) return;
  const servers = proxyServersFromCfg(cfg);
  const activeIdx = cfg?.serverIndex ?? 0;
  const count = servers.length;
  const rotation = cfg?.rotation || 'round-robin';
  const nextIdx = count > 1 && rotation === 'round-robin' ? (activeIdx + 1) % count : -1;
  const state = status?.state;

  $$('#proxy-list .proxy-item').forEach((li, i) => {
    li.classList.remove('active', 'state-ok', 'state-fail', 'state-unknown', 'state-checking');
    const tag = li.querySelector('.proxy-item-tag');
    if (!tag) return;

    if (count > 1 && i === activeIdx && cfg?.enabled) {
      li.classList.add('active');
      if (state && state !== 'off' && state !== 'checking') li.classList.add(`state-${state}`);
      tag.classList.remove('next');
      tag.hidden = false;
      tag.textContent = status?.working === true ? 'Active ✓' : 'Active';
    } else if (count > 1 && i === nextIdx) {
      tag.classList.add('next');
      tag.hidden = false;
      tag.textContent = 'Next';
    } else {
      tag.hidden = true;
      tag.textContent = '';
      tag.classList.remove('next');
    }
  });
}

function normalizeProxyServerClient(server) {
  const s = String(server || '').trim();
  if (!s) return '';
  if (/^(https?|socks5):\/\//i.test(s)) return s;
  return `http://${s}`;
}

function proxyUrlWithAuthClient(host, port, username, password) {
  const h = String(host || '').trim();
  const p = String(port || '').trim();
  if (!h || !p) return '';
  const user = String(username || '');
  const pass = password != null ? String(password) : '';
  if (user || pass) {
    return `http://${encodeURIComponent(user)}:${encodeURIComponent(pass)}@${h}:${p}`;
  }
  return `http://${h}:${p}`;
}

/** @returns {{ server: string, username?: string, password?: string }|null} */
function parseOneProxyLine(line) {
  const s = String(line || '').trim();
  if (!s || s.startsWith('#')) return null;
  if (/^(https?|socks5):\/\//i.test(s)) {
    return { server: normalizeProxyServerClient(s) };
  }

  const parts = s.split(':');
  if (parts.length >= 4) {
    const password = parts.pop();
    const username = parts.pop();
    const port = parts.pop();
    const host = parts.join(':');
    if (!host || !port || !/^\d+$/.test(port)) return null;
    return {
      server: proxyUrlWithAuthClient(host, port, username, password),
      username: String(username || ''),
      password: String(password || ''),
    };
  }

  if (parts.length === 2 && /^\d+$/.test(parts[1])) {
    return { server: normalizeProxyServerClient(s) };
  }

  return { server: normalizeProxyServerClient(s) };
}

function parseBulkProxyLines(text) {
  const lines = String(text || '').split(/[\n\r,;]+/).map(x => x.trim()).filter(Boolean);
  const servers = [];
  let username;
  let password;
  let credsConflict = false;

  for (const line of lines) {
    const parsed = parseOneProxyLine(line);
    if (!parsed?.server) continue;
    servers.push(parsed.server);
    if (parsed.username != null) {
      if (username === undefined) {
        username = parsed.username;
        password = parsed.password;
      } else if (username !== parsed.username || password !== parsed.password) {
        credsConflict = true;
      }
    }
  }

  return {
    servers: [...new Set(servers)],
    username,
    password,
    credsConflict,
  };
}

function addProxyFromInput() {
  const inp = $('#proxy-add-input');
  const hint = $('#proxy-save-hint');
  if (!inp) return;
  const raw = inp.value.trim();
  if (!raw) return;

  const { servers: newServers, username, password, credsConflict } = parseBulkProxyLines(raw);
  if (!newServers.length) {
    if (hint) {
      hint.className = 'proxy-hint fail';
      hint.textContent = 'No valid proxies — use host:port or host:port:user:pass per line';
    }
    return;
  }

  const existing = collectProxyServersFromDom();
  const merged = [...new Set([...existing, ...newServers])];
  const added = merged.length - existing.length;

  renderProxyList(merged, {
    serverIndex: 0,
    rotation: $('#proxy-rotation')?.value || 'round-robin',
  });
  updateProxyPoolMeta();

  if (username != null && !credsConflict) {
    const userEl = $('#proxy-username');
    const passEl = $('#proxy-password');
    if (userEl) userEl.value = username;
    if (passEl) passEl.value = password;
  } else if (credsConflict) {
    if (hint) {
      hint.className = 'proxy-hint muted';
      hint.textContent = `Added ${added || newServers.length} proxies — each line keeps its own user/pass (not shared fields)`;
    }
  }

  inp.value = '';
  proxyFormDirty = true;
  if (hint) {
    hint.className = 'proxy-hint ok';
    let msg = `Added ${added} proxy${added === 1 ? '' : 'ies'}`;
    const dupes = newServers.length - added;
    if (dupes > 0) msg += ` (${dupes} duplicate${dupes === 1 ? '' : 's'} skipped)`;
    if (credsConflict) msg += ' — each proxy keeps its own user/pass';
    else if (username != null) msg += ' · user/pass filled';
    msg += ' — click Save';
    hint.textContent = msg;
  }
}

function paintAccount(a) {
  const player = $('#acc-player');
  const login = $('#acc-login');
  const ip = $('#acc-ip');
  const ipLbl = $('#acc-ip-lbl');
  const ipSub = $('#acc-ip-sub');
  if (!player || !login || !ip) return;

  player.textContent = a.playerName || (a.loggedIn ? 'Loading…' : '—');
  player.title = a.playerName
    ? 'In-game player name'
    : (a.loggedIn ? 'Click Refresh — reading name from Travian UI' : 'Log in first');
  login.textContent = a.loginUsername || '—';
  login.title = a.serverUrl || '';

  if (a.publicIp) {
    const matchMark = a.ipViaProxy && a.ipMatchesProxy ? ' ✓' : '';
    ip.textContent = `${a.publicIp}${matchMark}`;
    ip.classList.toggle('ip-via-proxy', !!a.ipViaProxy);
    ip.classList.remove('fail');

    if (a.ipViaProxy) {
      if (ipLbl) ipLbl.textContent = 'Proxy IP';
      const pool = a.activeProxyCount > 1
        ? `Proxy ${(a.activeProxyIndex ?? 0) + 1}/${a.activeProxyCount}`
        : 'Proxy active';
      const host = a.activeProxyServer ? a.activeProxyServer.replace(/^https?:\/\//i, '') : '';
      if (ipSub) {
        ipSub.hidden = false;
        ipSub.textContent = host
          ? `${pool} · ${host} — this is what Travian sees (not your home IP)`
          : `${pool} — egress IP through proxy (not your home IP)`;
      }
      ip.title = [
        'Outbound IP through the active proxy (what Travian and ipify see).',
        a.activeProxyDisplay ? `Active: ${a.activeProxyDisplay}` : '',
        a.ipMatchesProxy ? 'Matches active proxy host.' : 'Proxy host may differ from egress IP on some providers.',
        a.ipSource ? `Checked via ${a.ipSource}` : '',
      ].filter(Boolean).join(' ');
    } else {
      if (ipLbl) ipLbl.textContent = 'Direct IP';
      if (ipSub) {
        ipSub.hidden = false;
        ipSub.textContent = 'No proxy — your real outbound IP';
      }
      ip.title = a.ipSource
        ? `Direct outbound IP (proxy off). Checked via ${a.ipSource}`
        : 'Direct outbound IP — proxy is off';
    }
  } else if (a.ipError) {
    if (ipLbl) ipLbl.textContent = a.ipViaProxy ? 'Proxy IP' : 'Outbound IP';
    if (ipSub) ipSub.hidden = true;
    ip.textContent = 'Unavailable';
    ip.title = `${a.ipError} — click Refresh to retry`;
    ip.classList.remove('ip-via-proxy');
    ip.classList.add('fail');
  } else {
    if (ipLbl) ipLbl.textContent = 'Outbound IP';
    if (ipSub) ipSub.hidden = true;
    ip.textContent = '—';
    ip.title = 'Log in and click Refresh';
    ip.classList.remove('ip-via-proxy', 'fail');
  }
}

function hasStoredProxiesInCfg(cfg) {
  if (!cfg) return false;
  if (cfg.hasStored != null) return !!cfg.hasStored;
  return proxyServersFromCfg(cfg).length > 0
    || !!(cfg.username && String(cfg.username).trim())
    || !!cfg.hasPassword
    || !!(cfg.bypass && String(cfg.bypass).trim());
}

function updateProxyReloadButton(cfg) {
  const btn = $('#proxy-reload');
  if (!btn) return;
  const stored = hasStoredProxiesInCfg(cfg);
  btn.hidden = false;
  btn.disabled = !stored;
  btn.title = stored
    ? 'Discard unsaved edits and reload proxy pool and settings from config.json'
    : 'No proxy settings saved in config.json yet';
}

function fillProxyForm(cfg) {
  const en = $('#proxy-enabled');
  const rot = $('#proxy-rotation');
  const user = $('#proxy-username');
  const bypass = $('#proxy-bypass');
  if (!en) return;
  en.checked = !!cfg.enabled;
  if (rot) rot.value = cfg.rotation || 'round-robin';
  renderProxyList(proxyServersFromCfg(cfg), cfg);
  if (user) user.value = cfg.username || '';
  if (bypass) bypass.value = cfg.bypass || '';
  const pass = $('#proxy-password');
  const passHint = $('#proxy-pass-hint');
  if (pass) {
    pass.value = '';
    if (cfg.hasPassword) {
      pass.placeholder = 'Leave empty to keep current';
      pass.title = 'A password is already stored in config.json. Only type here if you want to replace it.';
      if (passHint) {
        passHint.textContent = 'Password is stored in config.json. Leave this field empty when you Save unless you are setting a new one.';
      }
    } else {
      pass.placeholder = 'Set proxy password';
      pass.title = 'Optional. Stored in config.json when you Save.';
      if (passHint) passHint.textContent = 'No proxy password saved yet. Type one here only if your proxy requires it.';
    }
  }
  updateProxyReloadButton(cfg);
  syncDailyScheduleProxyPool(proxyServersFromCfg(cfg));
  updateSchedulerProxyButtons();
}

async function loadProxyForm(options = {}) {
  const hint = $('#proxy-save-hint');
  const btn = $('#proxy-reload');
  if (options.showFeedback && btn) btn.disabled = true;
  let loadedCfg = null;
  try {
    const res = await fetch('/api/config/proxy');
    const data = await parseApiJson(res);
    if (!res.ok || data.ok === false) {
      throw new Error(data.message || `Server error (${res.status})`);
    }
    if (!data.proxy) {
      throw new Error('No proxy settings in server response');
    }
    loadedCfg = data.proxy;
    fillProxyForm(data.proxy);
    proxyFormDirty = false;
    if (options.showFeedback) {
      const n = proxyServersFromCfg(data.proxy).length;
      if (hint) {
        hint.className = 'proxy-hint ok';
        if (n) {
          hint.textContent = `Reloaded ${n} stored proxy${n === 1 ? '' : 'ies'} from config.json`;
        } else if (data.proxy.hasStored) {
          hint.textContent = 'Reloaded proxy settings from config.json (no proxy hosts in pool — add hosts or restore proxy.servers in config.json)';
        } else {
          hint.textContent = 'Reloaded proxy settings from config.json';
        }
      }
      void loadDailyScheduleForm();
      fetchStatus();
    }
    return true;
  } catch (err) {
    updateProxyReloadButton({});
    if (options.showFeedback && hint) {
      hint.className = 'proxy-hint fail';
      hint.textContent = err?.message || 'Could not reload from config.json';
    }
    return false;
  } finally {
    if (loadedCfg) updateProxyReloadButton(loadedCfg);
    if (options.showFeedback && btn) btn.disabled = !hasStoredProxiesInCfg(loadedCfg || {});
  }
}

async function reloadProxyFromConfig() {
  const btn = $('#proxy-reload');
  if (btn?.disabled) {
    const hint = $('#proxy-save-hint');
    if (hint) {
      hint.className = 'proxy-hint muted';
      hint.textContent = 'No proxy settings saved in config.json yet';
    }
    return;
  }
  if (proxyFormDirty) {
    const n = collectProxyServersFromDom().length;
    const storedRes = await fetch('/api/config/proxy').then(r => parseApiJson(r)).catch(() => null);
    const storedN = storedRes?.proxy ? proxyServersFromCfg(storedRes.proxy).length : 0;
    const ok = window.confirm(
      storedN
        ? `Discard ${n} unsaved proxy change${n === 1 ? '' : 's'} and reload ${storedN} stored `
          + `proxy${storedN === 1 ? '' : 'ies'} from config.json?`
        : 'Discard unsaved proxy edits and reload settings from config.json?',
    );
    if (!ok) return;
  }
  await loadProxyForm({ showFeedback: true });
}

async function saveProxyForm(ev) {
  ev.preventDefault();
  const hint = $('#proxy-save-hint');
  const btn = $('#proxy-form')?.querySelector('.proxy-save');
  if (btn) btn.disabled = true;
  if (hint) {
    hint.className = 'proxy-hint muted';
    hint.textContent = 'Saving…';
  }

  const servers = collectProxyServersFromDom();
  const body = {
    enabled: $('#proxy-enabled')?.checked ?? false,
    servers,
    server: servers[0] || '',
    rotation: $('#proxy-rotation')?.value || 'round-robin',
    username: $('#proxy-username')?.value?.trim() ?? '',
    bypass: $('#proxy-bypass')?.value?.trim() ?? '',
    password: $('#proxy-password')?.value ?? '',
  };

  try {
    const res = await fetch('/api/config/proxy', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.proxy) fillProxyForm(data.proxy);
    if (data.proxyStatus) paintProxy(data.proxyStatus);
    if (data.ok) {
      syncDailyScheduleProxyPool(data.proxy?.servers || []);
      if (!dailyScheduleFormDirty) {
        try {
          const ds = await fetch('/api/config/daily-schedule');
          const dsData = await parseApiJson(ds);
          if (dsData.dailySchedule) fillDailyScheduleForm(dsData.dailySchedule);
        } catch { /* optional refresh */ }
      }
    }
    if (hint) {
      hint.className = data.ok ? 'proxy-hint ok' : 'proxy-hint fail';
      hint.textContent = data.message || (data.ok ? 'Saved' : 'Failed');
    }
    if (!data.ok) return;
    proxyFormDirty = false;
    bonusesSynced = false;
    fetchStatus();
  } catch {
    if (hint) {
      hint.className = 'proxy-hint fail';
      hint.textContent = 'Network error';
    }
  } finally {
    if (btn) btn.disabled = false;
  }
}

async function refreshAccount() {
  const btn = $('#refresh-account');
  if (btn) btn.disabled = true;
  try {
    const res = await fetch('/api/account/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.account) paintAccount(data.account);
    fetchStatus();
  } catch {
    setText('#acc-ip', 'Error');
  } finally {
    if (btn) btn.disabled = false;
  }
}

function paintProxy(p) {
  const dot = $('#proxy-dot');
  const txt = $('#proxy-status-text');
  const btn = $('#test-proxy');
  if (!dot || !txt) return;

  const state = p.state || (p.configured ? 'unknown' : 'off');
  dot.className = `proxy-dot ${state}`;

  if (!p.enabled && !p.configured) {
    txt.className = 'proxy-status-text';
    txt.textContent = 'Off — enable below and save';
    if (btn) btn.disabled = true;
    return;
  }

  if (p.missingServer) {
    txt.className = 'proxy-status-text fail';
    txt.textContent = 'Enabled but server is empty';
    if (btn) btn.disabled = true;
    return;
  }

  if (btn) btn.disabled = false;

  txt.className = `proxy-status-text ${state}`;
  const addrLabel = p.display || p.server || '';
  if (state === 'ok') {
    const ms = p.latencyMs != null ? ` · ${Math.round(p.latencyMs / 1000)}s` : '';
    txt.textContent = `${addrLabel} — Working${ms}`;
  } else if (state === 'fail') {
    txt.textContent = `${addrLabel} — ${p.message || 'Failed'}`;
  } else if (state === 'unknown') {
    txt.textContent = `${addrLabel} — ${p.message || 'Log in to test'}`;
  } else if (state === 'checking') {
    txt.textContent = 'Testing…';
  } else {
    txt.className = 'proxy-status-text';
    txt.textContent = p.message || 'Off';
  }

  const cfg = {
    enabled: p.enabled,
    servers: p.servers || (p.server ? [p.server] : []),
    serverIndex: p.serverIndex ?? 0,
    serverCount: p.serverCount ?? (p.servers?.length || (p.server ? 1 : 0)),
    rotation: p.rotation || 'round-robin',
  };
  if (!proxyFormDirty) paintProxyListMarkers(cfg, p);
}

async function refreshProxyPool() {
  const btn = $('#proxy-refresh');
  const dot = $('#proxy-dot');
  const txt = $('#proxy-status-text');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  if (dot) dot.className = 'proxy-dot checking';
  if (txt) {
    txt.className = 'proxy-status-text';
    txt.textContent = 'Trying next proxies…';
  }

  try {
    const res = await fetch('/api/proxy/refresh', { method: 'POST' });
    const data = await res.json();
    if (data.proxy) paintProxy(data.proxy);
    if (data.account) paintAccount(data.account);
    if (txt && data.message) txt.textContent = data.message;
  } catch {
    if (txt) {
      txt.className = 'proxy-status-text fail';
      txt.textContent = 'Network error';
    }
    if (dot) dot.className = 'proxy-dot fail';
  } finally {
    btn.disabled = false;
    fetchStatus();
  }
}

async function testProxy() {
  const btn = $('#test-proxy');
  const dot = $('#proxy-dot');
  const txt = $('#proxy-status-text');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  if (dot) dot.className = 'proxy-dot checking';
  if (txt) {
    txt.className = 'proxy-status-text';
    txt.textContent = 'Testing through browser…';
  }

  try {
    const res = await fetch('/api/proxy/test', { method: 'POST' });
    const data = await res.json();
    if (data.proxy) paintProxy(data.proxy);
    else if (txt) txt.textContent = 'No response from server';
  } catch {
    if (txt) {
      txt.className = 'proxy-status-text fail';
      txt.textContent = 'Network error';
    }
    if (dot) dot.className = 'proxy-dot fail';
  } finally {
    btn.disabled = false;
    fetchStatus();
  }
}

async function refreshHero(deep = true) {
  if (heroRefreshPromise) return heroRefreshPromise;
  heroRefreshPromise = refreshHeroInner(deep).finally(() => {
    heroRefreshPromise = null;
  });
  return heroRefreshPromise;
}

async function refreshHeroInner(deep = true) {
  setText('#hero-name', 'Loading…');
  setText('#hero-toggle-meta', deep ? 'Loading stats…' : 'HP — · Adv —');
  try {
    const res = await fetch(`/api/hero?deep=${deep ? 1 : 0}`);
    const h = await res.json();
    paintHero(h);
    if (deep && h && !h.deep) {
      setText('#hero-toggle-meta', 'Stats unavailable — click ↻');
    }
  } catch (err) {
    setText('#hero-name', '—');
    setText('#hero-toggle-meta', 'Could not load hero');
    console.error(err);
  }
  refreshAdventures({ quiet: true });
}

async function refreshAdventures(options = {}) {
  const quiet = options.quiet === true;
  const statusEl = $('#adventures-status');
  const listEl = $('#adventures-list');
  const refreshBtn = $('#refresh-adventures');
  const sendBtn = $('#send-shortest-adventure');

  if (!quiet && statusEl) statusEl.textContent = 'Loading adventures…';
  if (!quiet && refreshBtn) refreshBtn.disabled = true;
  if (!quiet && sendBtn) sendBtn.disabled = true;

  try {
    const res = await fetch('/api/adventures');
    const data = await res.json();
    paintAdventures(data);
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = 'Could not load adventures';
    if (listEl) listEl.innerHTML = '';
  } finally {
    if (refreshBtn) refreshBtn.disabled = false;
    if (sendBtn) sendBtn.disabled = false;
  }
}

function formatAdventureDuration(a) {
  if (a?.duration && a.duration !== '?') return a.duration;
  const s = a?.durationSeconds;
  if (s == null || Number.isNaN(s)) return '—';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function setAdventureRowSendDisabled(disabled) {
  $$('#adventures-list [data-adventure-send]').forEach(btn => { btn.disabled = disabled; });
  const shortest = $('#send-shortest-adventure');
  if (shortest) shortest.disabled = disabled || shortest.dataset.sendable !== '1';
}

function paintAdventures(data) {
  const statusEl = $('#adventures-status');
  const listEl = $('#adventures-list');
  const sendBtn = $('#send-shortest-adventure');
  if (!listEl) return;

  listEl.innerHTML = '';

  if (statusEl) statusEl.className = 'adventures-status muted';

  if (!data || !data.ok) {
    if (statusEl) statusEl.textContent = data?.message || 'Adventures unreachable';
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.dataset.sendable = '0';
    }
    return;
  }

  const adventures = data.adventures || data.status?.adventures || [];
  const heroAway = data.heroAway ?? data.status?.heroAway;
  const shortestIndex = data.shortestIndex ?? data.status?.shortestIndex;

  if (heroAway) {
    if (statusEl) statusEl.textContent = 'Hero is on an adventure — list refreshes when they return.';
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.dataset.sendable = '0';
    }
    return;
  }

  if (!adventures.length) {
    if (statusEl) statusEl.textContent = 'No adventures available right now.';
    if (sendBtn) {
      sendBtn.disabled = true;
      sendBtn.dataset.sendable = '0';
    }
    return;
  }

  const sendable = adventures.filter(a => a.canSend);
  if (shortestIndex != null && sendable.length) {
    const pick = adventures.find(a => a.index === shortestIndex);
    if (statusEl) {
      statusEl.textContent = pick
        ? `${adventures.length} available — shortest: ${pick.place} (${formatAdventureDuration(pick)})`
        : `${adventures.length} adventure(s) available`;
    }
  } else if (statusEl) {
    statusEl.textContent = sendable.length
      ? `${adventures.length} listed — ${sendable.length} sendable`
      : `${adventures.length} listed — none sendable (hero busy?)`;
  }

  if (sendBtn) {
    sendBtn.disabled = !sendable.length;
    sendBtn.dataset.sendable = sendable.length ? '1' : '0';
  }

  for (const a of adventures) {
    const li = document.createElement('li');
    li.className = 'adventure-item';
    if (a.index === shortestIndex && a.canSend) li.classList.add('shortest');
    if (!a.canSend) li.classList.add('unsendable');

    const top = document.createElement('div');
    top.className = 'adventure-item-top';

    const place = document.createElement('span');
    place.className = 'adventure-place';
    place.textContent = a.place || '?';
    place.title = a.place || '';

    top.appendChild(place);

    if (a.canSend) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ghost adventure-send-row-btn';
      btn.textContent = 'Send';
      btn.dataset.adventureSend = String(a.index);
      btn.title = `Send hero to ${a.place || 'adventure'} (${formatAdventureDuration(a)})`;
      top.appendChild(btn);
    }

    const meta = document.createElement('div');
    meta.className = 'adventure-item-meta';

    const timeWrap = document.createElement('span');
    timeWrap.className = 'adventure-time-wrap';
    const timeLbl = document.createElement('span');
    timeLbl.className = 'adventure-time-lbl';
    timeLbl.textContent = 'Time';
    const timeVal = document.createElement('span');
    timeVal.className = 'adventure-time';
    timeVal.textContent = formatAdventureDuration(a);
    timeWrap.append(timeLbl, timeVal);

    const distWrap = document.createElement('span');
    distWrap.className = 'adventure-dist-wrap';
    const distLbl = document.createElement('span');
    distLbl.className = 'adventure-meta-lbl';
    distLbl.textContent = 'Dist';
    const distVal = document.createElement('span');
    distVal.className = 'adventure-meta';
    distVal.textContent = a.distance || '—';
    distWrap.append(distLbl, distVal);

    const diff = document.createElement('span');
    diff.className = `adventure-diff ${a.difficulty === 'Hard' ? 'hard' : 'normal'}`;
    diff.textContent = a.difficulty || 'Normal';

    meta.append(timeWrap, distWrap, diff);

    if (a.index === shortestIndex && a.canSend) {
      const tag = document.createElement('span');
      tag.className = 'adventure-tag';
      tag.textContent = 'Shortest';
      meta.appendChild(tag);
    }

    li.append(top, meta);
    listEl.appendChild(li);
  }
}

let adventureSendInFlight = false;

async function sendAdventureByIndex(index) {
  if (adventureSendInFlight) return;
  const statusEl = $('#adventures-status');
  adventureSendInFlight = true;
  setAdventureRowSendDisabled(true);
  if (statusEl) statusEl.textContent = 'Sending hero…';

  try {
    const res = await fetch('/api/adventures/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index }),
    });
    const data = await res.json();
    if (statusEl) {
      statusEl.textContent = data.message || (data.ok ? 'Hero sent' : 'Send failed');
      statusEl.className = data.ok ? 'adventures-status muted ok' : 'adventures-status muted fail';
    }
    await refreshAdventures({ quiet: true });
    refreshHero(false);
  } catch (err) {
    console.error(err);
    if (statusEl) {
      statusEl.textContent = err.message || 'Send failed';
      statusEl.className = 'adventures-status muted fail';
    }
  } finally {
    adventureSendInFlight = false;
    setAdventureRowSendDisabled(false);
  }
}

async function sendShortestAdventure() {
  if (adventureSendInFlight) return;
  const statusEl = $('#adventures-status');
  adventureSendInFlight = true;
  setAdventureRowSendDisabled(true);
  if (statusEl) statusEl.textContent = 'Sending hero to shortest adventure…';

  try {
    const res = await fetch('/api/adventures/send-shortest', { method: 'POST' });
    const data = await res.json();
    if (statusEl) {
      statusEl.textContent = data.message || (data.ok ? 'Hero sent' : 'Send failed');
      statusEl.className = data.ok ? 'adventures-status muted ok' : 'adventures-status muted fail';
    }
    await refreshAdventures({ quiet: true });
    refreshHero(false);
  } catch (err) {
    console.error(err);
    if (statusEl) statusEl.textContent = 'Network error while sending hero';
  } finally {
    adventureSendInFlight = false;
    setAdventureRowSendDisabled(false);
  }
}

function paintHero(h) {
  if (!h) return;
  const q = h.quick || {};
  const d = h.deep || {};

  const name = d.name || q.heroName || 'Hero';
  const badge = d.adventureBadge || q.adventureBadge || '0';
  setText('#hero-name', name);
  setText('#hero-badge', badge);
  setText('#hero-toggle-meta', `HP ${pct(d.healthPercent)} · Adv ${badge}`);

  // Experience is shown as a raw number (e.g. "1107"), not a percentage,
  // so the XP bar is capped at 100% just for visual feedback.
  setBar('#hero-health-bar', d.healthPercent);
  setText('#hero-health-text', pct(d.healthPercent));

  const xp = d.experience != null ? d.experience : null;
  setText('#hero-xp-text', xp != null ? `${xp} XP` : '—');
  setBar('#hero-xp-bar', xp != null ? Math.min(100, (xp / 2000) * 100) : 0);

  setText('#stat-power',   d.power);
  setText('#stat-off',     d.offBonusPercent != null ? `${d.offBonusPercent}%` : '—');
  setText('#stat-def',     d.defBonusPercent != null ? `${d.defBonusPercent}%` : '—');
  setText('#stat-res',     d.resourceBonusText || (d.resourceBonus != null ? d.resourceBonus : '—'));
  setText('#stat-free',    d.freePoints);
  setText('#stat-speed',   d.speedText);
  setText('#stat-xp',      d.experienceText || (d.experience != null ? d.experience : '—'));
  setText('#stat-village', d.homeVillage);
}

/* ----- Bonus button handler ----- */

function buttonResourceKey(btn) {
  const ep = btn.dataset.endpoint || '';
  if (ep.includes('/bonus/time')) return 'time';
  if (ep.includes('/bonus/danger')) return 'danger';
  const m = ep.match(/\/bonus\/resource\/(\w+)/);
  return m ? m[1] : 'unknown';
}

function statusSelectorFor(btn) {
  const key = buttonResourceKey(btn);
  return `#status-${key === 'time' || key === 'danger' ? key : key}`;
}

function paintBonusStatusEl(el, statusClass, text) {
  if (!el) return;
  el.className = `bonus-status ${statusClass}`;
  el.textContent = text;
}

function paintNotClaimed(el) {
  paintBonusStatusEl(el, 'inactive', 'Not Claimed');
}

function paintClaimed(el, timeLabel) {
  const text = timeLabel ? `Claimed · ${timeLabel} left` : 'Claimed';
  paintBonusStatusEl(el, 'claimed', text);
}

function bonusTimeLabel(info) {
  if (!info) return null;
  if (info.cooldownText && /\d+:\d+/.test(info.cooldownText)) return info.cooldownText.trim();
  if (info.cooldownSeconds > 0) return formatCountdown(info.cooldownSeconds * 1000);
  return null;
}

function setBonusStatus(btn, statusClass, text) {
  const sel = statusSelectorFor(btn);
  paintBonusStatusEl($(sel), statusClass, text);
}

/** Live countdowns for resources polled from Travian (resource name → endsAt ms). */
const bonusCooldownEnds = {};

function formatCountdown(msLeft) {
  if (msLeft <= 0) return '0:00:00';
  const s = Math.floor(msLeft / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function paintResourceStatus(resource, info) {
  const el = $(`#status-${resource}`);
  if (!el) return;
  if (info.status === 'active') {
    const label = bonusTimeLabel(info);
    if (info.cooldownSeconds > 0) {
      bonusCooldownEnds[resource] = Date.now() + info.cooldownSeconds * 1000;
    } else {
      delete bonusCooldownEnds[resource];
    }
    paintClaimed(el, label);
  } else if (info.status === 'missing') {
    delete bonusCooldownEnds[resource];
    paintBonusStatusEl(el, 'unavail', 'Box not present');
  } else {
    delete bonusCooldownEnds[resource];
    paintNotClaimed(el);
  }
}

function paintHeroBonusFromPoll(key, info) {
  const el = $(`#status-${key}`);
  if (!el || !info) return;
  if (info.status === 'active') {
    const label = bonusTimeLabel(info);
    if (info.cooldownSeconds > 0) {
      bonusCooldownEnds[key] = Date.now() + info.cooldownSeconds * 1000;
    } else {
      delete bonusCooldownEnds[key];
    }
    paintClaimed(el, label);
  } else {
    delete bonusCooldownEnds[key];
    paintNotClaimed(el);
  }
}

function paintHeroBonusStatus(key, data) {
  const el = $(`#status-${key}`);
  if (!el) return;
  if (data.status === 'claimed' || data.status === 'active') {
    bonusCooldownEnds[key] = Date.now() + 8 * 60 * 60 * 1000;
    paintClaimed(el, '08:00:00');
  } else if (data.status === 'unavailable') {
    paintNotClaimed(el);
  } else {
    paintBonusStatusEl(el, 'failed', data.message || 'Failed');
  }
}

const BONUS_KEYS = ['time', 'danger', 'Wood', 'Clay', 'Iron', 'Crop'];
const HERO_BONUS_KEYS = ['time', 'danger'];
const RESOURCE_BONUS_KEYS = ['Wood', 'Clay', 'Iron', 'Crop'];

function bonusKeysForScope(scope) {
  if (scope === 'hero') return HERO_BONUS_KEYS;
  if (scope === 'resources') return RESOURCE_BONUS_KEYS;
  return BONUS_KEYS;
}
let bonusesSynced = false;
let refreshPromise = null;
let heroRefreshPromise = null;
let startupSyncStarted = false;
let logRefreshTimer = null;

function setAllBonusStatusesPolling(keys = BONUS_KEYS) {
  for (const key of keys) {
    paintBonusStatusEl($(`#status-${key}`), 'busy', 'Checking…');
  }
}

async function handleClaimAllResources() {
  const btn = $('#claim-all-resources');
  const resultEl = $('#claim-all-result');
  if (!btn || btn.disabled) return;

  btn.disabled = true;
  if (resultEl) {
    resultEl.className = 'claim-all-result muted';
    resultEl.textContent = 'Checking shop and claiming videos…';
  }
  ['Wood', 'Clay', 'Iron', 'Crop'].forEach(r => {
    paintBonusStatusEl($(`#status-${r}`), 'busy', 'Batch claim…');
  });
  $$('button.bonus').forEach(b => { b.disabled = true; });

  try {
    const res = await fetch('/api/bonus/resources/claim-all', { method: 'POST' });
    const data = await res.json();

    if (data.claimed && data.claimed.length) {
      const ends = Date.now() + 8 * 60 * 60 * 1000;
      for (const r of data.claimed) {
        bonusCooldownEnds[r] = ends;
        paintClaimed($(`#status-${r}`), '08:00:00');
      }
    }

    if (resultEl) {
      if (data.claimedCount > 0) {
        resultEl.className = 'claim-all-result ok';
        resultEl.textContent = data.message || `Claimed ${data.claimed.join(', ')}`;
      } else if (data.message && /shop|advantages|unreachable/i.test(data.message)) {
        resultEl.className = 'claim-all-result bad';
        resultEl.textContent = data.message;
      } else if (data.available && data.available.length === 0) {
        resultEl.className = 'claim-all-result warn';
        resultEl.textContent = 'No claimable resource videos right now — try Refresh all bonuses';
      } else {
        resultEl.className = 'claim-all-result bad';
        resultEl.textContent = data.message || 'Nothing claimed';
      }
    }
  } catch {
    if (resultEl) {
      resultEl.className = 'claim-all-result bad';
      resultEl.textContent = 'Network error';
    }
  } finally {
    btn.disabled = false;
    $$('button.bonus').forEach(b => { b.disabled = false; });
    fetchStatus();
    await refreshAllBonuses({ quiet: true, force: true, scope: 'resources' });
  }
}

async function handleBonusClick(btn) {
  if (btn.disabled) return;
  const endpoint = btn.dataset.endpoint;
  if (!endpoint) return;
  const resourceKey = buttonResourceKey(btn);
  const isResource = ['Wood', 'Clay', 'Iron', 'Crop'].includes(resourceKey);

  $$('button.bonus').forEach(b => { b.disabled = true; });
  setBonusStatus(btn, 'busy', 'Working…');

  try {
    const res = await fetch(endpoint, { method: 'POST' });
    const data = await res.json();

    if (isResource) {
      if (data.status === 'claimed') {
        // Video buff is ~8h; show optimistic active until poll confirms.
        bonusCooldownEnds[resourceKey] = Date.now() + 8 * 60 * 60 * 1000;
        setBonusStatus(btn, 'claimed', 'Claimed · 08:00:00 left');
      } else {
        if (data.status === 'unavailable') {
          paintNotClaimed($(`#status-${resourceKey}`));
        } else {
          paintBonusStatusEl($(`#status-${resourceKey}`), 'failed', data.message || 'Failed');
        }
      }
    } else {
      paintHeroBonusStatus(resourceKey, data);
    }
  } catch {
    setBonusStatus(btn, 'failed', 'Network error');
  } finally {
    $$('button.bonus').forEach(b => { b.disabled = false; });
    fetchStatus();
    const scope = isResource ? 'resources' : 'hero';
    await refreshAllBonuses({ quiet: true, force: true, scope });
  }
}

/* ----- Poll all bonus buttons (hero + resources) ----- */

function applyBonusesPoll(data) {
  if (data.resources) {
    const res = data.resources;
    if (res.statuses) {
      for (const [resource, info] of Object.entries(res.statuses)) {
        paintResourceStatus(resource, info);
      }
    } else {
      RESOURCE_BONUS_KEYS.forEach(r => {
        paintBonusStatusEl(
          $(`#status-${r}`),
          'unavail',
          res.opened === false ? 'Shop unreachable' : 'Could not read'
        );
      });
    }
  }

  if (data.hero) {
    const hero = data.hero;
    if (hero.ok) {
      paintHeroBonusFromPoll('time', hero.time);
      paintHeroBonusFromPoll('danger', hero.danger);
    } else {
      HERO_BONUS_KEYS.forEach(k => {
        paintBonusStatusEl($(`#status-${k}`), 'unavail', 'Adventures unreachable');
      });
    }
  }
}

async function refreshAllBonuses(options = {}) {
  const quiet = options.quiet === true;
  const force = options.force === true;
  const scope = options.scope === 'hero' || options.scope === 'resources' ? options.scope : 'all';
  const keys = bonusKeysForScope(scope);

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const btn = $('#refresh-bonuses');
    if (!quiet && btn) {
      btn.disabled = true;
      btn.textContent = 'Checking…';
    }
    if (!quiet || !bonusesSynced) setAllBonusStatusesPolling(keys);

    try {
      const params = new URLSearchParams();
      if (force) params.set('force', '1');
      if (scope !== 'all') params.set('scope', scope);
      const qs = params.toString();
      const url = qs ? `/api/bonuses/status?${qs}` : '/api/bonuses/status';
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) {
        keys.forEach(k => {
          paintBonusStatusEl($(`#status-${k}`), 'unavail', data.message || 'Not logged in');
        });
        return;
      }
      applyBonusesPoll(data);
      if (scope === 'all') bonusesSynced = true;
    } catch (err) {
      console.error(err);
      keys.forEach(k => {
        paintBonusStatusEl($(`#status-${k}`), 'failed', 'Network error');
      });
    } finally {
      if (!quiet && btn) {
        btn.disabled = false;
        btn.textContent = 'Refresh all bonuses';
      }
    }
  })().finally(() => {
    refreshPromise = null;
  });

  return refreshPromise;
}

/** One startup sync after login — not repeated by the 5s status poll. */
async function syncBonusesWhenReady() {
  if (startupSyncStarted) return;
  startupSyncStarted = true;

  for (let attempt = 0; attempt < 90; attempt++) {
    try {
      const res = await fetch('/api/health');
      const h = await res.json();
      if (h.loggedIn && !h.busy) {
        await refreshAllBonuses({ quiet: true });
        await refreshHero(true);
        return;
      }
      if (!h.loggedIn && attempt > 5) {
        BONUS_KEYS.forEach(k => {
          paintBonusStatusEl($(`#status-${k}`), 'unavail', 'Waiting for login…');
        });
      }
    } catch {
      /* server still starting */
    }
    await new Promise(r => setTimeout(r, 2000));
  }
}

function scheduleBonusRefreshFromLog() {
  clearTimeout(logRefreshTimer);
  logRefreshTimer = setTimeout(() => {
    if (!refreshPromise) refreshAllBonuses({ quiet: true, force: true });
  }, 4000);
}

function tickBonusCountdowns() {
  const now = Date.now();
  for (const [resource, endsAt] of Object.entries(bonusCooldownEnds)) {
    const el = $(`#status-${resource}`);
    if (!el) continue;
    const left = endsAt - now;
    if (left > 0) {
      paintClaimed(el, formatCountdown(left));
    } else {
      delete bonusCooldownEnds[resource];
      paintNotClaimed(el);
    }
  }
}

/* ----- Re-login + clear ----- */

async function relogin() {
  accountAutoRefreshAttempts = 0;
  const btn = $('#relogin');
  btn.disabled = true;
  try {
    await fetch('/api/relogin', { method: 'POST' });
  } finally {
    btn.disabled = false;
    bonusesSynced = false;
    startupSyncStarted = false;
    fetchStatus();
    refreshHero(true);
    await syncBonusesWhenReady();
  }
}

async function quitBot() {
  const btn = $('#quit-bot');
  if (!btn || btn.disabled) return;
  const ok = window.confirm('Quit bot and close the GUI server now?');
  if (!ok) return;

  btn.disabled = true;
  try {
    await fetch('/api/quit', { method: 'POST' });
    setText('#session-text', 'Shutting down...');
  } catch {
    btn.disabled = false;
    setText('#session-text', 'Quit failed (network error)');
  }
}

/* ----- Live log SSE ----- */

const logEl = $('#log');
function appendLog(entry) {
  const ts = entry.ts || '';
  const level = (entry.level || '').toLowerCase() || 'info';
  const tag = entry.tag || '';
  const message = entry.message || entry.line || '';
  const line = document.createElement('div');
  line.className = level;
  line.innerHTML = `<span class="ts">[${ts}]</span> <span class="tag">[${tag}]</span> ${escapeHtml(message)}`;
  logEl.appendChild(line);
  // cap at 500 lines
  while (logEl.children.length > 500) logEl.removeChild(logEl.firstChild);
  logEl.scrollTop = logEl.scrollHeight;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function parseReplayLine(line) {
  // Replay format: "[2026-05-21 04:18:10.534] [adventures] message"
  const m = String(line).match(/^\[([^\]]+)\] \[([^\]]+)\] (?:(INFO|WARN|ERROR)\s+)?(.*)$/);
  if (!m) return { ts: '', tag: '', level: 'info', message: line };
  return { ts: m[1], tag: m[2], level: (m[3] || 'INFO').toUpperCase(), message: m[4] };
}

function startLogStream() {
  const es = new EventSource('/api/log/stream');
  es.onmessage = ev => {
    try {
      const data = JSON.parse(ev.data);
      if (data.replay) {
        appendLog(parseReplayLine(data.line));
        return;
      }
      appendLog(data);
      const msg = data.message || '';
      if (/bonus.*completed|bonus video watched successfully/i.test(msg)) {
        fetchStatus();
        scheduleBonusRefreshFromLog();
      }
      if (/farmList|farm list/i.test(msg)) {
        fetchStatus();
      }
    } catch { /* ignore malformed */ }
  };
  es.onerror = () => {
    setTimeout(startLogStream, 2000);
    es.close();
  };
}

/* ----- Wire-up ----- */

document.addEventListener('click', ev => {
  const btn = ev.target.closest('[data-action]');
  if (!btn) return;
  const action = btn.dataset.action;
  if (action === 'bonus')                 handleBonusClick(btn);
  if (action === 'claim-all-resources')   handleClaimAllResources();
  if (action === 'refresh-hero')          refreshHero(true);
  if (action === 'refresh-adventures')    refreshAdventures();
  if (action === 'send-shortest-adventure') sendShortestAdventure();

$('#adventures-list')?.addEventListener('click', ev => {
  const btn = ev.target.closest('[data-adventure-send]');
  if (!btn || btn.disabled) return;
  const index = Number(btn.dataset.adventureSend);
  if (Number.isNaN(index)) return;
  ev.preventDefault();
  sendAdventureByIndex(index);
});
  if (action === 'refresh-bonuses')       refreshAllBonuses({ force: true });
});

$('#relogin').addEventListener('click', relogin);
$('#quit-bot')?.addEventListener('click', quitBot);
$('#test-proxy')?.addEventListener('click', testProxy);
$('#proxy-refresh')?.addEventListener('click', refreshProxyPool);
$('#proxy-reload')?.addEventListener('click', reloadProxyFromConfig);
$('#refresh-account')?.addEventListener('click', refreshAccount);
$('#proxy-form')?.addEventListener('submit', saveProxyForm);
$('#proxy-form')?.addEventListener('input', () => { proxyFormDirty = true; });
$('#schedule-form')?.addEventListener('submit', saveScheduleForm);
$('#schedule-form')?.addEventListener('input', () => { scheduleFormDirty = true; });
$('#schedule-run-now')?.addEventListener('click', runSchedulerNow);
$('#schedule-clear')?.addEventListener('click', clearBonusSchedulerForm);
$('#schedule-generate')?.addEventListener('click', generateBonusSchedulerForm);
$('#schedule-proxy-toggle')?.addEventListener('click', toggleGlobalProxy);
$('#work-sleep-save')?.addEventListener('click', saveWorkSleepForm);
$('#work-sleep-clear')?.addEventListener('click', clearWorkSleepFormUi);
$('#work-sleep-generate')?.addEventListener('click', () => { generateWorkSleepForm().catch(() => {}); });
$('#work-sleep-proxy-toggle')?.addEventListener('click', toggleGlobalProxy);
$('#micro-pause-save')?.addEventListener('click', saveMicroPauseForm);
$('#micro-pause-clear')?.addEventListener('click', clearMicroPauseFormUi);
$('#micro-pause-generate')?.addEventListener('click', () => { generateMicroPauseForm().catch(() => {}); });
$('#micro-pause-proxy-toggle')?.addEventListener('click', toggleGlobalProxy);
$('#daily-schedule-save')?.addEventListener('click', saveDailyScheduleForm);
$('#daily-schedule-clear')?.addEventListener('click', clearDailyScheduleGrid);
$('#daily-schedule-generate')?.addEventListener('click', generateDailyScheduleGrid);
$('#daily-schedule-proxy-toggle')?.addEventListener('click', toggleDailyScheduleProxy);
$('#daily-schedule-enabled')?.addEventListener('change', () => { dailyScheduleFormDirty = true; });
$('#work-sleep-enabled')?.addEventListener('change', () => { workSleepFormDirty = true; });
$('#micro-pause-enabled')?.addEventListener('change', () => { microPauseFormDirty = true; });
$$('#work-sleep-work-min, #work-sleep-work-max, #work-sleep-sleep-min, #work-sleep-sleep-max')
  .forEach(el => el.addEventListener('input', () => { workSleepFormDirty = true; }));
$$('#micro-pause-min, #micro-pause-max, #micro-pause-interval-min, #micro-pause-interval-max')
  .forEach(el => el.addEventListener('input', () => { microPauseFormDirty = true; }));
$('#farm-list-save')?.addEventListener('click', saveFarmListForm);
$('#farm-list-form')?.addEventListener('submit', ev => {
  ev.preventDefault();
  saveFarmListForm();
});
$('#farm-list-form')?.addEventListener('input', () => { farmListFormDirty = true; });
$('#farm-list-items')?.addEventListener('change', () => {
  farmListFormDirty = true;
  updateFarmListRunNowButtonFromForm();
  updateFarmListSendAllButtonFromForm();
});
$('#farm-list-send-all-mode')?.addEventListener('change', () => {
  farmListFormDirty = true;
  updateFarmListRunNowButtonFromForm();
  updateFarmListSendAllButtonFromForm();
});
$('#farm-list-run-now')?.addEventListener('click', runFarmListNow);
$('#farm-list-send-all')?.addEventListener('click', sendAllFarmListsNow);
$('#farm-list-discover')?.addEventListener('click', discoverFarmLists);
$('#farm-list-check-all')?.addEventListener('click', () => setAllFarmListChecks(true));
$('#farm-list-check-none')?.addEventListener('click', () => setAllFarmListChecks(false));
$('#proxy-add-btn')?.addEventListener('click', addProxyFromInput);
$('#proxy-add-input')?.addEventListener('keydown', ev => {
  if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
    ev.preventDefault();
    addProxyFromInput();
  }
});
$('#proxy-rotation')?.addEventListener('change', () => {
  proxyFormDirty = true;
  updateProxyPoolMeta();
  paintProxyListMarkers(
    {
      servers: collectProxyServersFromDom(),
      serverIndex: 0,
      enabled: $('#proxy-enabled')?.checked,
      rotation: $('#proxy-rotation')?.value,
    },
    null
  );
});
$('#clear-log').addEventListener('click', () => { logEl.innerHTML = ''; });

const THEME_STORAGE_KEY = 'tbot-theme';

function resolveTheme(pref) {
  if (pref === 'light') return 'light';
  if (pref === 'ocean') return 'ocean';
  if (pref === 'peach') return 'peach';
  if (pref === 'system') {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  }
  return 'dark';
}

function applyTheme(pref) {
  localStorage.setItem(THEME_STORAGE_KEY, pref);
  document.documentElement.dataset.themePref = pref;
  document.documentElement.setAttribute('data-theme', resolveTheme(pref));
  $$('.theme-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themePref === pref);
  });
}

function initTheme() {
  const pref = localStorage.getItem(THEME_STORAGE_KEY) || document.documentElement.dataset.themePref || 'dark';
  applyTheme(pref);
  $$('.theme-btn').forEach(btn => {
    btn.addEventListener('click', () => applyTheme(btn.dataset.themePref));
  });
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (localStorage.getItem(THEME_STORAGE_KEY) === 'system') applyTheme('system');
  });
}

initTheme();
updateProxyReloadButton({});
loadProxyForm();
loadScheduleForm();
loadWorkSleepForm();
loadMicroPauseForm();
loadDailyScheduleForm();
loadFarmListForm();
checkGuiServerCapabilities();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') checkGuiServerCapabilities();
});
setInterval(checkGuiServerCapabilities, 30000);

setAllBonusStatusesPolling();
fetchStatus();
syncBonusesWhenReady();
startLogStream();
setInterval(fetchStatus, 5000);
setInterval(applyDailyScheduleNowHighlight, 30_000);
setInterval(tickBonusCountdowns, 1000);
