const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMap, strength } = require('../media/liquid-glass');

const at = (data, w, x, y) => { const i = (y * w + x) * 4; return [data[i], data[i + 1], data[i + 2], data[i + 3]]; };

test('lens strength is full at the rim and gone at the inner edge', () => {
  assert.equal(strength(0), 1);
  assert.equal(strength(1), 0);
  assert.equal(strength(2), 0);
  assert.ok(strength(0.25) > strength(0.5));
});

test('the middle of a surface is not displaced', () => {
  const w = 120, h = 60, data = buildMap(w, h, 20, 14);
  assert.deepEqual(at(data, w, 60, 30), [128, 128, 128, 255]);
});

test('edges push the sample inward and opaque alpha is kept', () => {
  const w = 120, h = 60, data = buildMap(w, h, 20, 14);
  const [lr, lg, , la] = at(data, w, 0, 30); // left edge: sample from the right, no vertical shift
  assert.ok(lr > 200 && Math.abs(lg - 128) <= 1 && la === 255);
  const [rr] = at(data, w, w - 1, 30);
  assert.ok(rr < 60);
  const [, tg] = at(data, w, 60, 0); // top edge: sample from below
  assert.ok(tg > 200);
  const [, bg] = at(data, w, 60, h - 1);
  assert.ok(bg < 60);
});

test('a round corner pushes along the diagonal', () => {
  const w = 40, h = 40, data = buildMap(w, h, 20, 10);
  const [r, g] = at(data, w, 5, 5); // inside the top-left arc, close to the rim
  assert.ok(r > 128 && g > 128 && Math.abs(r - g) <= 2);
});

test('degenerate sizes still produce a valid map', () => {
  assert.equal(buildMap(1, 1, 50, 0).length, 4);
  assert.equal(buildMap(32, 32, 16, 50).length, 32 * 32 * 4);
});

const { buildLens } = require('../media/liquid-glass');

test('the lens profile falls off monotonically from the rim to the flat top', () => {
  let last = strength(0);
  for (let t = 0.02; t <= 1; t += 0.02) { const s = strength(t); assert.ok(s <= last + 1e-9, `strength rises at t=${t}`); last = s; }
  assert.ok(strength(0.1) < 0.6, 'the bend is thin and sharp at the rim, not a wide slope');
});

test('the specular map lights the rim facing the light, echoes the far side, and is empty inside', () => {
  const w = 120, h = 60, { spec } = buildLens(w, h, 30, 20, { spec: 1 });
  const alpha = (x, y) => spec[(y * w + x) * 4 + 3];
  const top = alpha(60, 0), bottom = alpha(60, h - 1), middle = alpha(60, 30);
  assert.ok(top > 120, 'rim facing the light is bright');
  assert.ok(bottom > 0 && bottom < top, 'the opposite rim is a weaker echo');
  assert.equal(middle, 0);
});

test('spec: 0 produces no highlight and the displacement map is unchanged', () => {
  const w = 80, h = 40, off = buildLens(w, h, 20, 14, { spec: 0 });
  assert.ok(off.spec.every((v) => v === 0));
  assert.deepEqual(Array.from(off.map), Array.from(buildMap(w, h, 20, 14)));
});

test('a map built for a 2x screen keeps the hairline the same CSS width', () => {
  const lit = (px) => { const w = 100 * px, h = 60 * px, { spec } = buildLens(w, h, 30 * px, 14 * px, { spec: 1, px }); let n = 0; for (let y = 0; y < 8 * px; y++) if (spec[(y * w + 50 * px) * 4 + 3] > 40) n++; return n / px; };
  assert.ok(Math.abs(lit(1) - lit(2)) <= 1, `${lit(1)} vs ${lit(2)}`);
});

test('the far side of the slab gets a dark inner shade, the lit side a white bloom', () => {
  const w = 120, h = 120, { spec } = buildLens(w, h, 60, 40, { spec: 1 });
  const px = (x, y) => { const i = (y * w + x) * 4; return { c: spec[i], a: spec[i + 3] }; };
  const lit = px(20, 20), far = px(100, 100); // 10 px inside the rim, towards and away from the top-left light
  assert.ok(lit.a > 20 && lit.c > 200, 'bloom on the lit side is white');
  assert.ok(far.a > 10 && far.c < 80, 'the far side darkens');
  assert.equal(px(60, 60).a, 0, 'the middle stays clear');
});

const { islandMask, islandLight } = require('../media/liquid-glass');
const pill = { x: 40, y: 80, w: 300, h: 52, rx: 26, ry: 26, o: 1 };
const bud = { x: 40, y: 20, w: 300, h: 50, rx: 18, ry: 18, o: 0.5 };

