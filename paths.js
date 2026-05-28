'use strict';

/**
 * Project paths — all runtime files live under the t.bot project root.
 *
 * Layout:
 *   t.bot/
 *     config.json, config.example.json   (secrets / settings at root)
 *     *.js, public/, docs/, scripts/
 *     data/          bot.log, *-state.json (gitignored)
 *     debug/         login/video snapshots (gitignored)
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname);
const DATA_DIR = path.join(ROOT, 'data');
const DEBUG_DIR = path.join(ROOT, 'debug');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const CONFIG_EXAMPLE_PATH = path.join(ROOT, 'config.example.json');

const LOG_FILE = path.join(DATA_DIR, 'bot.log');
const SCHEDULE_STATE_FILE = path.join(DATA_DIR, 'schedule-state.json');
const RESOURCE_BONUS_STATE_FILE = path.join(DATA_DIR, 'resource-bonus-state.json');
const TOTALS_STATE_FILE = path.join(DATA_DIR, 'totals-state.json');
const PROXY_ROTATION_STATE_FILE = path.join(DATA_DIR, 'proxy-rotation-state.json');

/** Zip / docs folder name (not version-suffixed). */
const PACKAGE_FOLDER_NAME = 't.bot';

const LEGACY_ROOT_FILES = [
  ['bot.log', LOG_FILE],
  ['schedule-state.json', SCHEDULE_STATE_FILE],
  ['resource-bonus-state.json', RESOURCE_BONUS_STATE_FILE],
  ['totals-state.json', TOTALS_STATE_FILE],
  ['proxy-rotation-state.json', PROXY_ROTATION_STATE_FILE],
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function migrateLegacyRootFiles() {
  ensureDir(DATA_DIR);
  for (const [name, dest] of LEGACY_ROOT_FILES) {
    const legacy = path.join(ROOT, name);
    if (!fs.existsSync(legacy) || fs.existsSync(dest)) continue;
    try {
      fs.renameSync(legacy, dest);
    } catch {
      try {
        fs.copyFileSync(legacy, dest);
        fs.unlinkSync(legacy);
      } catch { /* best effort */ }
    }
  }
}

ensureDir(DEBUG_DIR);
migrateLegacyRootFiles();

module.exports = {
  ROOT,
  DATA_DIR,
  DEBUG_DIR,
  CONFIG_PATH,
  CONFIG_EXAMPLE_PATH,
  LOG_FILE,
  SCHEDULE_STATE_FILE,
  RESOURCE_BONUS_STATE_FILE,
  TOTALS_STATE_FILE,
  PROXY_ROTATION_STATE_FILE,
  PACKAGE_FOLDER_NAME,
  migrateLegacyRootFiles,
};
