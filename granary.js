'use strict';

/**
 * Granary watch — polls stocks and, when crop is about to overflow, uses the
 * NPC merchant to re-split everything into 1:1:1 with the crop emptied.
 *
 * The NPC costs gold, so acting needs both `dryRun: false` and `npcEnabled`.
 */

const log = require('./logger');
const { loadConfig } = require('./auth');
const { randomDelay, pause, dismissBlockingDialogs, ensureGameShell } = require('./utils');
const { granarySettings, planNpcDistribution, cropPercent } = require('./granaryConfig');
const { villagesForCycle } = require('./villageSelection');
const { switchToVillage, currentVillageDid } = require('./villages');

const TAG = 'granary';

/** The NPC sits on the marketplace's exchange tab. */
const NPC_PATHS = ['build.php?gid=17&t=3', 'build.php?gid=17&t=2', 'build.php?gid=17'];

const NPC_SUBMIT_SELECTORS = [
  'button.npcDistribute',
  'button[name="npc"]',
  '#npc_market_button',
  '.npcTrade button.textButtonV2.green',
  'form[name="npc"] button[type="submit"]',
  'button.textButtonV2.green',
  'button[type="submit"]',
];

function serverBase(cfg = loadConfig()) {
  return (cfg.url || '').replace(/\/+$/, '');
}

/**
 * Current stocks and storage sizes from the resource bar.
 * @returns {Promise<{wood:number|null,clay:number|null,iron:number|null,crop:number|null,warehouseCapacity:number|null,granaryCapacity:number|null}>}
 */
async function readStocksOnPage(page) {
  return page.evaluate(() => {
    const toInt = s => {
      const t = String(s || '')
        .replace(/[‎‏‪-‮]/g, '')
        .replace(/[^\d]/g, '');
      if (!t) return null;
      const n = Number(t);
      return Number.isFinite(n) ? n : null;
    };

    const pick = sels => {
      for (const sel of sels) {
        const el = document.querySelector(sel);
        const n = el ? toInt(el.textContent) : null;
        if (n != null) return n;
      }
      return null;
    };

    return {
      wood: pick(['#l1 .value', '#l1', '.stockBarButton#l1 .value', '[class*="r1"] .value']),
      clay: pick(['#l2 .value', '#l2', '[class*="r2"] .value']),
      iron: pick(['#l3 .value', '#l3', '[class*="r3"] .value']),
      crop: pick(['#l4 .value', '#l4', '[class*="r4"] .value']),
      warehouseCapacity: pick([
        '#stockBar .warehouse .capacity .value',
        '.warehouse .capacity .value',
        '#stockBar .warehouse .value',
      ]),
      granaryCapacity: pick([
        '#stockBar .granary .capacity .value',
        '.granary .capacity .value',
        '#stockBar .granary .value',
      ]),
    };
  });
}

/** Stocks plus the derived crop fill level. */
async function readGranaryStatus(page) {
  if (!(await ensureGameShell(page, { tag: TAG }))) {
    return { ok: false, message: 'Game shell not reachable' };
  }
  const stocks = await readStocksOnPage(page);
  const pct = cropPercent(stocks);
  const readable = stocks.crop != null && stocks.granaryCapacity != null;
  return {
    ok: readable,
    message: readable
      ? `crop ${stocks.crop}/${stocks.granaryCapacity} (${pct.toFixed(1)}%)`
      : 'Could not read the resource bar',
    stocks,
    cropPercent: pct,
  };
}

