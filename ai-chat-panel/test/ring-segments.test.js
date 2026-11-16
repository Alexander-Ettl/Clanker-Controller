'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { layout, arcPath, binding, MAX_SEGMENTS, RINGS } = require('../media/ring-segments.js');

test('one arc is the whole circle from twelve o\'clock', () => {
  assert.deepEqual(layout(1), [[0, 360]]);
  assert.match(arcPath(15, 0, 360), /^M33\.000 18\.000A15 15 0 0 1 3\.000 18\.000A15 15 0 0 1 33\.000 18\.000$/);
});

test('two arcs are halves with equal gaps; the first is on the left', () => {
  const [first, second] = layout(2);
  assert.ok(first[0] > 180 && first[1] < 360, 'the first arc is the left half');
  assert.ok(second[0] > 360 && second[1] < 540, 'the second arc is the right half (angles run on past 360)');
  assert.ok(Math.abs((first[1] - first[0]) - (second[1] - second[0])) < 1e-9);
  const gap = second[0] - first[1];
  assert.ok(gap > 15 && gap < 30 && Math.abs(gap - (first[0] + 360 - second[1])) < 1e-9, `gap ${gap} degrees`);
});

test('three and four arcs are even slices, and the count is capped', () => {
  for (const n of [3, 4]) {
    const arcs = layout(n);
    assert.equal(arcs.length, n);
    const spans = arcs.map(([from, to]) => to - from);
    assert.ok(spans.every((span) => Math.abs(span - spans[0]) < 1e-9));
    assert.ok(arcs.every(([, to], i) => i === n - 1 || arcs[i + 1][0] - to > 15));
  }
  assert.equal(layout(9).length, MAX_SEGMENTS);
  assert.equal(layout(0).length, 1);
});

test('the thick one-window ring leaves the same visible gap as the thin rings', () => {
  const visible = ({ radius, trim }) => {
    const [first, second] = layout(2, radius, trim);
    return (second[0] - first[1]) * Math.PI / 180 * radius - trim; // round caps overhang stroke/2 at each end
  };
  const { outer, inner, thick } = RINGS;
  assert.ok(Math.abs(visible(outer) - visible(inner)) < 1e-9 && Math.abs(visible(outer) - visible(thick)) < 1e-9);
  assert.equal(thick.stroke, (outer.radius + outer.stroke / 2) - (inner.radius - inner.stroke / 2), 'it covers both thin rings and the space between');
  assert.equal(thick.radius, (outer.radius + inner.radius) / 2);
});

test('binding picks the window with the least left, ties to the earlier reset', () => {
  assert.equal(binding({ remaining: 80, resetsAt: 1 }, { remaining: 65, resetsAt: 9 }).remaining, 65);
  assert.equal(binding({ remaining: 50, resetsAt: 9 }, { remaining: 50, resetsAt: 3 }).resetsAt, 3);
  assert.equal(binding(null, { remaining: 0, resetsAt: 1 }).remaining, 0);
  assert.equal(binding(null, undefined, { remaining: 'x' }), null);
});
