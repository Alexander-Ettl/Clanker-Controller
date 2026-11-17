'use strict';

/**
 * Claude's real plan usage, without spending tokens.
 * - `claude -p "/usage"` is a local command: it asks Anthropic's account API for
 *   the limits and prints them (0 model turns, $0, 0 tokens; checked on 2.1.282).
 *   Its text is parsed here. If a probe ever reports a model turn or a cost, probing
 *   stops for good rather than silently spending usage.
 * - Every real Claude turn also carries a `rate_limit_event` with exact
 *   utilization and reset times (stream-engine emits it as `rate_limit`).
 * Both feed quota-bridge's last-known store, which the gauges and the scheduler read.
 */
const { spawn } = require('node:child_process');
const { locate, resolveShim } = require('./binary-locator.js');

const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

/** "Sep 25, 5:40am" / "Sep 25, 18:30" / "Sep 25, 3pm" / "5:40am" / "18:30" in local time -> epoch seconds, or null. */
function parseResetTime(text, now = new Date()) {
  const m = /^(?:([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?$/i.exec(String(text).trim());
  if (!m) return null;
  const is12Hour = Boolean(m[5]);
  let hour = Number(m[3]);
  if (is12Hour) {
    hour = (hour % 12) + (m[5].toLowerCase() === 'pm' ? 12 : 0);
  } else if (hour > 23) {
    return null;
  }
  const min = Number(m[4] || 0);
  if (min > 59) return null;
  const month = m[1] ? MONTHS[m[1].toLowerCase()] : now.getMonth();
  const day = m[2] ? Number(m[2]) : now.getDate();
  if (month === undefined) return null;
  const at = new Date(now.getFullYear(), month, day, hour, min);
  if (!m[1] && !m[2] && at.getTime() < now.getTime() - 60000) at.setDate(at.getDate() + 1);
  if (at.getTime() < now.getTime() - 183 * 86400000) at.setFullYear(at.getFullYear() + 1); // "Jan 2" seen in December
  return Math.floor(at.getTime() / 1000);
}

/** The /usage screen's text -> { fiveHour, sevenDay } windows ({ used, resetsAt }), or null if it isn't there. */
function parseUsageText(text, now = new Date()) {
  const line = (label) => new RegExp(`${label}[^:\\n]*:\\s*(\\d{1,3})%\\s*used(?:\\s*·\\s*resets\\s+([^(\\n]+?)\\s*(?:\\(|$))?`, 'im').exec(String(text));
  const session = line('Current session');
  const week = line('Current week \\(all models\\)') || line('Current week');
  const window = (m) => m && { used: Number(m[1]), resetsAt: m[2] ? parseResetTime(m[2], now) : null };
  const fiveHour = window(session);
  const sevenDay = window(week);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

/** A turn's rate_limit_event (rate_limit_info.unifiedWindows, utilization 0..1) -> the same shape. */
function fromRateLimitEvent(event) {
  const windows = event?.rate_limit_info?.unifiedWindows;
  if (!windows) return null;
  const window = (w) => w && typeof w.utilization === 'number' ? { used: Math.round(w.utilization * 100), resetsAt: w.resetsAt ?? null } : null;
  const fiveHour = window(windows.five_hour);
  const sevenDay = window(windows.seven_day);
  return fiveHour || sevenDay ? { fiveHour, sevenDay } : null;
}

let disabled = false;
/** Runs `claude -p "/usage"` headless; resolves the parsed windows or null. */
function probeClaudeUsage(cwd) {
  const binary = locate('claude').path;
  if (disabled || !binary) return Promise.resolve(null);
  const shim = process.platform === 'win32' && /\.cmd$/i.test(binary) ? resolveShim(binary) : null;
  return new Promise((resolve) => {
    let out = '';
    let child;
    const timer = setTimeout(() => { try { child?.kill(); } catch { /* gone */ } resolve(null); }, 45000);
    try {
      child = spawn(shim?.command || binary, [...(shim?.args || []), '-p', '/usage', '--output-format', 'stream-json', '--verbose'], { cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { clearTimeout(timer); return resolve(null); }
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.on('close', () => {
      clearTimeout(timer);
      const result = out.split('\n').map((line) => { try { return JSON.parse(line); } catch { return null; } }).find((event) => event?.type === 'result');
      if (!result) return resolve(null);
      if ((result.num_turns || 0) > 0 || (result.total_cost_usd || 0) > 0) {
        disabled = true; // /usage went to the model on this CLI version: never probe again
        require('./log.js').warn('claude usage', '"/usage" cost a model turn on this Claude Code version; usage probing is off.');
        return resolve(null);
      }
      resolve(parseUsageText(result.result));
    });
  });
}

module.exports = { parseUsageText, parseResetTime, fromRateLimitEvent, probeClaudeUsage };
