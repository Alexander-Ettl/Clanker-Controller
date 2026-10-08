/* Empty-state Clanker: the preview's SVG rig; all reactions are silent except launch. */
(function () {
  'use strict';
  let serial = 0;
  let audio = null;
  function fanfare() {
    try {
      if (navigator.userActivation && !navigator.userActivation.isActive) return;
      const Audio = window.AudioContext || window.webkitAudioContext;
      if (!Audio) return;
      audio = audio || new Audio();
      if (audio.state === 'suspended') void audio.resume().catch(() => {});
      [523.25, 659.25, 783.99, 1046.50].forEach((frequency, index) => {
        const oscillator = audio.createOscillator();
        const gain = audio.createGain();
        const start = audio.currentTime + index * 0.065;
        oscillator.type = 'triangle';
        oscillator.frequency.setValueAtTime(frequency, start);
        gain.gain.setValueAtTime(0.0001, start);
        gain.gain.exponentialRampToValueAtTime(0.075, start + 0.012);
        gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.15);
        oscillator.connect(gain).connect(audio.destination);
        oscillator.onended = () => { oscillator.disconnect(); gain.disconnect(); };
        oscillator.start(start);
        oscillator.stop(start + 0.16);
      });
    } catch { /* An unavailable audio device must never prevent sending. */ }
  }

  // Every moving part is one number in a pose. Springs ease the pose toward a goal built from the state's static pose
  // plus its procedural layer, so no state change, loop start or loop end ever snaps.
  // fx/fy face, gx/gy eye gaze, ry right eye drop, bl*/br* brows, l*/r* eye scale, c* body, s*/so scanline, ha/ho clock hands.
  const REST = { fx: 0, fy: 0, gx: 0, gy: 0, ry: 0, bly: 0, blr: 0, bry: 0, brr: 0, lsx: 1, lsy: 1, rsx: 1, rsy: 1, cr: 0, cy: 0, cs: 1, sy: 0, so: 0, ha: 0, ho: 0, fl: 0, shut: 0, wk: 0, bt: 0, bx: 0 };
  const POSE = {
    focus: { fy: 7.5, bly: -3, bry: -5, brr: 4 },
    typing: { fy: 7.5, bly: -1, bry: -5, brr: 7 },
    mention: { fx: -4, fy: 4, bly: 2, blr: -5, bry: -4, brr: 10, lsy: 0.7, rsy: 0.85 },
    action: { fy: -3, bly: -6, bry: -8, brr: 8, lsx: 1.15, lsy: 1.15, rsx: 1.15, rsy: 1.15 },
    image: { bry: -4, brr: 8 },
    thinking: { bly: 2, blr: -3, bry: -5, brr: 8 },
    listening: { fy: -4, bly: -4, bry: -9, brr: 12, cr: 4, cy: -2, lsx: 1.14, lsy: 1.14, rsx: 1.14, rsy: 1.14 },
    decode: { fy: 3, bly: -1, bry: -6, brr: 6 },
    scheduling: { fy: -2, bly: -3, blr: -2, bry: -6, brr: 6, rsx: 1.12, rsy: 1.12 },
  };
  const SOFT = [16, 0.85]; // [stiffness rad/s, damping ratio]
  const SPRING = { gx: [34, 0.8], gy: [34, 0.8], ha: [38, 0.42] }; // quick glances; a clock hand that ticks and settles
  const DIRECT = new Set(['sy', 'so', 'ho', 'fl', 'shut', 'wk', 'bt', 'bx']); // already eased by the layer weight
  const ONE_SHOT = { model: true, image: true };
  const TAU = Math.PI * 2;
  // The right eye as a 10x10 pixel grid (the same stair-stepped octagon as the solid shape): [first column, last column] per row.
  const EYE = { x: 208.41, y: 78.93, w: 5.7, h: 5.677, cy: 107.3, rows: [[3, 6], [2, 7], [1, 8], [0, 9], [0, 9], [0, 9], [0, 9], [1, 8], [2, 7], [3, 6]] };
  const EYE_L = { x: 112.89, y: 96.38, w: 5.46, h: 5.55, rows: [[2, 4], [1, 5], [0, 6], [0, 6], [0, 6], [1, 5], [2, 4]] }; // the left eye, 7x7
  const BLINK = { close: 0.09, hold: 0.05, open: 0.13, steps: 4, gap: 0.6 }; // a blink drops rows outside-in in steps, so it reads as pixels
  const cellsOf = grid => grid.rows.map(([a, b], r) => Array.from({ length: b - a + 1 }, (_, i) => `<rect data-r="${r}" data-c="${a + i}"/>`).join('')).join('');
  const LINE = 3.2; // the closed eye is a thin arc, thinner than a pixel
  const ARC = [6, 5, 5, 4, 4, 4, 4, 5, 5, 6]; // per column, the row that survives: a happy ^ eye
  // Easter egg: while you type, the visor now and then turns into a ticker that scrolls a short message as ASCII bits.
  const BITS = { 0: ['111', '101', '101', '101', '111'], 1: ['010', '110', '010', '010', '111'] };
  const MESSAGES = ['NO U', 'BONK', 'HI MOM', 'SUDO'];
  const BIT = { cell: 4.4, advance: 4.4 * 4.5, byteGap: 4.4 * 1.6, top: 95.5, speed: 190, visor: 300, start: 335 }; // viewBox units, units per second
  const bitStream = text => [...text].map(ch => ch.charCodeAt(0).toString(2).padStart(8, '0'));
  const bitWidth = text => bitStream(text).length * (8 * BIT.advance + BIT.byteGap);
  const bitPath = text => {
    let x = 0, d = '';
    for (const byte of bitStream(text)) {
      for (const digit of byte) {
        BITS[digit].forEach((row, r) => [...row].forEach((on, c) => { if (on === '1') d += `M${(x + c * BIT.cell).toFixed(1)} ${(BIT.top + r * BIT.cell).toFixed(1)}h${BIT.cell}v${BIT.cell}h-${BIT.cell}z`; }));
        x += BIT.advance;
      }
      x += BIT.byteGap;
    }
    return d;
  };
  const GLANCE = [[-6, -1.5], [4, -3], [7, 1], [-2, 2], [-7, 0], [2, -2.5]];
  const ease = x => x * x * (3 - 2 * x);
  const ANIM = {
    thinking(g, t, w) {
      g.fx += w * 9.5 * Math.sin(t * TAU / 2.4);
      g.gx += w * 3 * Math.sin((t + 0.15) * TAU / 2.4); // the eyes lead the head
      const phase = (t / 1.8) % 1;
      g.sy = 45 + 137 * phase;
      g.so = w * 0.95 * Math.min(1, phase / 0.12, (1 - phase) / 0.12);
    },
    listening(g, t, w) {
      const breath = (1 - Math.cos(t * TAU / 2.2)) / 2, pulse = 0.5 + 0.5 * Math.sin(t * TAU / 1.4);
      const [x, y] = GLANCE[Math.floor(t / 1.05) % GLANCE.length];
      g.cr += w * 1.4 * breath; g.cy -= w * 2 * breath; g.cs += w * 0.015 * breath;
      g.lsx += w * 0.08 * pulse; g.lsy += w * 0.08 * pulse; g.rsx += w * 0.08 * pulse; g.rsy += w * 0.08 * pulse;
      g.gx += w * x; g.gy += w * y; g.fx += w * x * 0.35; // looks around the room, head half a beat behind
    },
    scheduling(g, t, w, layer) {
      const steps = Math.floor(t * 2), bump = Math.exp(-((t * 2) % 1) * 7);
      g.steps = layer.base + steps; // the right eye turns into a ticking clock face
      g.gy += w * 1.5 * bump; g.cy -= w * 0.8 * bump;
      g.ho += w;
    },
    decode(g, t, w) {
      g.bt = w;
      g.bx = BIT.start - t * BIT.speed;
    },
    image(g, t) { // looks down at the + button, the shutter clicks with a visor flash, then it beams at the shot
      const look = t < 0.3 ? ease(t / 0.3) : t < 0.9 ? 1 : 1 - ease(Math.min(1, (t - 0.9) / 0.4));
      const click = t < 0.55 ? 0 : t < 0.62 ? (t - 0.55) / 0.07 : t < 0.8 ? 1 - (t - 0.62) / 0.18 : 0;
      const pop = t < 0.75 ? 0 : ease(Math.min(1, (t - 0.75) / 0.2)) * (1 - ease(Math.min(1, Math.max(0, (t - 1.3) / 0.5))));
      g.gx -= 6 * look; g.gy += 3 * look; g.fx -= 2 * look; g.fy += 1.5 * look;
      g.shut = click;
      g.fl = t < 0.6 ? 0 : Math.exp(-(t - 0.6) * 9);
      for (const key of ['lsx', 'lsy', 'rsx', 'rsy']) g[key] += 0.2 * pop;
      g.bly -= 3 * pop; g.bry -= 3 * pop;
    },
    model(g, t, w) { // wink: the right eye squeezes into a happy arc, the cheek lifts, then it opens again
      const c = t < 0.24 ? ease(t / 0.24) : t < 0.7 ? 1 : t < 1.05 ? 1 - ease((t - 0.7) / 0.35) : 0;
      g.wk = c * w;
      g.bry += 4 * c; g.brr -= 3 * c; g.bly -= 2 * c; g.lsx += 0.06 * c; g.lsy += 0.06 * c;
      g.cr -= 2.5 * c; g.cy -= 1.5 * c; g.fx -= 1.5 * c;
    },
  };

  window.createClankerMascot = function ({ root, input, modelPicker, attach, mic, schedule, transcript }) {
    const clipId = `clanker-visor-${++serial}`;
    root.querySelector('.empty-mark').innerHTML = `<svg class="clanker-rig" viewBox="0 0 374.78 296.77" aria-hidden="true" focusable="false">
<defs>
<clipPath id="${clipId}">
<path d="M289.89,178.84c4.41-2.14,8.16-4.6,11.92-7.45,17.27-13.06,27.8-33.76,27.85-55.39l.05-18.27c.04-16.43-4.99-32.63-15.1-45.63-5.96-7.66-13.29-13.79-21.7-18.64-11.41-6.58-24.43-9.75-37.65-9.75l-131.94.04c-11.18-.35-22.27,1.27-32.63,5.43-18.47,7.42-33.75,22.36-40.7,41.11-2.98,8.04-4.94,16.18-4.95,24.82l-.03,20.9c.21,11.28,3.09,22.28,8.34,32.25,12.54,23.81,38.33,38.31,65.17,38.31h137.46c11.74,0,23.34-2.61,33.91-7.74Z"/>
</clipPath>
</defs>
<g class="clanker-body-rig">
<g clip-path="url(#${clipId})">
<rect class="clanker-visor-bg" fill="#141416" x="0" y="0" width="374.78" height="296.77" />
</g>
<g class="clanker-chassis-rig">
<path fill="#ffffff" fill-rule="evenodd" d="M294.4,258.9l-14.83-21.98-11.92-17.18c-3.31-4.77-8.94-8.16-15.05-8.17l-130.21-.08c-6.12.46-11.61,3.01-15.08,8.06l-14.18,20.6-22.55,33.33c-4.46,6.6-13.31,17.34-19.76,21.29-5.85,3.59-14.06,1.67-19.94-1.7-7.03-4.03-13.25-9.34-18.23-15.78C3.66,265.7.41,249.46.05,234.98c-.44-17.56,2.36-38.84,5.42-56.35,2.35-13.4,4.93-26.6,8.16-39.81l8.76-35.87,6.5-23.72,5.65-18.6c2.35-7.73,5.29-15.01,9.1-22.12,4.7-8.78,13.13-16.6,21.55-21.93C79.86,7.3,96.57,1.64,113.86.1c6.63-.59,11.53,1.52,15.29,6.84.25.35.79.65,1.4.65h113.64c.66,0,1.2-.4,1.48-.8,3.27-4.73,8.37-7.18,14.24-6.75,17,1.25,33.49,6.62,48.05,15.47,4.45,2.7,8.43,5.68,12.26,9.15,5.23,4.72,9.27,10.35,12.34,16.68,2.36,4.87,4.48,9.6,6.12,14.75l5.04,15.82,3.22,10.99,10.75,41.3,9.91,44.81c2.82,14.36,4.99,28.62,6.22,43.18l.93,18.76c.06,15.99-2.52,33.05-12.22,46.07-4.86,6.52-11,11.73-17.97,15.85-3.6,2.13-7.42,3.35-11.54,3.8-3.66.4-7.07-.55-10.02-2.68-6.15-4.43-14.5-14.31-18.86-20.73l-9.78-14.37ZM289.89,178.84c4.41-2.14,8.16-4.6,11.92-7.45,17.27-13.06,27.8-33.76,27.85-55.39l.05-18.27c.04-16.43-4.99-32.63-15.1-45.63-5.96-7.66-13.29-13.79-21.7-18.64-11.41-6.58-24.43-9.75-37.65-9.75l-131.94.04c-11.18-.35-22.27,1.27-32.63,5.43-18.47,7.42-33.75,22.36-40.7,41.11-2.98,8.04-4.94,16.18-4.95,24.82l-.03,20.9c.21,11.28,3.09,22.28,8.34,32.25,12.54,23.81,38.33,38.31,65.17,38.31h137.46c11.74,0,23.34-2.61,33.91-7.74Z"/>
</g>
<g clip-path="url(#${clipId})">
<g class="clanker-face-rig">
<g class="clanker-brow-left-rig">
<polygon fill="#ffffff" points="111.71 85.86 98.81 98.59 91.08 91.02 106.88 75.42 152.6 75.43 152.62 85.86 111.71 85.86"/>
</g>
<g class="clanker-brow-right-rig">
<polygon fill="#ffffff" points="272.16 74.13 255.05 57.3 216.17 60.18 215.11 49.48 258.94 46.27 279.64 66.68 272.16 74.13"/>
</g>
<g class="clanker-eye-left-rig">
<polygon class="clanker-eye-solid" fill="#ffffff" points="140.48 135.21 123.78 135.19 123.74 129.86 118.16 129.8 118.09 124.55 112.89 124.49 112.89 107.23 118.15 107.24 118.17 101.79 123.68 101.78 123.72 96.4 140.53 96.38 140.54 101.84 145.8 101.84 145.79 107.23 151.12 107.28 151.12 124.56 145.93 124.58 145.82 129.8 140.49 129.82 140.48 135.21"/>
<g class="clanker-eye-pixels" fill="#ffffff" visibility="hidden">${cellsOf(EYE_L)}</g>
</g>
<g class="clanker-eye-right-rig">
<polygon class="clanker-eye-solid" fill="#ffffff" points="247.93 135.7 225.69 135.73 225.67 129.79 219.72 129.76 219.72 124.52 214.18 124.48 214.15 118.35 208.41 118.3 208.41 96.74 214.06 96.71 214.2 90.39 219.74 90.31 219.83 85.05 225.68 85 225.74 78.95 247.94 78.93 248.02 85 253.78 85.01 253.81 90.22 259.49 90.31 259.6 96.44 265.38 96.51 265.33 118.13 259.57 118.11 259.56 124.17 253.91 124.16 253.83 129.61 247.98 129.62 247.93 135.7"/>
<g class="clanker-eye-pixels" fill="#ffffff" visibility="hidden">${cellsOf(EYE)}</g>
<line class="clanker-hand-hour" x1="236.9" y1="107.3" x2="236.9" y2="97.5" stroke="#141416" stroke-width="5" stroke-linecap="square" opacity="0" />
<line class="clanker-hand-min" x1="236.9" y1="107.3" x2="236.9" y2="90" stroke="#141416" stroke-width="3.5" stroke-linecap="square" opacity="0" />
</g>
<path class="clanker-bits" fill="#30d158" opacity="0" d="" />
</g>
</g>
<g clip-path="url(#${clipId})">
<line class="clanker-scanline" x1="45" y1="0" x2="330" y2="0" stroke="var(--clanker-scanline, #60a5fa)" stroke-width="3.5" opacity="0" />
</g>
</g>
</svg>`;
    const mark = root.querySelector('.empty-mark');
    const part = name => root.querySelector(`.clanker-${name}-rig`);
    const rig = { body: part('body'), face: part('face'), browL: part('brow-left'), browR: part('brow-right'), eyeL: part('eye-left'), eyeR: part('eye-right') };
    const scan = root.querySelector('.clanker-scanline');
    const bits = root.querySelector('.clanker-bits');
    const eyeOf = (rigName, grid) => {
      const rig = root.querySelector(`.clanker-eye-${rigName}-rig`);
      return { grid, solid: rig.querySelector('.clanker-eye-solid'), box: rig.querySelector('.clanker-eye-pixels'), cells: [...rig.querySelectorAll('.clanker-eye-pixels rect')].map(el => ({ el, r: +el.dataset.r, c: +el.dataset.c, key: '' })) };
    };
    const eyeLeft = eyeOf('left', EYE_L), eyeRight = eyeOf('right', EYE);
    const solid = eyeRight.solid, pixelBox = eyeRight.box;
    // Each column collapses toward its slot on the arc: the cells farthest from it drop out first, the arc cell never does.
    const pixels = eyeRight.cells.map(p => {
      const dist = Math.abs(p.r - ARC[p.c]);
      return Object.assign(p, { arc: dist === 0, at: 0.06 + 0.62 * dist / 5 });
    });
    const visorBg = root.querySelector('.clanker-visor-bg');
    const handMin = root.querySelector('.clanker-hand-min');
    const handHour = root.querySelector('.clanker-hand-hour');
    const abort = new AbortController();
    const timers = new Set();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)');
    const pose = { ...REST }, vel = {}, layers = new Map(), look = { x: 0, y: 0, active: false };
    let alive = true, visible = true, frame = 0, keys = 0, listening = false, hover = false, armed = false;
    let mode = 'idle', nudge = 0, lastTick = 0, reacting = false, handSteps = 0, blinkAt = -1, clock = 0, last = 0, raf = 0;
    let pauseTimer, reactionTimer, idleTimer, armObserver;
    const live = () => alive && root.isConnected && visible && !document.hidden;
    const later = (fn, delay) => {
      const timer = setTimeout(() => { timers.delete(timer); if (alive) fn(); }, delay);
      timers.add(timer);
      return timer;
    };
    const cancel = timer => { clearTimeout(timer); timers.delete(timer); };
    const listen = (el, type, fn) => el.addEventListener(type, fn, { signal: abort.signal });

    // Blink and shutter: rows drop out from the outside in; the last step squashes what is left into a thin line.
    function blinkPixels(eye, level) {
      const on = level > 0;
      eye.solid.style.display = on ? 'none' : '';
      eye.box.setAttribute('visibility', on ? 'visible' : 'hidden');
      if (!on) { eye.cells.forEach(p => { p.key = ''; }); return; }
      const { x, y, w, h, rows } = eye.grid, n = rows.length, half = n / 2, keep = Math.max(0.5, half * (1 - level));
      const closed = level === 1, ch = closed ? LINE / (n % 2 ? 1 : 2) : h, gv = closed ? 0 : BLINK.gap;
      for (const p of eye.cells) {
        const gone = Math.abs(p.r + 0.5 - half) > keep;
        const key = gone ? 'h' : `b${level}`;
        if (key === p.key) continue;
        p.key = key;
        const el = p.el;
        if (gone) { el.setAttribute('visibility', 'hidden'); continue; }
        el.setAttribute('visibility', 'visible');
        el.setAttribute('x', (x + p.c * w + BLINK.gap / 2).toFixed(2));
        el.setAttribute('y', (y + half * h + (p.r + 0.5 - half) * ch - ch / 2 + gv / 2).toFixed(2));
        el.setAttribute('width', (w - BLINK.gap).toFixed(2));
        el.setAttribute('height', Math.max(0.1, ch - gv).toFixed(2));
      }
    }
    function winkPixels(wk, level) {
      const on = wk > 0.002;
      if (!on) { blinkPixels(eyeRight, level); return; }
      solid.style.display = 'none';
      pixelBox.setAttribute('visibility', 'visible');
      const gap = Math.min(1, wk * 6) * 0.9;
      const squeeze = Math.round(Math.min(1, Math.max(0, (wk - 0.74) / 0.22)) * 3) / 3; // steps, so it reads as pixels shrinking
      const h = EYE.h - (EYE.h - LINE) * squeeze, g = gap * (1 - squeeze);
      for (const p of pixels) {
        const gone = !p.arc && wk > p.at;
        const key = gone ? 'x' : `${g.toFixed(2)}|${p.arc ? h.toFixed(2) : ''}`;
        if (key === p.key) continue;
        p.key = key;
        const el = p.el;
        if (gone) { el.setAttribute('visibility', 'hidden'); continue; }
        el.setAttribute('visibility', 'visible');
        const ch = p.arc ? h : EYE.h;
        el.setAttribute('x', (EYE.x + p.c * EYE.w + g / 2).toFixed(2));
        el.setAttribute('y', (EYE.y + p.r * EYE.h + (EYE.h - ch) / 2 + g / 2).toFixed(2));
        el.setAttribute('width', (EYE.w - g).toFixed(2));
        el.setAttribute('height', Math.max(0.1, ch - g).toFixed(2));
      }
    }
    function apply() {
      const k = n => n.toFixed(2);
      const age = clock - blinkAt, { close, hold, open } = BLINK;
      const shut = Math.max(pose.shut, blinkAt < 0 ? 0 : age < close ? age / close : age < close + hold ? 1 : age < close + hold + open ? 1 - (age - close - hold) / open : 0);
      const level = Math.round(Math.min(1, shut) * BLINK.steps) / BLINK.steps;
      const flash = Math.min(1, Math.max(0, pose.fl));
      visorBg.style.fill = flash < 0.01 ? '' : `rgb(${Math.round(20 + 90 * flash)}, ${Math.round(20 + 90 * flash)}, ${Math.round(22 + 95 * flash)})`;
      const eye = (sx, sy, dy) => `translate(${k(pose.gx)}px, ${k(pose.gy + dy)}px) scale(${k(sx)}, ${k(sy)})`;
      const brow = (y, r) => `translateY(${k(y)}px) rotate(${k(r)}deg)`;
      rig.body.style.transform = pose.cr === 0 && pose.cy === 0 && pose.cs === 1 ? '' : `translateY(${k(pose.cy)}px) rotate(${k(pose.cr)}deg) scale(${k(pose.cs)})`;
      rig.face.style.transform = `translate(${k(pose.fx)}px, ${k(pose.fy)}px)`;
      rig.browL.style.transform = brow(pose.bly, pose.blr);
      rig.browR.style.transform = brow(pose.bry, pose.brr);
      rig.eyeL.style.transform = eye(pose.lsx, pose.lsy, 0);
      rig.eyeR.style.transform = eye(pose.rsx, pose.rsy, pose.ry);
      blinkPixels(eyeLeft, level);
      winkPixels(pose.wk, level);
      const bt = Math.min(1, Math.max(0, pose.bt));
      bits.style.opacity = k(bt);
      bits.style.transform = bt > 0.002 ? `translateX(${k(pose.bx)}px)` : '';
      rig.eyeL.style.opacity = rig.eyeR.style.opacity = rig.browL.style.opacity = rig.browR.style.opacity = bt > 0.002 ? k(1 - 0.9 * bt) : '';
      scan.style.transform = `translateY(${k(pose.sy)}px)`;
      scan.style.opacity = k(Math.max(0, pose.so));
      handMin.style.transform = `rotate(${k(pose.ha)}deg)`;
      handHour.style.transform = `rotate(${k(pose.ha / 12)}deg)`;
      handMin.style.opacity = handHour.style.opacity = k(Math.min(1, Math.max(0, pose.ho)));
    }
    function tick(now) {
      try { step(now); } catch (error) { console.error('[clanker-mascot]', error); raf = requestAnimationFrame(tick); } // a bad frame must never end the loop
    }
    function step(now) {
      raf = 0;
      lastTick = now;
      if (!live()) return;
      const dt = Math.min(0.033, (now - last) / 1000);
      last = now;
      clock += dt;
      if (blinkAt >= 0 && clock - blinkAt > BLINK.close + BLINK.hold + BLINK.open) blinkAt = -1;
      const goal = { ...REST, ...POSE[mode] };
      if (look.active) { goal.fx = look.x; goal.fy = look.y; goal.gx = look.x * 0.3; goal.gy = look.y * 0.3; }
      goal.fx += nudge;
      let moving = blinkAt >= 0;
      for (const [name, layer] of layers) {
        layer.w += ((layer.on ? 1 : 0) - layer.w) * (1 - Math.exp(-dt * 7));
        if (!layer.on && layer.w < 0.01) { layers.delete(name); continue; }
        if (!reduced.matches) ANIM[name](goal, clock - layer.t0, layer.w, layer);
        moving = true;
      }
      if (goal.steps !== undefined) handSteps = goal.steps;
      goal.ha = handSteps * 30;
      for (const key in REST) {
        if (DIRECT.has(key)) { pose[key] = goal[key]; continue; }
        const [stiff, damp] = SPRING[key] || SOFT;
        let p = pose[key], v = vel[key] || 0;
        if (reduced.matches) { p = goal[key]; v = 0; }
        else {
          for (let i = 0; i < 2; i++) { v += (stiff * stiff * (goal[key] - p) - 2 * damp * stiff * v) * dt / 2; p += v * dt / 2; }
          if (Math.abs(goal[key] - p) < 0.005 && Math.abs(v) < 0.01) { p = goal[key]; v = 0; } else moving = true;
        }
        pose[key] = p;
        vel[key] = v;
      }
      apply();
      if (moving) raf = requestAnimationFrame(tick);
    }
    // The visibility observer is the one signal that can get stuck (a webview restored while hidden); real interaction overrules it.
    function recheck() {
      if (!visible && alive && root.isConnected && mark.getBoundingClientRect().width > 0) { visible = true; root.classList.remove('mascot-paused'); }
    }
    function kick() {
      if (!alive || !live()) return;
      // A frame that was requested but never delivered (webview hidden and restored) must not block the loop forever.
      if (raf && performance.now() - lastTick > 250) { cancelAnimationFrame(raf); raf = 0; }
      if (raf) return;
      last = performance.now();
      raf = requestAnimationFrame(tick);
    }
    function state(name) {
      cancel(reactionTimer);
      reacting = false;
      look.active = false;
      nudge = 0;
      root.dataset.mascot = name;
      mode = name;
      layers.forEach((layer, key) => { layer.on = key === name; });
      if (ANIM[name]) {
        const layer = layers.get(name);
        if (!layer) layers.set(name, { t0: clock, w: ONE_SHOT[name] ? 1 : 0, on: true, base: handSteps });
        else if (ONE_SHOT[name]) { layer.t0 = clock; layer.w = 1; }
      }
      kick();
    }
    function rest() {
      if (listening) { state('listening'); return; }
      const focused = document.activeElement === input;
      state(hover ? 'scheduling' : focused ? (input.value.trim() ? 'typing' : 'focus') : armed ? 'scheduling' : 'idle');
    }
    function react(name, duration = 1400) {
      recheck();
      if (!live() || listening) return;
      state(name);
      reacting = true;
      reactionTimer = later(rest, duration);
    }
    // Focus moving around (the model menu closing, a file dialog returning) must not cut a reaction short; it settles when it ends.
    const settle = () => { if (!reacting) rest(); };
    function decode() {
      if (!live() || reduced.matches || listening) return;
      const text = MESSAGES[Math.floor(Math.random() * MESSAGES.length)];
      bits.setAttribute('d', bitPath(text));
      react('decode', (BIT.start + bitWidth(text)) / BIT.speed * 1000 + 400);
    }
    function think(infinite = false) {
      if (!live() || reduced.matches || (!input.value.trim() && !infinite)) return;
      keys = 0;
      if (infinite) {
        state('thinking');
      } else {
        react('thinking', 5400);
      }
    }
    function setListening(active) {
      if (!live()) return;
      listening = Boolean(active);
      cancel(reactionTimer);
      cancel(pauseTimer);
      if (listening) {
        state('listening');
      } else {
        rest();
      }
    }
    function blink() {
      recheck();
      if (live() && !reduced.matches && ['idle', 'focus', 'typing', 'listening', 'scheduling'].includes(root.dataset.mascot)) {
        blinkAt = clock;
        root.classList.add('mascot-blinking');
        later(() => root.classList.remove('mascot-blinking'), 280);
        kick();
      }
      later(blink, 4200 + Math.random() * 2400);
    }
    function resetIdleTimer() {
      cancel(idleTimer);
      idleTimer = later(() => {
        if (live() && !reduced.matches && !listening && root.dataset.mascot === 'idle') {
          react('thinking', 5400);
          resetIdleTimer();
        }
      }, 7000 + Math.random() * 2000);
    }
    listen(document, 'pointermove', event => {
      recheck();
      resetIdleTimer();
      if (!live() || reduced.matches || listening || !['idle', 'focus'].includes(root.dataset.mascot)) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (!live() || listening || !['idle', 'focus'].includes(root.dataset.mascot)) return;
        const rect = mark.getBoundingClientRect();
        look.x = Math.max(-11, Math.min(11, (event.clientX - rect.left - rect.width / 2) / 200 * 11));
        look.y = Math.max(-7.5, Math.min(7.5, (event.clientY - rect.top - rect.height / 2) / 220 * 7.5));
        look.active = true;
        kick();
      });
    });
    listen(document.documentElement, 'pointerleave', () => { look.active = false; kick(); });
    listen(input, 'focus', () => { recheck(); cancel(idleTimer); settle(); });
    listen(input, 'blur', () => { cancel(pauseTimer); settle(); resetIdleTimer(); });
    listen(input, 'input', event => {
      recheck();
      if (!live() || listening) return;
      cancel(pauseTimer);
      cancel(idleTimer);
      keys++;
      if (event.data === '@' || event.data === '/') { react(event.data === '@' ? 'mention' : 'action'); return; }
      if (root.dataset.mascot === 'decode') return;
      if (root.dataset.mascot === 'thinking' && keys <= 10) return;
      rest();
      if (!input.value.trim()) { keys = 0; return; }
      if (keys >= 8 && Math.random() < 0.04) { decode(); return; }
      if (((event.data === ' ' && keys >= 6) || keys >= 16) && Math.random() < 0.28) { think(); return; }
      if (!reduced.matches) { nudge = input.value.length % 7 - 3; kick(); }
      pauseTimer = later(() => {
        if (live() && document.activeElement === input && input.value.trim() && !listening) {
          think(true);
        }
      }, 750);
    });
    listen(attach, 'click', () => react('image', 1900));
    listen(modelPicker, 'click', () => react('model', 1100));
    listen(modelPicker, 'clanker:model-change', () => react('model', 1100));
    if (schedule) {
      // Armed, or merely hovered: Clanker checks the clock.
      const sync = () => { armed = schedule.getAttribute('aria-pressed') === 'true'; };
      sync();
      armObserver = new MutationObserver(() => { sync(); if (live()) settle(); });
      armObserver.observe(schedule, { attributes: true, attributeFilter: ['aria-pressed'] });
      listen(schedule, 'pointerenter', () => { hover = true; if (live()) settle(); });
      listen(schedule, 'pointerleave', () => { hover = false; if (live()) settle(); });
    }
    root.querySelectorAll('[data-mascot-action]').forEach(button => listen(button, 'click', () => {
      const action = button.dataset.mascotAction;
      if (action === 'image') attach.click();
      else {
        input.focus();
        input.setRangeText(action === 'mention' ? '@' : '/', input.selectionStart, input.selectionEnd, 'end');
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      react(action, action === 'image' ? 1900 : undefined);
    }));
    const visibility = new IntersectionObserver(entries => {
      visible = entries[0].isIntersecting;
      root.classList.toggle('mascot-paused', !visible);
      kick();
    });
    visibility.observe(mark);
    listen(document, 'visibilitychange', () => { root.classList.toggle('mascot-paused', document.hidden || !visible); kick(); });
    const detached = new MutationObserver(() => { if (!root.isConnected) dispose(); });
    detached.observe(transcript, { childList: true });
    function dispose() {
      alive = false;
      abort.abort();
      timers.forEach(clearTimeout);
      timers.clear();
      cancelAnimationFrame(frame);
      cancelAnimationFrame(raf);
      visibility.disconnect();
      detached.disconnect();
      armObserver?.disconnect();
    }
    rest();
    later(blink, 4200 + Math.random() * 1600);
    resetIdleTimer();
    return {
      dispose,
      launch() {
        if (!alive || !root.isConnected) { dispose(); root.remove(); return; }
        // The send-message sound and launch leap only play in a completely new chat where the Clanker controller is visible.
        const hasExistingChat = Boolean(transcript?.querySelector('.msg-user, .msg-assistant, .compact-divider, .chat-turn, .chat-notice'));
        if (hasExistingChat) { dispose(); root.remove(); return; }
        const rect = root.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0 || root.closest('[hidden]') || getComputedStyle(root).display === 'none' || getComputedStyle(root).visibility === 'hidden') {
          dispose();
          root.remove();
          return;
        }
        dispose();
        Object.assign(pose, REST);
        layers.clear();
        blinkAt = -1;
        apply();
        root.classList.remove('mascot-blinking', 'mascot-paused');
        root.dataset.mascot = 'idle';
        root.setAttribute('aria-hidden', 'true');
        root.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;max-width:none`;
        root.classList.add('is-launching');
        document.body.append(root);
        fanfare();
        setTimeout(() => root.remove(), reduced.matches ? 180 : 700);
      },
      setListening,
    };
  };
})();
