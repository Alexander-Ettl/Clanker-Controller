'use strict';

// Shapes the raw readings from lib/quota-sources.js (Gemini, Claude, Codex) into the windows the
// launcher gauges, chat headers and scheduler read, and keeps the last-known store on disk.

const { getQuotas, onDidChangeQuotas: onRawQuotas } = require('./quota-sources.js');

// Our own reset clock. A provider's usage file only updates when that CLI runs,
// so after a limit it can say "0% left, resets 18:30" (or nothing at all) long
// past 18:30, and a scheduled task waiting for quota never fires. So every
// window's last reading is remembered (on disk, surviving a restart); once its
// resetsAt has passed, the window counts as fresh (100% left) until the
// provider reports something newer.
const fs = require('node:fs');
const path = require('node:path');
const cacheFile = () => process.env.AI_CHAT_PANEL_QUOTA_CACHE || path.join(require('node:os').tmpdir(), 'ai-chat-panel-quota-resets.json');
let resetCache = null;
let resetCacheFile = null;
function cache() {
  if (!resetCache || resetCacheFile !== cacheFile()) {
    resetCacheFile = cacheFile();
    try { resetCache = JSON.parse(fs.readFileSync(resetCacheFile, 'utf8')); } catch { resetCache = {}; }
  }
  return resetCache;
}
function remember(key, window) {
  const known = cache()[key];
  if (known && known.resetsAt === window.resetsAt && known.remaining === window.remaining) return;
  cache()[key] = window;
  try { fs.writeFileSync(resetCacheFile, JSON.stringify(resetCache)); } catch { /* best effort */ }
}
const UNDATED_READING_MS = 20 * 60 * 1000;
const resetPassed = (window) => typeof window?.resetsAt === 'number' && window.resetsAt * 1000 <= Date.now();
const fresh = (window) => ({ ...window, remaining: 100, used: 0, resetsAt: null, assumedReset: true });

/**
 * Claude's own numbers (lib/claude-usage.js: each turn's rate-limit event, or the free
 * `/usage` probe), remembered on disk with when they were read. While their window is
 * still running they beat the status bar's cache, which only refreshes when Claude
 * Code's /usage screen runs and so often reads stale after a restart.
 */
function recordClaudeUsage(windows, at = Date.now()) {
  if (!windows?.fiveHour && !windows?.sevenDay) return;
  cache().claudeLive = { ...cache().claudeLive, ...Object.fromEntries(Object.entries(windows).filter(([, w]) => w)), at };
  try { fs.writeFileSync(resetCacheFile, JSON.stringify(resetCache)); } catch { /* best effort */ }
}
/** Last real reading's age in ms (Infinity if none): the extension probes /usage when it's old or a window has rolled over. */
function claudeUsageAge() {
  const live = cache().claudeLive;
  if (!live?.at) return Infinity;
  const rolled = [live.fiveHour, live.sevenDay].some((w) => w && w.resetsAt * 1000 <= Date.now() && live.at < w.resetsAt * 1000);
  return rolled ? Infinity : Date.now() - live.at;
}
function withClaudeLive(quotas) {
  const live = cache().claudeLive;
  if (!live) return quotas;
  // A reading with a reset time counts until that time. One without (`/usage` right after a reset says "0% used" and no
  // "resets ..." yet: the next window has not started) counts for a while; dropping it left the stale "0% left" from the
  // status bar in charge, and a task waiting for the reset never fired.
  const fresh = (w) => w.resetsAt == null ? Date.now() - live.at < UNDATED_READING_MS : w.resetsAt * 1000 > Date.now();
  const asWindow = (w, windowMinutes) => w && fresh(w) ? { used: w.used, remaining: 100 - w.used, resetsAt: w.resetsAt ?? null, windowMinutes } : null;
  return {
    ...quotas,
    claude: asWindow(live.fiveHour, 300) || quotas.claude,
    claudeWeekly: asWindow(live.sevenDay, 10080) || quotas.claudeWeekly,
  };
}

