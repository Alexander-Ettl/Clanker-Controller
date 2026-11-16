/* Image markup editor: draw, highlight, type and erase on a staged image. The marks stay vectors (so the editor can
   reopen them) and are flattened onto a copy at the image's own size. The original image is never changed; the host
   keeps it next to the copy and tells the agents where the marks are (lib/markup.js). */
(() => {
  const COLORS = [['#ff3b30', 'Red'], ['#ffd60a', 'Yellow'], ['#30d158', 'Green'], ['#0a84ff', 'Blue'], ['#ffffff', 'White'], ['#000000', 'Black']];
  const THICKNESS = [['Thin', 0.6], ['Medium', 1], ['Thick', 1.8]];
  const MAX_EXPORT_EDGE = 4000, MAX_HISTORY = 60;
  const icon = (paths) => `<svg viewBox="0 0 16 16" fill="none" aria-hidden="true">${paths}</svg>`;
  const stroke = 'stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"';
  const ICONS = {
    pen: icon(`<path d="M10.5 3.5l2 2M3 13l.7-2.8 7-7 2.1 2.1-7 7L3 13z" ${stroke}/>`),
    highlight: icon(`<path d="M6 10.5l4.5-4.5 2 2L8 12.5 5.5 13 6 10.5zM9 7.5l2 2M3 14h5" ${stroke}/>`),
    text: icon(`<path d="M3.5 4.5v-1h9v1M8 3.5v9M6 12.5h4" ${stroke}/>`),
    erase: icon(`<path d="M9.5 3.5l3 3-5.2 5.5H4.8L3 10.2 9.5 3.5zM7.3 12H13M5.5 7.5l3 3" ${stroke}/>`),
    undo: icon(`<path d="M5.5 4L3 6.5 5.5 9M3.5 6.5h5.8a3.2 3.2 0 010 6.4H7" ${stroke}/>`),
    clear: icon(`<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.5 8h5l.5-8" ${stroke}/>`),
  };
  const el = (tag, cls, text) => { const node = document.createElement(tag); if (cls) node.className = cls; if (text != null) node.textContent = text; return node; };
  const button = (cls, label, html, text) => {
    const node = el('button', cls, text); node.type = 'button'; node.title = label; node.setAttribute('aria-label', label);
    if (html) node.innerHTML = html;
    return node;
  };
  const FONT = (size) => `600 ${size}px ui-sans-serif, system-ui, "Segoe UI", sans-serif`;
  const luminance = (hex) => (parseInt(hex.slice(1, 3), 16) * 0.299 + parseInt(hex.slice(3, 5), 16) * 0.587 + parseInt(hex.slice(5, 7), 16) * 0.114) / 255;

  function drawItem(ctx, item) {
    ctx.save();
    if (item.kind === 'text') {
      ctx.font = FONT(item.size); ctx.textBaseline = 'top'; ctx.lineJoin = 'round';
      ctx.lineWidth = Math.max(2, item.size / 5); ctx.strokeStyle = luminance(item.color) > 0.55 ? '#000000' : '#ffffff'; ctx.globalAlpha = 0.9;
      ctx.strokeText(item.text, item.x, item.y);
      ctx.globalAlpha = 1; ctx.fillStyle = item.color; ctx.fillText(item.text, item.x, item.y);
    } else {
      ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.lineWidth = item.size; ctx.strokeStyle = ctx.fillStyle = item.color;
      if (item.kind === 'highlight') ctx.globalAlpha = 0.4;
      const p = item.points;
      if (p.length === 1) { ctx.beginPath(); ctx.arc(p[0][0], p[0][1], item.size / 2, 0, Math.PI * 2); ctx.fill(); }
      else {
        ctx.beginPath(); ctx.moveTo(p[0][0], p[0][1]);
        for (let i = 1; i < p.length - 1; i++) ctx.quadraticCurveTo(p[i][0], p[i][1], (p[i][0] + p[i + 1][0]) / 2, (p[i][1] + p[i + 1][1]) / 2);
        ctx.lineTo(p.at(-1)[0], p.at(-1)[1]); ctx.stroke();
      }
    }
    ctx.restore();
  }
  const segmentDistance = (p, a, b) => {
    const dx = b[0] - a[0], dy = b[1] - a[1], len = dx * dx + dy * dy;
    const t = len ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len)) : 0;
    return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
  };
  function hits(ctx, item, point, radius) {
    if (item.kind === 'text') {
      ctx.save(); ctx.font = FONT(item.size); const width = ctx.measureText(item.text).width; ctx.restore();
      return point[0] >= item.x - radius && point[0] <= item.x + width + radius && point[1] >= item.y - radius && point[1] <= item.y + item.size * 1.2 + radius;
    }
    const reach = radius + item.size / 2, p = item.points;
    if (p.length === 1) return Math.hypot(point[0] - p[0][0], point[1] - p[0][1]) <= reach;
    return p.slice(1).some((q, i) => segmentDistance(point, p[i], q) <= reach);
  }

  /**
   * options: { src, name, items, width?, height?, onDone({ dataUrl, markup }), onCancel }
   * `items` are the marks from an earlier session (same coordinates as the image's own pixels). Done with no marks
   * returns { dataUrl: null } so the caller can put the original back.
   */
  async function open({ src, name = 'image', items = [], onDone, onCancel }) {
    const previousFocus = document.activeElement;
    const root = el('div', 'markup-editor'); root.setAttribute('role', 'dialog'); root.setAttribute('aria-modal', 'true'); root.setAttribute('aria-label', `Mark up ${name}`);
    const bar = el('div', 'markup-bar glass'); bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', 'Markup tools');
    const stageWrap = el('div', 'markup-stage-wrap'), stage = el('div', 'markup-stage'), hint = el('div', 'markup-hint');
    const image = el('img'); image.alt = ''; image.draggable = false;
    const canvas = el('canvas'); canvas.setAttribute('aria-label', 'Drawing area');
    stage.append(image, canvas); stageWrap.append(stage); root.append(bar, stageWrap, hint);

    let blobUrl = null, bitmap = null, closed = false;
    try {
      const blob = await (await fetch(src)).blob();
      blobUrl = URL.createObjectURL(blob);
      image.src = blobUrl;
      await image.decode();
      bitmap = image;
    } catch { if (blobUrl) URL.revokeObjectURL(blobUrl); onCancel?.('This image could not be opened for markup.'); return null; }
    const W = image.naturalWidth, H = image.naturalHeight, base = Math.max(2, Math.round(Math.max(W, H) / 220));
    canvas.width = W; canvas.height = H; image.src = blobUrl;
    stage.style.aspectRatio = `${W} / ${H}`; stage.style.setProperty('--ar', String(W / H));
    const ctx = canvas.getContext('2d');

    let marks = items.filter(i => i && (i.kind === 'text' ? i.text : i.points?.length)).map(i => JSON.parse(JSON.stringify(i)));
    const history = []; let saved = JSON.stringify(marks);
    let tool = 'pen', color = COLORS[0][0], thick = 1, discardArmed = 0, active = null, draft = null;

    const redraw = () => { ctx.clearRect(0, 0, W, H); for (const m of marks) drawItem(ctx, m); if (active) drawItem(ctx, active); };
    let frame = 0; const schedule = () => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; redraw(); }); };
    const remember = () => { history.push(JSON.stringify(marks)); if (history.length > MAX_HISTORY) history.shift(); sync(); };

    // ---------- toolbar ----------
    const toolButtons = {};
    const group = (label) => { const g = el('div', 'markup-group'); g.setAttribute('role', 'group'); g.setAttribute('aria-label', label); return g; };
    const tools = group('Tool');
    for (const [id, label] of [['pen', 'Pen'], ['highlight', 'Highlighter'], ['text', 'Type text'], ['erase', 'Eraser']]) {
      const b = button('markup-tool', label, ICONS[id]); b.dataset.tool = id; toolButtons[id] = b;
      b.addEventListener('click', () => { commitText(); tool = id; sync(); }); tools.append(b);
    }
    const colors = group('Colour'), swatches = [];
    for (const [hex, label] of COLORS) {
      const b = button('markup-swatch', label); b.style.setProperty('--swatch', hex); b.dataset.color = hex;
      b.addEventListener('click', () => { color = hex; if (tool === 'erase') tool = 'pen'; if (draft) draft.input.style.color = hex; sync(); }); swatches.push(b); colors.append(b);
    }
    const sizes = group('Thickness'), sizeButtons = [];
    for (const [label, value] of THICKNESS) {
      const b = button('markup-size', label); b.dataset.size = String(value); b.style.setProperty('--dot', `${4 + value * 4}px`);
      b.addEventListener('click', () => { thick = value; sync(); }); sizeButtons.push(b); sizes.append(b);
    }
    const history2 = group('History');
    const undo = button('markup-act', 'Undo (Ctrl+Z)', ICONS.undo), clear = button('markup-act', 'Remove all marks', ICONS.clear);
    history2.append(undo, clear);
    const finish = group('Finish');
    const cancel = button('markup-cancel', 'Discard markup', '', 'Cancel'), done = button('markup-done', 'Save markup', '', 'Done');
    finish.append(cancel, done);
    bar.append(tools, colors, sizes, history2, finish);

    function sync() {
      for (const [id, b] of Object.entries(toolButtons)) b.setAttribute('aria-pressed', String(id === tool));
      swatches.forEach(b => b.setAttribute('aria-pressed', String(b.dataset.color === color)));
      sizeButtons.forEach(b => b.setAttribute('aria-pressed', String(Number(b.dataset.size) === thick)));
      undo.disabled = !history.length; clear.disabled = !marks.length;
      canvas.dataset.tool = tool;
      hint.textContent = discardArmed ? 'Press Esc again to discard your marks.' : tool === 'text' ? 'Click where the text goes, type, then press Enter.' : tool === 'erase' ? 'Drag over a mark to remove it.'
        : `${marks.length ? `${marks.length} ${marks.length === 1 ? 'mark' : 'marks'}. ` : ''}Your original image is kept; the agents also see where you marked.`;
    }
    undo.addEventListener('click', () => { commitText(); const previous = history.pop(); if (previous) { marks = JSON.parse(previous); redraw(); } sync(); });
    clear.addEventListener('click', () => { commitText(); if (!marks.length) return; remember(); marks = []; redraw(); sync(); });

    // ---------- pointer ----------
    const pointOf = (event) => { const r = canvas.getBoundingClientRect(); return [(event.clientX - r.left) * W / r.width, (event.clientY - r.top) * H / r.height]; };
    const displayScale = () => canvas.getBoundingClientRect().width / W;
    function commitText() {
      if (!draft) return;
      const { input, at, size, color: hex } = draft; draft = null;
      const text = input.value.replace(/\s+/g, ' ').trim(); input.remove();
      if (text) { remember(); marks.push({ kind: 'text', color: hex, size, x: at[0], y: at[1], text }); redraw(); sync(); }
    }
    function startText(point) {
      const size = Math.round(Math.max(W, H) / 30 * thick), input = el('input', 'markup-text'); input.type = 'text'; input.maxLength = 200; input.setAttribute('aria-label', 'Text on the image');
      const scale = displayScale();
      Object.assign(input.style, { left: `${point[0] * scale}px`, top: `${point[1] * scale}px`, fontSize: `${size * scale}px`, color });
      stage.append(input);
      draft = { input, at: point, size, color };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') { e.preventDefault(); commitText(); }
        if (e.key === 'Escape') { e.preventDefault(); draft = null; input.remove(); }
      });
      input.addEventListener('blur', () => { if (draft?.input === input) commitText(); });
      setTimeout(() => input.focus(), 0);
    }
    function erase(point) {
      const radius = base * 2.5, left = marks.filter(m => !hits(ctx, m, point, radius));
      if (left.length === marks.length) return;
      if (!active.remembered) { remember(); active.remembered = true; } // one undo step per drag
      marks = left; redraw(); sync();
    }
    canvas.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      event.preventDefault(); discardArmed = 0; canvas.setPointerCapture(event.pointerId);
      const point = pointOf(event);
      if (tool === 'text') { commitText(); startText(point); return; }
      commitText();
      if (tool === 'erase') { active = { erasing: true, kind: 'erase', remembered: false }; erase(point); return; }
      active = { kind: tool, color, size: Math.max(1, Math.round(base * thick * (tool === 'highlight' ? 5 : 1))), points: [point] };
      schedule();
    });
    canvas.addEventListener('pointermove', (event) => {
      if (!active) return;
      const point = pointOf(event);
      if (active.erasing) return erase(point);
      const last = active.points.at(-1);
      if (Math.hypot(point[0] - last[0], point[1] - last[1]) < Math.max(1, base / 3)) return;
      active.points.push(point); schedule();
    });
    const lift = () => {
      if (!active) return;
      if (!active.erasing) { remember(); marks.push({ ...active, points: active.points.map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]) }); }
      active = null; redraw(); sync();
    };
    canvas.addEventListener('pointerup', lift); canvas.addEventListener('pointercancel', lift);

    // ---------- finish ----------
    function exportPng() {
      commitText();
      const k = Math.min(1, MAX_EXPORT_EDGE / Math.max(W, H)), out = document.createElement('canvas');
      out.width = Math.round(W * k); out.height = Math.round(H * k);
      const c = out.getContext('2d'); c.imageSmoothingQuality = 'high'; c.drawImage(bitmap, 0, 0, out.width, out.height); c.scale(k, k);
      for (const m of marks) drawItem(c, m);
      return out.toDataURL('image/png');
    }
    const close = () => {
      if (closed) return; closed = true; cancelAnimationFrame(frame);
      document.removeEventListener('keydown', onKey, true); bitmap.close?.(); if (blobUrl) URL.revokeObjectURL(blobUrl);
      root.classList.remove('is-open'); setTimeout(() => root.remove(), 220); previousFocus?.focus?.({ preventScroll: true });
    };
    const leave = () => { commitText(); close(); onCancel?.(); };
    cancel.addEventListener('click', () => leave());
    done.addEventListener('click', () => {
      commitText();
      const markup = { width: W, height: H, items: marks };
      const dataUrl = marks.length ? exportPng() : null;
      close(); onDone?.({ dataUrl, markup });
    });
    function onKey(event) {
      if (event.key === 'Escape') {
        event.preventDefault(); event.stopPropagation();
        if (draft) { draft.input.remove(); draft = null; return; }
        if (JSON.stringify(marks) !== saved && !discardArmed) { discardArmed = 1; sync(); setTimeout(() => { discardArmed = 0; if (!closed) sync(); }, 3000); return; }
        leave();
      } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z' && !draft) { event.preventDefault(); undo.click(); }
      else if (event.key === 'Tab') {
        const list = [...root.querySelectorAll('button:not(:disabled)')], firstButton = list[0], last = list.at(-1);
        if (event.shiftKey && document.activeElement === firstButton) { event.preventDefault(); last.focus(); }
        else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); firstButton.focus(); }
      }
    }
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(root);
    redraw(); sync();
    requestAnimationFrame(() => { if (!closed) { root.classList.add('is-open'); toolButtons.pen.focus({ preventScroll: true }); } });
    return { close };
  }

  window.attachmentMarkup = { open, drawItem };
})();