test('the island mask is the goo silhouette: one rect per shape, then blur and the same alpha threshold', () => {
  const svg = islandMask(380, 200, [pill, bud]);
  assert.equal((svg.match(/<rect /g) || []).length, 2);
  assert.match(svg, /stdDeviation="5"/);
  assert.match(svg, /0 0 0 18 -7/);
  assert.match(svg, /fill-opacity="0.5"/); // a bud still fading in contributes less
  assert.equal(islandMask(380, 200, []), '');
});

test('the island lighting draws shadow, shade, bloom, echo and rim, and a flat-footed shape becomes a path', () => {
  const svg = islandLight(380, 200, [pill, { x: 40, y: 0, w: 200, h: 90, rx: 20, ry: 20, o: 1, flat: true }]);
  for (const id of ['shadow', 'shade', 'bloom', 'echo', 'rim']) assert.ok(svg.includes(`<feMergeNode in="${id}"/>`), id);
  assert.match(svg, /<path d="M40 90V20A20 20 0 0 1 60 0H220A20 20 0 0 1 240 20V90Z"/);
  assert.ok(islandLight(380, 200, [pill], { rim: 0.1 }).includes('0 0 0 0.1 0'));
});

/* The dock's rim refraction runs in thin boxes along each shape's edge, not over the whole dock. That is what keeps typing
   cheap (a backdrop filter reruns whenever anything inside its box changes), and it is only safe if the boxes still cover
   everything the lens bends and leave the middle of the pill, where the text is, free. */
const { rimBoxes, BEZEL } = require('../media/liquid-glass');
const inside = (boxes, x, y) => boxes.some(([bx, by, bw, bh]) => x >= bx && x < bx + bw && y >= by && y < by + bh);
// The pixels the refraction actually draws: the same footprint the ring mask uses (the lens, minus its faint tail).
const bent = (s) => {
  const { map } = buildLens(s.w, s.h, s.rx, Math.min(BEZEL, Math.min(s.w, s.h) / 2), { spec: 0 });
  const out = [];
  for (let y = 0; y < s.h; y++) for (let x = 0; x < s.w; x++) { const i = (y * s.w + x) * 4; if (Math.hypot(map[i] - 128, map[i + 1] - 128) * 3.2 - 8 > 0) out.push([x, y]); }
  return out;
};

for (const shape of [{ w: 300, h: 52, rx: 26 }, { w: 860, h: 56, rx: 28 }, { w: 44, h: 44, rx: 22 }, { w: 120, h: 64, rx: 12 }]) {
  test(`the rim boxes of a ${shape.w}x${shape.h} shape cover everything the lens bends`, () => {
    const boxes = rimBoxes({ x: 0, y: 0, ...shape });
    const footprint = bent(shape);
    assert.ok(footprint.length > 200, 'the lens footprint is not empty');
    const missed = footprint.filter(([x, y]) => !inside(boxes, x, y));
    assert.deepEqual(missed.slice(0, 5), [], `${missed.length} bent pixels fall outside every box`);
  });
}

test('the rim boxes leave the middle of a wide pill free, so typing in it damages no backdrop filter', () => {
  const pillShape = { x: 0, y: 0, w: 860, h: 56, rx: 28 };
  const boxes = rimBoxes(pillShape);
  assert.ok(boxes.length >= 3, 'a wide pill is split into edge boxes, not filtered whole');
  // The text sits between the caps and between the top and bottom edge strips.
  for (const [x, y] of [[100, 28], [430, 18], [430, 38], [700, 28]]) assert.equal(inside(boxes, x, y), false, `${x},${y} is in the typing area`);
  const covered = boxes.reduce((sum, [, , w, h]) => sum + w * h, 0);
  assert.ok(covered < 0.5 * pillShape.w * pillShape.h, `the boxes cover ${Math.round((100 * covered) / (pillShape.w * pillShape.h))}% of the pill`);
});

test('a flat-footed shape (the model menu) gets no strip along the edge hidden inside the pill, and a tiny one is a single box', () => {
  const menu = rimBoxes({ x: 0, y: 0, w: 220, h: 150, rx: 20, flat: true });
  assert.equal(menu.length, 3);
  assert.equal(inside(menu, 110, 149), false, 'the bottom edge of the menu is the pill\'s business');
  assert.deepEqual(rimBoxes({ x: 5, y: 6, w: 44, h: 44, rx: 22 }), [[5, 6, 44, 44]]);
});

