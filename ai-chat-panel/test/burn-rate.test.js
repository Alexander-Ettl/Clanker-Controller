'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { estimate, describe } = require('../media/burn-rate.js');
const now = Date.UTC(2026, 9, 1, 12);
const window = (remaining, elapsedMinutes = 10) => ({
  remaining, windowMinutes: 300, resetsAt: now / 1000 + (300 - elapsedMinutes) * 60,
});

test('projects exhaustion from ten minutes of consumption', () => {
  const burn = estimate(window(92), now);
  assert.equal(burn.perHour, 48);
  assert.equal(burn.minutesLeft, 115);
  assert.equal(burn.resetsFirst, false);
  assert.equal(describe(window(92), now), '≈ 1h 55m left · 48%/h');
});

test('reports when the allowance lasts until its reset', () => {
  assert.equal(describe(window(99), now), 'Lasts until reset · 6%/h');
  assert.equal(estimate(window(80, 60), now).resetsFirst, true, 'exhaustion exactly at reset');
});

test('waits for measurable consumption and discards expired or assumed windows', () => {
  for (const quota of [null, {}, window(100), window(90, 0), window(90, 0.5),
    window(90, 301), { ...window(90), resetsAt: null },
    { ...window(90), stale: true }, { ...window(90), assumedReset: true }]) {
    assert.equal(estimate(quota, now), null);
    assert.equal(describe(quota, now), 'Measuring burn rate…');
  }
  assert.equal(describe(window(0), now), 'Usage exhausted');
});

test('new reset windows immediately use their own pace', () => {
  assert.equal(estimate(window(50, 120), now).perHour, 25);
  assert.equal(estimate(window(95, 10), now).perHour, 30);
});

test('formats the time left for the rail chip', () => {
  const { duration } = require('../media/burn-rate.js');
  assert.deepEqual([0.2, 40, 95, 120, 3000].map(duration), ['1m', '40m', '1h 35m', '2h', '2d 2h']);
});
