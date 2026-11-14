'use strict';

// Small helpers the provider descriptors share. No requires, so a descriptor can load before anything else does.

const parseVersion = (text) => /\d+\.\d+\.\d+/.exec(String(text || ''))?.[0] || null;
const cap = (word) => word.charAt(0).toUpperCase() + word.slice(1);

// A CLI whose launcher crashed (missing module, damaged install) writes a stack trace instead of an answer.
// `launchFailure` returns the readable error line of such a crash, or '' when the text is an ordinary CLI message.
const CRASH = /Missing optional dependency|Cannot find (?:module|package)|ERR_MODULE_NOT_FOUND|MODULE_NOT_FOUND|^\s+at .+:\d+:\d+\)?\s*$/m;
function launchFailure(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (!lines.some((line) => CRASH.test(line))) return '';
  return (lines.find((line) => /^(?:\w*Error|error)\b.*:/.test(line)) || lines.at(-1)).replace(/^Error:\s*/, '').slice(0, 400);
}

module.exports = { parseVersion, cap, launchFailure };
