'use strict';

const { randomDelay, dismissBlockingDialogs, ensureGameShell } = require('./utils');
const { loadConfig } = require('./auth');
const log = require('./logger');
const { waitForVideoToFinish } = require('./videoAds');
const { setLastCompletedBonus } = require('./runState');
const { incrementHeroTimeBonus, incrementHeroDangerBonus } = require('./totals');

const BOX_TIME = '.videoFeatureBonusBox.adventureDuration';
const BOX_DANGER = '.videoFeatureBonusBox.adventureDifficulty';
const ADVENTURE_NAV = 'a.layoutButton.adventure';
const ADVENTURE_PAGE = 'table.adventureList tbody tr, td.noAdventures, .videoFeatureBonusBox.adventureDuration, .videoFeatureBonusBox.adventureDifficulty';

const HERO_BONUS_KINDS = {
  time:   { box: BOX_TIME,   label: 'Hero time bonus',   tally: 'time' },
  danger: { box: BOX_DANGER, label: 'Hero danger bonus', tally: 'danger' },
};

/** Read hero video bonus state from the adventures page (watchReady / watchVideo UI). */
async function readBonusBox(page, selector) {
  return page.evaluate(sel => {
    const box = document.querySelector(sel);
    if (!box) return { videoReady: false, bonusActive: false, cooldownText: null };

    const isVisible = el => {
      if (!el) return false;
      const s = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
    };

    const isClickable = btn => {
      if (!isVisible(btn)) return false;
      if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
      if (btn.classList.contains('disabled')) return false;
      return true;
    };

    const watchReady =
      box.classList.contains('watchReady')
      || !!box.querySelector('.bonusStatus.watchReady, .watchVideo');

    const findWatchButton = () => {
      const candidates = [
        ...box.querySelectorAll('.watchVideo button'),
        ...box.querySelectorAll('.bonusStatus button'),
        ...box.querySelectorAll('button.purple'),
        ...box.querySelectorAll('button'),
      ];
      for (const btn of candidates) {
        if (!isClickable(btn)) continue;
        const t = (btn.innerText || btn.textContent || '').toLowerCase();
        if (/watch|video|ansehen|regarder|schauen|ver/i.test(t) || btn.querySelector('.videoIcon, i[class*="video"]')) {
          return btn;
        }
      }
      return null;
    };

    const watchBtn = findWatchButton();
    const videoReady = watchReady && !!watchBtn;

    const bonusActive = !videoReady && (
      box.classList.contains('active')
      || !!box.querySelector('.bonusReadyText, .bonusActive, .bonusDuration .timerReact')
      || (!watchReady && !!box.querySelector('.timerReact') && !watchBtn)
    );

    const timerEl = box.querySelector('.timerReact, .bonusDuration .timerReact, .bonusReadyText .timerReact');
    const cooldownText = timerEl ? (timerEl.innerText || timerEl.textContent || '').trim() : null;

    return { videoReady, bonusActive, cooldownText };
  }, selector);
}

async function claimBonusVideo(page, boxSelector) {
  const clicked = await page.evaluate(sel => {
    const box = document.querySelector(sel);
    if (!box) return false;

    const isVisible = el => {
      if (!el) return false;
      const s = getComputedStyle(el);
      const b = el.getBoundingClientRect();
      return s.display !== 'none' && s.visibility !== 'hidden' && b.width > 0 && b.height > 0;
    };

    const candidates = [
      ...box.querySelectorAll('.watchVideo button'),
      ...box.querySelectorAll('.bonusStatus button'),
      ...box.querySelectorAll('button.purple'),
      ...box.querySelectorAll('button'),
    ];
    for (const btn of candidates) {
      if (!isVisible(btn) || btn.disabled) continue;
      const t = (btn.innerText || btn.textContent || '').toLowerCase();
      if (/watch|video|ansehen|regarder|schauen|ver/i.test(t) || btn.querySelector('.videoIcon, i[class*="video"]')) {
        btn.click();
        return true;
      }
    }
    return false;
  }, boxSelector);

  if (!clicked) {
    try {
      await page.locator(`${boxSelector} .watchVideo button, ${boxSelector} button.purple`).first()
        .click({ force: true, timeout: 10_000 });
    } catch (err) {
      log.warn('adventures', `Could not click bonus button: ${err.message}`);
      return false;
    }
  }

  await randomDelay();
  const videoFinished = await waitForVideoToFinish(page);
  if (videoFinished) {
    log.info('adventures', 'Bonus video watched successfully');
  } else {
    log.warn('adventures', 'Bonus video failed or timed out');
  }
  await randomDelay();
  return videoFinished;
}

