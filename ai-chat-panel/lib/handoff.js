'use strict';

const fs = require('node:fs');
const path = require('node:path');

// P12-D: a ~150-token summary of what the just-verified batch actually did,
// handed to the next batch's fresh chat session so it doesn't have to
// re-read the diff or re-derive decisions already made -- hard-capped so
// it can never grow into the exact context bloat this mechanism exists to
// avoid (see docs/content-editor-todo.md's own "60k+ tokens of past tool
// outputs" framing for why a fresh session is used at all).
const MAX_CHARS = 700; // ~150 tokens at a conservative ~4.5 chars/token

function clampList(items, max) {
  if (!Array.isArray(items)) return [];
  return items.slice(0, max).map((item) => String(item));
}

/**
 * Writes the compact handoff artifact, trimming list entries (least
 * load-bearing first: decisions' prose, then invariants) rather than
 * truncating mid-string if the caller-supplied summary runs over budget --
 * a truncated JSON string would fail to parse for the very next reader
 * this file exists to serve.
 */
function writeMicroHandoff(filePath, summary) {
  const payload = {
    writtenAt: new Date().toISOString(),
    decisions: clampList(summary && summary.decisions, 5),
    modifiedExports: clampList(summary && summary.modifiedExports, 8),
    invariants: clampList(summary && summary.invariants, 5),
  };
  let json = JSON.stringify(payload, null, 2);
  while (json.length > MAX_CHARS && payload.decisions.length > 1) {
    payload.decisions.pop();
    json = JSON.stringify(payload, null, 2);
  }
  while (json.length > MAX_CHARS && payload.invariants.length > 0) {
    payload.invariants.pop();
    json = JSON.stringify(payload, null, 2);
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, json, 'utf8');
  return payload;
}

function readMicroHandoff(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return null;
  }
}

/** Renders a handoff payload into the short prefix prepended to the next batch's own prompt. */
function formatMicroHandoffPrompt(summary) {
  if (!summary) return '';
  const lines = ['**Handoff from the previous phase (fresh session -- no prior chat context):**'];
  if (summary.decisions && summary.decisions.length) lines.push('- Decisions: ' + summary.decisions.join('; '));
  if (summary.modifiedExports && summary.modifiedExports.length) lines.push('- Modified exports/files: ' + summary.modifiedExports.join(', '));
  if (summary.invariants && summary.invariants.length) lines.push('- Active invariants to preserve: ' + summary.invariants.join('; '));
  return lines.length > 1 ? lines.join('\n') : '';
}

module.exports = { writeMicroHandoff, readMicroHandoff, formatMicroHandoffPrompt, MAX_CHARS };
