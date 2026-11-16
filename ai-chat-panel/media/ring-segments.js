// Segmented usage ring: one arc per quota pool, spaced evenly around the circle with a small gap. Pure, shared by the rail and tests.
// Angles are degrees clockwise from twelve o'clock (the ring's SVG is rotated -90deg, so 0 is its 3 o'clock).
(function (root) {
  'use strict';
  const MAX_SEGMENTS = 4;
  const CENTER = 18; // the 36x36 viewBox of the launcher rings
  const RADIUS = 15;
  // Visible space between two arcs is GAP minus the stroke width (3): the round caps use it up. 5.4 leaves a 2.4 gap.
  const GAP = 5.4;

  const point = (radius, degrees) => {
    const rad = degrees * Math.PI / 180;
    return `${(CENTER + radius * Math.cos(rad)).toFixed(3)} ${(CENTER + radius * Math.sin(rad)).toFixed(3)}`;
  };

  // The three rings a pool can draw. A pool with two windows draws the 5h outside and the week inside, thin like the other
  // providers' circles. A pool with one window (Argon has only a week) draws one arc as thick as both together, so its
  // width says "no second window". All three have round caps, which eat `stroke` of the gap, hence `trim`.
  const RINGS = {
    outer: { radius: RADIUS, stroke: 3, trim: 3 },
    inner: { radius: 10, stroke: 3, trim: 3 },
    thick: { radius: 12.5, stroke: 8, trim: 8 },
  };

  // [from, to] of each arc. One arc is the full circle from twelve o'clock like the other rings; two arcs put the first on
  // the left (it reads left to right, the way the numbers under the ring do); three and four start at twelve.
  // `trim` is how much the caps overhang (the stroke width for round caps); the visible gap stays the same on every ring.
  function layout(count, radius = RADIUS, trim = 3) {
    const n = Math.max(1, Math.min(MAX_SEGMENTS, Math.floor(count) || 1));
    const slice = 360 / n;
    const gap = n === 1 ? 0 : ((GAP - 3 + trim) / radius) * (180 / Math.PI);
    const start = n === 2 ? 180 : 0;
    return Array.from({ length: n }, (_, k) => [start + k * slice + gap / 2, start + (k + 1) * slice - gap / 2]);
  }

  // SVG path of one arc, in pieces of at most 180 degrees so the large-arc flag never matters.
  function arcPath(radius, from, to) {
    const pieces = Math.max(1, Math.ceil((to - from) / 180 - 1e-9));
    let d = `M${point(radius, from)}`;
    for (let i = 1; i <= pieces; i++) d += `A${radius} ${radius} 0 0 1 ${point(radius, from + (to - from) * i / pieces)}`;
    return d;
  }

  // The window that limits a pool: the one with the least left. Ties go to the one that resets first.
  function binding(...windows) {
    let best = null;
    for (const win of windows) {
      if (!win || !Number.isFinite(win.remaining)) continue;
      if (!best || win.remaining < best.remaining || (win.remaining === best.remaining && win.resetsAt < best.resetsAt)) best = win;
    }
    return best;
  }

  const api = { MAX_SEGMENTS, RADIUS, RINGS, layout, arcPath, binding };
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ringSegments = api;
})(typeof window === 'object' ? window : globalThis);
