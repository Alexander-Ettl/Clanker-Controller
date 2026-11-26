/* Find in chat: Ctrl+F (or the magnifier button) opens a small bar over the transcript; typing jumps to the nearest match,
   Enter / Down goes to the next one, Shift+Enter / Up to the previous one, Esc closes. Like a PDF viewer's find, but the
   conversation is paged: the host counts matches in the whole stored chat (lib/chat-find.js), the window counts the turns
   it already shows, and a match in history that was never loaded is fetched in one request from that turn on.

   Built to stay cheap while you jump around:
   - Nothing is re-rendered. Matches are painted with the CSS Custom Highlight API (ranges over the existing text nodes).
   - Each turn's searchable text is built once and cached; only turns that change (a streaming reply, a code block the
     highlighter re-renders) are read again, found by a MutationObserver that runs only while the bar is open.
   - Only the current match and the turns around the viewport are painted, on the next animation frame after a scroll.
   - Typing answers from the loaded turns at once; the host's count for older history follows a moment later. */
(function () {
  'use strict';

  const BLOCK = 'p, li, div, pre, h1, h2, h3, h4, h5, h6, td, th, blockquote, tr, dt, dd, summary';
  // Chrome inside a message that is not its text: buttons, icons, KaTeX's hidden source, steps and thoughts.
  const SKIP = 'button, svg, .katex-mathml, [aria-hidden="true"], .tool-card, .thought-fold, .work-summary, .msg-actions, .code-head, .code-copy';
  const space = (c) => c === ' ' || c === '\n' || c === '\t' || c === '\r' || c === '\u00a0' || c === '\f' || c === '\v';
  const normalize = (text) => String(text).toLowerCase().replace(/\s+/g, ' ');

  function createChatFind(api) {
    const { transcript } = api;
    const highlights = typeof CSS !== 'undefined' && CSS.highlights && typeof Highlight === 'function' ? CSS.highlights : null;

    const bar = document.createElement('div');
    bar.className = 'chat-find';
    bar.setAttribute('role', 'search');
    bar.hidden = true;
    bar.innerHTML = `
      <svg class="chat-find-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/></svg>
      <input class="chat-find-input" type="text" placeholder="Find in chat" aria-label="Find in chat" spellcheck="false" autocomplete="off">
      <span class="chat-find-count" aria-live="polite"></span>
      <button class="chat-find-btn" type="button" data-find="prev" title="Previous match (Shift+Enter)" aria-label="Previous match"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 10 4-4 4 4"/></svg></button>
      <button class="chat-find-btn" type="button" data-find="next" title="Next match (Enter)" aria-label="Next match"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button>
      <button class="chat-find-btn" type="button" data-find="close" title="Close (Esc)" aria-label="Close find"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="m4.5 4.5 7 7m0-7-7 7"/></svg></button>`;
    document.body.appendChild(bar);
    const input = bar.querySelector('.chat-find-input');
    const counter = bar.querySelector('.chat-find-count');

    let needle = '';
    let generation = 0; // bumps on every new query; stale host answers and loads are dropped
    let hostTurns = new Map(); // turn -> count in the stored chat (only used for turns the window has not loaded)
    let hostPending = false;
    let hits = []; // [{ turn, k }], oldest first
    let hitTurns = new Set(); // turn indices that currently have matches (rebuilt in refresh)
    let current = -1;
    let loading = false;
    let jumpUntil = 0; // suppresses scroll-triggered gap loads while reveal() is jumping across the transcript
    let turnMap = null; // turn -> .turn element, rebuilt when the transcript changes
    const texts = new WeakMap(); // .turn element -> { text, map }
    let restoreFocus = null;

    const turns = () => {
      if (turnMap) return turnMap;
      turnMap = new Map();
      for (const group of transcript.querySelectorAll('.msg-group-user[data-user-index]')) {
        const turn = group.closest('.turn');
        if (turn) turnMap.set(Number(group.dataset.userIndex), turn);
      }
      return turnMap;
    };

    /** The turn's visible message text, lower case with whitespace collapsed, and where each character came from. */
    function textOf(turnEl) {
      const cached = texts.get(turnEl);
      if (cached) return cached;
      let text = '', pendingSpace = false, lastBlock = null;
      const map = [];
      for (const root of turnEl.querySelectorAll('.msg-user-text, .msg-assistant .msg-body')) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (node) => node.parentElement?.closest(SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
          const block = node.parentElement.closest(BLOCK) || root;
          if (block !== lastBlock) { pendingSpace = true; lastBlock = block; }
          const data = node.data;
          for (let i = 0; i < data.length; i++) {
            const c = data[i];
            if (space(c)) { pendingSpace = true; continue; }
            if (pendingSpace && text) { text += ' '; map.push(node, i); }
            pendingSpace = false;
            const lower = c.toLowerCase();
            text += lower.length === 1 ? lower : c;
            map.push(node, i);
          }
        }
      }
      const entry = { text, map };
      texts.set(turnEl, entry);
      return entry;
    }

    function countIn(text) {
      let count = 0;
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
      return count;
    }

    /** Every match in one turn as a Range, in order. */
    function rangesIn(turnEl) {
      const { text, map } = textOf(turnEl);
      const ranges = [];
      for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) {
        const end = at + needle.length - 1;
        try {
          const range = document.createRange();
          range.setStart(map[at * 2], map[at * 2 + 1]);
          range.setEnd(map[end * 2], map[end * 2 + 1] + 1);
          ranges.push(range);
        } catch { /* the text changed under the cache; the observer rebuilds it */ }
      }
      return ranges;
    }

    function rebuildHits() {
      const loaded = turns();
      const counts = new Map();
      for (const [turn, el] of loaded) { const n = countIn(textOf(el).text); if (n) counts.set(turn, n); }
      for (const [turn, n] of hostTurns) if (!loaded.has(turn)) counts.set(turn, n);
      const list = [];
      for (const turn of [...counts.keys()].sort((a, b) => a - b)) for (let k = 0; k < counts.get(turn); k++) list.push({ turn, k });
      return list;
    }

    /** The turn in the middle of what you are looking at: where a new search starts from. */
    function viewTurn() {
      const box = transcript.getBoundingClientRect();
      const middle = box.top + box.height / 2;
      let best = -1;
      for (const [turn, el] of turns()) { if (el.getBoundingClientRect().top <= middle) best = Math.max(best, turn); }
      return best;
    }

    function renderCount() {
      const empty = !needle.trim();
      bar.classList.toggle('is-empty', !empty && !hits.length && !hostPending);
      counter.textContent = empty ? '' : loading ? '…' : hits.length ? `${current + 1} of ${hits.length}${hostPending ? '+' : ''}` : hostPending ? '…' : 'No results';
      for (const button of bar.querySelectorAll('[data-find="prev"], [data-find="next"]')) button.disabled = !hits.length;
    }

    /** Re-reads the matches; keeps the current one if it still exists, else picks the nearest to `anchor`. */
    function refresh({ jump = false, anchor = null } = {}) {
      const previous = hits[current];
      hits = needle.trim() ? rebuildHits() : [];
      hitTurns = new Set(hits.map((hit) => hit.turn));
      current = previous ? hits.findIndex((hit) => hit.turn === previous.turn && hit.k === previous.k) : -1;
      if (current === -1 && hits.length) {
        const from = anchor ?? previous?.turn ?? viewTurn();
        const after = hits.findIndex((hit) => hit.turn >= from);
        // At the bottom of the chat nothing comes after: the nearest match is the latest one above.
        current = after === -1 ? hits.length - 1 : hits[after].turn === from ? after : Math.max(0, after - 1);
        jump = true;
      }
      renderCount();
      if (jump && current >= 0) void show(current);
      else paint();
    }

    function search(value) {
      needle = normalize(value);
      generation++;
      hostTurns = new Map();
      hostPending = Boolean(needle.trim());
      const anchor = hits[current]?.turn ?? null;
      hits = []; hitTurns = new Set(); current = -1;
      if (hostPending) api.post({ type: 'findInChat', query: value, requestId: generation });
      refresh({ jump: true, anchor });
    }

    /** The host's count for the whole stored chat. */
    function onResults(message) {
      if (message.requestId !== generation || bar.hidden) return;
      hostTurns = new Map(Array.isArray(message.turns) ? message.turns : []);
      hostPending = false;
      refresh();
    }

    async function show(index) {
      let hit = hits[index];
      if (!hit) return;
      const same = (other) => other && other.turn === hit.turn && other.k === hit.k;
      const ticket = generation;
      let turnEl = turns().get(hit.turn);
      if (!turnEl) {
        loading = true; renderCount();
        api.releaseStick();
        await api.loadFromTurn(hit.turn);
        loading = false;
        if (ticket !== generation || !same(hits[current])) { renderCount(); return; }
        turnMap = null;
        refresh(); // the loaded turns now count from what is on screen; may move the current match to its real place
        hit = hits[current];
        turnEl = hit && turns().get(hit.turn);
        if (!turnEl) return;
      }
      const ranges = rangesIn(turnEl);
      const range = ranges[Math.min(hit.k, ranges.length - 1)];
      const clamped = range?.startContainer.parentElement?.closest('.msg-user.is-clamped:not(.is-expanded)');
      clamped?.querySelector('.msg-clamp-toggle')?.click(); // the match is in the folded part of a long prompt
      reveal(range, turnEl);
      paint();
    }

    /** Scrolls the match to just above the middle. Turns far away have estimated heights (content-visibility), so look again next frame. */
    function reveal(range, turnEl) {
      api.releaseStick();
      const place = () => {
        let target = range ? range.getBoundingClientRect() : turnEl.getBoundingClientRect();
        let revealed = false;
        if (!target.height && !target.width) {
          // content-visibility: auto skips layout for off-screen turns; scroll the turn in first so the range has real geometry.
          jumpUntil = performance.now() + 180;
          turnEl.scrollIntoView({ block: 'center' });
          target = range ? range.getBoundingClientRect() : turnEl.getBoundingClientRect();
          revealed = true;
        }
        const box = transcript.getBoundingClientRect();
        const delta = target.top + target.height / 2 - (box.top + box.height * 0.42);
        if (Math.abs(delta) > 2) {
          jumpUntil = performance.now() + 180;
          transcript.scrollTop += delta;
        }
        return revealed ? Infinity : delta;
      };
      if (Math.abs(place()) > 2) requestAnimationFrame(() => { place(); paint(); });
    }

    let paintFrame = 0;
    function paint() {
      if (!highlights) return;
      cancelAnimationFrame(paintFrame);
      paintFrame = 0;
      if (bar.hidden || !hits.length) { highlights.delete('chat-find'); highlights.delete('chat-find-current'); return; }
      const box = transcript.getBoundingClientRect();
      const reach = box.height; // one screen above and below, so a scroll does not show unpainted matches
      const others = [];
      let currentRange = null;
      for (const [turn, el] of turns()) {
        if (!hitTurns.has(turn)) continue;
        const rect = el.getBoundingClientRect();
        const isCurrent = hits[current]?.turn === turn;
        if (!isCurrent && (rect.bottom < box.top - reach || rect.top > box.bottom + reach)) continue;
        const ranges = rangesIn(el);
        ranges.forEach((range, k) => { if (isCurrent && k === Math.min(hits[current].k, ranges.length - 1)) currentRange = range; else others.push(range); });
      }
      highlights.set('chat-find', new Highlight(...others));
      const mine = currentRange ? new Highlight(currentRange) : new Highlight();
      mine.priority = 1;
      highlights.set('chat-find-current', mine);
    }
    const schedulePaint = () => { if (!paintFrame && !bar.hidden) paintFrame = requestAnimationFrame(paint); };

    function step(delta) {
      if (!hits.length) return;
      current = current === -1 ? 0 : (current + delta + hits.length) % hits.length;
      renderCount();
      void show(current);
    }

    // Turns that change are read again; a new or removed turn rebuilds the map. Quiet while the bar is closed.
    let recountTimer = 0;
    const observer = new MutationObserver((records) => {
      let changed = false;
      let needsHost = false;
      for (const record of records) {
        if (record.target === transcript) {
          turnMap = null;
          // Only re-ask the host when a live turn is appended at the end (not when historical chunks/gaps are inserted).
          if ([...record.addedNodes].some((n) => n.nodeType === 1 && n.matches?.('.turn') && !n.nextElementSibling)) {
            changed = true;
            needsHost = true;
          }
          continue;
        }
        const node = record.target.nodeType === 1 ? record.target : record.target.parentElement;
        const turn = node?.closest?.('.turn');
        if (turn) { texts.delete(turn); changed = true; needsHost = true; }
        if (record.type === 'childList' && [...record.addedNodes, ...record.removedNodes].some((n) => n.nodeType === 1 && (n.matches?.('.turn, .msg-group-user') || n.querySelector?.('.msg-group-user')))) turnMap = null;
      }
      if (!changed || !needle.trim()) return;
      clearTimeout(recountTimer);
      recountTimer = setTimeout(() => {
        if (needsHost) api.post({ type: 'findInChat', query: input.value, requestId: generation });
        refresh();
      }, 300);
    });

    function position() {
      const box = transcript.getBoundingClientRect();
      const topbar = document.querySelector('.topbar');
      const topbarRect = topbar?.getBoundingClientRect();
      const ceiling = topbarRect && topbarRect.height > 0 ? Math.max(box.top, topbarRect.bottom) : box.top;
      bar.style.top = `${Math.round(ceiling + 8)}px`;
      bar.style.right = `${Math.round(window.innerWidth - box.right + 14)}px`;
      bar.style.maxWidth = `${Math.max(200, Math.round(box.width - 28))}px`;
    }

    function open() {
      if (bar.hidden) {
        restoreFocus = document.activeElement;
        bar.hidden = false;
        position();
        observer.observe(transcript, { childList: true, subtree: true, characterData: true });
        transcript.addEventListener('scroll', schedulePaint, { passive: true });
        if (input.value) search(input.value);
      }
      input.focus();
      input.select();
    }

    function close() {
      if (bar.hidden) return;
      bar.hidden = true;
      generation++;
      observer.disconnect();
      clearTimeout(recountTimer);
      transcript.removeEventListener('scroll', schedulePaint);
      hits = []; hitTurns = new Set(); current = -1; hostPending = false; loading = false;
      paint();
      if (restoreFocus?.isConnected) restoreFocus.focus();
    }

    /** A different chat: nothing found so far belongs to it. */
    function reset() {
      turnMap = null;
      hostTurns = new Map();
      if (!bar.hidden) { generation++; hits = []; hitTurns = new Set(); current = -1; if (input.value) search(input.value); else renderCount(); }
    }

    input.addEventListener('input', () => search(input.value));
    input.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
      else if (event.key === 'ArrowDown') { event.preventDefault(); step(1); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); step(-1); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    bar.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    });
    bar.addEventListener('mousedown', (event) => { if (event.target.closest('button')) event.preventDefault(); }); // keep the caret in the field
    bar.addEventListener('click', (event) => {
      const action = event.target.closest('[data-find]')?.dataset.find;
      if (action === 'prev') step(-1);
      else if (action === 'next') step(1);
      else if (action === 'close') close();
    });
    document.addEventListener('keydown', (event) => {
      const mod = event.ctrlKey || event.metaKey;
      if (mod && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'f') { event.preventDefault(); event.stopPropagation(); open(); }
      else if (!bar.hidden && event.key === 'F3') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
    }, true);
    window.addEventListener('resize', () => { if (!bar.hidden) position(); });

    return { open, close, reset, onResults, get isOpen() { return !bar.hidden; }, get isJumping() { return performance.now() < jumpUntil; }, get state() { return { hits: hits.length, current, pending: hostPending, loading }; } };
  }

  window.createChatFind = createChatFind;
})();