/** Parse Travian duration text (e.g. "1:23:45", "23:45") to seconds for comparison. */
function parseDurationToSeconds(text) {
  if (!text || text === '?') return null;
  const cleaned = String(text).replace(/\s+/g, '').trim();
  const parts = cleaned.split(':').map(p => parseInt(p, 10));
  if (!parts.length || parts.some(n => Number.isNaN(n))) return null;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 1) return parts[0];
  return null;
}

async function readAdventureList(page) {
  const raw = await page.evaluate(() => {
    const noAdv = document.querySelector('td.noAdventures');
    const bodyText = (document.body && document.body.innerText) || '';
    const heroAway = /hero is (currently )?on an adventure|currently on an adventure|returning from an adventure/i.test(bodyText)
      || !!document.querySelector('.runningAdventure, .adventureRunning, tr.runningAdventure');

    if (noAdv) return { heroAway, adventures: [] };

    const rows = Array.from(document.querySelectorAll('table.adventureList tbody tr'));
    const adventures = rows.map((row, index) => {
      const placeImg = row.querySelector('td.place img');
      const place = placeImg ? (placeImg.getAttribute('alt') || '').trim() : '?';
      const distEl = row.querySelector('td.distance');
      const distance = distEl ? distEl.innerText.trim() : '?';
      const durEl = row.querySelector('td.duration div.duration, td.duration');
      const duration = durEl ? durEl.innerText.trim().replace(/\s+/g, ' ') : '?';
      const hard = !!row.querySelector('td.difficulty i.difficulty_hard, i.difficulty_hard');
      let canSend = false;
      for (const btn of row.querySelectorAll('button')) {
        if (btn.disabled) continue;
        const cls = btn.className || '';
        const t = (btn.innerText || '').toLowerCase();
        if (cls.includes('green') || /start|explore|send|go/.test(t)) {
          canSend = true;
          break;
        }
      }
      if (!canSend) {
        const link = row.querySelector('a.green, td.button a, td.action a');
        canSend = !!(link && !link.classList.contains('disabled'));
      }
      return { index, place, distance, duration, difficulty: hard ? 'Hard' : 'Normal', canSend };
    });

    return { heroAway, adventures };
  });

  const adventures = (raw.adventures || []).map(a => ({
    ...a,
    durationSeconds: parseDurationToSeconds(a.duration),
  }));

  let shortestIndex = null;
  let best = Infinity;
  for (const a of adventures) {
    if (!a.canSend || a.durationSeconds == null) continue;
    if (a.durationSeconds < best) {
      best = a.durationSeconds;
      shortestIndex = a.index;
    }
  }

  return {
    heroAway: !!raw.heroAway,
    adventures,
    shortestIndex,
  };
}

async function readAdventurePageStatus(page) {
  const time = await readBonusBox(page, BOX_TIME);
  const danger = await readBonusBox(page, BOX_DANGER);
  const list = await readAdventureList(page);
  return {
    timeVideoReady: time.videoReady,
    timeBonusActive: time.bonusActive,
    timeCooldownText: time.cooldownText,
    dangerVideoReady: danger.videoReady,
    dangerBonusActive: danger.bonusActive,
    dangerCooldownText: danger.cooldownText,
    adventureCount: list.adventures.length,
    heroAway: list.heroAway,
    adventures: list.adventures,
    shortestIndex: list.shortestIndex,
  };
}

async function clickAdventureStartButton(row) {
  const selectors = [
    'button.textButtonV2.green',
    'button.green',
    'td.button button:not([disabled])',
    'td.action button:not([disabled])',
    'button:not([disabled])',
  ];
  for (const sel of selectors) {
    const btn = await row.$(sel);
    if (!btn) continue;
    const visible = await btn.isVisible().catch(() => false);
    const disabled = await btn.isDisabled().catch(() => true);
    if (!visible || disabled) continue;
    const text = ((await btn.innerText()) || '').toLowerCase();
    if (text.includes('bonus')) continue;
    await btn.click({ force: true, timeout: 10_000 });
    return true;
  }
  const link = await row.$('td.button a, td.action a, a.green');
  if (link && await link.isVisible().catch(() => false)) {
    await link.click({ force: true, timeout: 10_000 });
    return true;
  }
  return false;
}

async function confirmAdventureDialog(page) {
  const confirmSelectors = [
    'button#btn_ok',
    'button.confirm',
    'div.dialog button.textButtonV2.green',
    'div.dialog button.green',
  ];
  for (const sel of confirmSelectors) {
    try {
      const btn = page.locator(sel).first();
      if (await btn.isVisible({ timeout: 1500 })) {
        await btn.click({ force: true, timeout: 5000 });
        return true;
      }
    } catch { /* next */ }
  }
  return false;
}

