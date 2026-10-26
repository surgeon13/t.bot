'use strict';

/**
 * Troop training — keeps each enabled building's queue topped up.
 *
 * Barracks and great barracks (and stable / great stable) are separate buildings
 * with separate queues, so both can train the same unit at once. Each is visited
 * in turn, per village.
 *
 * The training page markup varies by server skin, so rows are matched on the
 * troop name the user typed and everything read is exposed through
 * `inspectTrainingBuilding` for when a server does not match.
 */

const log = require('./logger');
const { loadConfig } = require('./auth');
const { randomDelay, pause, dismissBlockingDialogs, ensureGameShell } = require('./utils');
const { trainingSettings, unitsToQueue } = require('./troopsConfig');
const { villagesForCycle } = require('./villageSelection');
const { switchToVillage, currentVillageDid } = require('./villages');

const TAG = 'training';

const ROW_ATTR = 'data-tbot-troop';
const MS_BETWEEN_BUILDINGS = 1_200;

const TRAIN_BUTTON_SELECTORS = [
  'button.startTraining',
  'button[value="Train"]',
  '.startTraining button',
  'form button.textButtonV2.green',
  'form button.textButtonV1',
  'button[type="submit"]',
  'input[type="submit"]',
];

function serverBase(cfg = loadConfig()) {
  return (cfg.url || '').replace(/\/+$/, '');
}

/** Open a training building by gid (19 barracks, 20 stable, 21 workshop, …). */
async function openTrainingBuilding(page, gid) {
  const base = serverBase();
  if (!base) return { ok: false, message: 'No config.url — cannot open building' };

  if (!(await ensureGameShell(page, { tag: TAG }))) {
    return { ok: false, message: 'Game shell not reachable' };
  }

  const url = `${base}/build.php?gid=${gid}`;
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 25_000 });
    await dismissBlockingDialogs(page, { tag: TAG });
    await pause(400);
  } catch (err) {
    return { ok: false, message: `Could not open gid=${gid}: ${err.message}` };
  }

  // A training building shows unit rows with an amount box. Anything else
  // (not built, wrong gid) has neither.
  const hasForm = await page.evaluate(() => !!document.querySelector(
    'input[name^="t"][type="text"], input[name^="t"][type="number"], .troop input, .trainUnits',
  )).catch(() => false);

  if (!hasForm) {
    return { ok: false, message: `No training form at gid=${gid} — is the building present?` };
  }
  return { ok: true, message: `Opened gid=${gid}` };
}

/**
 * Read every unit row and the current queue from the open training page.
 * @returns {Promise<{buildingName:string|null,troops:Array<object>,queueSeconds:number,queueItems:Array<object>}>}
 */
