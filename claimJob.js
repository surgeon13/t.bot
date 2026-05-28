'use strict';

/**
 * Shared one-shot: launch browser, log in, claim video bonuses, close.
 * Returns 0 on success, 1 on login failure or error.
 */

const log = require('./logger');
const { login, hasLoggedInShell } = require('./auth');
const { ensureGameShell } = require('./utils');
const { launchWithPage } = require('./browserLaunch');
const { handleAdventures } = require('./adventures');
const { claimResourceBonuses } = require('./resourceBonuses');
const { isTaskInterrupted, isTaskRestarted } = require('./terminalControl');

async function runClaimAllBonuses() {
  const { browser, context, page } = await launchWithPage();

  try {
    if (!(await login(page))) {
      return 1;
    }
    if (!(await hasLoggedInShell(page)) && !(await ensureGameShell(page, { tag: 'bonuses' }))) {
      log.warn('bonuses', 'Not on game shell after login — skipping run');
      return 1;
    }
    await handleAdventures(page);
    await claimResourceBonuses(page);
    return 0;
  } catch (e) {
    if (isTaskRestarted(e)) {
      log.info('bonuses', 'Run restarting by terminal command');
      throw e;
    }
    if (isTaskInterrupted(e)) {
      log.warn('bonuses', 'Run stopped by terminal command');
      return 0;
    }
    log.error('bonuses', e.message);
    return 1;
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

async function runClaimResourceBonuses() {
  const { browser, context, page } = await launchWithPage();

  try {
    if (!(await login(page))) {
      return 1;
    }
    await claimResourceBonuses(page, { force: true });
    log.info('resources', 'Run finished - browser closing');
    return 0;
  } catch (e) {
    if (isTaskInterrupted(e)) {
      log.warn('resources', 'Run stopped by terminal command');
      return 0;
    }
    log.error('resources', e.message);
    return 1;
  } finally {
    try { await context.close(); } catch {}
    try { await browser.close(); } catch {}
  }
}

module.exports = { runClaimAllBonuses, runClaimResourceBonuses };