/**
 * Send the hero to the available adventure with the shortest travel time.
 *
 * @param {import('playwright').Page} page
 * @returns {Promise<{ok: boolean, status?: string, message: string, adventure?: object}>}
 */
async function sendHeroOnShortestAdventure(page) {
  log.info('adventures', 'Send hero to shortest adventure requested');
  if (!(await openAdventuresPage(page))) {
    return { ok: false, status: 'unavailable', message: 'Adventures page not reachable' };
  }
  await randomDelay();

  const list = await readAdventureList(page);
  if (list.heroAway) {
    return { ok: false, status: 'away', message: 'Hero is already on an adventure' };
  }
  if (!list.adventures.length) {
    return { ok: false, status: 'unavailable', message: 'No adventures available' };
  }

  let pick = null;
  if (list.shortestIndex != null) {
    pick = list.adventures.find(a => a.index === list.shortestIndex);
  }
  if (!pick) {
    pick = list.adventures.find(a => a.canSend);
  }
  if (!pick) {
    return { ok: false, status: 'unavailable', message: 'No sendable adventures (hero may be busy)' };
  }

  const rows = await page.$$('table.adventureList tbody tr');
  const row = rows[pick.index];
  if (!row) {
    return { ok: false, status: 'failed', message: 'Adventure row not found in page' };
  }

  log.info('adventures', `Sending hero → ${pick.place} (${pick.duration}, ${pick.difficulty})`);
  const clicked = await clickAdventureStartButton(row);
  if (!clicked) {
    return { ok: false, status: 'failed', message: 'Could not find Start/Send button on adventure row' };
  }

  await randomDelay();
  await confirmAdventureDialog(page);
  await randomDelay();

  const after = await readAdventureList(page);
  const sent = after.heroAway || after.adventures.length < list.adventures.length;
  if (!sent) {
    log.warn('adventures', 'Clicked start but hero still appears available — check in-game');
    return {
      ok: false,
      status: 'failed',
      message: 'Clicked start; confirm in Travian that the hero was sent',
      adventure: pick,
    };
  }

  log.info('adventures', `Hero sent to ${pick.place} (${pick.duration})`);
  return {
    ok: true,
    status: 'sent',
    message: `Hero sent to ${pick.place} (${pick.duration}, ${pick.difficulty})`,
    adventure: pick,
  };
}

async function waitForAdventurePageContent(page, timeout = 30_000) {
  try {
    await page.waitForFunction(() => {
      if (document.querySelector('td.noAdventures')) return true;
      if (document.querySelector('table.adventureList tbody tr')) return true;
      if (document.querySelector('.videoFeatureBonusBox.adventureDuration')) return true;
      if (document.querySelector('.videoFeatureBonusBox.adventureDifficulty')) return true;
      if (document.querySelector('.videoFeatureBonusBox.adventureDuration.watchReady')) return true;
      if (document.querySelector('.videoFeatureBonusBox.adventureDifficulty.watchReady')) return true;
      return false;
    }, { timeout });
    return true;
  } catch {
    log.warn('adventures', 'Adventure page content did not appear');
    return false;
  }
}