test('copying the identical middle columns of a wide shape gives exactly the bytes of computing every pixel', () => {
  for (const [w, h, r, bezel, spec, px] of [[860, 56, 28, 20, 0, 1], [300, 52, 26, 20, 0.9, 1], [900, 150, 12, 20, 0.7, 2], [600, 80, 40, 14, 0.5, 2], [90, 40, 20, 20, 0.9, 1], [1000, 30, 15, 15, 0, 1]]) {
    const fast = buildLens(w, h, r, bezel, { spec, px }), slow = buildLens(w, h, r, bezel, { spec, px, noReuse: true });
    assert.deepEqual(Buffer.from(fast.map), Buffer.from(slow.map), `map ${w}x${h} r${r}`);
    assert.deepEqual(Buffer.from(fast.spec), Buffer.from(slow.spec), `spec ${w}x${h} r${r}`);
  }
});

/* The rim pieces. The island used to paint every tile onto three dock-sized canvases and crop the boxes out of them; it now cuts
   each box straight from narrow tiles (only the ends of a wide shape and one middle column). The pictures must not change by a
   byte, so this keeps the old way as the reference. */
const { lensTile, composeBox } = require('../media/liquid-glass');
function referencePieces(shapes, dockW, dockH, px, box, spec = {}) {
  const W = Math.round(dockW) * px, H = Math.round(dockH) * px;
  const map = new Uint8ClampedArray(W * H * 4), ring = new Uint8ClampedArray(W * H * 4), solid = new Uint8ClampedArray(W * H * 4);
  for (let i = 0; i < map.length; i += 4) { map[i] = map[i + 1] = map[i + 2] = 128; map[i + 3] = 255; }
  for (const s of shapes) {
    const tw = Math.round(s.w) * px, th = Math.round(s.h) * px;
    const m = buildLens(tw, th, s.rx * px, Math.min(BEZEL, Math.min(s.w, s.h) / 2) * px, { spec: 0 }).map;
    const r = new Uint8ClampedArray(m.length), so = new Uint8ClampedArray(m.length);
    r.fill(255); so.fill(255);
    for (let i = 0; i < m.length; i += 4) {
      const dx = m[i] - 128, dy = m[i + 1] - 128;
      if (dx === 0 && dy === 0) { r[i + 3] = so[i + 3] = 0; continue; }
      r[i + 3] = Math.max(0, Math.min(255, (Math.sqrt(dx * dx + dy * dy) * 3.2 - 8) * 1.032));
      so[i + 3] = r[i + 3] > 0 ? 255 : 0;
    }
    const sx = Math.round(s.x * px), sy = Math.round(s.y * px); // putImageData: the tile replaces what is under it, clipped to the canvas
    for (let y = 0; y < th; y++) for (let x = 0; x < tw; x++) {
      const X = sx + x, Y = sy + y;
      if (X < 0 || Y < 0 || X >= W || Y >= H) continue;
      for (const [dst, src] of [[map, m], [ring, r], [solid, so]]) for (let k = 0; k < 4; k++) dst[(Y * W + X) * 4 + k] = src[(y * tw + x) * 4 + k];
    }
  }
  const [bx, by, bw, bh] = box, out = { map: [], ring: [], solid: [] };
  for (const key of Object.keys(out)) {
    const src = { map, ring, solid }[key], dst = new Uint8ClampedArray(bw * px * bh * px * 4);
    for (let y = 0; y < bh * px; y++) for (let x = 0; x < bw * px; x++) for (let k = 0; k < 4; k++) dst[(y * bw * px + x) * 4 + k] = src[((by * px + y) * W + bx * px + x) * 4 + k];
    out[key] = dst;
  }
  return out;
}

