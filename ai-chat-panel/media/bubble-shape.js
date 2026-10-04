// Your messages wear the same shape as the rail's chat tiles (launcher.js): superellipse (n = 5) corners, so the
// curvature flows into the straight edges, and the little tail under the right corner. The tiles are one fixed size
// and use a bounding-box clip path; a message is any size, so its outline is drawn in pixels for the size it has and
// redrawn when that changes.
//
// The whole thing, fill and rim, is ONE image behind the message group (bubble + its time/copy/revert dock), not a
// clip path plus a masked layer: one raster means one antialiasing pass and a rim of exactly the same width all the
// way round. While the pointer is on the message, the dock's pill is added to the shape as part of the same contour,
// so bubble and dock share one outline instead of two touching ones.
(() => {
  const N = 5;
  const STEPS = 16; // points per corner
  const RADIUS = 20; // the tile's corner, for a 40px square
  // How far the tail hangs below the body; .msg-user reserves the room as padding (keep the two equal). The tile's tail
  // is 6px; the same tail is drawn a little larger so it reads at message size.
  const TAIL = 10;
  const FILL = 'rgb(26,28,34)'; // the charcoal of the composer and the model menu
  const RIM = '#2b2d32';

  /** The outline of a bubble of w x h, tail included, as an SVG path in pixels. The tail is TAIL tall unless given (the rail's tiles use 6). */
  function bubblePath(w, h, tail = TAIL) {
    const K = tail / 6;
    const body = h - tail;
    const r = Math.min(RADIUS, w / 2, body / 2);
    const xv = w - 9 * K; // the tail's straight edge, and its left foot 8.6 * K further in: as the tile's 31 and 22.4 of 40
    const xl = xv - 8.6 * K;
    // The bottom edge's height at x: level, or lifted through the corner.
    const bottom = (x) => {
      const dx = x - (w - r);
      return dx <= 0 ? body : body - r + r * (1 - (dx / r) ** N) ** (1 / N);
    };
    const corner = (cx, cy, from) => Array.from({ length: STEPS + 1 }, (_, k) => {
      const t = from + (Math.PI / 2) * (k / STEPS);
      const c = Math.cos(t);
      const s = Math.sin(t);
      return [cx + r * Math.sign(c) * Math.abs(c) ** (2 / N), cy + r * Math.sign(s) * Math.abs(s) ** (2 / N)];
    });
    // Clockwise from the top edge: top right, bottom right, bottom left, top left.
    const points = [
      ...corner(w - r, r, 1.5 * Math.PI),
      ...corner(w - r, body - r, 0),
      ...corner(r, body - r, 0.5 * Math.PI),
      ...corner(r, r, Math.PI),
    ];
    const f = (x, y) => `${x.toFixed(2)} ${y.toFixed(2)}`;
    let d = '';
    let tailDone = false;
    for (const [x, y] of points) {
      // The tail replaces the stretch of the bottom edge between its two feet.
      if (y > body - r && x < xv && x > xl) {
        if (!tailDone) d += `L${f(xv, bottom(xv))}L${f(xv, body + 4.6 * K)}Q${f(xv, body + 6.4 * K)} ${f(xv - 1.4 * K, body + 5.3 * K)}L${f(xl, bottom(xl))}`;
        tailDone = true;
        continue;
      }
      d += `${d ? 'L' : 'M'}${f(x, y)}`;
    }
    return `${d}Z`;
  }

  /** A rounded rectangle with a radius per corner (top left, top right, bottom right, bottom left) as an SVG path. */
  const roundedRect = (x, y, w, h, [tl, tr, br, bl]) => `M${x + tl} ${y}H${x + w - tr}${tr ? `A${tr} ${tr} 0 0 1 ${x + w} ${y + tr}` : ''}V${y + h - br}${br ? `A${br} ${br} 0 0 1 ${x + w - br} ${y + h}` : ''}H${x + bl}${bl ? `A${bl} ${bl} 0 0 1 ${x} ${y + h - bl}` : ''}V${y + tl}${tl ? `A${tl} ${tl} 0 0 1 ${x + tl} ${y}` : ''}Z`;

  /**
   * Fills the inside of a concave corner where two edges meet at 90 degrees, so it is a curve instead of a notch.
   * c is the corner, u and v are unit vectors along the two edges, away from it. Returns the filled sliver and its arc.
   */
  function fillet(c, u, v, f) {
    const p1 = [c[0] + u[0] * f, c[1] + u[1] * f];
    const p2 = [c[0] + v[0] * f, c[1] + v[1] * f];
    const sweep = v[0] * u[1] - v[1] * u[0] > 0 ? 1 : 0;
    const arc = `M${p1[0]} ${p1[1]}A${f} ${f} 0 0 ${sweep} ${p2[0]} ${p2[1]}`;
    // The two straight sides of the sliver lie on the neighbours' edges. Their rims, which would show as lines inside the
    // joined shape, are hidden by these strips, one per side, 2px wide, on the neighbour's side of the edge.
    const strip = (from, to, out) => `M${from[0]} ${from[1]}L${to[0]} ${to[1]}L${to[0] + out[0] * 2} ${to[1] + out[1] * 2}L${from[0] + out[0] * 2} ${from[1] + out[1] * 2}Z`;
    const hidden = strip(c, p1, [-v[0], -v[1]]) + strip(c, p2, [-u[0], -u[1]]);
    return { shape: `M${c[0]} ${c[1]}L${p1[0]} ${p1[1]}A${f} ${f} 0 0 ${sweep} ${p2[0]} ${p2[1]}Z`, arc, hidden };
  }

  /** Fill plus a 1px rim inside the edge, for the bubble and (optionally) the dock's pill, as one contour. */
  function groupImage(W, H, bubble, dock, { fill: FILL_COLOR = FILL, rim: RIM_COLOR = RIM } = {}) {
    const a = `<path d="${bubblePath(bubble.w, bubble.h)}" transform="translate(${bubble.x} ${bubble.y})"`;
    let defs = '<linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".045"/><stop offset=".4" stop-color="#fff" stop-opacity="0"/></linearGradient>';
    let body = `${a} fill="${FILL_COLOR}"/>${a} fill="url(#g)"/>`;
    let clip = `${a}/>`;
    const stroke = `fill="none" stroke="${RIM_COLOR}" stroke-width="2" stroke-linejoin="round"`;
    let rim = `${a} ${stroke}/>`;
    if (dock) {
      // The dock's pill hangs off the bubble's lower right: flush with its right edge (which then runs straight down
      // into it) and reaching up to where the corner starts, so the corner is absorbed and no seam is left.
      const bodyBottom = bubble.y + bubble.h - TAIL;
      const r = Math.min(RADIUS, bubble.w / 2, (bubble.h - TAIL) / 2);
      const top = bodyBottom - r;
      const right = bubble.x + bubble.w;
      const bottom = dock.y + dock.h;
      const round = Math.min(dock.h / 2, 14);
      const f = 8; // radius of the curve where pill and bubble meet
      let left = right - dock.w;
      const ears = [];
      let tl = 0;
      if (left >= bubble.x + r + f) {
        ears.push(fillet([left, bodyBottom], [-1, 0], [0, 1], f)); // the pill starts under the bubble's bottom edge
      } else if (left >= bubble.x - 0.5) {
        left = bubble.x; // about as wide as the bubble: flush with it on the left too
      } else {
        tl = round; // wider than the bubble: it sticks out to the left, and meets the bubble's left edge above itself
        ears.push(fillet([bubble.x, top], [0, -1], [-1, 0], f));
      }
      const b = `<path d="${roundedRect(left, top, right - left, bottom - top, [tl, 0, round, round])}"`;
      const shapes = ears.map((ear) => `<path d="${ear.shape}"/><path d="${ear.hidden}"/>`).join('');
      // Each rim is hidden where it lies inside the other shape (or a fillet), so only the outside of the union keeps one.
      const hide = (paths) => `<mask maskUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}" id="MASK"><rect width="${W}" height="${H}" fill="#fff"/><g fill="#000">${paths}</g></mask>`;
      // The pill's rim is hidden inside the bubble, but not within 2px of the pill's own sides: where a side runs along
      // the bubble's edge or its corner, the bubble's shape would otherwise swallow the pill's rim there, leaving a gap.
      // The bubble's rim carries on 1px into the pill's side and the pill's takes over there, so they meet without a tick.
      const flush = [right, ...(left === bubble.x ? [left] : [])];
      const lower = flush.map((x) => `<rect x="${x - 2}" y="${top + 1}" width="4" height="${bottom - top}" fill="#fff"/>`).join('');
      const upper = flush.map((x) => `<rect x="${x - 2}" y="${top - 2}" width="4" height="3" fill="#fff"/>`).join('');
      defs += hide(`${b}/>${shapes}`).replace('</g></mask>', `</g>${upper}</mask>`).replace('MASK', 'nb') + hide(`${a}/>${shapes}`).replace('</g></mask>', `</g>${lower}</mask>`).replace('MASK', 'na');
      body += `${b} fill="${FILL_COLOR}"/>${shapes.replaceAll('<path', `<path fill="${FILL_COLOR}"`)}`;
      clip += `${b}/>${shapes}`;
      // (The bubble's stroke sits in a group of its own: a mask is placed by the coordinates of the element it is on,
      // and the bubble path carries a translate.)
      rim = `<g mask="url(#nb)">${a} ${stroke}/></g>${b} ${stroke} mask="url(#na)"/>${ears.map((ear) => `<path d="${ear.arc}" ${stroke}/>`).join('')}`;
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}"><defs><clipPath id="u">${clip}</clipPath>${defs}</defs><g clip-path="url(#u)">${body}${rim}</g></svg>`;
  }

  /** A Manage Chats card is a bubble on its own: same outline, its colours from the card's --card-fill and --card-rim. */
  function paintCard(card) {
    if (!card.offsetWidth) return;
    const style = getComputedStyle(card);
    const image = groupImage(card.offsetWidth, card.offsetHeight, { x: 0, y: 0, w: card.offsetWidth, h: card.offsetHeight }, null, {
      fill: style.getPropertyValue('--card-fill').trim() || FILL,
      rim: style.getPropertyValue('--card-rim').trim() || RIM,
    });
    card.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(image)}")`;
    card.classList.add('has-shape');
  }

  function paint(group) {
    if (group.classList.contains('history-card')) { paintCard(group); return; }
    const bubble = group.querySelector('.msg-user');
    if (!bubble || !bubble.offsetWidth) return;
    const dockEl = group.querySelector('.msg-actions');
    const open = dockEl && group.matches(':hover, :focus-within');
    const image = groupImage(
      group.offsetWidth,
      group.offsetHeight,
      { x: bubble.offsetLeft, y: bubble.offsetTop, w: bubble.offsetWidth, h: bubble.offsetHeight },
      open ? { x: dockEl.offsetLeft, y: dockEl.offsetTop, w: dockEl.offsetWidth, h: dockEl.offsetHeight } : null,
    );
    group.style.backgroundImage = `url("data:image/svg+xml,${encodeURIComponent(image)}")`;
    group.classList.add('has-shape');
  }

  const sizes = new ResizeObserver((entries) => entries.forEach((entry) => paint(entry.target)));
  const watch = (root) => {
    if (root.nodeType !== 1) return;
    const groups = root.matches('.msg-group-user') ? [root] : [];
    groups.push(...(root.querySelectorAll?.('.msg-group-user') || []));
    for (const group of groups) {
      sizes.observe(group);
      for (const type of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) group.addEventListener(type, () => paint(group));
    }
  };
  // The cards of the Manage Chats list are made by main.js, outside the transcript: it hands each one over.
  window.shapeBubbleCard = (card) => sizes.observe(card);
  window.bubbleOutline = bubblePath; // the rail's hover preview draws the same outline at its own width
  const transcript = document.getElementById('transcript');
  if (!transcript) return;
  watch(transcript);
  new MutationObserver((records) => records.forEach((record) => record.addedNodes.forEach(watch))).observe(transcript, { childList: true, subtree: true });
})();
