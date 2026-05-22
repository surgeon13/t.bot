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
  } else {
    dot.className = 'dot bad';
    txt.textContent = 'Not logged in';
    bonusesSynced = false;
  }

  if (s.nextResourceBonusLine) {
    $('#bonus-next').textContent = s.nextResourceBonusLine.replace(/^\s*Resource bonus\s*:\s*/, '');
  }

  if (s.proxy) paintProxy(s.proxy);
  if (s.account) paintAccount(s.account);
  if (s.proxyConfig && !proxyFormDirty) fillProxyForm(s.proxyConfig);
}

let proxyFormDirty = false;

function paintAccount(a) {
  const player = $('#acc-player');
  const login = $('#acc-login');
  const ip = $('#acc-ip');
  if (!player || !login || !ip) return;

  player.textContent = a.playerName || (a.loggedIn === false ? '—' : 'Unknown');
  player.title = a.playerName || 'In-game name from Travian UI';
  login.textContent = a.loginUsername || '—';
  login.title = a.serverUrl || '';

  if (a.publicIp) {
    ip.textContent = a.publicIp;
    ip.title = a.ipSource ? `Via ${a.ipSource}` : 'Outbound IP seen by the browser';
    ip.classList.remove('fail');
  } else if (a.ipError) {
    ip.textContent = 'Unavailable';
    ip.title = a.ipError;
    ip.classList.add('fail');
  } else {
    ip.textContent = '—';
    ip.title = 'Log in and refresh';
    ip.classList.remove('fail');
  }
}

function fillProxyForm(cfg) {
  const en = $('#proxy-enabled');
  const srv = $('#proxy-server');
  const user = $('#proxy-username');
  const bypass = $('#proxy-bypass');
  if (!en || !srv) return;
  en.checked = !!cfg.enabled;
  srv.value = cfg.server || '';
  if (user) user.value = cfg.username || '';
  if (bypass) bypass.value = cfg.bypass || '';
  const pass = $('#proxy-password');
  if (pass) {
    pass.value = '';
    pass.placeholder = cfg.hasPassword ? 'Saved (leave blank to keep)' : 'Optional';
  }
}

