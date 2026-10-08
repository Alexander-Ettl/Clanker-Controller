'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isLimitNotice } = require('../media/limit-notice');

test('Claude limit notices at the end of long partial replies are recognized', () => {
  assert.equal(isLimitNotice('Work completed so far. '.repeat(40) + "\nYou've hit your session limit · resets 2:10pm (Europe/Berlin)"), true);
  assert.equal(isLimitNotice("You've hit your usage limit"), true);
  assert.equal(isLimitNotice('This long explanation discusses the session limit. '.repeat(40)), false);
  assert.equal(isLimitNotice('Work completed so far. '.repeat(40) + '\nExplain what happens when you have hit your session limit.'), false);
  assert.equal(isLimitNotice(''), false);
});
