'use strict';

const { spawnSync } = require('child_process');
const path = require('path');

const root = path.join(__dirname, '..');
const isWin = process.platform === 'win32';

const r = isWin
  ? spawnSync(
    'powershell',
    ['-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'install.ps1')],
    { stdio: 'inherit', cwd: root, shell: true },
  )
  : spawnSync('bash', [path.join(__dirname, 'install.sh')], { stdio: 'inherit', cwd: root });

process.exit(r.status ?? 1);
