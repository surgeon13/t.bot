'use strict';

/**
 * Build a clean deployment zip (no secrets, no local state, no node_modules).
 *
 * Usage: npm run export
 * Output: t.bot-v<version>.zip in the project root
 */

const fs = require('fs');
const path = require('path');
const archiver = require('archiver');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version || '0.0.0';
const OUT_NAME = `t.bot-v${VERSION}.zip`;
const OUT_PATH = path.join(ROOT, OUT_NAME);

/** Path segments (posix) that must never ship */
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  'debug',
  'agent-transcripts',
  '.cursor',
  'scripts', // only export-zip lives here; omit tooling folder from deploy zip
]);

const EXCLUDE_FILES = new Set([
  'config.json',
  'bot.log',
  'schedule-state.json',
  'resource-bonus-state.json',
  'totals-state.json',
  OUT_NAME,
]);

function shouldSkip(relPosix) {
  const parts = relPosix.split('/');
  if (parts.some(p => EXCLUDE_DIRS.has(p))) return true;
  const base = parts[parts.length - 1];
  if (EXCLUDE_FILES.has(base)) return true;
  if (/^t\.bot-v[\d.]+\.zip$/i.test(base)) return true;
  if (base.startsWith('.') && base !== '.gitignore') return true;
  return false;
}

function walk(dir, base = '') {
  const entries = [];
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = base ? `${base}/${ent.name}` : ent.name;
    if (shouldSkip(rel)) continue;
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      entries.push(...walk(abs, rel));
    } else {
      entries.push({ abs, rel: rel.replace(/\\/g, '/') });
    }
  }
  return entries;
}

async function main() {
  if (fs.existsSync(OUT_PATH)) fs.unlinkSync(OUT_PATH);

  const files = walk(ROOT);
  const output = fs.createWriteStream(OUT_PATH);
  const archive = archiver('zip', { zlib: { level: 9 } });

  const done = new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
  });

  archive.pipe(output);
  const folderName = `t.bot-v${VERSION}`;
  for (const { abs, rel } of files) {
    archive.file(abs, { name: `${folderName}/${rel}` });
  }
  await archive.finalize();
  await done;

  const sizeMb = (archive.pointer() / (1024 * 1024)).toFixed(2);
  console.log(`Created ${OUT_NAME} (${sizeMb} MB, ${files.length} files)`);
  console.log('');
  console.log('On the new machine:');
  console.log('  1. Unzip the archive');
  console.log('  2. npm install');
  console.log('  3. Edit config.json (created automatically on first run if missing)');
  console.log('  4. npm run gui   (or npm start / npm run bonuses)');
}

main().catch(err => {
  console.error('Export failed:', err.message);
  process.exit(1);
});
