/**
 * The Logs popup: what lib/log.js has recorded (extension errors, failed webview messages, uncaught webview errors,
 * console warnings, and at Debug level each click and message). main.js gives it a modal; the extension answers
 * `logsSubscribe` with `logEntries` and then streams `logEntry` until `logsUnsubscribe`.
 */
(function () {
  'use strict';

  const RANK = { debug: 0, info: 1, warn: 2, error: 3 };
  const FILTERS = [['error', 'Errors'], ['warn', 'Warnings'], ['info', 'Info'], ['debug', 'Debug']];
  const LIMIT = 2000;
  const svg = (paths) => `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;
  const ICON = {
    search: svg('<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3 3"/>'),
    copy: svg('<rect x="5.5" y="5.5" width="8" height="8" rx="1.6"/><path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2"/>'),
    trash: svg('<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 8.5h5.8l.6-8.5"/>'),
    output: svg('<path d="M3 4.5 6.5 8 3 11.5M8 11.5h5"/>'),
    ask: svg('<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z"/>'),
  };

  const pad = (n, width = 2) => String(n).padStart(width, '0');
  const clock = (time) => { const d = new Date(time); return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`; };
  const stamp = (time) => { const d = new Date(time); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${clock(time)}`; };
  const asText = (entry) => `${stamp(entry.time)} ${entry.level.toUpperCase()} [${entry.source}] ${entry.message}${entry.details ? `\n${entry.details}` : ''}${entry.stack ? `\n${entry.stack}` : ''}`;

  window.initLogViewer = function initLogViewer({ vscode, modal }) {
    const body = modal.body;
    body.classList.add('cs', 'lv');
    body.innerHTML = `
      <div class="lv-tools">
        <div class="lv-levels pill-track" role="radiogroup" aria-label="Lowest level shown">
          ${FILTERS.map(([level, label]) => `<button class="format-pill" role="radio" type="button" data-level="${level}" aria-checked="false">${label}</button>`).join('')}
        </div>
        <label class="cs-model-search lv-search">${ICON.search}<input type="search" placeholder="Filter…" aria-label="Filter log entries" autocomplete="off" spellcheck="false"></label>
      </div>
      <div class="lv-actions">
        <button class="cs-btn is-small" type="button" data-act="copy">${ICON.copy}<span>Copy shown</span></button>
        <button class="cs-btn is-small is-quiet" type="button" data-act="output" title="The same log in VS Code's Output panel, kept in the IDE's log folder">${ICON.output}<span>Output panel</span></button>
        <button class="cs-btn is-small is-quiet" type="button" data-act="clear">${ICON.trash}<span>Clear</span></button>
        <span class="lv-status" role="status"></span>
      </div>
      <ol class="lv-list" aria-label="Log entries"></ol>
      <p class="lv-empty" hidden></p>`;

    const list = body.querySelector('.lv-list');
    const empty = body.querySelector('.lv-empty');
    const status = body.querySelector('.lv-status');
    const search = body.querySelector('.lv-search input');
    const pills = [...body.querySelectorAll('.lv-levels [data-level]')];
    let entries = [];
    let minLevel = 'warn';
    let open = false;
    const expanded = new Set();
    let statusTimer;

    const flash = (text) => { status.textContent = text; clearTimeout(statusTimer); statusTimer = setTimeout(() => { status.textContent = ''; }, 2200); };
    const shown = () => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      return entries.filter(entry => RANK[entry.level] >= RANK[minLevel]
        && words.every(word => `${entry.source} ${entry.message} ${entry.details} ${entry.stack}`.toLowerCase().includes(word)));
    };
    const copy = async (text, done) => {
      try { await navigator.clipboard.writeText(text); flash(done); }
      catch { vscode.postMessage({ type: 'copyText', text }); flash(done); }
    };
    function updateCount() {
      const errors = entries.filter(entry => entry.level === 'error').length;
      modal.count.textContent = errors ? String(errors) : '';
      modal.count.title = errors ? `${errors} error${errors === 1 ? '' : 's'}` : '';
    }

    function row(entry) {
      const item = document.createElement('li');
      item.className = `lv-entry is-${entry.level}`;
      item.dataset.id = entry.id;
      const head = document.createElement('button');
      head.type = 'button';
      head.className = 'lv-head';
      head.setAttribute('aria-expanded', String(expanded.has(entry.id)));
      head.innerHTML = '<span class="lv-time"></span><span class="lv-level"></span><span class="lv-source"></span><span class="lv-message"></span>';
      head.querySelector('.lv-time').textContent = clock(entry.time);
      head.querySelector('.lv-time').title = stamp(entry.time);
      head.querySelector('.lv-level').textContent = entry.level;
      head.querySelector('.lv-source').textContent = entry.source;
      head.querySelector('.lv-message').textContent = entry.message || '(no message)';
      head.addEventListener('click', () => {
        if (expanded.has(entry.id)) expanded.delete(entry.id); else expanded.add(entry.id);
        item.replaceWith(row(entry));
      });
      item.append(head);
      if (expanded.has(entry.id)) {
        const detail = document.createElement('div');
        detail.className = 'lv-detail';
        const pre = document.createElement('pre');
        pre.textContent = [entry.message, entry.details, entry.stack].filter(Boolean).join('\n\n');
        const actions = document.createElement('div');
        actions.className = 'lv-detail-actions';
        const copyOne = document.createElement('button');
        copyOne.type = 'button'; copyOne.className = 'cs-btn is-small'; copyOne.innerHTML = `${ICON.copy}<span>Copy</span>`;
        copyOne.addEventListener('click', () => copy(asText(entry), 'Copied'));
        const ask = document.createElement('button');
        ask.type = 'button'; ask.className = 'cs-btn is-small is-quiet'; ask.innerHTML = `${ICON.ask}<span>Ask in chat</span>`;
        ask.title = 'Put this entry into the composer, so an agent can look into it';
        ask.addEventListener('click', () => vscode.postMessage({ type: 'askAboutLogEntry', id: entry.id }));
        actions.append(copyOne, ask);
        detail.append(pre, actions);
        item.append(detail);
      }
      return item;
    }

    function render() {
      const visible = shown();
      const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
      list.replaceChildren(...visible.map(row));
      empty.hidden = visible.length > 0;
      empty.textContent = entries.length
        ? 'Nothing at this level. Pick a lower level above, or clear the filter.'
        : 'Nothing logged yet. Errors from the extension and this window appear here as they happen.';
      if (atBottom) list.scrollTop = list.scrollHeight;
      updateCount();
    }
    function setLevel(level) {
      minLevel = level;
      pills.forEach(pill => { const on = pill.dataset.level === level; pill.setAttribute('aria-checked', String(on)); pill.classList.toggle('active', on); });
      render();
    }

    pills.forEach(pill => pill.addEventListener('click', () => setLevel(pill.dataset.level)));
    search.addEventListener('input', render);
    body.querySelector('[data-act="copy"]').addEventListener('click', () => {
      const visible = shown();
      if (!visible.length) { flash('Nothing to copy'); return; }
      copy(visible.map(asText).join('\n'), `Copied ${visible.length} entr${visible.length === 1 ? 'y' : 'ies'}`);
    });
    body.querySelector('[data-act="output"]').addEventListener('click', () => vscode.postMessage({ type: 'showLogOutput' }));
    body.querySelector('[data-act="clear"]').addEventListener('click', () => vscode.postMessage({ type: 'clearLogs' }));
    setLevel(minLevel);

    return {
      show(level) {
        open = true;
        if (level && RANK[level] !== undefined) setLevel(level);
        vscode.postMessage({ type: 'logsSubscribe' });
        requestAnimationFrame(() => { list.scrollTop = list.scrollHeight; });
      },
      hide() {
        if (!open) return;
        open = false;
        vscode.postMessage({ type: 'logsUnsubscribe' });
      },
      /** Handles the extension's log messages; returns whether the message was one. */
      handle(message) {
        if (message.type === 'logEntries') { entries = (message.entries || []).slice(-LIMIT); render(); return true; }
        if (message.type === 'logEntry') {
          if (!message.entry) return true;
          entries.push(message.entry);
          if (entries.length > LIMIT) entries.splice(0, entries.length - LIMIT);
          if (!shown().includes(message.entry)) { updateCount(); return true; }
          // Append rather than rebuild: at Debug level every click arrives here.
          const atBottom = list.scrollHeight - list.scrollTop - list.clientHeight < 24;
          list.append(row(message.entry));
          while (list.childElementCount > LIMIT) list.firstElementChild.remove();
          empty.hidden = true;
          if (atBottom) list.scrollTop = list.scrollHeight;
          updateCount();
          return true;
        }
        if (message.type === 'logCleared') { entries = []; expanded.clear(); render(); return true; }
        return false;
      },
    };
  };
})();
