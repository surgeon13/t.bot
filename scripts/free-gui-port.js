'use strict';

/**
 * Free the GUI listen port before npm run gui / gui:dev (avoids EADDRINUSE on Windows).
 * Set PORT=3734 to target another port.
 */

const { execSync } = require('child_process');

const PORT = String(process.env.PORT || 3733).trim();

function freePortWin(port) {
  let out = '';
  try {
    out = execSync(`netstat -ano | findstr :${port}`, { encoding: 'utf8' });
  } catch {
    return;
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    if (!/LISTENING/i.test(line)) continue;
    const m = line.trim().match(/\s(\d+)\s*$/);
    if (m) pids.add(m[1]);
  }
  const self = String(process.pid);
  for (const pid of pids) {
    if (pid === self) continue;
    try {
      execSync(`taskkill /PID ${pid} /F`, { stdio: 'ignore' });
      console.log(`[free-gui-port] Stopped PID ${pid} on port ${port}`);
    } catch {
      /* already gone */
    }
  }
}

function freePortUnix(port) {
  try {
    execSync(`lsof -ti tcp:${port} | xargs -r kill -9`, { stdio: 'ignore', shell: '/bin/sh' });
  } catch {
    /* none */
  }
}

if (process.platform === 'win32') freePortWin(PORT);
else freePortUnix(PORT);
