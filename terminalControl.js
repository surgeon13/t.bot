'use strict';

const readline = require('readline');
const log = require('./logger');
const fs = require('fs');
const path = require('path');
const { LOG_FILE } = require('./paths');
const { getTotals } = require('./totals');
const { getLastCompletedBonuses } = require('./runState');

let activeControl = null;

function formatStatusScreen(lines) {
  const safeLines = Array.isArray(lines) ? lines : String(lines).split('\n');
  const width = safeLines.reduce((max, line) => Math.max(max, line.length), 0);
  const border = '═'.repeat(width + 4);
  const framed = safeLines.map(line => `║ ${line.padEnd(width, ' ')} ║`).join('\n');
  return `╔${border}╗\n${framed}\n╚${border}╝`;
}

class TaskInterrupted extends Error {
  constructor(command = 'stop') {
    super(`Task interrupted by terminal command: ${command}`);
    this.name = 'TaskInterrupted';
    this.command = command;
  }
}

class TaskRestarted extends Error {
  constructor(command = 'restart') {
    super(`Task interrupted by terminal command: ${command}`);
    this.name = 'TaskRestarted';
    this.command = command;
  }
}

function isTaskInterrupted(err) {
  return err instanceof TaskInterrupted || err?.name === 'TaskInterrupted' || err instanceof TaskRestarted || err?.name === 'TaskRestarted';
}

function isTaskRestarted(err) {
  return err instanceof TaskRestarted || err?.name === 'TaskRestarted';
}

function getActiveControl() {
  return activeControl?.closed ? null : activeControl;
}

class TerminalControl {
  constructor(options = {}) {
    this.tag = options.tag || 'control';
    this.status = options.status || null;
    this.allowRunNow = options.allowRunNow ?? false;
    this.stopRequested = false;
    this.runNowRequested = false;
    this.restartRequested = false;
    this.closed = false;
    this.stopWaiters = new Set();
    this.runNowWaiters = new Set();
    this.restartWaiters = new Set();
    this.readline = null;
    this.ownsReadline = false;
    this.lineHandler = line => this.handleLine(line);
  }

  helpText() {
    const commands = [
      'c/clean = clear all past logs',
      'l/log = show log counters and last 5 bonuses',
      'r/restart = refresh and run again with a new login',
      's/status = show current state',
      'h/help = show commands',
      'q/quit = stop after the current browser action',
    ];
    if (this.allowRunNow) commands.splice(4, 0, 'run/now = start the next scheduled run now');
    return ['Commands while running:', ...commands].join('\n  ');
  }

  printHelp() {
    console.log(`\n[${this.tag}]\n  ${this.helpText()}\n`);
  }

  attachReadline(rl) {
    this.readline = rl;
    this.ownsReadline = false;
    activeControl = this;
    rl.on('line', this.lineHandler);
    this.printHelp();
    return () => this.detach();
  }

  attachStdin() {
    if (!process.stdin.isTTY) return () => {};

    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    this.readline = rl;
    this.ownsReadline = true;
    activeControl = this;
    rl.on('line', this.lineHandler);
    this.printHelp();
    return () => this.detach();
  }

  detach() {
    if (this.closed) return;
    this.closed = true;

    if (this.readline) {
      this.readline.off('line', this.lineHandler);
      if (this.ownsReadline) {
        this.readline.close();
      }
    }

    if (activeControl === this) activeControl = null;
    this.stopWaiters.clear();
    this.runNowWaiters.clear();
  }

