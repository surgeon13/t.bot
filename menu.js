'use strict';

const readline = require('readline');

const log = require('./logger');
const { launchWithPage } = require('./browserLaunch');
const { nextRunMenuLine } = require('./scheduleState');
const { loadConfig, saveConfig, login } = require('./auth');
const { handleAdventures, openAdventuresPage, readAdventurePageStatus } = require('./adventures');
const { claimResourceBonuses, nextResourceBonusRunLine } = require('./resourceBonuses');
const { createTerminalControl, isTaskInterrupted } = require('./terminalControl');

function ask(rl, q) {
  return new Promise(resolve => rl.question(q, resolve));
}

function clearScreen() {
  process.stdout.write('\x1Bc');
}

async function runWithTerminalCommands(rl, tag, status, task) {
  const control = createTerminalControl({ tag, status });
  const detachControl = control.attachReadline(rl);
  try {
    await task();
  } catch (err) {
    if (!isTaskInterrupted(err)) throw err;
    log.warn(tag, 'Task stopped by terminal command');
  } finally {
    detachControl();
  }
}

function printBanner() {
  console.log('╔══════════════════════════════╗');
  console.log('║    t.bot v0.9.1 – Travian    ║');
  console.log('╚══════════════════════════════╝\n');
}

function printMenu() {
  const cfg     = loadConfig();
  const auto    = (cfg.autoMode ?? false) ? 'ON' : 'OFF';
  const head    = (cfg.headless !== false) ? 'ON (no window)' : 'OFF (visible)';
  const sch     = cfg.schedule || {};
  const schOn   = (sch.enabled ?? false) ? 'ON' : 'OFF';
  const everyH  = sch.intervalHours != null ? sch.intervalHours : 3;
  const res     = cfg.resourceBonuses || {};
  const resOn   = (res.enabled ?? false) ? 'ON' : 'OFF';
  const resH    = res.intervalHours != null ? res.intervalHours : 8;
  console.log(`  Session        : Connected ✓`);
  console.log(`  Auto mode      : ${auto}`);
  console.log(`  Headless       : ${head}`);
  console.log(`  Schedule       : ${schOn}  (every ${everyH}h)`);
  console.log(`  Resources      : ${resOn}  (every ${resH}h)`);
  console.log(nextRunMenuLine());
  console.log(nextResourceBonusRunLine());
  console.log('  Scheduler      : not auto; start manually in a 2nd terminal:');
  console.log('                   npm run schedule\n');
  console.log('  [S]  Settings');
  console.log('  [0]  Check adventures');
  console.log('  [1]  Claim bonuses  (hero + due resources)');
  console.log('  [2]  Claim resource bonuses');
  console.log('  [Q]  Quit\n');
}

async function showSettings(rl) {
  clearScreen();
  printBanner();
  const cfg = loadConfig();
  console.log('Current settings  (press Enter to keep the current value):\n');

  const url      = await ask(rl, `  Server URL       [${cfg.url}]: `);
  const username = await ask(rl, `  Username         [${cfg.username}]: `);
  const password = await ask(rl, `  Password         [${cfg.password}]: `);
  const dmin     = await ask(rl, `  Delay min (ms)   [${cfg.delay?.min ?? 500}]: `);
  const dmax     = await ask(rl, `  Delay max (ms)   [${cfg.delay?.max ?? 1500}]: `);
  const autoIn   = await ask(rl, `  Auto mode        [${(cfg.autoMode ?? false) ? 'ON' : 'OFF'}] (on/off): `);
  const headIn   = await ask(rl, `  Headless browser [${(cfg.headless !== false) ? 'ON' : 'OFF'}] (on/off): `);
  if (!cfg.schedule) cfg.schedule = { enabled: false, intervalHours: 3 };
  const schE     = await ask(rl, `  Periodic claims  [${cfg.schedule.enabled ? 'ON' : 'OFF'}] (on/off, uses npm run schedule): `);
  const schH     = await ask(rl, `  Every N hours    [${cfg.schedule.intervalHours}]: `);
  if (!cfg.resourceBonuses) cfg.resourceBonuses = { enabled: false, intervalHours: 8 };
  const resE     = await ask(rl, `  Resource videos  [${cfg.resourceBonuses.enabled ? 'ON' : 'OFF'}] (on/off): `);
  const resH     = await ask(rl, `  Resource every N hours [${cfg.resourceBonuses.intervalHours}]: `);

  if (url.trim())      cfg.url = url.trim();
  if (username.trim()) cfg.username = username.trim();
  if (password.trim()) cfg.password = password.trim();
  if (!cfg.delay) cfg.delay = { min: 500, max: 1500 };
  if (dmin.trim()) cfg.delay.min = parseInt(dmin.trim(), 10);
  if (dmax.trim()) cfg.delay.max = parseInt(dmax.trim(), 10);
  if (autoIn.trim().toLowerCase() === 'on')  cfg.autoMode = true;
  if (autoIn.trim().toLowerCase() === 'off') cfg.autoMode = false;
  if (headIn.trim().toLowerCase() === 'on')  cfg.headless = true;
  if (headIn.trim().toLowerCase() === 'off') cfg.headless = false;
  if (schE.trim().toLowerCase() === 'on')  cfg.schedule.enabled = true;
  if (schE.trim().toLowerCase() === 'off') cfg.schedule.enabled = false;
  if (schH.trim()) {
    const n = parseFloat(schH.trim());
    if (!Number.isNaN(n) && n > 0) cfg.schedule.intervalHours = n;
  }
  if (resE.trim().toLowerCase() === 'on')  cfg.resourceBonuses.enabled = true;
  if (resE.trim().toLowerCase() === 'off') cfg.resourceBonuses.enabled = false;
  if (resH.trim()) {
    const n = parseFloat(resH.trim());
    if (!Number.isNaN(n) && n > 0) cfg.resourceBonuses.intervalHours = n;
  }

  saveConfig(cfg);
  console.log('\n  ✓ Settings saved.\n');
  await ask(rl, '  Press Enter to return to menu...');
}

