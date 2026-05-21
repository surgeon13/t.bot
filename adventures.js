'use strict';

const { randomDelay } = require('./utils');
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

async function readBonusBox(page, selector) {
  const box = await page.$(selector);
  if (!box) return { videoReady: false, bonusActive: false };
  const btn = await box.$('button.textButtonV2.purple');
  if (!btn) return { videoReady: false, bonusActive: false };
  const disabled = await btn.getAttribute('disabled').then(v => v !== null).catch(() => false);
  const visible = await btn.isVisible().catch(() => false);
  const videoReady = !disabled && visible;
  const bonusActive = disabled && !!(await box.$('span.bonusReadyText'));
  return { videoReady, bonusActive };
}

async function claimBonusVideo(page, boxSelector) {
  const btnSelector = `${boxSelector} button.textButtonV2.purple`;
  try {
    await page.locator(btnSelector).click({ force: true, timeout: 10_000 });
  } catch (err) {
    log.warn('adventures', `Could not click bonus button: ${err.message}`);
    return false;
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

async function readAdventurePageStatus(page) {
  const time = await readBonusBox(page, BOX_TIME);
  const danger = await readBonusBox(page, BOX_DANGER);
  const noAdv = await page.$('td.noAdventures');
  const rows = await page.$$('table.adventureList tbody tr');
  return {
    timeVideoReady: time.videoReady,
    timeBonusActive: time.bonusActive,
    dangerVideoReady: danger.videoReady,
    dangerBonusActive: danger.bonusActive,
    adventureCount: noAdv ? 0 : rows.length,
  };
}

async function openAdventuresPage(page) {
  try {
    await page.waitForSelector(ADVENTURE_NAV, { timeout: 10_000 });
  } catch {
    log.warn('adventures', 'Adventure nav button not found in DOM');
    return false;
  }

  await page.click(ADVENTURE_NAV);
  try {
    await page.waitForSelector(ADVENTURE_PAGE, { timeout: 30_000 });
  } catch {
    log.warn('adventures', 'Adventure page content did not appear after opening');
  }
  return true;
}

async function getAdventureCount(page) {
  try {
    await page.waitForSelector(ADVENTURE_NAV, { timeout: 10_000 });
  } catch {
    log.warn('adventures', 'Adventure nav button not found in DOM');
    return 0;
  }
  const badge = await page.$(`${ADVENTURE_NAV} .content`);
  if (!badge) return 0;
  const n = parseInt((await badge.innerText()).trim(), 10);
  return isNaN(n) ? 0 : n;
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
  claimHeroBonus,
};
