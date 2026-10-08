// Is this reply the model saying its usage limit is used up? Shared by the chat window (it offers "Send continue when the
// limit resets") and the extension (queued prompts then wait for the reset instead of all failing one after another).
(function (root) {
  'use strict';

  const LIMIT_RE = /\b(usage|session|weekly|daily|rate)\s+limit\b|hit your .{0,24}limit|limit (reached|exceeded)|quota (exceeded|exhausted)|exhausted (your|the) .{0,24}(quota|limit)|RESOURCE_EXHAUSTED|out of (usage|credits)/i;

  function isLimitNotice(raw) {
    const text = String(raw || '').trim();
    // A cut-off reply may contain substantial work before the CLI appends its own limit line.
    const lastLine = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || '';
    return (text.length > 0 && text.length <= 400 && LIMIT_RE.test(text)) ||
      (lastLine.length <= 400 && /^you['’]ve hit your (?:session|usage|weekly|daily) limit\b/i.test(lastLine));
  }

  const api = { isLimitNotice, LIMIT_RE };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.limitNotice = api;
})(typeof window !== 'undefined' ? window : globalThis);
