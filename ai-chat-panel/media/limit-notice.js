// Is this reply the model saying its usage limit is used up? Shared by the chat window (it offers "Send continue when the
// limit resets") and the extension (queued prompts then wait for the reset instead of all failing one after another).
(function (root) {
  'use strict';

  const LIMIT_RE = /\b(usage|session|weekly|daily|rate)\s+limit\b|hit your .{0,24}limit|limit (reached|exceeded)|quota (exceeded|exhausted)|exhausted (your|the) .{0,24}(quota|limit)|RESOURCE_EXHAUSTED|out of (usage|credits)/i;

  function isLimitNotice(raw) {
    const text = String(raw || '').trim();
    // A cut-off reply may contain substantial work before the CLI appends its own limit line.
    const lastLine = text.split(/\r?\n/).map(line => line.trim()).filter(Boolean).at(-1) || '';
    return lastLine.length > 0 && lastLine.length <= 400 && /^(?:(?:claude|codex|gemini) error:\s*)?(?:you['\u2019]ve hit your (?:session|usage|weekly|daily|\d+[-\u2011\u2013 ]hour) limit\b|(?:(?:usage|session|weekly|daily|rate)\s+)?limit (?:reached|exceeded)\b|quota (?:exceeded|exhausted)\b|RESOURCE_EXHAUSTED\b|(?:you(?: are|'re) )?out of (?:usage|credits)\b)/i.test(lastLine);
  }

  // agy says when its pool comes back: "... Individual quota reached. Resets in 4h43m1s." Milliseconds from the notice, or null.
  function resetsInMs(raw) {
    const m = /\bresets? in\s+(?:(\d+)d\s*)?(?:(\d+)h\s*)?(?:(\d+)m\s*)?(?:(\d+)s)?/i.exec(String(raw || ''));
    if (!m || !(m[1] || m[2] || m[3] || m[4])) return null;
    return ((Number(m[1] || 0) * 24 + Number(m[2] || 0)) * 60 + Number(m[3] || 0)) * 60000 + Number(m[4] || 0) * 1000;
  }
  /** Does the notice itself say the limit is still in force? true/false when it names a reset time (sent at `at`), null when it does not. */
  function limitActive(raw, at = Date.now(), now = Date.now()) {
    const ms = resetsInMs(raw);
    return ms === null ? null : (Number.isFinite(Date.parse(at)) ? Date.parse(at) : at) + ms > now;
  }

  const api = { isLimitNotice, LIMIT_RE, resetsInMs, limitActive };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.limitNotice = api;
})(typeof window !== 'undefined' ? window : globalThis);
