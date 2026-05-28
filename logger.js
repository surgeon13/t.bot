'use strict';

const fs   = require('fs');
const path = require('path');

const { LOG_FILE } = require('./paths');

function timestamp() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}

const COLORS = {
  reset: '\x1b[0m',
  yellow: '\x1b[93m',
  mint: '\x1b[96m',
  white: '\x1b[97m',
};

const subscribers = new Set();

function notify(entry) {
  for (const fn of subscribers) {
    try { fn(entry); }
    catch { /* never let a bad subscriber kill the bot */ }
  }
}

function append(level, tag, message) {
  const prefix = level === 'INFO' ? '' : `${level}  `;
  const ts = timestamp();
  const line   = `[${ts}] [${tag}] ${prefix}${message}\n`;
  const colorLine = `${COLORS.yellow}[${ts}]${COLORS.reset} ${COLORS.mint}[${tag}]${COLORS.reset} ${COLORS.white}${prefix}${message}${COLORS.reset}\n`;
  process.stdout.write(colorLine);
  fs.appendFileSync(LOG_FILE, line);
  notify({ ts, level, tag, message, line: line.trimEnd() });
}

/**
 * Subscribe to log lines as they are emitted.
 * Returns an unsubscribe function. Safe to call from gui.js for SSE streaming.
 */
function subscribe(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

const log = {
  info:  (tag, msg) => append('INFO',  tag, msg),
  warn:  (tag, msg) => append('WARN',  tag, msg),
  error: (tag, msg) => append('ERROR', tag, msg),
  subscribe,
};

module.exports = log;
