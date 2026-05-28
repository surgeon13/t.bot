'use strict';

/**
 * Read Travian Legends hero data.
 *
 * The hero attributes page (`/hero/attributes`) is a React SPA: `#heroV2`
 * starts empty and is populated after navigation. We wait for content, then
 * parse `.attributeBox` nodes and fall back to line-based text parsing.
 */

const log = require('./logger');
const { loadConfig } = require('./auth');

const TAG = 'hero';

/** Visible labels on the attributes page → keys returned to the UI. */
const LABEL_MAP = {
  Health: 'healthPercent',
  Experience: 'experience',
  Speed: 'speed',
  'Fighting strength': 'power',
  'Off bonus': 'offBonus',
  'Def bonus': 'defBonus',
  Resources: 'resourceBonus',
  'Points available': 'freePoints',
  // Common translations (best-effort)
  Gesundheit: 'healthPercent',
  Erfahrung: 'experience',
  Geschwindigkeit: 'speed',
  Kampfstärke: 'power',
  Angriff: 'offBonus',
  Verteidigung: 'defBonus',
  Ressourcen: 'resourceBonus',
  'Verfügbare Punkte': 'freePoints',
};

const LABEL_ALIASES = [
  { re: /^health$/i, key: 'healthPercent' },
  { re: /^experience|^xp$/i, key: 'experience' },
  { re: /^speed$/i, key: 'speed' },
  { re: /fighting\s*strength|^strength$|^str$/i, key: 'power' },
  { re: /^off\s*bonus|^offense/i, key: 'offBonus' },
  { re: /^def\s*bonus|^defense/i, key: 'defBonus' },
  { re: /^resources?$/i, key: 'resourceBonus' },
  { re: /points?\s*available|free\s*points?/i, key: 'freePoints' },
];

function cleanValue(raw) {
  if (raw == null) return null;
  return String(raw)
    .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
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
  const n = toNumber(cleaned);
  if (n != null && n <= 100) return n;
  return null;
}

function mapLabelToKey(label) {
  const l = cleanValue(label);
  if (!l) return null;
  if (LABEL_MAP[l]) return LABEL_MAP[l];
  for (const { re, key } of LABEL_ALIASES) {
    if (re.test(l)) return key;
  }
  return null;
}

async function readHeroAttributesPage(page) {
  return page.evaluate(({ LABEL_MAP, LABEL_ALIASES }) => {
    const norm = s => (s || '')
      .replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '')
      .trim();
    const root = document.querySelector('#heroV2');
    if (!root) return null;

    const out = {};
    const labels = Object.keys(LABEL_MAP);

    const setField = (key, value) => {
      if (!key || value == null) return;
      const v = norm(value);
      if (!v) return;
      if (!out[key]) out[key] = v;
    };

    // Strategy 1: attribute boxes (Legends UI)
    const boxes = root.querySelectorAll(
      '.attributeBox, [class*="attributeBox"], [class*="AttributeBox"]',
    );
    boxes.forEach(box => {
      const labelEl = box.querySelector(
        '.attributeLabel, .attributeName, [class*="attributeLabel"], [class*="attributeName"], h3, h4',
      );
      const valueEl = box.querySelector(
        '.attributeValue, .value, [class*="attributeValue"], [class*="points"], [class*="value"]',
      );
      let label = labelEl ? (labelEl.innerText || labelEl.textContent) : '';
      let value = valueEl ? (valueEl.innerText || valueEl.textContent) : '';
      if (!label) {
        const lines = (box.innerText || '').split('\n').map(norm).filter(Boolean);
        if (lines.length >= 2) {
          label = lines[0];
          value = lines[1];
        }
      }
      const key = (() => {
        const exact = LABEL_MAP[norm(label)];
        if (exact) return exact;
        for (const { re, key: k } of LABEL_ALIASES) {
          if (re.test(norm(label))) return k;
        }
        return null;
      })();
      if (key) setField(key, value);
    });

    // Strategy 2: label → next line in full text
    const text = (root.innerText || '').replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    lines.forEach((line, i) => {
      let key = LABEL_MAP[line] || null;
      if (!key) {
        for (const { re, key: k } of LABEL_ALIASES) {
          if (re.test(line)) {
            key = k;
            break;
          }
        }
      }
      if (key) {
        const next = lines[i + 1];
        if (next && !LABEL_MAP[next]) setField(key, next);
      }
    });

    const prodMatches = text.match(/Hero production[\s\S]*?(?=\n[A-ZÄÖÜ])/);
    out.heroProductionRaw = prodMatches ? prodMatches[0].trim() : null;

    const villageMatch = text.match(/Hero is currently in village\s+([^\.\n]+)/i)
      || text.match(/(?:Held|Hero)\s+(?:ist\s+)?(?:derzeit\s+)?(?:in\s+)?(?:Dorf|village)\s+([^\.\n]+)/i);
    out.homeVillage = villageMatch ? villageMatch[1].trim() : null;

    const adv = document.querySelector('a.layoutButton.adventure .content, a.adventureButton .content');
    out.adventureBadge = adv ? norm(adv.innerText || adv.textContent) : null;

    const portrait = document.querySelector('#heroImageButton img.heroImage, img.heroImage, .heroImage img');
    out.heroPortraitAlt = portrait ? (portrait.getAttribute('alt') || norm(portrait.getAttribute('title')) || '') : null;

    return out;
  }, { LABEL_MAP, LABEL_ALIASES });
}