async function readTrainingPageOnPage(page) {
  return page.evaluate(rowAttr => {
    const norm = s => String(s || '')
      .replace(/[‎‏‪-‮]/g, '')
      .trim()
      .replace(/\s+/g, ' ');

    const toInt = s => {
      const t = norm(s).replace(/[^\d]/g, '');
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };

    /** "0:16:40" or "16:40" -> seconds. */
    const toSeconds = s => {
      const t = norm(s);
      const m = /(\d+):(\d{1,2}):(\d{1,2})/.exec(t) || /(\d{1,2}):(\d{1,2})/.exec(t);
      if (!m) return null;
      return m.length === 4
        ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
        : Number(m[1]) * 60 + Number(m[2]);
    };

    const buildingName = norm(
      document.querySelector('#build h1, .titleInHeader, h1.titleInHeader, #content h1')?.textContent,
    ) || null;

    // --- queue ------------------------------------------------------------
    // Each queued batch carries a countdown; the last one is when the queue
    // empties, which is the depth we care about.
    const timerSeconds = Array.from(document.querySelectorAll(
      '.under_progress .timer, .buildDuration .timer, table.under_progress .dur span, .troopsInTraining .timer',
    )).map(el => {
      const v = el.getAttribute('value');
      const n = Number(v);
      return Number.isFinite(n) && n > 0 ? n : toSeconds(el.textContent);
    }).filter(n => Number.isFinite(n) && n > 0);

    const queueItems = Array.from(document.querySelectorAll('.under_progress tr, .troopsInTraining tr'))
      .map(tr => norm(tr.textContent))
      .filter(t => t && t.length > 2)
      .slice(0, 20);

    const queueSeconds = timerSeconds.length ? Math.max(...timerSeconds) : 0;

    // --- unit rows --------------------------------------------------------
    const troops = [];
    const inputs = Array.from(document.querySelectorAll('input[name^="t"]'))
      .filter(el => /^t\d+$/i.test(el.getAttribute('name') || ''));

    inputs.forEach((input, index) => {
      const row = input.closest('.troop, .action, tr, li, div[class*="troop" i]') || input.parentElement;
      if (!row) return;

      const nameEl = row.querySelector('.tit a, .tit, a.details, .details a, .unitName, strong');
      let name = norm(nameEl?.textContent);
      if (!name) {
        // Fall back to the unit icon's alt/title.
        const img = row.querySelector('img[alt], [title]');
        name = norm(img?.getAttribute('alt') || img?.getAttribute('title'));
      }

      // "(max 120)" style link, or any number sitting beside the box.
      let max = null;
      for (const el of Array.from(row.querySelectorAll('a, .maxUnits, .cta a'))) {
        const t = norm(el.textContent);
        if (/\d/.test(t) && /max|\(\s*\d/i.test(t)) {
          max = toInt(t);
          if (max != null) break;
        }
      }
      if (max == null) {
        const m = /max[^0-9]{0,10}(\d[\d.,\s]*)/i.exec(norm(row.textContent));
        if (m) max = toInt(m[1]);
      }

      const durEl = row.querySelector('.duration, .dur, [class*="duration" i]');
      const secondsPerUnit = toSeconds(durEl?.textContent)
        ?? toSeconds(norm(row.textContent).match(/\d+:\d{2}:\d{2}/)?.[0]);

      row.setAttribute(rowAttr, String(index));
      troops.push({
        index,
        name: name || null,
        inputName: input.getAttribute('name'),
        max,
        secondsPerUnit: secondsPerUnit ?? null,
        disabled: !!input.disabled,
        rowText: norm(row.textContent).slice(0, 200),
      });
    });

    return { buildingName, troops, queueSeconds, queueItems };
  }, ROW_ATTR);
}

/** Loose match so "khopesh" finds "Khopesh warrior". */
function findTroopRow(troops, wanted) {
  const want = String(wanted || '').trim().toLowerCase();
  if (!want) return null;
  const rows = (troops || []).filter(t => t.name);
  return rows.find(t => t.name.toLowerCase() === want)
    || rows.find(t => t.name.toLowerCase().includes(want))
    || rows.find(t => want.includes(t.name.toLowerCase()))
    || null;
}

/** Type the amount into the unit's box and submit the form. */
async function submitTraining(page, troop, amount) {
  const box = page.locator(`[${ROW_ATTR}="${troop.index}"] input[name="${troop.inputName}"]`).first();
  if (!(await box.count().catch(() => 0))) {
    return { ok: false, message: 'Amount box not found for that unit' };
  }

  try {
    await box.fill(String(amount), { timeout: 8_000 });
  } catch (err) {
    return { ok: false, message: `Could not fill amount: ${err.message}` };
  }
  await randomDelay();

  for (const sel of TRAIN_BUTTON_SELECTORS) {
    const btn = page.locator(sel).first();
    if (!(await btn.count().catch(() => 0))) continue;
    if (!(await btn.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    if (await btn.isDisabled().catch(() => false)) continue;
    try {
      await btn.click({ timeout: 8_000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await randomDelay();
      return { ok: true, message: `Queued ${amount} via ${sel}` };
    } catch (err) {
      log.warn(TAG, `Train click failed via ${sel}: ${err.message}`);
    }
  }
  return { ok: false, message: 'No usable Train button on the page' };
}

/**
 * Read-only: what the bot sees in one building. Used by the GUI's Inspect so a
 * server whose markup differs can be reported without guesswork.
 */
async function inspectTrainingBuilding(page, gid) {
  const opened = await openTrainingBuilding(page, gid);
  if (!opened.ok) return { ok: false, message: opened.message, troops: [], queueSeconds: 0 };
  const read = await readTrainingPageOnPage(page);
  return { ok: true, message: `Read ${read.troops.length} unit row(s)`, ...read };
}

/** One building in the village that is already active. */
async function runTrainingForBuilding(page, building, settings, options = {}) {
  const dryRun = options.dryRun !== undefined ? !!options.dryRun : settings.dryRun;
  const label = `${building.label} (${building.troop})`;

  const opened = await openTrainingBuilding(page, building.gid);
  if (!opened.ok) {
    return { key: building.key, label: building.label, ok: false, skipped: true, message: opened.message, queued: 0 };
  }

  const read = await readTrainingPageOnPage(page);
  const troop = findTroopRow(read.troops, building.troop);
  if (!troop) {
    const names = read.troops.map(t => t.name).filter(Boolean).join(', ') || 'none readable';
    return {
      key: building.key,
      label: building.label,
      ok: false,
      message: `"${building.troop}" not on the page (saw: ${names})`,
      queued: 0,
      queueSeconds: read.queueSeconds,
    };
  }

  const plan = unitsToQueue({
    queueSeconds: read.queueSeconds,
    targetQueueHours: building.targetQueueHours,
    secondsPerUnit: troop.secondsPerUnit,
    maxAffordable: troop.max,
    maxPerBatch: building.maxPerBatch,
  });

  const base = {
    key: building.key,
    label: building.label,
    troop: troop.name,
    queueSeconds: read.queueSeconds,
    maxAffordable: troop.max,
    secondsPerUnit: troop.secondsPerUnit,
  };

  if (plan.amount <= 0) {
    return { ...base, ok: true, queued: 0, message: `${label}: ${plan.reason}` };
  }

  if (dryRun) {
    log.info(TAG, `Dry run — ${label}: would queue ${plan.amount}`);
    return { ...base, ok: true, queued: 0, wouldQueue: plan.amount, message: `${label}: would queue ${plan.amount} (${plan.reason})` };
  }

  const sent = await submitTraining(page, troop, plan.amount);
  if (!sent.ok) {
    return { ...base, ok: false, queued: 0, message: `${label}: ${sent.message}` };
  }
  log.info(TAG, `${label}: queued ${plan.amount}`);
  return { ...base, ok: true, queued: plan.amount, message: `${label}: queued ${plan.amount}` };
}

/** Every enabled building in the village that is already active. */
async function runTrainingHere(page, settings, options = {}) {
  const results = [];
  for (const building of settings.activeBuildings) {
    if (results.length) await pause(MS_BETWEEN_BUILDINGS);
    results.push(await runTrainingForBuilding(page, building, settings, options));
  }
  return results;
}

/**
 * One full cycle: the selected villages (all, or one in round-robin), each
 * visiting every enabled building.
 */
async function runTrainingCycle(page, options = {}) {
  const settings = options.settings || trainingSettings();
  const dryRun = options.dryRun !== undefined ? !!options.dryRun : settings.dryRun;

  if (!settings.activeBuildingCount) {
    return { ok: false, status: 'idle', message: 'No building enabled with a troop name', villages: [], queued: 0 };
  }

  const targets = villagesForCycle(settings.activeVillages, {
    roundRobin: settings.roundRobin,
    lastDid: options.lastVillageDid,
  });

  // No village picked: train wherever the browser already is.
  if (!targets.length) {
    const results = await runTrainingHere(page, settings, { dryRun });
    const queued = results.reduce((n, r) => n + (r.queued || 0), 0);
    return {
      ok: results.some(r => r.ok),
      status: queued ? 'queued' : 'idle',
      dryRun,
      queued,
      villages: [{ did: null, name: 'current village', buildings: results }],
      lastVillageDid: null,
      message: results.map(r => r.message).join(' · ') || 'Nothing to do',
    };
  }

  const startedAt = await currentVillageDid(page).catch(() => null);
  const villages = [];

  for (const village of targets) {
    const name = village.name || `village ${village.did}`;
    const switched = await switchToVillage(page, village.did);
    if (!switched.ok) {
      log.warn(TAG, `${name}: ${switched.message}`);
      villages.push({ did: village.did, name: village.name, ok: false, message: switched.message, buildings: [] });
      continue;
    }
    log.info(TAG, `Training cycle in ${name}`);
    const buildings = await runTrainingHere(page, settings, { dryRun });
    villages.push({ did: village.did, name: village.name, ok: true, buildings });
  }

  if (startedAt && startedAt !== (await currentVillageDid(page).catch(() => null))) {
    await switchToVillage(page, startedAt).catch(() => {});
  }

  const queued = villages.reduce(
    (n, v) => n + v.buildings.reduce((m, b) => m + (b.queued || 0), 0), 0,
  );
  const wouldQueue = villages.reduce(
    (n, v) => n + v.buildings.reduce((m, b) => m + (b.wouldQueue || 0), 0), 0,
  );
  const failed = villages.filter(v => v.ok === false);

  const per = villages.map(v => {
    if (v.ok === false) return `${v.name || v.did}: ${v.message}`;
    const n = v.buildings.reduce((m, b) => m + (b.queued || b.wouldQueue || 0), 0);
    return `${v.name || v.did}: ${n ? `${n} unit(s)` : 'nothing needed'}`;
  }).join(' · ');

  const status = failed.length === villages.length ? 'failed'
    : (dryRun && wouldQueue) ? 'dry-run'
      : queued ? 'queued' : 'idle';

  return {
    ok: failed.length < villages.length,
    status,
    dryRun,
    queued,
    wouldQueue,
    villages,
    lastVillageDid: targets[targets.length - 1]?.did ?? null,
    message: dryRun && wouldQueue
      ? `Dry run — would queue ${wouldQueue} unit(s): ${per}`
      : `${queued} unit(s) queued · ${per}`,
  };
}

module.exports = {
  ...require('./troopsConfig'),
  openTrainingBuilding,
  readTrainingPageOnPage,
  inspectTrainingBuilding,
  findTroopRow,
  runTrainingForBuilding,
  runTrainingCycle,
};