  handleLine(raw) {
    const command = raw.trim().toLowerCase();
    if (!command) return;

    if (command === 'clean' || command === 'c') {
      const logFile = LOG_FILE;
      try {
        fs.writeFileSync(logFile, '');
        console.log(`\n[${this.tag}] Log file cleared.\n`);
      } catch (err) {
        console.log(`\n[${this.tag}] Failed to clear log file: ${err.message}\n`);
      }
      return;
    }

    if (command === 'log' || command === 'l') {
      const totals = getTotals();
      const lastBonuses = getLastCompletedBonuses(5);
      const lines = [
        'Log Counters:',
        `  Hero Time Bonuses: ${totals.heroTimeBonuses}`,
        `  Hero Danger Bonuses: ${totals.heroDangerBonuses}`,
        `  Wood Bonuses: ${totals.woodBonuses}`,
        `  Clay Bonuses: ${totals.clayBonuses}`,
        `  Iron Bonuses: ${totals.ironBonuses}`,
        `  Crop Bonuses: ${totals.cropBonuses}`,
        `  Farm list sends: ${totals.farmListSends ?? 0}`,
        '',
        'Last 5 Successful Bonuses:',
        ...lastBonuses.map((bonus, i) => `  ${i + 1}. [${bonus.timestamp}] ${bonus.message}`),
      ];
      console.log(`\n${formatStatusScreen(lines)}\n`);
      return;
    }

    if (command === 'restart' || command === 'r') {
      this.requestRestart();
      return;
    }

    if (command === 'status' || command === 's') {
      const statusResult = this.status ? this.status() : 'Task is running';
      const statusLines = Array.isArray(statusResult)
        ? statusResult
        : String(statusResult).split('\n');
      console.log(`\n${formatStatusScreen(statusLines)}\n`);
      return;
    }

    if (this.allowRunNow && (command === 'run' || command === 'now')) {
      this.requestRunNow();
      return;
    }

    if (command === 'help' || command === 'h') {
      this.printHelp();
      return;
    }

    if (command === 'quit' || command === 'q') {
      this.requestStop(command);
      return;
    }

    console.log(`\n[${this.tag}] Unknown command: ${command}. Type help.\n`);
  }

  requestStop(command = 'stop') {
    if (this.stopRequested) return;
    this.stopRequested = true;
    for (const reject of this.stopWaiters) reject(new TaskInterrupted(command));
    this.stopWaiters.clear();
  }

  requestRunNow() {
    this.runNowRequested = true;
    log.info(this.tag, 'Terminal command requested run now');
    for (const resolve of this.runNowWaiters) resolve('run');
    this.runNowWaiters.clear();
  }

  requestRestart() {
    if (this.restartRequested) return;
    this.restartRequested = true;
    log.info(this.tag, 'Terminal command requested restart');
    for (const resolve of this.restartWaiters) resolve('restart');
    this.restartWaiters.clear();
  }

  throwIfStopped() {
    if (this.stopRequested) throw new TaskInterrupted('stop');
  }

  waitForStop() {
    if (this.stopRequested) return Promise.reject(new TaskInterrupted('stop'));
    if (this.restartRequested) return Promise.reject(new TaskRestarted('restart'));
    return new Promise((_, reject) => this.stopWaiters.add(reject));
  }

  race(promise) {
    if (this.stopRequested) return Promise.reject(new TaskInterrupted('stop'));
    if (this.restartRequested) return Promise.reject(new TaskRestarted('restart'));

    let stopReject;
    let restartReject;
    const stopPromise = new Promise((_, reject) => {
      stopReject = reject;
      this.stopWaiters.add(stopReject);
    });
    const restartPromise = new Promise((_, reject) => {
      restartReject = reject;
      this.restartWaiters.add(restartReject);
    });

    return Promise.race([promise, stopPromise, restartPromise])
      .finally(() => {
        this.stopWaiters.delete(stopReject);
        this.restartWaiters.delete(restartReject);
      });
  }

  async wait(ms) {
    this.throwIfStopped();
    if (this.runNowRequested) {
      this.runNowRequested = false;
      return 'run';
    }
    if (this.restartRequested) {
      this.restartRequested = false;
      return 'restart';
    }

    let stopReject;
    let runResolve;
    let restartResolve;
    const stopPromise = new Promise((_, reject) => {
      stopReject = reject;
      this.stopWaiters.add(stopReject);
    });
    const runPromise = new Promise(resolve => {
      runResolve = resolve;
      this.runNowWaiters.add(runResolve);
    });
    const restartPromise = new Promise(resolve => {
      restartResolve = resolve;
      this.restartWaiters.add(restartResolve);
    });

    return Promise.race([
      new Promise(resolve => setTimeout(() => resolve('timeout'), ms)),
      stopPromise,
      runPromise,
      restartPromise,
    ]).then(result => {
      if (result === 'run') this.runNowRequested = false;
      if (result === 'restart') this.restartRequested = false;
      return result;
    }).finally(() => {
      this.stopWaiters.delete(stopReject);
      this.runNowWaiters.delete(runResolve);
      this.restartWaiters.delete(restartResolve);
    });
  }
}

function createTerminalControl(options) {
  return new TerminalControl(options);
}

module.exports = {
  TaskInterrupted,
  TaskRestarted,
  createTerminalControl,
  getActiveControl,
  isTaskInterrupted,
  isTaskRestarted,
};