async function loadProxyForm() {
  try {
    const res = await fetch('/api/config/proxy');
    const data = await res.json();
    if (data.proxy) {
      fillProxyForm(data.proxy);
      proxyFormDirty = false;
    }
  } catch {
    /* ignore */
  }
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

  const body = {
    enabled: $('#proxy-enabled')?.checked ?? false,
    server: $('#proxy-server')?.value?.trim() ?? '',
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
  setText('#hero-name', 'Loading…');
  try {
    const res = await fetch(`/api/hero?deep=${deep ? 1 : 0}`);
    const h = await res.json();
    paintHero(h);
  } catch (err) {
    setText('#hero-name', '—');
    console.error(err);
  }
}

function paintHero(h) {
  const q = h && h.quick ? h.quick : {};
  const d = h && h.deep  ? h.deep  : {};

  setText('#hero-name',   d.name || 'Hero');
  setText('#hero-badge',  d.adventureBadge || q.adventureBadge || '0');

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

function setBonusStatus(btn, statusClass, text) {
  const sel = statusSelectorFor(btn);
  const el = $(sel);
  if (!el) return;
  el.className = `bonus-status ${statusClass}`;
  el.textContent = text;
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
  if (info.status === 'claimable') {
    delete bonusCooldownEnds[resource];
    el.className = 'bonus-status claimed';
    el.textContent = 'Claimable now';
  } else if (info.status === 'active') {
    el.className = 'bonus-status active';
    if (info.cooldownSeconds > 0) {
      bonusCooldownEnds[resource] = Date.now() + info.cooldownSeconds * 1000;
      el.textContent = `Active — ${formatCountdown(info.cooldownSeconds * 1000)} left`;
    } else {
      el.textContent = 'Active';
    }
  } else if (info.status === 'missing') {
    delete bonusCooldownEnds[resource];
    el.className = 'bonus-status unavail';
    el.textContent = 'Box not present';
  } else {
    delete bonusCooldownEnds[resource];
    el.className = 'bonus-status unavail';
    el.textContent = 'Unavailable';
  }
}

function paintHeroBonusFromPoll(key, info) {
  const el = $(`#status-${key}`);
  if (!el || !info) return;
  if (info.status === 'claimable') {
    el.className = 'bonus-status claimed';
    el.textContent = 'Claimable now';
  } else if (info.status === 'active') {
    el.className = 'bonus-status active';
    el.textContent = 'Active';
  } else {
    el.className = 'bonus-status unavail';
    el.textContent = 'Not available';
  }
}

function paintHeroBonusStatus(key, data) {
  const el = $(`#status-${key}`);
  if (!el) return;
  if (data.status === 'claimed') {
    el.className = 'bonus-status active';
    el.textContent = 'Activated';
  } else if (data.status === 'active') {
    el.className = 'bonus-status active';
    el.textContent = 'Already active';
  } else if (data.status === 'unavailable') {
    el.className = 'bonus-status unavail';
    el.textContent = data.message || 'Not available';
  } else {
    el.className = 'bonus-status failed';
    el.textContent = data.message || 'Failed';
  }
}

const BONUS_KEYS = ['time', 'danger', 'Wood', 'Clay', 'Iron', 'Crop'];
let bonusesSynced = false;
let refreshPromise = null;
let startupSyncStarted = false;
let logRefreshTimer = null;

function setAllBonusStatusesPolling() {
  for (const key of BONUS_KEYS) {
    const el = $(`#status-${key}`);
    if (el) {
      el.className = 'bonus-status busy';
      el.textContent = 'Checking…';
    }
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
    const el = $(`#status-${r}`);
    if (el) {
      el.className = 'bonus-status busy';
      el.textContent = 'Batch claim…';
    }
  });
  $$('button.bonus').forEach(b => { b.disabled = true; });

  try {
    const res = await fetch('/api/bonus/resources/claim-all', { method: 'POST' });
    const data = await res.json();

    if (data.claimed && data.claimed.length) {
      const ends = Date.now() + 8 * 60 * 60 * 1000;
      for (const r of data.claimed) {
        bonusCooldownEnds[r] = ends;
        const el = $(`#status-${r}`);
        if (el) {
          el.className = 'bonus-status active';
          el.textContent = 'Active — ~8:00:00 left';
        }
      }
    }

    if (resultEl) {
      if (data.claimedCount > 0) {
        resultEl.className = 'claim-all-result ok';
        resultEl.textContent = data.message || `Claimed ${data.claimed.join(', ')}`;
      } else if (data.available && data.available.length === 0) {
        resultEl.className = 'claim-all-result warn';
        resultEl.textContent = 'No claimable resource videos right now';
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
    await refreshAllBonuses({ quiet: true, force: true });
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
        setBonusStatus(btn, 'active', 'Active — ~8:00:00 left');
      } else {
        const el = $(`#status-${resourceKey}`);
        if (el) {
          el.className = `bonus-status ${data.status === 'unavailable' ? 'unavail' : 'failed'}`;
          el.textContent = data.message || 'Failed';
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
    await refreshAllBonuses({ quiet: true, force: true });
  }
}

/* ----- Poll all bonus buttons (hero + resources) ----- */

function applyBonusesPoll(data) {
  const res = data.resources;
  if (res?.statuses) {
    for (const [resource, info] of Object.entries(res.statuses)) {
      paintResourceStatus(resource, info);
    }
  } else {
    ['Wood', 'Clay', 'Iron', 'Crop'].forEach(r => {
      const el = $(`#status-${r}`);
      if (el) {
        el.className = 'bonus-status unavail';
        el.textContent = res?.opened === false ? 'Shop unreachable' : 'Could not read';
      }
    });
  }

  const hero = data.hero;
  if (hero?.ok) {
    paintHeroBonusFromPoll('time', hero.time);
    paintHeroBonusFromPoll('danger', hero.danger);
  } else {
    ['time', 'danger'].forEach(k => {
      const el = $(`#status-${k}`);
      if (el) {
        el.className = 'bonus-status unavail';
        el.textContent = 'Adventures unreachable';
      }
    });
  }
}

async function refreshAllBonuses(options = {}) {
  const quiet = options.quiet === true;
  const force = options.force === true;

  if (refreshPromise) return refreshPromise;

  refreshPromise = (async () => {
    const btn = $('#refresh-bonuses');
    if (!quiet && btn) {
      btn.disabled = true;
      btn.textContent = 'Checking…';
    }
    if (!quiet || !bonusesSynced) setAllBonusStatusesPolling();

    try {
      const url = force ? '/api/bonuses/status?force=1' : '/api/bonuses/status';
      const res = await fetch(url);
      const data = await res.json();
      if (!data.ok) {
        BONUS_KEYS.forEach(k => {
          const el = $(`#status-${k}`);
          if (el) {
            el.className = 'bonus-status unavail';
            el.textContent = data.message || 'Not logged in';
          }
        });
        return;
      }
      applyBonusesPoll(data);
      bonusesSynced = true;
    } catch (err) {
      console.error(err);
      BONUS_KEYS.forEach(k => {
        const el = $(`#status-${k}`);
        if (el) {
          el.className = 'bonus-status failed';
          el.textContent = 'Network error';
        }
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
        return;
      }
      if (!h.loggedIn && attempt > 5) {
        BONUS_KEYS.forEach(k => {
          const el = $(`#status-${k}`);
          if (el) {
            el.className = 'bonus-status unavail';
            el.textContent = 'Waiting for login…';
          }
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
      el.className = 'bonus-status active';
      el.textContent = `Active — ${formatCountdown(left)} left`;
    } else {
      delete bonusCooldownEnds[resource];
      el.className = 'bonus-status claimed';
      el.textContent = 'Claimable now';
    }
  }
}

/* ----- Re-login + clear ----- */

async function relogin() {
  const btn = $('#relogin');
  btn.disabled = true;
  try {
    await fetch('/api/relogin', { method: 'POST' });
  } finally {
    btn.disabled = false;
    bonusesSynced = false;
    startupSyncStarted = false;
    fetchStatus();
    refreshHero(false);
    await syncBonusesWhenReady();
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
  if (action === 'refresh-bonuses')       refreshAllBonuses({ force: true });
});

$('#relogin').addEventListener('click', relogin);
$('#test-proxy')?.addEventListener('click', testProxy);
$('#refresh-account')?.addEventListener('click', refreshAccount);
$('#proxy-form')?.addEventListener('submit', saveProxyForm);
$('#proxy-form')?.addEventListener('input', () => { proxyFormDirty = true; });
$('#clear-log').addEventListener('click', () => { logEl.innerHTML = ''; });

loadProxyForm();

setAllBonusStatusesPolling();
fetchStatus();
refreshHero(false);
syncBonusesWhenReady();
startLogStream();
setInterval(fetchStatus, 5000);
setInterval(tickBonusCountdowns, 1000);
