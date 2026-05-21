'use strict';

const { runClaimResourceBonuses } = require('./claimJob');
const { createTerminalControl } = require('./terminalControl');
const { getLastCompletedBonus } = require('./runState');

const control = createTerminalControl({
  tag: 'resources',
  status: () => [
    'STATUS MODE',
    '-------------',
    'Resource bonus run is active.',
    `Last completed bonus: ${getLastCompletedBonus()}`,
    '',
    'Type stop to end after the current browser action.',
  ],
});
const detachControl = control.attachStdin();

runClaimResourceBonuses()
  .then(code => { process.exitCode = code; })
  .catch(e => {
    const log = require('./logger');
    log.error('resources', e.message);
    process.exitCode = 1;
  })
  .finally(detachControl);
