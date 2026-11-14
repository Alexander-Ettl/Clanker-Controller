'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { isLimitNotice } = require('../media/limit-notice');

test('Claude limit notices at the end of long partial replies are recognized', () => {
  for (const period of ['5-hour', '5\u2011hour']) {
    assert.equal(isLimitNotice('Status: work done.\n\nYou\'ve hit your ' + period + ' limit · resets 11:40am (Europe/Berlin)'), true);
  }
  assert.equal(isLimitNotice('You\u2019ve hit your 5-hour limit'), true);
  assert.equal(isLimitNotice('Work completed so far. '.repeat(40) + "\nYou've hit your session limit · resets 2:10pm (Europe/Berlin)"), true);
  assert.equal(isLimitNotice("You've hit your usage limit"), true);
  assert.equal(isLimitNotice('This long explanation discusses the session limit. '.repeat(40)), false);
  assert.equal(isLimitNotice('Work completed so far. '.repeat(40) + '\nExplain what happens when you have hit your session limit.'), false);
  assert.equal(isLimitNotice(''), false);
  assert.equal(isLimitNotice('A rate limit caps the number of requests per minute.'), false);
  assert.equal(isLimitNotice('The session limit controls how much context is available.'), false);
  assert.equal(isLimitNotice('Quota exhausted'), true);
});

test('Codex limit errors appended to a long partial reply are recognized', () => {
  const error = "Codex error: You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/settings/usage to purchase more credits or try again at 8:20 PM.";
  assert.equal(isLimitNotice('The installer has finished building. '.repeat(30) + '\n\n' + error), true);
  assert.equal(isLimitNotice(error), true);
  assert.equal(isLimitNotice('The installer has finished building. '.repeat(30) + '\n\nCodex error: request failed'), false);
});