async function openNpcPage(page) {
  const base = serverBase();
  if (!base) return { ok: false, message: 'No config.url — cannot open the NPC' };

  for (const path of NPC_PATHS) {
    try {
      await page.goto(`${base}/${path}`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await dismissBlockingDialogs(page, { tag: TAG });
      await pause(400);
      const has = await page.evaluate(() => !!document.querySelector(
        'input[name^="m2"], .npcTrade, #npc_market, form[name="npc"]',
      )).catch(() => false);
      if (has) return { ok: true, message: `NPC form at ${path}` };
    } catch (err) {
      log.warn(TAG, `NPC navigation failed (${path}): ${err.message}`);
    }
  }
  return { ok: false, message: 'NPC exchange form not found — is the marketplace built?' };
}

/** Fill the four NPC boxes with the planned split and submit. */
async function applyNpcDistribution(page, target) {
  const order = ['wood', 'clay', 'iron', 'crop'];
  const filled = [];

  for (let i = 0; i < order.length; i++) {
    const value = String(target[order[i]]);
    // Travian names them m2[1]..m2[4] in resource order.
    const box = page.locator(`input[name="m2[${i + 1}]"]`).first();
    if (!(await box.count().catch(() => 0))) {
      return { ok: false, message: `NPC input for ${order[i]} not found` };
    }
    try {
      await box.fill(value, { timeout: 8_000 });
      filled.push(`${order[i]}=${value}`);
    } catch (err) {
      return { ok: false, message: `Could not fill ${order[i]}: ${err.message}` };
    }
  }
  await randomDelay();

  for (const sel of NPC_SUBMIT_SELECTORS) {
    const btn = page.locator(sel).first();
    if (!(await btn.count().catch(() => 0))) continue;
    if (!(await btn.isVisible({ timeout: 1_000 }).catch(() => false))) continue;
    if (await btn.isDisabled().catch(() => false)) continue;
    try {
      await btn.click({ timeout: 8_000 });
      await page.waitForLoadState('domcontentloaded').catch(() => {});
      await randomDelay();
      return { ok: true, message: `Submitted ${filled.join(' ')} via ${sel}` };
    } catch (err) {
      log.warn(TAG, `NPC submit failed via ${sel}: ${err.message}`);
    }
  }
  return { ok: false, message: 'No usable NPC submit button' };
}

/** One village: read stocks, convert when over the threshold. */
async function runGranaryHere(page, settings, options = {}) {
  const dryRun = options.dryRun !== undefined ? !!options.dryRun : settings.dryRun;

  const status = await readGranaryStatus(page);
  if (!status.ok) return { ok: false, message: status.message, converted: false };

  const pct = status.cropPercent;
  const base = {
    stocks: status.stocks,
    cropPercent: pct,
    threshold: settings.cropPercentThreshold,
  };

  if (pct < settings.cropPercentThreshold) {
    return { ...base, ok: true, converted: false, message: `crop ${pct.toFixed(1)}% — under ${settings.cropPercentThreshold}%` };
  }

  const plan = planNpcDistribution(status.stocks, { leaveCrop: settings.leaveCrop });
  const planned = { ...base, plan: plan.target, planMessage: plan.message };

  if (!plan.changed) {
    return { ...planned, ok: true, converted: false, message: `crop ${pct.toFixed(1)}% — already at the target split` };
  }
  if (!settings.npcEnabled) {
    return { ...planned, ok: true, converted: false, message: `crop ${pct.toFixed(1)}% over threshold — NPC is off. Would do ${plan.message}` };
  }
  if (dryRun) {
    log.info(TAG, `Dry run — would NPC: ${plan.message}`);
    return { ...planned, ok: true, converted: false, wouldConvert: true, message: `Dry run — would NPC: ${plan.message}` };
  }
  if (!plan.balanced) {
    return { ...planned, ok: false, converted: false, message: 'Refusing to submit: the split does not add up to the stock total' };
  }

  const opened = await openNpcPage(page);
  if (!opened.ok) return { ...planned, ok: false, converted: false, message: opened.message };

  const applied = await applyNpcDistribution(page, plan.target);
  if (!applied.ok) return { ...planned, ok: false, converted: false, message: applied.message };

  log.info(TAG, `NPC done: ${plan.message}`);
  return { ...planned, ok: true, converted: true, message: `NPC: ${plan.message}` };
}

/** One full cycle over the selected villages (all, or one in round-robin). */
async function runGranaryCycle(page, options = {}) {
  const settings = options.settings || granarySettings();
  const dryRun = options.dryRun !== undefined ? !!options.dryRun : settings.dryRun;

  const targets = villagesForCycle(settings.activeVillages, {
    roundRobin: settings.roundRobin,
    lastDid: options.lastVillageDid,
  });

  if (!targets.length) {
    const one = await runGranaryHere(page, settings, { dryRun });
    return {
      ok: one.ok,
      status: one.converted ? 'converted' : 'checked',
      dryRun,
      converted: one.converted ? 1 : 0,
      villages: [{ did: null, name: 'current village', ...one }],
      lastVillageDid: null,
      message: one.message,
    };
  }

  const startedAt = await currentVillageDid(page).catch(() => null);
  const villages = [];

  for (const village of targets) {
    const name = village.name || `village ${village.did}`;
    const switched = await switchToVillage(page, village.did);
    if (!switched.ok) {
      log.warn(TAG, `${name}: ${switched.message}`);
      villages.push({ did: village.did, name: village.name, ok: false, converted: false, message: switched.message });
      continue;
    }
    const result = await runGranaryHere(page, settings, { dryRun });
    villages.push({ did: village.did, name: village.name, ...result });
  }

  if (startedAt && startedAt !== (await currentVillageDid(page).catch(() => null))) {
    await switchToVillage(page, startedAt).catch(() => {});
  }

  const converted = villages.filter(v => v.converted).length;
  const failed = villages.filter(v => v.ok === false);
  const per = villages.map(v => `${v.name || v.did}: ${v.message}`).join(' · ');

  return {
    ok: failed.length < villages.length,
    status: converted ? 'converted' : (failed.length === villages.length ? 'failed' : 'checked'),
    dryRun,
    converted,
    villages,
    lastVillageDid: targets[targets.length - 1]?.did ?? null,
    message: per || 'Nothing checked',
  };
}

module.exports = {
  ...require('./granaryConfig'),
  readStocksOnPage,
  readGranaryStatus,
  openNpcPage,
  applyNpcDistribution,
  runGranaryHere,
  runGranaryCycle,
};
