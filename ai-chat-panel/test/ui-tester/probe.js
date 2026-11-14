'use strict';

// Runs INSIDE the page (Playwright serialises `probe` with toString), so it must stay self-contained.
// It measures geometry only, costs no model tokens, and returns plain findings:
//   { kind, severity: 'error' | 'warn' | 'info', selector, text, rect, other? }
// Kinds: page-overflow, clipped-text, overlap, covered-control, offscreen, unnamed-control, tiny-target.
// Intentional overlays (absolute or fixed badges, menus, popups) are not reported as overlaps: overlap is only
// judged between in-flow siblings and between two interactive controls.
function probe(options) {
  const MAX = (options && options.max) || 40;
  const INTERACTIVE = 'button, a[href], input:not([type=hidden]), select, textarea, summary, [role=button], [role=tab], [role=menuitem], [role=option], [tabindex]:not([tabindex="-1"])';
  const found = [];
  // With a popup open, only the popup is judged: the page behind it is covered on purpose.
  const scope = (options && options.scope && document.querySelector(options.scope)) || document.body;
  const rectOf = el => { const r = el.getBoundingClientRect(); return { x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) }; };
  const visible = el => {
    const style = getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
    const r = el.getBoundingClientRect();
    if (r.width < 1 || r.height < 1) return false;
    // Closed <details> keep their content laid out but not rendered; only the summary shows.
    for (let node = el; node && node !== document.documentElement; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (s.display === 'none' || s.visibility === 'hidden' || Number(s.opacity) === 0 || node.hidden) return false;
      if (node !== el && node.matches('details:not([open])') && !node.querySelector(':scope > summary')?.contains(el)) return false;
    }
    return true;
  };
  const selectorOf = el => {
    const parts = [];
    for (let node = el; node && node.nodeType === 1 && parts.length < 4; node = node.parentElement) {
      let part = node.tagName.toLowerCase();
      if (node.id) { parts.unshift(`${part}#${node.id}`); break; }
      const classes = [...node.classList].filter(name => !/^(is-|has-|active|open|show)/.test(name)).slice(0, 2);
      if (classes.length) part += '.' + classes.join('.');
      const same = node.parentElement ? [...node.parentElement.children].filter(child => child.tagName === node.tagName) : [];
      if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      parts.unshift(part);
    }
    return parts.join(' > ');
  };
  const label = el => (el.getAttribute('aria-label') || el.innerText || el.value || el.placeholder || el.title || el.alt || '').replace(/\s+/g, ' ').trim().slice(0, 48);
  const add = (kind, severity, el, extra) => { if (found.length < MAX * 3) found.push({ kind, severity, selector: selectorOf(el), text: label(el), rect: rectOf(el), ...extra }); };
  const scrollParent = el => {
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (/(auto|scroll)/.test(s.overflowX + s.overflowY) && (node.scrollWidth > node.clientWidth || node.scrollHeight > node.clientHeight)) return node;
    }
    return null;
  };
  const clippedBy = el => {
    // An ancestor that clips (overflow hidden/clip) and does not contain the element's box.
    const box = el.getBoundingClientRect();
    for (let node = el.parentElement; node && node !== document.documentElement; node = node.parentElement) {
      const s = getComputedStyle(node);
      if (!/(hidden|clip)/.test(s.overflowX + s.overflowY)) continue;
      const b = node.getBoundingClientRect();
      const partlyOut = (box.left < b.left - 1 && box.right > b.left + 1) || (box.right > b.right + 1 && box.left < b.right - 1);
      if (b.width && partlyOut) return node;
    }
    return null;
  };

  const root = document.documentElement;
  if (root.scrollWidth > innerWidth + 1) add('page-overflow', 'error', document.body, { detail: `document is ${root.scrollWidth}px wide in a ${innerWidth}px window` });

  const controls = [...scope.querySelectorAll(INTERACTIVE)].filter(visible);
  for (const el of controls) {
    const r = el.getBoundingClientRect();
    if (!label(el) && !el.getAttribute('aria-labelledby') && !(el.labels && el.labels.length)) add('unnamed-control', 'warn', el);
    if ((r.width < 16 || r.height < 16) && !el.matches('input[type=checkbox], input[type=radio], input[type=range]')) add('tiny-target', 'info', el, { detail: `${Math.round(r.width)}x${Math.round(r.height)}px` });
    const parent = scrollParent(el);
    if ((r.right > innerWidth + 1 || r.left < -1) && !parent) add('offscreen', 'error', el, { detail: `spans ${Math.round(r.left)}..${Math.round(r.right)}px in a ${innerWidth}px window` });
    const cutter = clippedBy(el);
    if (cutter && !parent) add('offscreen', 'error', el, { detail: `cut off by ${selectorOf(cutter)}` });
    // Covered: the topmost thing at the control's centre must be the control, something inside it, or its label.
    if (r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth) {
      const top = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      if (top && top !== el && !el.contains(top) && !top.contains(el) && !(el.labels && [...el.labels].some(l => l === top || l.contains(top)))) {
        add('covered-control', 'error', el, { detail: `covered by ${selectorOf(top)}`, other: selectorOf(top) });
      }
    }
  }

  // Text that does not fit its own box.
  for (const el of scope.querySelectorAll('*')) {
    if (!el.childNodes.length || ![...el.childNodes].some(n => n.nodeType === 3 && n.textContent.trim())) continue;
    const s = getComputedStyle(el);
    if (!visible(el) || s.textOverflow === 'ellipsis' || s.webkitLineClamp !== 'none' && s.webkitLineClamp) continue;
    if (/(hidden|clip)/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 1) add('clipped-text', 'warn', el, { detail: `text needs ${el.scrollWidth}px, box is ${el.clientWidth}px` });
    else if (/(hidden|clip)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 2 && s.height !== 'auto') add('clipped-text', 'warn', el, { detail: `text needs ${el.scrollHeight}px, box is ${el.clientHeight}px` });
  }

  // Overlap: in-flow siblings, and any two interactive controls that are not nested.
  const flow = el => { const p = getComputedStyle(el).position; return p !== 'absolute' && p !== 'fixed'; };
  const area = r => Math.max(0, r.width) * Math.max(0, r.height);
  const common = (a, b) => {
    const w = Math.min(a.right, b.right) - Math.max(a.left, b.left), h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
    return w > 0 && h > 0 ? w * h : 0;
  };
  const seen = new Set();
  const compare = (a, b) => {
    if (a === b || a.contains(b) || b.contains(a)) return;
    const key = selectorOf(a) + '|' + selectorOf(b); if (seen.has(key)) return; seen.add(key);
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const shared = common(ra, rb), smaller = Math.min(area(ra), area(rb));
    if (shared > 16 && shared / smaller > 0.15) add('overlap', 'error', a, { detail: `overlaps ${selectorOf(b)} by ${Math.round(shared / smaller * 100)}%`, other: selectorOf(b) });
  };
  for (const parent of [scope, ...scope.querySelectorAll('*')]) {
    if (parent.closest('svg')) continue; // icon internals are drawn on top of each other on purpose
    const kids = [...parent.children].filter(child => flow(child) && visible(child) && !/^(script|style|br)$/i.test(child.tagName));
    if (kids.length < 2 || kids.length > 60) continue;
    for (let i = 0; i < kids.length; i++) for (let j = i + 1; j < kids.length; j++) compare(kids[i], kids[j]);
  }
  for (let i = 0; i < controls.length; i++) for (let j = i + 1; j < Math.min(controls.length, i + 40); j++) compare(controls[i], controls[j]);

  // Most severe first, capped.
  const order = { error: 0, warn: 1, info: 2 };
  return found.sort((a, b) => order[a.severity] - order[b.severity]).slice(0, MAX);
}

module.exports = { probe };
