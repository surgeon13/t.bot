'use strict';

const fs = require('fs');
const path = require('path');

const { LOG_FILE } = require('./paths');
let lastCompletedBonus = null;

function setLastCompletedBonus(value) {
  lastCompletedBonus = value;
}

function getLastCompletedBonus() {
  if (lastCompletedBonus) return lastCompletedBonus;
  if (!fs.existsSync(LOG_FILE)) return 'None yet';

  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = content.trim().split(/\r?\n/).reverse();
  for (const line of lines) {
    if (!/completed/i.test(line)) continue;
    const match = line.match(/^\[[^\]]+\] \[[^\]]+\] (?:INFO\s+|WARN\s+|ERROR\s+)?(.*)$/);
    if (match) {
      const message = match[1].trim();
      if (message) {
        lastCompletedBonus = message;
        return message;
      }
    }
  }

  return 'None yet';
}

function getLastCompletedBonuses(count = 5) {
  if (!fs.existsSync(LOG_FILE)) return [];

  const content = fs.readFileSync(LOG_FILE, 'utf8');
  const lines = content.trim().split(/\r?\n/).reverse();
  const bonuses = [];
  for (const line of lines) {
    if (!/completed/i.test(line)) continue;
    const match = line.match(/^\[([^\]]+)\] \[[^\]]+\] (?:INFO\s+|WARN\s+|ERROR\s+)?(.*)$/);
    if (match) {
      const timestamp = match[1];
      const message = match[2].trim();
      if (message) {
        bonuses.push({ timestamp, message });
        if (bonuses.length >= count) break;
      }
    }
  }
  return bonuses;
}

function resetLastCompletedBonus() {
  lastCompletedBonus = null;
}

module.exports = {
  setLastCompletedBonus,
  getLastCompletedBonus,
  getLastCompletedBonuses,
  resetLastCompletedBonus,
};