// P16-M: the full window objects (used, remaining, resetsAt, windowMinutes),
// not just a percentage, so the launcher can draw 5h and 7d gauges with
// reset countdowns. `remaining`/`windowLabel` stay for the chat header.
function windowOf(raw, windowLabel, key) {
  const live = raw && typeof raw.remaining === 'number'
    ? { remaining: raw.remaining, used: raw.used, resetsAt: raw.resetsAt ?? null, windowMinutes: raw.windowMinutes ?? null, windowLabel: raw.windowLabel || windowLabel, ...(raw.detail ? { detail: raw.detail } : {}) }
    : null;
  if (!key) return live && resetPassed(live) ? fresh(live) : live;
  // No reset time in the reading, and it is exactly what was remembered before whose reset has since passed: the same
  // stale number (a provider file that only updates when its CLI runs), so the window has rolled over.
  const known = cache()[key];
  const unchanged = live && live.resetsAt == null && known && resetPassed(known) && known.remaining === live.remaining;
  if (live && !unchanged && !resetPassed(live)) { remember(key, live); return live; }
  if (unchanged) return fresh(known);
  // Stale or missing: the last reading, reset by our own clock once its time has come.
  const last = live || cache()[key] || null;
  return last && resetPassed(last) ? fresh(last) : last;
}

// P17-B: Opus runs on the same Anthropic account, so its 5h window is
// Claude's; its 7d gauge is the account's Opus-only weekly cap when one is
// reported, else the all-models week.
function shapeQuotas(raw) {
  const quotas = withClaudeLive(raw || {});
  const claude = windowOf(quotas.claude, '5h', 'claude');
  // Remembered only for the 5h windows that gate scheduled tasks; a missing weekly/Opus cap means "none on this plan".
  const claudeWeekly = windowOf(quotas.claudeWeekly, '7d');
  const claudeOpus = windowOf(quotas.claudeOpus, '7d');
  const codex = windowOf(quotas.codex, '5h', 'codex');
  const gemini = windowOf(quotas.gemini, '5h', 'gemini');
  const copilot = windowOf(quotas.copilot, 'month', 'copilot'); // a monthly allowance; its reset is remembered like the 5h windows
  const antigravityClaudeGpt = windowOf(quotas.antigravityClaudeGpt, quotas.antigravityClaudeGpt?.windowMinutes === 10080 ? '7d' : '5h', 'antigravityClaudeGpt');
  const antigravityArgon = windowOf(quotas.antigravityArgon, quotas.antigravityArgon?.windowMinutes === 10080 ? '7d' : '5h');
  return {
    claude: claude && { ...claude, secondary: claudeWeekly },
    claudeWeekly,
    claudeOpus,
    opus: claude && { ...claude, secondary: claudeOpus || claudeWeekly },
    codex: codex && { ...codex, secondary: windowOf(quotas.codex?.secondary, '7d') },
    gemini: gemini && { ...gemini, secondary: windowOf(quotas.gemini?.secondary, '7d') },
    copilot,
    antigravityClaudeGpt: antigravityClaudeGpt && { ...antigravityClaudeGpt, secondary: windowOf(quotas.antigravityClaudeGpt?.secondary, '7d') },
    antigravityArgon: antigravityArgon && { ...antigravityArgon, secondary: windowOf(quotas.antigravityArgon?.secondary, '7d') },
  };
}

/** Snapshot for the panel header: Claude 5h/7d, Codex 5h/7d, Antigravity 5h/7d (live language-server quota). */
async function readQuotas(sources) {
  return shapeQuotas(await getQuotas(sources));
}

/** Live updates from one shared poll, so gauges move as tokens are spent. */
function onDidChangeQuotas(listener) {
  return onRawQuotas((quotas) => listener(shapeQuotas(quotas)));
}

module.exports = { readQuotas, onDidChangeQuotas, shapeQuotas, recordClaudeUsage, claudeUsageAge };
