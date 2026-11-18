/* Liquid Glass 2.0: real refraction and a lit rim for the floating glass surfaces (round buttons, rail pills, menus).
   Plain CSS blur only frosts what is behind a surface. Real glass also bends it: the slab's edge is a convex curve, so
   near the rim the background is pulled in along that curve and its colours split slightly, while the middle stays
   calm and readable. Chromium (so Antigravity and VS Code) can run an SVG filter as a backdrop-filter, so for each
   surface size this builds, once, two images and one <filter> around them:
     - a displacement map: red = x shift, green = y shift. The shift per pixel comes from Snell's law on a convex
       "squircle" edge (see LENS), so the bend is thin and strong at the rim and fades smoothly to nothing inside;
     - a specular map: a hairline highlight on the rim facing the light plus a soft glow, from the same edge normals.
   The filter displaces the backdrop, then lays the specular map over it. style.css reads --lg-bd under `body.lg-on`;
   without it, or when the engine can't do it, every surface keeps its normal blur. Everything per-pixel is pure
   (buildLens) so the tests cover it without a browser, and it runs only when a size is first seen, never per frame. */
(function (root) {
  'use strict';

  /* Lens profile. The glass edge is a convex squircle: height f(x) = (1 - (1 - x)^4)^(1/4) for x = 0 (rim) .. 1 (the
     flat top). A ray going straight down meets the surface at angle theta = atan(f'(x)) and bends to phi where
     sin(phi) = sin(theta) / n (Snell, n = 1.5 for glass); across the slab it lands tan(theta - phi) away from where it
     entered. That sideways shift, normalised so the rim is 1, is the table below. It is 1 at the rim, falls fast and
     is exactly 0 on the flat top, so the middle of a surface is never distorted. */
  const N_GLASS = 1.5;
  const LUT_N = 256;
  const LENS = (() => {
    const out = new Float32Array(LUT_N);
    for (let i = 0; i < LUT_N; i++) {
      const x = i / (LUT_N - 1), u = 1 - x;
      const theta = x <= 0 ? Math.PI / 2 : x >= 1 ? 0 : Math.atan(Math.pow(u, 3) * Math.pow(1 - Math.pow(u, 4), -0.75));
      out[i] = Math.tan(theta - Math.asin(Math.sin(theta) / N_GLASS));
    }
    const peak = out[0];
    for (let i = 0; i < LUT_N; i++) out[i] /= peak;
    return out;
  })();

  /* How strongly the background is displaced at t = 0 (the rim) .. 1 (inner edge of the bezel). */
  const strength = (t) => {
    if (!(t > 0)) return 1;
    if (t >= 1) return 0;
    const p = t * (LUT_N - 1), i = Math.floor(p);
    return LENS[i] + (LENS[i + 1] - LENS[i]) * (p - i);
  };

  /* The light sits top left (y points down). The rim facing it is fully lit; the opposite rim catches a weaker echo,
     as on Apple's glass. */
  const LIGHT = { x: -0.55, y: -0.835 };
  const RIM_PX = 2; // width of the specular hairline, in CSS px
  const BLOOM = 0.34; // peak alpha of the broad white bloom on the lit side, relative to the hairline
  const SHADE = 0.42; // peak alpha of the dark inner shade on the far side

  /* Both maps for a w x h rounded rectangle with corner radius r, as RGBA bytes (w*h*4).
       map:  each pixel inside the bezel points along the inward normal, scaled by the lens profile; 128 = no shift.
       spec: white, with alpha = highlight. opts.spec is its peak alpha (0 turns it off); opts.px is how many map
             pixels make one CSS pixel (2 for a map built for a 2x screen), so the hairline keeps its CSS width. */
  function buildLens(w, h, r, bezel, opts) {
    const o = opts || {};
    const peak = o.spec == null ? 0.8 : o.spec, px = o.px || 1;
    w = Math.max(1, Math.round(w)); h = Math.max(1, Math.round(h));
    r = Math.max(0, Math.min(r, w / 2, h / 2));
    bezel = Math.max(1, bezel);
    const map = new Uint8ClampedArray(w * h * 4), spec = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < map.length; i += 4) { map[i] = 128; map[i + 1] = 128; map[i + 2] = 128; map[i + 3] = 255; }
    const hx = w / 2, hy = h / 2, ix = hx - r, iy = hy - r, deep = r - bezel, rim = RIM_PX * px, glowLen = bezel * 0.45, bloomLen = bezel * 0.5;
    /* A wide shape is mostly straight top and bottom edge, and there every column is the same: the corners and the side
       bezel are over once a pixel is max(r, bezel) from the left or right edge. Those columns are computed once and copied
       (opts.noReuse turns that off; the tests check the two give the same bytes). A 860 px pill spends its time on 56 + 56
       columns instead of 860. */
    const edge = Math.max(r, bezel), xFirst = Math.ceil(edge - 0.5), xLast = Math.floor(w - edge - 0.5), reuse = !o.noReuse && xLast > xFirst;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (reuse && x > xFirst && x <= xLast) {
          const from = (y * w + xFirst) * 4, to = (y * w + x) * 4;
          map[to] = map[from]; map[to + 1] = map[from + 1];
          spec[to] = spec[from]; spec[to + 1] = spec[from + 1]; spec[to + 2] = spec[from + 2]; spec[to + 3] = spec[from + 3];
          continue;
        }
        const pxx = x + 0.5 - hx, pyy = y + 0.5 - hy;
        const qx = Math.abs(pxx) - ix, qy = Math.abs(pyy) - iy;
        if (qx < 0 && qy < 0 && Math.max(qx, qy) < deep) continue; // deep inside: calm glass, nothing to draw
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0);
        const outside = ox === 0 ? oy : oy === 0 ? ox : Math.hypot(ox, oy);
        const sdf = outside + Math.min(Math.max(qx, qy), 0) - r; // < 0 inside
        let nx, ny; // outward normal
        if (outside > 0) { nx = (ox / outside) * Math.sign(pxx || 1); ny = (oy / outside) * Math.sign(pyy || 1); }
        else if (qx > qy) { nx = Math.sign(pxx || 1); ny = 0; }
        else { nx = 0; ny = Math.sign(pyy || 1); }
        const d = Math.max(-sdf, 0); // how far inside the rim, in map pixels
        const s = strength(d / bezel);
        const i = (y * w + x) * 4;
        map[i] = 128 - nx * s * 127;
        map[i + 1] = 128 - ny * s * 127;
        if (peak > 0 && d < bezel) {
          const facing = nx * LIGHT.x + ny * LIGHT.y; // -1 .. 1
          const lit = Math.pow(facing >= 0 ? facing : -facing * 0.55, 1.2);
          const hair = d >= rim ? 0 : Math.pow(1 - d / rim, 1.5);
          // White: the hairline, a soft glow hugging it, and a broad bloom on the lit side that makes the slab look thick.
          const aw = Math.min(1, peak * lit * (hair + 0.16 * Math.exp(-d / glowLen)) + peak * BLOOM * Math.max(facing, 0) * Math.exp(-d / bloomLen));
          // Black: the far side of the slab darkens just inside its rim. Over a flat dark window this is what reads as depth.
          const ab = peak * SHADE * Math.max(-facing, 0) * Math.pow(1 - d / bezel, 2) * (d < rim ? 0 : 1);
          const a = aw + ab * (1 - aw);
          const c = a > 0 ? (255 * aw) / a : 0;
          spec[i] = c; spec[i + 1] = c; spec[i + 2] = c;
          spec[i + 3] = a * 255;
        }
      }
    }
    return { map, spec };
  }

  /* Just the displacement map (kept as the small, stable entry point the tests use). */
  const buildMap = (w, h, r, bezel) => buildLens(w, h, r, bezel, { spec: 0 }).map;

  /* One role per surface kind: bezel = lens width in px, depth = peak background shift in px, chroma = colour split
     (0..1; 0 means one displacement pass instead of three), spec = rim highlight strength, blur / saturate /
     brightness = the glass body. Sized to the element, not the viewport: strong on small buttons, gentle on menus,
     almost none on big panels. */
  const KINDS = [
    { sel: '.round-btn', bezel: 22, depth: 20, chroma: 0.15, spec: 0.9, blur: 0.4, saturate: 1.7, brightness: 1.1 },
    { sel: '.project-pill, .api-value-figure', bezel: 22, depth: 18, chroma: 0, spec: 0.7, blur: 0.6, saturate: 1.7, brightness: 1.08 },
    { sel: '.image-context-menu', bezel: 20, depth: 12, chroma: 0, spec: 0.6, blur: 2, saturate: 1.6, brightness: 1.06 },
    // "Show more" on a long prompt: a small clear pill over the faded text, so the lines under it bend through its rim.
    { sel: '.msg-clamp-toggle', bezel: 13, depth: 9, chroma: 0.15, spec: 0.85, frost: 1.5, blur: 0, saturate: 1.5, brightness: 1.08 },
    { sel: '.history-list', bezel: 24, depth: 8, chroma: 0, spec: 0.5, blur: 0.6, saturate: 1.7, brightness: 1.08 },
    // Floating popup bars and pills (glass-ui.css): frosted interior before the lens, crisp curved rim and specular edge.
    { sel: '.cs-settings-search, .history-tools .history-search, .history-filter-btn, .project-gallery-search, .project-gallery-quota, .inv-bar, .cs-route-status', bezel: 18, depth: 16, chroma: 0, spec: 0.85, frost: 2.2, blur: 0, saturate: 1.55, brightness: 1.04 },
  ];

  /* The island's rim refraction (see island() below): the lens is BEZEL px wide and bends the backdrop by up to DEPTH px. */
  const BEZEL = 20, DEPTH = 12;
  const RIM_FRAC = 0.6; // beyond this share of the bezel the lens bends under 1px: nothing to see, nothing to filter

  /* The boxes that cover a shape's ring (shape = { x, y, w, h, rx, flat } in px), or the whole shape when it is too small
     to have a middle. Each box is filtered on its own, and the bend pulls pixels from up to DEPTH px away, so no bend may
     reach across a box's edge: the two end caps are full height and as wide as the corner radius (the whole curve, where the
     bend is diagonal); between them only the straight top and bottom edges remain, where the bend is purely vertical and
     RIM_FRAC deep is enough. The middle of a wide shape, where the text is, belongs to no box: a backdrop filter reruns
     whenever anything inside its box changes, so typing there must not touch one. */
  function rimBoxes(s) {
    const x = Math.round(s.x), y = Math.round(s.y), w = Math.round(s.w), h = Math.round(s.h);
    const T = Math.ceil(Math.min(BEZEL, Math.min(w, h) / 2) * RIM_FRAC) + 1, C = Math.max(Math.round(s.rx), T + 3);
    if (h <= 2 * T + 8 || w <= 2 * C + 16) return [[x, y, w, h]];
    const boxes = [[x, y, C, h], [x + w - C, y, C, h], [x + C, y, w - 2 * C, T]];
    if (!s.flat) boxes.push([x + C, y + h - T, w - 2 * C, T]); // the menu's foot is inside the pill, which draws its own rim there
    return boxes;
  }

  /* ---------- The island: a glass dock that keeps the Dynamic Island's liquid fusing ----------
     The dock's shapes (the composer pill and the buds around it) used to be opaque charcoal because the goo filter
     (#msg-goo: blur, then an alpha threshold) can only fuse shapes it can see, and a backdrop-filter can't see
     through a filtered ancestor. So the fusing moves out of the shapes: both pictures below are SVG images drawn
     from the shapes' rectangles, with the very same blur and threshold.
       islandMask:  the fused silhouette, as an alpha image. A glass layer (a real backdrop-filter, so the transcript
                    scrolls blurred underneath) is masked with it, so neck and all it is the goo's shape, but clear.
       islandLight: what makes it read as a slab: a hairline rim and a soft bloom on the lit top-left, a dark inner
                    shade on the far side, a faint echo rim, and the soft shadow outside the silhouette.
     A shape is { x, y, w, h, rx, ry, o } in px relative to the glass layer; o is its opacity (a bud fading in). */
  const GOO = '<feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur"/><feColorMatrix in="blur" type="matrix" values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7" result="S"/>';
  const num = (v) => (Math.round(v * 100) / 100).toString();
  // A rounded rectangle; s.flat squares off the bottom (the model menu sits on the composer's top edge).
  const shapeRects = (shapes) => shapes.map((s) => {
    const w = Math.max(0, s.w), h = Math.max(0, s.h), o = num(s.o == null ? 1 : s.o);
    if (!s.flat) return `<rect x="${num(s.x)}" y="${num(s.y)}" width="${num(w)}" height="${num(h)}" rx="${num(s.rx)}" ry="${num(s.ry)}" fill-opacity="${o}"/>`;
    const rx = Math.min(s.rx, w / 2), ry = Math.min(s.ry, h), r = s.x + w, b = s.y + h;
    return `<path d="M${num(s.x)} ${num(b)}V${num(s.y + ry)}A${num(rx)} ${num(ry)} 0 0 1 ${num(s.x + rx)} ${num(s.y)}H${num(r - rx)}A${num(rx)} ${num(ry)} 0 0 1 ${num(r)} ${num(s.y + ry)}V${num(b)}Z" fill-opacity="${o}"/>`;
  }).join('');
  const svgOf = (w, h, defs, body) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(w)}" height="${num(h)}" viewBox="0 0 ${num(w)} ${num(h)}"><defs><filter id="f" filterUnits="userSpaceOnUse" x="0" y="0" width="${num(w)}" height="${num(h)}" color-interpolation-filters="sRGB">${defs}</filter></defs>${body}</svg>`;

  function islandMask(w, h, shapes) {
    if (!shapes.length) return '';
    return svgOf(w, h, GOO + '<feMerge><feMergeNode in="S"/></feMerge>', `<g filter="url(#f)" fill="#000">${shapeRects(shapes)}</g>`);
  }

  function islandLight(w, h, shapes, opts) {
    if (!shapes.length) return '';
    const k = Object.assign({ rim: 0.95, bloom: 0.34, shade: 0.5, echo: 0.2, shadow: 0.42 }, opts);
    // "Edge on one side" = the silhouette minus itself shifted the other way; blurred, clipped to the silhouette and tinted.
    const edge = (id, dx, dy, blur, color, alpha) =>
      `<feOffset in="S" dx="${dx}" dy="${dy}" result="${id}o"/><feComposite in="S" in2="${id}o" operator="out" result="${id}e"/>` +
      `<feGaussianBlur in="${id}e" stdDeviation="${blur}" result="${id}b"/>` +
      `<feColorMatrix in="${id}b" type="matrix" values="0 0 0 0 ${color}  0 0 0 0 ${color}  0 0 0 0 ${color}  0 0 0 ${alpha} 0" result="${id}c"/>` +
      `<feComposite in="${id}c" in2="S" operator="in" result="${id}"/>`;
    const defs = GOO +
      '<feGaussianBlur in="S" stdDeviation="13" result="sb"/><feOffset in="sb" dy="10" result="so"/>' +
      `<feColorMatrix in="so" type="matrix" values="0 0 0 0 0  0 0 0 0 0  0 0 0 0 0  0 0 0 ${k.shadow} 0" result="sc"/><feComposite in="sc" in2="S" operator="out" result="shadow"/>` +
      edge('bloom', 6, 10, 5, 1, k.bloom) + edge('shade', -8, -12, 6, 0, k.shade) + edge('echo', -1, -1.6, 0.7, 1, k.echo) + edge('rim', 1.2, 1.9, 0.6, 1, k.rim) +
      '<feMerge><feMergeNode in="shadow"/><feMergeNode in="shade"/><feMergeNode in="bloom"/><feMergeNode in="echo"/><feMergeNode in="rim"/></feMerge>';
    return svgOf(w, h, defs, `<g filter="url(#f)" fill="#000">${shapeRects(shapes)}</g>`);
  }

  const LIGHT_THEME = { rim: 0.7, bloom: 0.2, shade: 0.16, echo: 0.1, shadow: 0.2 }; // white edges vanish on a light window: less of everything

  function support() {
    try { return !!(root.CSS && CSS.supports('backdrop-filter', 'url(#x) blur(1px)')); } catch { return false; }
  }

  function cornerRadius(el, w, h) {
    const raw = getComputedStyle(el).borderTopLeftRadius || '0';
    const n = parseFloat(raw) || 0;
    const px = raw.endsWith('%') ? (Math.min(w, h) * n) / 100 : n;
    return Math.min(px, w / 2, h / 2);
  }

  function start() {
    const doc = root.document;
    if (!doc || !support() || (root.matchMedia && root.matchMedia('(prefers-reduced-transparency: reduce)').matches)) return;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('aria-hidden', 'true');
    svg.setAttribute('width', '0'); svg.setAttribute('height', '0');
    svg.style.cssText = 'position:fixed;left:0;top:0;width:0;height:0;pointer-events:none';
    const defs = doc.createElementNS(NS, 'defs');
    svg.appendChild(defs);
    doc.body.appendChild(svg);

    const filters = new Map(); // key -> { id, count }
    const tracked = new Map(); // element -> { kind, key }
    let seq = 0;

    function uriOf(data, w, h) {
      const canvas = doc.createElement('canvas');
      canvas.width = w; canvas.height = h;
      const ctx = canvas.getContext('2d');
      const img = ctx.createImageData(w, h);
      img.data.set(data);
      ctx.putImageData(img, 0, 0);
      return canvas.toDataURL('image/png');
    }

    function filterFor(kind, w, h, r) {
      // Maps are built at the screen's pixel density (at most 2x) so the hairline and the bend stay crisp on hi-dpi.
      const px = Math.min(2, Math.max(1, Math.ceil(root.devicePixelRatio || 1)));
      const dark = !doc.body.classList.contains('vscode-light');
      const key = [kind.sel, w, h, Math.round(r), px, dark].join('|');
      let entry = filters.get(key);
      if (!entry) {
        const id = `lg-${++seq}`;
        const bezel = Math.min(kind.bezel, Math.min(w, h) / 2);
        const mw = w * px, mh = h * px;
        const { map, spec } = buildLens(mw, mh, r * px, bezel * px, { spec: kind.spec * (dark ? 0.4 : 1), px });
        const mapUri = uriOf(map, mw, mh);
        const f = doc.createElementNS(NS, 'filter');
        f.setAttribute('id', id);
        f.setAttribute('filterUnits', 'userSpaceOnUse');
        f.setAttribute('primitiveUnits', 'userSpaceOnUse');
        f.setAttribute('color-interpolation-filters', 'sRGB');
        f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', String(w)); f.setAttribute('height', String(h));
        const image = (uri, result) => `<feImage href="${uri}" x="0" y="0" width="${w}" height="${h}" preserveAspectRatio="none" result="${result}"/>`;
        const scale = (k) => (kind.depth * 2 * k).toFixed(2);
        let body = image(mapUri, 'map');
        let src = 'SourceGraphic';
        if (kind.frost > 0) {
          body += `<feGaussianBlur in="SourceGraphic" stdDeviation="${kind.frost}" edgeMode="duplicate" result="frosted"/>`;
          src = 'frosted';
        }
        if (kind.chroma > 0) {
          // Red bends most, blue least: the coloured fringe real glass leaves on a bright edge. Three passes, so only
          // small surfaces ask for it.
          const mat = (c) => [c === 0 ? 1 : 0, 0, 0, 0, 0, 0, c === 1 ? 1 : 0, 0, 0, 0, 0, 0, c === 2 ? 1 : 0, 0, 0, 0, 0, 0, 1, 0].join(' ');
          const k = [1 + kind.chroma, 1, 1 - kind.chroma];
          body += [0, 1, 2].map((c) =>
            `<feDisplacementMap in="${src}" in2="map" scale="${scale(k[c])}" xChannelSelector="R" yChannelSelector="G" result="d${c}"/>` +
            `<feColorMatrix in="d${c}" type="matrix" values="${mat(c)}" result="c${c}"/>`).join('') +
            '<feComposite in="c0" in2="c1" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="rg"/>' +
            `<feComposite in="rg" in2="c2" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="bent"/>`;
        } else {
          body += `<feDisplacementMap in="${src}" in2="map" scale="${scale(1)}" xChannelSelector="R" yChannelSelector="G" result="bent"/>`;
        }
        if (kind.spec > 0) body += image(uriOf(spec, mw, mh), 'spec') + '<feComposite in="spec" in2="bent" operator="over"/>';
        f.innerHTML = body;
        defs.appendChild(f);
        entry = { id, count: 0 };
        filters.set(key, entry);
      }
      return { key, entry };
    }

    function release(key) {
      const entry = filters.get(key);
      if (!entry || --entry.count > 0) return;
      doc.getElementById(entry.id)?.remove();
      filters.delete(key);
    }

    function apply(el, kind) {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      const old = tracked.get(el);
      if (w < 8 || h < 8) return; // hidden or collapsed: keep what it had
      const r = cornerRadius(el, w, h);
      const { key, entry } = filterFor(kind, w, h, r);
      if (old?.key === key) return;
      entry.count++;
      if (old) release(old.key);
      tracked.set(el, { kind, key });
      const blur = kind.blur > 0 ? ` blur(${kind.blur}px)` : '';
      el.style.setProperty('--lg-bd', `url(#${entry.id})${blur} saturate(${kind.saturate}) brightness(${kind.brightness})`);
    }

    const pending = new Set();
    const afterReveal = callback => {
      const idle = () => root.requestIdleCallback ? root.requestIdleCallback(callback, { timeout: 800 }) : setTimeout(callback, 0);
      if (doc.documentElement.hasAttribute('data-ui-loading')) doc.addEventListener('clanker-ui-ready', idle, { once: true });
      else idle();
    };
    let frame = 0;
    let firstFlush = true;
    const flush = () => {
      if (firstFlush) { firstFlush = false; afterReveal(flush); return; }
      frame = 0;
      for (const el of pending) { const t = tracked.get(el); if (el.isConnected && t) apply(el, t.kind); }
      pending.clear();
    };
    const resizer = new ResizeObserver((entries) => {
      for (const e of entries) pending.add(e.target);
      if (!frame) frame = requestAnimationFrame(flush);
    });

    function scan() {
      for (const kind of KINDS) {
        for (const el of doc.querySelectorAll(kind.sel)) {
          if (tracked.has(el)) continue;
          tracked.set(el, { kind, key: '' });
          resizer.observe(el);
        }
      }
      for (const el of [...tracked.keys()]) {
        if (!el.isConnected) { const t = tracked.get(el); if (t.key) release(t.key); tracked.delete(el); resizer.unobserve(el); }
      }
    }

    let scanTimer = 0;
    // Only a new or removed surface matters. The transcript (every streamed word adds nodes) and the island's own layers
    // never hold one, so they must not wake the scan.
    const quiet = (node) => !!node.closest && !!node.closest('#transcript, .island-glass');
    // A "Show more" toggle is added inside the transcript once a prompt has been measured, so it is the one node that may wake it.
    const isToggle = (node) => !!node.classList && node.classList.contains('msg-clamp-toggle');
    const mutations = new MutationObserver((list) => {
      if (scanTimer || !list.some((m) => (m.addedNodes.length || m.removedNodes.length) && (!quiet(m.target) || [...m.addedNodes].some(isToggle)))) return;
      scanTimer = setTimeout(() => { scanTimer = 0; scan(); }, 200);
    });
    mutations.observe(doc.body, { childList: true, subtree: true });
    scan();
    let wasLight = doc.body.classList.contains('vscode-light');
    new MutationObserver(() => {
      const light = doc.body.classList.contains('vscode-light');
      if (light === wasLight) return;
      wasLight = light;
      for (const [el, t] of tracked) if (el.isConnected) apply(el, t.kind);
    }).observe(doc.body, { attributes: true, attributeFilter: ['class'] });
    doc.body.classList.add('lg-on');
    // Backdrops must live outside the rail's filtered ancestors to sample the chat column below them.
    const rail = doc.querySelector('.rail');
    if (rail) {
      const surface = doc.createElement('div');
      surface.className = 'rail-glass'; surface.hidden = true; surface.setAttribute('aria-hidden', 'true');
      doc.body.appendChild(surface);
      const kind = { sel: '.rail-glass', bezel: 16, depth: 12, chroma: 0, spec: 0.25, blur: 0.6, saturate: 1.15, brightness: 1.02 };
      tracked.set(surface, { kind, key: '' });
      const selector = '.ring:is(:hover, :focus-visible) .ring-pill, .round-btn-update:is(:hover, :focus-visible, .is-peek) .upd-pill, .round-btn-queue.is-sched-open .sched-pill, .project-item:is(:hover, .is-editing) .project-peek, .history-item:is(:hover, :focus-within) .history-peek';
      let active = null, signature = '', outline = '', until = 0, raf = 0, settle = 0;
      const materialOpacity = el => parseFloat(getComputedStyle(el, el.matches('.project-peek, .history-peek') ? null : '::before').opacity) || 0;
      const drawRail = () => {
        raf = 0;
        const candidates = [...rail.querySelectorAll(selector)];
        const target = candidates.find(el => el.matches(':hover') || el.parentElement.matches(':hover')) || candidates[0]
          || (active?.isConnected && materialOpacity(active) > 0.01 ? active : null);
        if (target !== active) {
          active?.classList.remove('is-glass-hover');
          active = target; signature = ''; outline = '';
          clearTimeout(settle);
          surface.style.backdropFilter = surface.style.webkitBackdropFilter = 'blur(3px) saturate(115%)';
        }
        if (!active) { surface.hidden = true; return; }
        const b = active.getBoundingClientRect(), cs = getComputedStyle(active);
        const sig = [b.x, b.y, b.width, b.height, cs.borderRadius].join('|');
        if (sig !== signature) {
          signature = sig;
          surface.style.left = `${b.x}px`; surface.style.top = `${b.y}px`;
          surface.style.width = `${b.width}px`; surface.style.height = `${b.height}px`;
          surface.style.borderRadius = cs.borderRadius;
          clearTimeout(settle);
          surface.style.backdropFilter = surface.style.webkitBackdropFilter = 'blur(3px) saturate(115%)';
          settle = setTimeout(() => {
            if (surface.hidden) return;
            apply(surface, kind);
            surface.style.removeProperty('backdrop-filter');
            surface.style.removeProperty('-webkit-backdrop-filter');
          }, 100);
        }
        const shaped = active.matches('.project-peek, .history-peek');
        if (shaped && window.bubbleOutline && outline !== sig) {
          outline = sig;
          const tail = active.matches('.history-peek') ? 6 : 0;
          const svg = `<svg xmlns="${NS}" width="${b.width}" height="${b.height}"><path fill="white" d="${window.bubbleOutline(b.width, b.height, tail)}"/></svg>`;
          surface.style.maskImage = `url("data:image/svg+xml,${encodeURIComponent(svg)}")`;
          surface.style.maskSize = '100% 100%';
        } else if (!shaped) surface.style.maskImage = '';
        surface.style.clipPath = cs.clipPath;
        surface.style.opacity = String(materialOpacity(active));
        surface.hidden = false;
        if (!active.classList.contains('is-glass-hover')) active.classList.add('is-glass-hover');
        if (performance.now() < until) raf = requestAnimationFrame(drawRail);
      };
      const kickRail = () => { until = performance.now() + 400; if (!raf) raf = requestAnimationFrame(drawRail); };
      for (const type of ['pointerover', 'pointerout', 'focusin', 'focusout', 'transitionrun', 'transitionend']) rail.addEventListener(type, kickRail);
      doc.addEventListener('scroll', kickRail, true);
      root.addEventListener('resize', kickRail);
      new MutationObserver(kickRail).observe(rail, { attributes: true, attributeFilter: ['class'], subtree: true });
    }
    const dock = { defs, NS, uriOf, afterReveal, tiles: new Map(), px: () => Math.min(2, Math.max(1, Math.ceil(root.devicePixelRatio || 1))) };
    island(doc, dock);
    island(doc, dock, true);
  }

  /* Wires the dock: a fixed glass layer behind .compose-row, sized to the row plus room for the shadow, whose mask and
     lighting are redrawn from the shapes' live rectangles whenever they move. Nothing here runs per frame while the
     dock is at rest; during a bud's spring or the composer's resize it follows the animation (getAnimations() tells). */
  function island(doc, gl, upper = false) {
    const row = doc.querySelector('.compose-row');
    const hc = doc.body.classList.contains('vscode-high-contrast') || doc.body.classList.contains('vscode-high-contrast-light');
    if (!row || hc) return;
    const PAD = 40;
    const glass = doc.createElement('div');
    glass.className = `island-glass${upper ? ' island-glass-upper' : ''}`;
    const prefix = upper ? 'ig-upper' : 'ig';
    glass.setAttribute('aria-hidden', 'true');
    // Two kinds of backdrop layer, not one: .ig-frost blurs everywhere except the rim; the .ig-rim strips (added once the dock
    // is at rest) only bend, and only along the rim. .ig-tint and .ig-light sit on top (the glass's colour, and its lighting).
    // Masks are set on each element rather than inherited custom properties, avoiding descendant style recalculation.
    const layer = (name) => { const el = doc.createElement('div'); el.className = name; glass.appendChild(el); return el; };
    const frost = layer('ig-frost'), tint = layer('ig-tint'), lighting = layer('ig-light');
    // Keep the filter graphs alive: changing geometry must not decode two new SVG images each frame.
    const maskSvg = doc.createElementNS(gl.NS, 'svg');
    maskSvg.innerHTML = islandMask(1, 1, [{ x: 0, y: 0, w: 1, h: 1, rx: 0, ry: 0 }]).replaceAll('id="f"', `id="${prefix}-silhouette-filter"`).replaceAll('url(#f)', `url(#${prefix}-silhouette-filter)`);
    const maskFilter = maskSvg.querySelector('filter');
    const maskGroup = maskSvg.querySelector('g');
    const mask = doc.createElementNS(gl.NS, 'mask');
    mask.id = `${prefix}-silhouette`;
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    mask.setAttribute('maskContentUnits', 'userSpaceOnUse');
    mask.setAttribute('style', 'mask-type:alpha');
    mask.appendChild(maskGroup);
    gl.defs.append(maskFilter, mask);
    const lightSvg = doc.createElementNS(gl.NS, 'svg');
    lightSvg.style.cssText = 'width:100%;height:100%;overflow:visible';
    lighting.appendChild(lightSvg);
    let lightTheme;
    const setMask = (el, value, composite) => {
      el.style.webkitMask = value; el.style.mask = value;
      el.style.webkitMaskComposite = composite ? composite[0] : ''; el.style.maskComposite = composite ? composite[1] : '';
    };
    const layerMask = (url, x, y, w, h) => `${url} ${x}px ${y}px / ${w} ${h} no-repeat`;
    row.parentNode.insertBefore(glass, row);
    let last = '', busy = false, silhouette = 'none', lastDockH = '';

    // The textarea rewrites its own height on every keystroke; if that changes the dock's size the ResizeObserver says so.
    const watch = new MutationObserver((list) => { if (list.some((m) => !(m.type === 'attributes' && m.target.tagName === 'TEXTAREA'))) kick(); });
    // Every .model-menu (model picker, permissions, the @ and / lists) rests on the composer and shares the upper slab; only an open one
    // has any opacity, so the silhouette is the composer plus whichever is showing.
    const menusOf = () => [...doc.querySelectorAll('.model-menu')];
    const watchedMenus = new WeakSet();
    const menuResize = new ResizeObserver(() => kick()); // a list's height follows what is typed, with no class change to say so
    function draw() {
      const rr = row.getBoundingClientRect();
      const rects = []; // [element, flat]
      for (const el of row.children) if (!upper || el.matches('.composer')) rects.push([el, false]);
      if (upper) {
        for (const menu of menusOf()) {
          rects.push([menu, true]);
          if (!watchedMenus.has(menu)) { watchedMenus.add(menu); watch.observe(menu, { attributes: true, attributeFilter: ['class'] }); menuResize.observe(menu); }
        }
      }
      const found = [];
      for (const [el, flat] of rects) {
        if (!(el.offsetWidth > 0 && el.offsetHeight > 0)) continue;
        const cs = getComputedStyle(el);
        if (cs.display === 'none' || cs.visibility === 'hidden') continue;
        const o = parseFloat(cs.opacity);
        if (flat && !(o > 0.01)) continue;
        const b = el.getBoundingClientRect();
        const sx = b.width / el.offsetWidth, sy = b.height / el.offsetHeight;
        const r = Math.min(parseFloat(cs.borderTopLeftRadius) || 0, el.offsetWidth / 2, el.offsetHeight / 2);
        // The menu reaches 6px into the composer so its square foot hides inside the pill and the goo draws the fillets.
        found.push({ left: b.left, top: b.top, w: b.width, h: b.height + (flat ? 6 : 0), rx: r * sx, ry: r * sy, o, flat });
      }
      const anchor = upper ? row.querySelector('.composer').getBoundingClientRect() : rr;
      let left = anchor.left, top = anchor.top, right = anchor.right, bottom = anchor.bottom;
      for (const f of found) { left = Math.min(left, f.left); top = Math.min(top, f.top); right = Math.max(right, f.left + f.w); bottom = Math.max(bottom, f.top + f.h); }
      const ox = left - PAD, oy = top - PAD, w = right - left + PAD * 2, h = bottom - top + PAD * 2;
      const shapes = found.map((f) => ({ x: f.left - ox, y: f.top - oy, w: f.w, h: f.h, rx: f.rx, ry: f.ry, o: f.o, flat: f.flat }));
      const light = doc.body.classList.contains('vscode-light');
      const sig = [ox, oy, w, h, light, ...shapes.map((s) => [s.x, s.y, s.w, s.h, s.rx, s.ry, s.o].map((n) => Math.round(n * 4) / 4).join(','))].join('|');
      if (sig === last) return;
      last = sig;
      const st = glass.style;
      st.left = `${ox}px`; st.top = `${oy}px`; st.width = `${w}px`; st.height = `${h}px`;
      for (const node of [maskFilter, mask]) {
        node.setAttribute('x', '0'); node.setAttribute('y', '0');
        node.setAttribute('width', num(w)); node.setAttribute('height', num(h));
      }
      maskGroup.innerHTML = shapeRects(shapes);
      silhouette = `url(#${prefix}-silhouette)`;
      setMask(tint, layerMask(silhouette, 0, 0, '100%', '100%'));
      setMask(frost, layerMask(silhouette, 0, 0, '100%', '100%'));
      if (lightTheme !== light) {
        lightTheme = light;
        const template = doc.createElementNS(gl.NS, 'svg');
        template.innerHTML = islandLight(w, h, shapes, light ? LIGHT_THEME : undefined).replaceAll('id="f"', `id="${prefix}-light-filter"`).replaceAll('url(#f)', `url(#${prefix}-light-filter)`);
        lightSvg.replaceChildren(...template.firstElementChild.childNodes);
      }
      lightSvg.setAttribute('viewBox', `0 0 ${num(w)} ${num(h)}`);
      const lightFilter = lightSvg.querySelector('filter');
      lightFilter.setAttribute('width', num(w)); lightFilter.setAttribute('height', num(h));
      lightSvg.querySelector('g').innerHTML = shapeRects(shapes);
      const dockH = `${Math.ceil(rr.height)}px`;
      if (!upper && dockH !== lastDockH) { lastDockH = dockH; doc.body.style.setProperty('--dock-h', dockH); } // inherited by the whole page: only when it changes
      onDrawn(shapes, w, h, sig);
      if (!doc.body.classList.contains('lg-island')) doc.body.classList.add('lg-island');
    }

    /* Rim refraction. The glass is frosted inside, but along its edge (the lens bezel) it shows the backdrop sharp and
       bent, the way a thick slab does. That used to be one SVG filter over the whole dock (bend, blur, then mask the two
       together). The dock repaints on every keystroke, and a backdrop filter reruns whenever anything inside its box
       changes, so typing re-ran a full-size displacement and was several times slower than plain blur. Now:
         - .ig-frost is the ordinary blur, shown through the silhouette minus the soft ring (CSS mask), on top;
         - the rim is a handful of thin strips (RIM_FRAC of the bezel deep) hugging each shape's edge, each with its own
           small displacement map, underneath, shown at FULL strength through the ring's footprint. Typing happens in
           the middle of the pill, outside every strip, so a keystroke damages no backdrop filter at all.
       Why the rim is solid and only the frost is soft: stacked at partial alpha the two layers would weigh the bent
       image a^2 (plus a leftover of unbent backdrop) instead of a. With the rim opaque and the frost on top at 1 - a,
       the result is (1 - a) * frost + a * bent, exactly what the single filter computed.
       The maps come from per-shape lens tiles (buildLens, cached by size). Rest state only: while anything moves the
       glass is plain frosted and this settles in ~150ms after. */
    const tiles = gl.tiles;
    const refractions = new Map();
    const encode = (canvas) => new Promise(resolve => canvas.toBlob(blob => {
      if (!blob) { resolve(canvas.toDataURL('image/png')); return; }
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => resolve(canvas.toDataURL('image/png'));
      reader.readAsDataURL(blob);
    }, 'image/png'));
    let rimNodes = [], rimSeq = 0;
    function tileFor(s, px) {
      const key = [Math.round(s.w), Math.round(s.h), Math.round(s.rx), px].join('|');
      let t = tiles.get(key);
      if (!t) {
        const w = Math.round(s.w) * px, h = Math.round(s.h) * px;
        const map = buildLens(w, h, s.rx * px, Math.min(BEZEL, Math.min(s.w, s.h) / 2) * px, { spec: 0 }).map;
        const ring = new Uint8ClampedArray(map.length), solid = new Uint8ClampedArray(map.length);
        // ring: how much of each pixel is rim (soft). solid: the same footprint at full strength (see refract()).
        // The faint tail of the lens (under ~3%) is dropped, so the strips can end where the ring does.
        ring.fill(255); solid.fill(255);
        for (let i = 0; i < map.length; i += 4) {
          const dx = map[i] - 128, dy = map[i + 1] - 128;
          if (dx === 0 && dy === 0) { ring[i + 3] = solid[i + 3] = 0; continue; } // most of a tile: no bend, no ring
          ring[i + 3] = Math.max(0, Math.min(255, (Math.sqrt(dx * dx + dy * dy) * 3.2 - 8) * 1.032));
          solid[i + 3] = ring[i + 3] > 0 ? 255 : 0;
        }
        t = { w, h, map, ring, solid };
        if (tiles.size >= 8) tiles.delete(tiles.keys().next().value);
        tiles.set(key, t);
      }
      return t;
    }
    function clearRim() {
      for (const n of rimNodes) n.remove();
      rimNodes = [];
    }
    async function refract(shapes, w, h, token) {
      if (token !== last || !row.isConnected) return;
      // Strip masks need an image with CSS positioning; SVG mask references use local user coordinates.
      silhouette = `url("data:image/svg+xml,${encodeURIComponent(islandMask(w, h, shapes))}")`;
      const px = gl.px();
      // The maps are placed on whole device pixels, so half-pixel layout jitter (537 vs 537.5 after a reflow) must not
      // miss the cache: key on floored geometry. Opacity stays exact because refract() skips shapes under 0.99.
      const cacheKey = JSON.stringify([Math.floor(w), Math.floor(h), px, shapes], (key, value) => typeof value === 'number' && key !== 'o' && key !== '2' ? Math.floor(value) : value);
      let encoded = refractions.get(cacheKey);
      if (!encoded) {
        const mapC = doc.createElement('canvas'); mapC.width = w * px; mapC.height = h * px;
        const mapX = mapC.getContext('2d');
        mapX.fillStyle = 'rgb(128,128,128)'; mapX.fillRect(0, 0, mapC.width, mapC.height);
        const ringC = doc.createElement('canvas'); ringC.width = w * px; ringC.height = h * px;
        const ringX = ringC.getContext('2d');
        const solidC = doc.createElement('canvas'); solidC.width = w * px; solidC.height = h * px;
        const solidX = solidC.getContext('2d');
        const boxes = [];
        // The menu first, the pill and buds after, so the pill's own rim wins where the menu's foot overlaps it.
        for (const s of [...shapes.filter((q) => q.flat), ...shapes.filter((q) => !q.flat)]) {
          if (s.o < 0.99 || s.w < 24 || s.h < 24) continue;
          const t = tileFor(s, px), x = Math.round(s.x * px), y = Math.round(s.y * px);
          mapX.putImageData(new ImageData(t.map, t.w, t.h), x, y);
          ringX.putImageData(new ImageData(t.ring, t.w, t.h), x, y);
          solidX.putImageData(new ImageData(t.solid, t.w, t.h), x, y);
          boxes.push(...rimBoxes(s));
        }
        const crops = boxes.map(([bx, by, bw, bh]) => {
          const crop = doc.createElement('canvas'); crop.width = bw * px; crop.height = bh * px;
          crop.getContext('2d').drawImage(mapC, bx * px, by * px, bw * px, bh * px, 0, 0, bw * px, bh * px);
          return crop;
        });
        const images = [];
        for (const canvas of [ringC, solidC, ...crops]) {
          if (token !== last) return;
          images.push(await encode(canvas)); // yield between canvas snapshots instead of blocking startup with the whole batch
        }
        const [ring, solid, ...maps] = images;
        if (token !== last) return; // a later geometry owns the masks, even if encoding finishes out of order
        encoded = { ring, solid, boxes, maps };
        if (refractions.size >= 8) refractions.delete(refractions.keys().next().value);
        refractions.set(cacheKey, encoded);
      }
      if (token !== last) return;
      clearRim();
      const ringUrl = `url("${encoded.ring}")`, solidUrl = `url("${encoded.solid}")`;
      // The frost shows the silhouette minus the soft ring; each strip shows the solid ring's footprint inside the silhouette.
      // Both masks are the full dock's size, shifted so they line up inside a strip.
      setMask(frost, `${layerMask(silhouette, 0, 0, '100%', '100%')}, ${layerMask(ringUrl, 0, 0, '100%', '100%')}`, ['source-out', 'subtract']);
      for (const [index, [bx, by, bw, bh]] of encoded.boxes.entries()) {
        const id = `${prefix}-rim-${++rimSeq}`;
        const f = doc.createElementNS(gl.NS, 'filter');
        f.setAttribute('id', id);
        f.setAttribute('filterUnits', 'userSpaceOnUse'); f.setAttribute('primitiveUnits', 'userSpaceOnUse');
        f.setAttribute('color-interpolation-filters', 'sRGB');
        f.setAttribute('x', '0'); f.setAttribute('y', '0'); f.setAttribute('width', String(bw)); f.setAttribute('height', String(bh));
        f.innerHTML = `<feImage href="${encoded.maps[index]}" x="0" y="0" width="${bw}" height="${bh}" preserveAspectRatio="none" result="map"/>` +
          `<feDisplacementMap in="SourceGraphic" in2="map" scale="${DEPTH * 2}" xChannelSelector="R" yChannelSelector="G"/>`;
        gl.defs.appendChild(f);
        const el = doc.createElement('div');
        el.className = 'ig-rim';
        el.style.cssText = `left:${bx}px;top:${by}px;width:${bw}px;height:${bh}px;`;
        const bd = `url(#${id}) brightness(1.06)`; // no saturate(): it turned a navy theme's dock a much bluer navy (see --ig-blur)
        el.style.webkitBackdropFilter = bd; el.style.backdropFilter = bd;
        setMask(el, `${layerMask(solidUrl, -bx, -by, `${w}px`, `${h}px`)}, ${layerMask(silhouette, -bx, -by, `${w}px`, `${h}px`)}`, ['source-in', 'intersect']);
        glass.insertBefore(el, frost); // below the frost, so it bends the sharp backdrop, not the blurred one
        rimNodes.push(f, el);
      }
      glass.classList.add('is-refracted');
    }
    let settle = 0;
    function onDrawn(shapes, w, h, token) {
      clearTimeout(settle);
      glass.classList.remove('is-refracted'); // plain frost while it moves
      clearRim();
      settle = setTimeout(() => {
        const render = () => refract(shapes, w, h, token);
        if (doc.documentElement.hasAttribute('data-ui-loading')) gl.afterReveal(render);
        else render();
      }, 160);
    }

    // Follow motion for as long as something in the dock is animating, then stop. Asking the document which animations
    // are running flushes style and walks the whole subtree, so it was the dearest part of every frame (it cost more
    // than redrawing the dock). Ask every few frames instead: a dock that has just stopped is redrawn a few more times
    // against an unchanged signature, which returns early.
    const ANIM_CHECK_EVERY = 6;
    let ticks = 0, moving = true;
    function follow() {
      if (!row.isConnected) { clearTimeout(settle); busy = false; return; }
      draw();
      if (ticks++ % ANIM_CHECK_EVERY === 0) moving = [row, ...row.children, ...menusOf()].some(el => el.getAnimations().some(a => a.playState === 'running'));
      if (moving) requestAnimationFrame(follow);
      else { busy = false; ticks = 0; moving = true; }
    }
    const kick = () => { if (!busy) { busy = true; requestAnimationFrame(follow); } };
    new ResizeObserver(kick).observe(row);
    watch.observe(row, { childList: true, subtree: true, attributes: true, attributeFilter: ['hidden', 'class', 'style'] });
    watch.observe(doc.body, { attributes: true, attributeFilter: ['class'] }); // theme changes
    watch.observe(doc.body, { childList: true }); // the model menu's stage is built after this script runs
    for (const type of ['animationstart', 'transitionrun', 'transitionend', 'animationend']) {
      doc.addEventListener(type, (e) => { if (e.target.closest?.('.compose-row, .model-menu-stage')) kick(); }, true);
    }
    root.addEventListener('resize', kick);
    kick();
  }

  const api = { buildLens, buildMap, strength, KINDS, islandMask, islandLight, rimBoxes, BEZEL, DEPTH, RIM_FRAC };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else {
    root.LiquidGlass = api;
    if (root.document) {
      const go = () => start();
      root.document.readyState === 'complete' ? go() : root.document.addEventListener('DOMContentLoaded', go, { once: true });
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
