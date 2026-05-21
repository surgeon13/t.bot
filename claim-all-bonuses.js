'use strict';

const { runClaimAllBonuses } = require('./claimJob');
const { createTerminalControl } = require('./terminalControl');
const { getLastCompletedBonus } = require('./runState');

const control = createTerminalControl({
  tag: 'bonuses',
  status: () => [
    'STATUS MODE',
    '-------------',
    'Bonus run is active.',
    `Last completed bonus: ${getLastCompletedBonus()}`,
    '',
    'Type stop to end after the current browser action.',
  ],
});
const detachControl = control.attachStdin();

runClaimAllBonuses()
  .then(code => { process.exitCode = code; })
  .catch(e => {
    const log = require('./logger');
    log.error('bonuses', e.message);
    process.exitCode = 1;
  })
  .finally(detachControl);