const DOCKS = {
  'a wide pill': { w: 940, h: 130, shapes: [{ x: 40, y: 40, w: 860, h: 56, rx: 28, ry: 28, o: 1 }] },
  'a pill at a half-pixel offset': { w: 700, h: 150, shapes: [{ x: 40.5, y: 40.5, w: 619.5, h: 56.5, rx: 28, ry: 28, o: 1 }] },
  'a tall composer': { w: 700, h: 260, shapes: [{ x: 40, y: 40, w: 620, h: 180, rx: 24, ry: 24, o: 1 }] },
  'a pill with a menu resting on it': { w: 700, h: 330, shapes: [{ x: 60, y: 40, w: 300, h: 156, rx: 20, ry: 20, o: 1, flat: true }, { x: 40, y: 190, w: 620, h: 56, rx: 28, ry: 28, o: 1 }] },
  'a pill and two buds': { w: 900, h: 130, shapes: [{ x: 40, y: 40, w: 56, h: 56, rx: 28, ry: 28, o: 1 }, { x: 110, y: 40, w: 640, h: 56, rx: 28, ry: 28, o: 1 }, { x: 764, y: 40, w: 56, h: 56, rx: 28, ry: 28, o: 1 }] },
  'a narrow pill': { w: 200, h: 130, shapes: [{ x: 40, y: 40, w: 90, h: 56, rx: 28, ry: 28, o: 1 }] },
  'a small radius': { w: 700, h: 130, shapes: [{ x: 40, y: 40, w: 600, h: 56, rx: 6, ry: 6, o: 1 }] },
};
for (const [name, dock] of Object.entries(DOCKS)) {
  for (const px of [1, 2]) {
    test(`rim pieces cut from narrow tiles match the dock-sized canvases byte for byte: ${name}, ${px}x`, () => {
      const cache = new Map();
      const tileOf = (s) => lensTile(Math.round(s.w) * px, Math.round(s.h) * px, s.rx * px, Math.min(BEZEL, Math.min(s.w, s.h) / 2) * px, cache);
      const painted = [...dock.shapes.filter((q) => q.flat), ...dock.shapes.filter((q) => !q.flat)];
      const boxes = painted.flatMap(rimBoxes);
      assert.ok(boxes.length > 0);
      for (const box of boxes) {
        const fast = composeBox(painted, tileOf, px, box), slow = referencePieces(painted, dock.w, dock.h, px, box);
        for (const key of ['map', 'ring', 'solid']) assert.deepEqual(Buffer.from(fast[key]), Buffer.from(slow[key]), `${key} of box ${box}`);
      }
    });
  }
}

test('a wide shape reuses one narrow tile at every width, and the tile does not grow with the width', () => {
  const cache = new Map();
  const sizes = [500, 640, 777, 1000, 1500, 2400].map((w) => lensTile(w * 2, 112, 56, 40, cache));
  assert.equal(cache.size, 1, 'one stored tile serves every width');
  const bytes = sizes[0].body.bytes;
  assert.ok(bytes < 2 * 1024 * 1024, `the stored tile is ${Math.round(bytes / 1024)} KB`);
  assert.ok(sizes.every((t) => t.body === sizes[0].body));
});

test('tiles of different heights, radii or narrow widths are different tiles', () => {
  const cache = new Map();
  lensTile(1600, 112, 56, 40, cache); lensTile(1600, 120, 56, 40, cache); lensTile(1600, 112, 40, 40, cache); lensTile(90, 112, 56, 40, cache); lensTile(91, 112, 56, 40, cache);
  assert.equal(cache.size, 5);
});

test('the tile cache stays bounded', () => {
  const cache = new Map();
  for (let h = 40; h < 140; h++) lensTile(600, h, 20, 20, cache);
  assert.ok(cache.size <= 24);
});

const { disjointBoxes } = require('../media/liquid-glass');
const area = (boxes) => boxes.reduce((sum, [, , w, h]) => sum + w * h, 0);
const cells = (boxes) => { const set = new Set(); for (const [x, y, w, h] of boxes) for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) set.add(`${i},${j}`); return set; };
test('disjoint boxes cover what the boxes cover and never overlap', () => {
  for (const boxes of [
    [[0, 0, 10, 10]], [[0, 0, 10, 10], [20, 20, 5, 5]], [[0, 0, 10, 10], [5, 5, 10, 10]], [[0, 0, 10, 10], [2, 2, 3, 3]], [[2, 2, 3, 3], [0, 0, 10, 10]],
    [[0, 0, 30, 4], [0, 0, 6, 20], [24, 0, 6, 20], [0, 16, 30, 4], [10, 2, 8, 30]],
    ...Object.values(DOCKS).map((dock) => [...dock.shapes.filter((q) => q.flat), ...dock.shapes.filter((q) => !q.flat)].flatMap(rimBoxes)),
  ]) {
    const parts = disjointBoxes(boxes);
    assert.equal(area(parts), cells(boxes).size, 'no pixel counted twice, none lost');
    assert.deepEqual([...cells(parts)].sort(), [...cells(boxes)].sort());
    assert.ok(parts.every(([, , w, h]) => w > 0 && h > 0));
  }
});

test('with no overlap the ring pieces are the boxes themselves', () => {
  const boxes = rimBoxes({ x: 0, y: 0, w: 860, h: 56, rx: 28 });
  assert.deepEqual(disjointBoxes(boxes), boxes);
});
