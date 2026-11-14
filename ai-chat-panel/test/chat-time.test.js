'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { chatTime, chatDayGroup } = require('../media/chat-time.js');

const opts = { locale: 'en-US', hourCycle: 'h23' };
const now = new Date(2026, 9, 1, 15, 30).getTime(); // Oct 1 2026, 15:30
const ago = (ms) => now - ms;
const at = (y, mo, d, h, mi) => new Date(y, mo, d, h, mi).getTime();
const MIN = 60000;
const HOUR = 60 * MIN;

test('chatTime: fresh chats read as minutes and hours ago', () => {
  assert.equal(chatTime(ago(10 * 1000), { now, ...opts }), 'Just now');
  assert.equal(chatTime(ago(MIN), { now, ...opts }), '1 minute ago');
  assert.equal(chatTime(ago(10 * MIN), { now, ...opts }), '10 minutes ago');
  assert.equal(chatTime(ago(20 * MIN), { now, ...opts }), '20 minutes ago');
  assert.equal(chatTime(ago(59 * MIN), { now, ...opts }), '59 minutes ago');
  assert.equal(chatTime(ago(HOUR), { now, ...opts }), '1 hour ago');
  assert.equal(chatTime(ago(2 * HOUR + 30 * MIN), { now, ...opts }), '2 hours ago');
});

test('chatTime: the same day shows the clock time, in the chosen hour cycle', () => {
  assert.equal(chatTime(at(2026, 9, 1, 9, 5), { now, ...opts }), '09:05');
  assert.match(chatTime(at(2026, 9, 1, 9, 5), { now, locale: 'en-US', hourCycle: 'h12' }), /^09:05\sAM$/);
});

test('chatTime: relative wins across midnight, then yesterday, then the date', () => {
  const early = at(2026, 9, 1, 0, 20);
  assert.equal(chatTime(at(2026, 8, 30, 23, 50), { now: early, ...opts }), '30 minutes ago');
  assert.equal(chatTime(at(2026, 8, 30, 18, 56), { now, ...opts }), 'Yesterday, 18:56');
  assert.equal(chatTime(at(2026, 8, 29, 18, 56), { now, ...opts }), 'Sep 29, 18:56');
  assert.equal(chatTime(at(2026, 0, 3, 8, 0), { now, ...opts }), 'Jan 3, 08:00');
});

test('chatTime: a year old or more carries the year, and no time', () => {
  assert.equal(chatTime(at(2025, 8, 29, 18, 56), { now, ...opts }), 'Sep 29, 2025');
  assert.equal(chatTime(at(2025, 9, 1, 15, 30), { now, ...opts }), 'Oct 1, 2025');
  assert.equal(chatTime(at(2025, 9, 2, 15, 30), { now, ...opts }), 'Oct 2, 15:30'); // one day short of a year: no year
});

test('chatTime: bad input is an empty label, a clock ahead of ours is "just now"', () => {
  assert.equal(chatTime('not a date', { now, ...opts }), '');
  assert.equal(chatTime(now + 5 * MIN, { now, ...opts }), 'Just now');
});

test('chatTime compact: the short labels of the narrow rail', () => {
  const c = { now, ...opts, compact: true };
  assert.equal(chatTime(ago(10 * 1000), c), 'Just now');
  assert.equal(chatTime(ago(4 * MIN), c), '4 min ago');
  assert.equal(chatTime(ago(2 * HOUR), c), '2 hr ago');
  assert.equal(chatTime(at(2026, 9, 1, 8, 8), c), '08:08');
  assert.equal(chatTime(at(2026, 8, 30, 18, 56), c), 'Yesterday');
  assert.equal(chatTime(at(2026, 8, 28, 18, 56), c), 'Sep 28');
  assert.equal(chatTime(at(2025, 8, 28, 18, 56), c), 'Sep 2025');
});

test('chatDayGroup: the headings the list is divided by', () => {
  const group = (when) => chatDayGroup(when, { now, locale: 'en-US' });
  assert.equal(group(at(2026, 9, 1, 0, 1)), 'Today');
  assert.equal(group(at(2026, 8, 30, 23, 59)), 'Yesterday');
  assert.equal(group(at(2026, 8, 27, 12, 0)), 'Last 7 days');
  assert.equal(group(at(2026, 8, 10, 12, 0)), 'Last 30 days');
  assert.equal(group(at(2026, 7, 5, 12, 0)), 'August');
  assert.equal(group(at(2025, 11, 5, 12, 0)), 'December 2025');
  assert.equal(group('nope'), '');
});

test('messageTime: the clock today, then Yesterday, then the date', () => {
  const { messageTime } = require('../media/chat-time.js');
  assert.equal(messageTime(at(2026, 9, 1, 9, 5), { now, ...opts }), '09:05');
  assert.equal(messageTime(ago(30 * 1000), { now, ...opts }), '15:29');
  assert.equal(messageTime(at(2026, 8, 30, 18, 56), { now, ...opts }), 'Yesterday, 18:56');
  assert.equal(messageTime(at(2026, 8, 29, 18, 56), { now, ...opts }), 'Sep 29, 18:56');
  assert.equal(messageTime(at(2025, 8, 29, 18, 56), { now, ...opts }), 'Sep 29, 2025, 18:56');
  assert.equal(messageTime('nope', { now, ...opts }), '');
});
