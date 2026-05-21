'use strict';

const log = require('./logger');
const { getActiveControl } = require('./terminalControl');

function randomDelay() {
  const { loadConfig } = require('./auth');
  const cfg = loadConfig();
  const min = cfg.delay?.min ?? 500;
  const max = cfg.delay?.max ?? 1500;
  const ms  = Math.floor(Math.random() * (max - min + 1)) + min;
  const delay = new Promise(resolve => setTimeout(resolve, ms));
  const control = getActiveControl();
  return control ? control.race(delay) : delay;
}

module.exports = { randomDelay };
