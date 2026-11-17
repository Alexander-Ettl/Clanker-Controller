/**
 * Loaded first in the chat webview: sends uncaught errors, rejected promises and console.error/warn to the
 * extension's log (lib/log.js), so the Logs popup shows what went wrong when a button does nothing. Each click is
 * logged at debug level too, and an error that follows a click within a few seconds names that click.
 *
 * A webview may acquire the VS Code API only once, so this takes it and hands the same object to the later scripts.
 */
(function () {
  'use strict';
  if (typeof acquireVsCodeApi !== 'function') return;
  const api = acquireVsCodeApi();
  window.acquireVsCodeApi = () => api;

  const CLICK_WINDOW_MS = 4000;
  let lastClick = null; // { label, time }
  let sentThisSecond = 0, second = 0; // a render loop that throws on every frame must not flood the host
  let sending = false;

  const describe = (node) => {
    const target = node?.closest?.('button, a, [role="button"], [role="tab"], [role="menuitem"], [role="option"], input, select, label, summary, [data-role]') || node;
    if (!target || target.nodeType !== 1 || target.closest('#logsModal')) return ''; // reading the log is not news
    const text = (target.getAttribute('aria-label') || target.getAttribute('title') || target.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 60);
    const id = target.id ? `#${target.id}` : '';
    const role = target.dataset?.role ? `[data-role=${target.dataset.role}]` : '';
    const cls = !id && !role && typeof target.className === 'string' && target.className ? `.${target.className.trim().split(/\s+/).slice(0, 2).join('.')}` : '';
    return `${text ? `"${text}" ` : ''}${target.tagName.toLowerCase()}${id}${role}${cls}`;
  };
  const text = (value) => {
    if (value instanceof Error) return value.message || value.name;
    if (typeof value === 'string') return value;
    try { return JSON.stringify(value); } catch { return String(value); }
  };

  function report(level, source, message, stack = '', details = '') {
    if (sending) return; // posting failed and logged again: stop the loop
    const now = Date.now();
    if (Math.floor(now / 1000) !== second) { second = Math.floor(now / 1000); sentThisSecond = 0; }
    if (++sentThisSecond > 20) return;
    if (level !== 'debug' && lastClick && now - lastClick.time < CLICK_WINDOW_MS) {
      details = `${details ? `${details}\n` : ''}${Math.round((now - lastClick.time) / 100) / 10}s after clicking ${lastClick.label}`;
    }
    sending = true;
    try { api.postMessage({ type: 'clientLog', level, source, message: String(message).slice(0, 8000), stack: String(stack || '').slice(0, 8000), details }); } catch { /* the host is gone */ }
    sending = false;
  }
  window.clankerLog = report; // other scripts can log a message of their own: clankerLog('warn', 'voice', 'No microphone')

  window.addEventListener('error', (event) => {
    if (event.error || event.message) {
      const where = event.filename ? `${event.filename.split('/').pop()}:${event.lineno}:${event.colno}` : '';
      report('error', 'uncaught', event.error ? text(event.error) : event.message, event.error?.stack || where, where && event.error ? `at ${where}` : '');
    } else if (event.target && event.target !== window) {
      // A resource (image, script, stylesheet) failed to load; these do not bubble, hence the capture listener.
      const node = event.target;
      report('warn', 'resource', `Could not load ${node.tagName?.toLowerCase() || 'resource'}`, '', node.src || node.href || '');
    }
  }, true);
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason;
    report('error', 'promise', `Unhandled rejection: ${text(reason)}`, reason?.stack || '');
  });

  for (const level of ['error', 'warn']) {
    const original = console[level].bind(console);
    console[level] = (...args) => {
      original(...args);
      const error = args.find(arg => arg instanceof Error);
      report(level, 'console', args.map(text).join(' '), error?.stack || '');
    };
  }

  document.addEventListener('click', (event) => {
    const label = describe(event.target);
    if (!label) return;
    lastClick = { label, time: Date.now() };
    report('debug', 'click', label);
  }, true);
})();
