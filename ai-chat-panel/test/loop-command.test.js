'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseInterval, parseLoopCommand } = require('../lib/loop-command.js');

test('intervals: seconds, minutes, hours and combinations', () => {
  assert.equal(parseInterval('5m'), 5);
  assert.equal(parseInterval('90s'), 1.5);
  assert.equal(parseInterval('2h'), 120);
  assert.equal(parseInterval('1h30m'), 90);
  assert.equal(parseInterval('5'), null);
  assert.equal(parseInterval('soon'), null);
  assert.equal(parseInterval(''), null);
});

test('/loop with no arguments or "help" explains itself; stop stops', () => {
  assert.deepEqual(parseLoopCommand(''), { action: 'help' });
  assert.deepEqual(parseLoopCommand('help'), { action: 'help' });
  assert.deepEqual(parseLoopCommand(' STOP '), { action: 'stop' });
});

test('/loop <interval> <prompt> with optional limits', () => {
  assert.deepEqual(parseLoopCommand('5m check the build'), { action: 'start', everyMinutes: 5, prompt: 'check the build' });
  assert.deepEqual(parseLoopCommand('2h --max 6 --for 8h run the tests\nand report'), { action: 'start', everyMinutes: 120, maxRuns: 6, forMinutes: 480, prompt: 'run the tests\nand report' });
  assert.deepEqual(parseLoopCommand('10m --max=3 hi'), { action: 'start', everyMinutes: 10, maxRuns: 3, prompt: 'hi' });
});

test('bad input gets a message that says what to type', () => {
  assert.match(parseLoopCommand('check the build').error, /not an interval/);
  assert.match(parseLoopCommand('5m').error, /needs a prompt/);
  assert.match(parseLoopCommand('5m --max 0 x').error, /whole number/);
  assert.match(parseLoopCommand('5m --for soon x').error, /duration/);
  assert.match(parseLoopCommand('30s x').error, /between 1 minute and 24 hours/);
  assert.match(parseLoopCommand('48h x').error, /between 1 minute and 24 hours/);
});

test('a prompt that merely starts with a dash is not read as a flag', () => {
  assert.equal(parseLoopCommand('5m --version check please').prompt, '--version check please');
});