async function checkAdventures(rl, page) {
  clearScreen();
  printBanner();
  console.log('  [0] Adventures status\n');

  if (!(await openAdventuresPage(page))) {
    await ask(rl, '  Press Enter to return to menu...');
    return;
  }

  const s = await readAdventurePageStatus(page);
  const t = s.timeBonusActive ? 'Yes' : s.timeVideoReady ? 'Not claimed – video ready' : 'No';
  const d = s.dangerBonusActive ? 'Yes' : s.dangerVideoReady ? 'Not claimed – video ready' : 'No';
  console.log(`  Time bonus   : ${t}`);
  console.log(`  Danger bonus : ${d}`);
  console.log(`  Adventures   : ${s.adventureCount}`);
  console.log(nextResourceBonusRunLine() + '\n');

  if (s.adventureCount === 0) {
    console.log('  No adventures available right now.\n');
  } else {
    const rows = await page.$$('table.adventureList tbody tr');
    for (let i = 0; i < rows.length; i++) {
      const row    = rows[i];
      const pe     = await row.$('td.place img');
      const place  = pe ? await pe.getAttribute('alt') : '?';
      const de     = await row.$('td.distance');
      const dist   = de ? (await de.innerText()).trim() : '?';
      const duE    = await row.$('td.duration div.duration');
      const dur    = duE ? (await duE.innerText()).trim() : '?';
      const isHard = await row.$('td.difficulty i.difficulty_hard');
      const diff   = isHard ? 'Hard' : 'Normal';
      console.log(`  Adventure ${i + 1}`);
      console.log(`    Place: ${place}  Distance: ${dist}  Duration: ${dur}  ${diff}\n`);
    }
  }
  await ask(rl, '  Press Enter to return to menu...');
}

async function runBonuses(rl, page) {
  clearScreen();
  printBanner();
  console.log('  [1] Claiming bonuses...\n');
  console.log('  Type status or stop and press Enter while this runs.\n');
  log.info('menu', 'Starting bonus routine');
  await runWithTerminalCommands(
    rl,
    'menu',
    () => 'Claiming hero/resource bonuses. Type stop to return to the menu.',
    async () => {
      await handleAdventures(page);
      await claimResourceBonuses(page);
    }
  );
  await ask(rl, '\n  Press Enter to return to menu...');
}

async function runResourceBonuses(rl, page) {
  clearScreen();
  printBanner();
  console.log('  [2] Claiming resource bonuses...\n');
  console.log('  Type status or stop and press Enter while this runs.\n');
  log.info('menu', 'Starting resource bonus routine');
  await runWithTerminalCommands(
    rl,
    'menu',
    () => 'Claiming resource bonuses. Type stop to return to the menu.',
    () => claimResourceBonuses(page, { force: true })
  );
  await ask(rl, '\n  Press Enter to return to menu...');
}

async function main() {
  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const cfg = loadConfig();
  const { browser, context, page } = await launchWithPage();

  clearScreen();
  printBanner();
  console.log('  Logging in...\n');

  if (!(await login(page))) {
    log.warn('menu', 'Login failed – exiting');
    try { await context.close(); } catch {}
    await browser.close();
    rl.close();
    process.exit(1);
  }

  if (cfg.autoMode) {
    log.info('menu', 'Auto mode – claiming bonuses then opening menu');
    console.log('  Auto mode running. Type status or stop and press Enter while this runs.\n');
    await runWithTerminalCommands(
      rl,
      'menu',
      () => 'Auto mode is claiming bonuses. Type stop to return to the menu.',
      async () => {
        await handleAdventures(page);
        await claimResourceBonuses(page);
      }
    );
  }

  for (;;) {
    clearScreen();
    printBanner();
    printMenu();
    const choice = (await ask(rl, '  > ')).trim().toUpperCase();

    if (choice === 'S')      await showSettings(rl);
    else if (choice === '0') await checkAdventures(rl, page);
    else if (choice === '1') await runBonuses(rl, page);
    else if (choice === '2') await runResourceBonuses(rl, page);
    else if (choice === 'Q') {
      console.log('\n  Closing browser and exiting...\n');
      log.info('menu', 'User quit');
      try { await context.close(); } catch {}
      await browser.close();
      rl.close();
      process.exit(0);
    } else {
      console.log('\n  Unknown option.\n');
      await new Promise(r => setTimeout(r, 800));
    }
  }
}

main().catch(err => {
  log.error('menu', err.message);
  process.exit(1);
});