async function readHeroStats(page, options = {}) {
  const deep = options.deep !== false;
  const result = {
    fetchedAt: new Date().toISOString(),
    ok: false,
    quick: null,
    deep: null,
  };

  if (deep) {
    try {
      const cfg = loadConfig();
      const base = cfg.url.replace(/\/+$/, '');
      await page.goto(`${base}/hero/attributes`, { waitUntil: 'domcontentloaded', timeout: 25_000 });
      await page.waitForFunction(() => {
        const root = document.querySelector('#heroV2');
        if (!root) return false;
        const t = (root.innerText || '').trim();
        if (t.length > 80) return true;
        return root.querySelectorAll('.attributeBox, [class*="attributeBox"]').length > 0;
      }, { timeout: 20_000 }).catch(() => {});

      await page.waitForTimeout(500);

      const raw = await readHeroAttributesPage(page);
      if (raw) {
        result.deep = {
          name: raw.heroPortraitAlt || null,
          healthPercent: parsePercent(raw.healthPercent),
          experience: toNumber(raw.experience),
          experienceText: cleanValue(raw.experience),
          speed: toNumber(raw.speed),
          speedText: cleanValue(raw.speed),
          power: toNumber(raw.power),
          offBonusPercent: parsePercent(raw.offBonus),
          defBonusPercent: parsePercent(raw.defBonus),
          resourceBonus: toNumber(raw.resourceBonus),
          resourceBonusText: cleanValue(raw.resourceBonus),
          freePoints: toNumber(raw.freePoints),
          heroProductionRaw: raw.heroProductionRaw,
          homeVillage: raw.homeVillage,
          adventureBadge: raw.adventureBadge,
        };
        result.ok = result.deep.healthPercent != null
          || result.deep.power != null
          || result.deep.experience != null;
      }
      if (!result.ok) {
        log.warn(TAG, 'Hero attributes page loaded but stats could not be parsed');
      }
    } catch (err) {
      log.warn(TAG, `Deep stats read failed: ${err.message}`);
    }
  }

  result.quick = await page.evaluate(() => {
    const adv = document.querySelector('a.layoutButton.adventure .content, a.adventureButton .content');
    const portrait = document.querySelector('#heroImageButton img.heroImage, img.heroImage');
    return {
      adventureBadge: adv ? (adv.innerText || '').trim() : null,
      heroName: portrait ? (portrait.getAttribute('alt') || '').trim() : null,
      url: location.href,
      title: document.title,
    };
  }).catch(() => null);

  if (result.deep?.adventureBadge == null && result.quick?.adventureBadge) {
    result.deep = result.deep || {};
    result.deep.adventureBadge = result.quick.adventureBadge;
  }

  return result;
}

module.exports = { readHeroStats, LABEL_MAP };
