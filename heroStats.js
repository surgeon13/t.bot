'use strict';

/**
 * Read Travian Legends hero data.
 *
 * The hero attributes page (`/hero/attributes`) is a React SPA: `#heroV2`
 * starts empty and is populated after navigation. We wait for it to fill
 * with content, then parse the rendered text of each `.attributeBox`.
 *
 * The parser is text-driven (label → next non-empty line) because Travian
 * frequently rotates CSS class hashes/markup. As long as the visible labels
 * stay the same the parser keeps working.
 */

const log = require('./logger');
const { loadConfig } = require('./auth');

const TAG = 'hero';

/* Labels rendered on the page → keys returned to the UI. Add new ones here. */
const LABEL_MAP = {
  'Health':            'healthPercent',
  'Experience':        'experience',
  'Speed':             'speed',
  'Fighting strength': 'power',
  'Off bonus':         'offBonus',
  'Def bonus':         'defBonus',
  'Resources':         'resourceBonus',
  'Points available':  'freePoints',
};

function cleanValue(raw) {
  if (raw == null) return null;
  return String(raw)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '') // bidi markers
    .replace(/\s+/g, ' ')
    .trim();
}

function toNumber(text) {
  const cleaned = cleanValue(text);
  if (!cleaned) return null;
  const m = cleaned.match(/-?\d+(?:[.,]\d+)?/);
  if (!m) return null;
  const n = parseFloat(m[0].replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

function parsePercent(text) {
  const cleaned = cleanValue(text);
  if (!cleaned) return null;
  const m = cleaned.match(/(-?\d+(?:[.,]\d+)?)\s*%/);
  if (m) return parseFloat(m[1].replace(',', '.'));
  return toNumber(cleaned);
}

async function readHeroAttributesPage(page) {
  return page.evaluate((LABEL_MAP) => {
    const root = document.querySelector('#heroV2');
    if (!root) return null;

    const text = (root.innerText || '').replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

    const out = {};
    const labels = Object.keys(LABEL_MAP);

    lines.forEach((line, i) => {
      if (labels.includes(line)) {
        const key = LABEL_MAP[line];
        const next = lines[i + 1];
        if (next && !labels.includes(next)) out[key] = next;
      }
    });

    // Hero production: total bonus (crop & resources) — shown in the production box.
    const prodMatches = text.match(/Hero production[\s\S]*?(?=\n[A-Z])/);
    out.heroProductionRaw = prodMatches ? prodMatches[0].trim() : null;

    // Home village from status sentence.
    const villageMatch = text.match(/Hero is currently in village\s+([^\.\n]+)/i);
    out.homeVillage = villageMatch ? villageMatch[1].trim() : null;

    // Top-bar adventure badge (best-effort).
    const adv = document.querySelector('a.layoutButton.adventure .content');
    out.adventureBadge = adv ? (adv.innerText || '').trim() : null;

    // Top-bar hero portrait href / alt — used as a name fallback.
    const portrait = document.querySelector('#heroImageButton img.heroImage');
    out.heroPortraitAlt = portrait ? (portrait.getAttribute('alt') || '') : null;

    return out;
  }, LABEL_MAP);
}

async function readHeroStats(page, options = {}) {
  const deep = options.deep ?? true;
  const result = {
    fetchedAt: new Date().toISOString(),
    quick: null,
    deep: null,
  };

  if (deep) {
    try {
      const cfg = loadConfig();
      const base = cfg.url.replace(/\/+$/, '');
      await page.goto(`${base}/hero/attributes`, { waitUntil: 'domcontentloaded', timeout: 15_000 });
      await page.waitForFunction(() => {
        const root = document.querySelector('#heroV2');
        return !!(root && root.children.length > 0 && (root.innerText || '').length > 50);
      }, { timeout: 15_000 }).catch(() => {});

      const raw = await readHeroAttributesPage(page);
      if (raw) {
        result.deep = {
          name:                     raw.heroPortraitAlt || null,
          healthPercent:            parsePercent(raw.healthPercent),
          experience:               toNumber(raw.experience),
          experienceText:           cleanValue(raw.experience),
          speed:                    toNumber(raw.speed),
          speedText:                cleanValue(raw.speed),
          power:                    toNumber(raw.power),
          offBonusPercent:          parsePercent(raw.offBonus),
          defBonusPercent:          parsePercent(raw.defBonus),
          resourceBonus:            toNumber(raw.resourceBonus),
          resourceBonusText:        cleanValue(raw.resourceBonus),
          freePoints:               toNumber(raw.freePoints),
          heroProductionRaw:        raw.heroProductionRaw,
          homeVillage:              raw.homeVillage,
          adventureBadge:           raw.adventureBadge,
        };
      }
    } catch (err) {
      log.warn(TAG, `Deep stats read failed: ${err.message}`);
    }
  }

  // Quick stats: read what's visible on whatever page we ended up on so the
  // UI gets *something* even when the deep navigation fails.
  result.quick = await page.evaluate(() => {
    const adv = document.querySelector('a.layoutButton.adventure .content');
    return {
      adventureBadge: adv ? (adv.innerText || '').trim() : null,
      url: location.href,
      title: document.title,
    };
  }).catch(() => null);

  return result;
}

module.exports = { readHeroStats, LABEL_MAP };
