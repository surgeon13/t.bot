'use strict';

const fs = require('fs');
const path = require('path');

const log = require('./logger');

const { TOTALS_STATE_FILE: TOTALS_FILE } = require('./paths');

const DEFAULT_TOTALS = {
  heroTimeBonuses: 0,
  heroDangerBonuses: 0,
  woodBonuses: 0,
  clayBonuses: 0,
  ironBonuses: 0,
  cropBonuses: 0,
  farmListSends: 0,
};

let totals = { ...DEFAULT_TOTALS };

function loadTotals() {
  try {
    if (fs.existsSync(TOTALS_FILE)) {
      const parsed = JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8'));
      totals = { ...DEFAULT_TOTALS, ...parsed };
    }
  } catch (err) {
    log.warn('totals', `Failed to load totals: ${err.message}`);
  }
}

function saveTotals() {
  try {
    fs.writeFileSync(TOTALS_FILE, JSON.stringify(totals, null, 2));
  } catch (err) {
    log.warn('totals', `Failed to save totals: ${err.message}`);
  }
}

function incrementHeroTimeBonus() {
  totals.heroTimeBonuses++;
  saveTotals();
  log.info('totals', `Total hero time bonuses: ${totals.heroTimeBonuses}`);
}

function incrementHeroDangerBonus() {
  totals.heroDangerBonuses++;
  saveTotals();
  log.info('totals', `Total hero danger bonuses: ${totals.heroDangerBonuses}`);
}

function incrementResourceBonus(resource) {
  const key = `${resource.toLowerCase()}Bonuses`;
  if (totals[key] !== undefined) {
    totals[key]++;
    saveTotals();
    log.info('totals', `Total ${resource} bonuses: ${totals[key]}`);
  }
}

/** @param {string} [listName] */
function incrementFarmListSend(listName) {
  totals.farmListSends = (Number(totals.farmListSends) || 0) + 1;
  saveTotals();
  const label = listName ? `"${listName}"` : 'farm list';
  log.info('farmList', `Sent ${label} — lifetime sends: ${totals.farmListSends}`);
  log.info('totals', `Total farm list sends: ${totals.farmListSends}`);
}

function getTotals() {
  return { ...totals };
}

function logAllTotals() {
  log.info('totals', `Totals - Hero time: ${totals.heroTimeBonuses}, Hero danger: ${totals.heroDangerBonuses}, Resources: ${totals.resourceBonuses}`);
}

// Load on require
loadTotals();

module.exports = {
  incrementHeroTimeBonus,
  incrementHeroDangerBonus,
  incrementResourceBonus,
  incrementFarmListSend,
  getTotals,
  logAllTotals,
};