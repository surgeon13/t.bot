'use strict';

const fs = require('fs');
const path = require('path');

const log = require('./logger');

const { TOTALS_STATE_FILE: TOTALS_FILE } = require('./paths');

let totals = {
  heroTimeBonuses: 0,
  heroDangerBonuses: 0,
  woodBonuses: 0,
  clayBonuses: 0,
  ironBonuses: 0,
  cropBonuses: 0,
};

function loadTotals() {
  try {
    if (fs.existsSync(TOTALS_FILE)) {
      totals = JSON.parse(fs.readFileSync(TOTALS_FILE, 'utf8'));
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
  getTotals,
  logAllTotals,
};