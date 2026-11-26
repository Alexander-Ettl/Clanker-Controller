# Resize performance, 2026-11-25

Reported: with a sidebar chat and a pop-out chat open, dragging the divider between them resizes both smoothly, but letting go freezes the window for about a second.

## What the freeze was

While the width changes, the composer's glass dock follows it as plain frosted glass. About 160 ms after the last change it "refracts" again: it bends the backdrop along the dock's rim (`refract()` in `media/liquid-glass.js`). That is the work that landed on the release, in both windows at once:

- every release is a width never seen before, so the lens tile for the pill was computed again at the full dock width;
- three dock-sized canvases (displacement map, ring, solid) were filled, then each rim box was cropped out with `drawImage` (canvas to canvas, a GPU readback on a real display);
- two dock-sized PNGs plus the crops were encoded and turned into base64 data URLs.

That is about 25 MB of transient allocation and 2.6 million encoded pixels for a 1000 px wide window at 2x, on a machine that, when measured, had 14.8 of 15.4 GB in use and its swap full. Allocation-heavy work stalls hardest in exactly that state.

## What changed

- `lensTile()` computes only the two ends of a wide shape and one middle column (every column between them is identical; `buildLens` already relied on that). The stored tile is a few hundred KB however wide the window is, and a new width finds it in the cache.
- `composeBox()` cuts each rim box's map, ring and solid straight out of the tiles with typed-array copies. No dock-sized canvas, no `drawImage`, no readback. Canvases that remain are small and CPU-backed (`willReadFrequently`).
- The frost's ring is a union of small pieces (`disjointBoxes()` keeps them from overlapping, which would count a soft edge twice) instead of one dock-sized image; each rim strip has its own solid piece.
- `buildLens` no longer allocates a highlight buffer when none is asked for.
- The composer's width-dependent measurements (`syncComposerShape`, `fitComposerBar`) run when the composer's width changes, not on every height change of its growth animation, and no longer twice per resize (window event and observer).
- The liquid-glass surface scan ignores the script's own `<defs>`, which every refraction touched.

Nothing about the lens mathematics or the look changed. `test/liquid-glass.test.js` compares the new pieces with the old dock-sized canvases byte for byte for seven dock layouts at 1x and 2x (wide pill, half-pixel offsets, tall composer, menu resting on the pill, pill with two buds, narrow pill, small radius). `test/dock-visual-parity.mjs` renders the real dock with the previous script and the current one at 36 combinations of width, pixel density, theme and state: 24 are identical pixel for pixel; the 12 with the model menu open differ in about 0.1 % of pixels by at most 3/255 (the compositor's dithering at the seam where the menu rests on the pill).

## Measuring it

`node test/resize-performance.mjs --turns=30 --scale=2 [--pair] [--sidebar]` resizes a loaded chat as a jump (the release) and as a 30-step drag, to widths never seen before, and reports main-thread CPU time (`ThreadTime`, not wall time), long tasks, and work counters that do not depend on how loaded the machine is.

Per release, 30-turn chat, 2x, 700↔1000 px, headless Chromium, same machine:

| | encoded images | pixels encoded | pixels into ImageData | canvases |
|---|---:|---:|---:|---:|
| before | 12 | 2,615 k | 1,736 k | 14 |
| after | 24 | 572 k | 572 k | 24 |

(After: more but much smaller images, two per box instead of crops of one big canvas.) Main-thread CPU for the same release moved from a median of 112 ms to 65 ms, but timings on this machine swing by several times between runs, so the work counters are the figures to trust.

Limits: headless Chromium rasterises in software, so this shows CPU and allocation cost, not GPU cost. The reporter's machine was not available, so the original second-long freeze was not reproduced as such; the 1.8 s long tasks seen in one early run were under a fake clock and load, and are not claimed.

## Regression tests

`node test/resize-settle.mjs`: releasing after a drag (nothing is encoded while the width still changes; one refraction after; an encode budget), a new width, 90 resizes in a second, the same width twice, 120 px to 3600 px, hidden while resized, pixel density changes, a theme switch mid-drag, the model menu open across a resize, a reply streaming while dragging (the end stays in view), reading position in a scrolled chat, the sidebar layout, an empty and a 150-turn chat, two windows resized together. Every one ends with the dock refracted again, every rim strip pointing at an existing filter, no filter graphs left over, and no page error.