async function gotoAdventuresUrl(page) {
  const base = (loadConfig().url || '').replace(/\/+$/, '');
  if (!base) return false;
  await page.goto(`${base}/hero/adventures`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
  await dismissBlockingDialogs(page, { tag: 'adventures' });
  return waitForAdventurePageContent(page);
}

async function openAdventuresPage(page) {
  try {
    if (/\/hero\/adventures/i.test(page.url())) {
      await dismissBlockingDialogs(page, { tag: 'adventures' });
      if (await waitForAdventurePageContent(page, 8000)) return true;
    }

    await dismissBlockingDialogs(page, { tag: 'adventures' });

    if (await gotoAdventuresUrl(page)) return true;

    log.warn('adventures', 'Direct /hero/adventures load failed — resetting to game shell');
    if (!(await ensureGameShell(page, { tag: 'adventures' }))) {
      log.warn('adventures', 'Cannot reach logged-in game shell');
      return false;
    }

    if (await gotoAdventuresUrl(page)) return true;

    await dismissBlockingDialogs(page, { tag: 'adventures' });

    try {
      await page.waitForSelector(ADVENTURE_NAV, { timeout: 8_000 });
    } catch {
      log.warn('adventures', 'Adventure nav button not found after shell reset');
      return false;
    }

    const nav = page.locator(ADVENTURE_NAV);
    try {
      await nav.click({ timeout: 8_000 });
    } catch (err) {
      log.warn('adventures', `Nav click blocked (${err.message}) — forcing click`);
      await dismissBlockingDialogs(page, { tag: 'adventures' });
      try {
        await nav.click({ force: true, timeout: 8_000 });
      } catch (err2) {
        log.warn('adventures', `Adventure nav click failed: ${err2.message}`);
        return false;
      }
    }

    return await waitForAdventurePageContent(page);
  } catch (err) {
    log.warn('adventures', `openAdventuresPage failed: ${err.message}`);
    return false;
  }
}

async function getAdventureCount(page) {
  const badge = await page.$(`${ADVENTURE_NAV} .content`);
  if (badge) {
    const n = parseInt((await badge.innerText()).trim(), 10);
    if (!isNaN(n)) return n;
  }
  if (await openAdventuresPage(page)) {
    const list = await readAdventureList(page);
    return list.adventures.length;
  }
  return 0;
}

async function handleAdventures(page) {
  const count = await getAdventureCount(page);
  log.info('adventures', `Adventure badge count: ${count}`);

  log.info('adventures', 'Opening adventures page');
  if (!(await openAdventuresPage(page))) return;
  await randomDelay();

  const s = await readAdventurePageStatus(page);
  log.info('adventures', `Time bonus   : ${s.timeBonusActive ? 'Yes' : s.timeVideoReady ? 'Not claimed - video ready' : 'No'}`);
  log.info('adventures', `Danger bonus : ${s.dangerBonusActive ? 'Yes' : s.dangerVideoReady ? 'Not claimed - video ready' : 'No'}`);
  log.info('adventures', `Adventures   : ${s.adventureCount}`);

  if (s.timeBonusActive) log.info('adventures', 'Time bonus already active - skipping');
  else if (s.timeVideoReady) {
    log.info('adventures', 'Claiming time bonus - watching video');
    if (await claimBonusVideo(page, BOX_TIME)) {
      setLastCompletedBonus('Hero time bonus completed');
      incrementHeroTimeBonus();
    }
  } else log.info('adventures', 'Time bonus not available');

  if (s.dangerBonusActive) log.info('adventures', 'Danger bonus already active - skipping');
  else if (s.dangerVideoReady) {
    log.info('adventures', 'Claiming danger bonus - watching video');
    if (await claimBonusVideo(page, BOX_DANGER)) {
      setLastCompletedBonus('Hero danger bonus completed');
      incrementHeroDangerBonus();
    }
  } else log.info('adventures', 'Danger bonus not available');

  log.info('adventures', 'Bonus routine complete - hero not sent');
}

/**
 * Claim a single hero bonus (time or danger) on demand (e.g. from the GUI).
 * Opens the adventures page if needed, reads status, and only claims when the
 * video button is currently ready. Never sends the hero on an adventure.
 *
 * @param {import('playwright').Page} page
 * @param {'time'|'danger'} kind
 * @returns {Promise<{ok: boolean, status: 'claimed'|'active'|'unavailable'|'failed', message: string}>}
 */
async function claimHeroBonus(page, kind) {
  const conf = HERO_BONUS_KINDS[kind];
  if (!conf) {
    return { ok: false, status: 'failed', message: `Unknown hero bonus kind: ${kind}` };
  }

  log.info('adventures', `Single-bonus request: ${conf.label}`);
  if (!(await openAdventuresPage(page))) {
    return { ok: false, status: 'unavailable', message: 'Adventures page not reachable' };
  }
  await randomDelay();

  const box = await readBonusBox(page, conf.box);
  if (box.bonusActive) {
    log.info('adventures', `${conf.label} already active - skipping`);
    return { ok: true, status: 'active', message: `${conf.label} already active` };
  }
  if (!box.videoReady) {
    log.info('adventures', `${conf.label} not available right now`);
    return { ok: false, status: 'unavailable', message: `${conf.label} not available` };
  }

  log.info('adventures', `Claiming ${conf.label.toLowerCase()} - watching video`);
  const ok = await claimBonusVideo(page, conf.box);
  if (!ok) {
    return { ok: false, status: 'failed', message: `${conf.label} video failed or timed out` };
  }

  setLastCompletedBonus(`${conf.label} completed`);
  if (conf.tally === 'time')   incrementHeroTimeBonus();
  if (conf.tally === 'danger') incrementHeroDangerBonus();
  return { ok: true, status: 'claimed', message: `${conf.label} claimed` };
}

module.exports = {
  handleAdventures,
  getAdventureCount,
  openAdventuresPage,
  readAdventurePageStatus,
  readAdventureList,
  sendHeroOnShortestAdventure,
  parseDurationToSeconds,
  claimHeroBonus,
};
