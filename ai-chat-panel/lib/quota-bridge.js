'use strict';

// P12-F: Quota Consolidation. This used to hand-roll its own disk-scraping
// (guessing tools/antigravity-usage-statusbar's install path across the
// filesystem with fs.readdirSync, then re-implementing that tool's own
// parseClaudeCache/parseClaudeWeeklyState/findLatestCodexRateLimit as
// fallbacks if the guess failed) -- three duplicated parsers that could
// silently drift from the real ones. Now it does the one thing a VS Code
// extension is actually supposed to do to talk to another one: look it up
// by id and call its exported API. tools/antigravity-usage-statusbar is the
// single canonical source of truth for both the parsing logic and the
// actual disk reads (see that extension's own exported `getQuotas()`).

const ANTIGRAVITY_STATUSBAR_EXTENSION_ID = 'local.antigravity-usage-statusbar';

const NO_QUOTAS = { claude: null, claudeWeekly: null, claudeOpus: null, opus: null, codex: null, gemini: null };

// `vscode` is required lazily, inside the function, rather than once at
// module top-level -- this file (like every other ai-chat-panel module) is
// also exercised outside a real VS Code extension host, by this package's
// own test/session.test.js. A top-level `require('vscode')` evaluates
// exactly once and gets baked into this module's cached exports forever;
// if that one evaluation happened to run while some other test had
// `vscode` monkeypatched to a bare stub (this file gets pulled in
// transitively through extension.js), every later call would silently
// keep using that stale stub instead of the real thing. A fresh require
// per call has no such staleness, and simply throws (caught below) when
// there's truly no VS Code host to resolve it against.
function getVscodeExtensionsApi() {
  try {
    return require('vscode').extensions || null;
  } catch {
    return null;
  }
}

async function getCanonicalQuotaReader() {
  const extensions = getVscodeExtensionsApi();
  if (!extensions) return null;
  const ext = extensions.getExtension(ANTIGRAVITY_STATUSBAR_EXTENSION_ID);
  if (!ext) return null;
  const exportsObj = ext.isActive ? ext.exports : await ext.activate();
  return exportsObj && typeof exportsObj.getQuotas === 'function' ? exportsObj : null;
}

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
const resetPassed = (window) => typeof window?.resetsAt === 'number' && window.resetsAt * 1000 <= Date.now();
const fresh = (window) => ({ ...window, remaining: 100, used: 0, resetsAt: null, assumedReset: true });

// P16-M: the full window objects (used, remaining, resetsAt, windowMinutes),
// not just a percentage, so the launcher can draw 5h and 7d gauges with
// reset countdowns. `remaining`/`windowLabel` stay for the chat header.
function windowOf(raw, windowLabel, key) {
  const live = raw && typeof raw.remaining === 'number'
    ? { remaining: raw.remaining, used: raw.used, resetsAt: raw.resetsAt ?? null, windowMinutes: raw.windowMinutes ?? null, windowLabel }
    : null;
  if (!key) return live && resetPassed(live) ? fresh(live) : live;
  if (live && !resetPassed(live)) { remember(key, live); return live; }
  // Stale or missing: the last reading, reset by our own clock once its time has come.
  const last = live || cache()[key] || null;
  return last && resetPassed(last) ? fresh(last) : last;
}

// P17-B: Opus runs on the same Anthropic account, so its 5h window is
// Claude's; its 7d gauge is the account's Opus-only weekly cap when one is
// reported, else the all-models week.
function shapeQuotas(quotas) {
  const claude = windowOf(quotas.claude, '5h', 'claude');
  // Remembered only for the 5h windows that gate scheduled tasks; a missing weekly/Opus cap means "none on this plan".
  const claudeWeekly = windowOf(quotas.claudeWeekly, '7d');
  const claudeOpus = windowOf(quotas.claudeOpus, '7d');
  const codex = windowOf(quotas.codex, '5h', 'codex');
  const gemini = windowOf(quotas.gemini, '5h', 'gemini');
  return {
    claude: claude && { ...claude, secondary: claudeWeekly },
    claudeWeekly,
    claudeOpus,
    opus: claude && { ...claude, secondary: claudeOpus || claudeWeekly },
    codex: codex && { ...codex, secondary: windowOf(quotas.codex?.secondary, '7d') },
    gemini: gemini && { ...gemini, secondary: windowOf(quotas.gemini?.secondary, '7d') },
  };
}

/** Snapshot for the panel header: Claude 5h/7d, Codex 5h/7d, Antigravity 5h/7d (live language-server quota). */
async function readQuotas() {
  const reader = await getCanonicalQuotaReader();
  if (!reader) return NO_QUOTAS;
  return shapeQuotas(await reader.getQuotas());
}

/** Live updates from the status-bar extension's own poll, so gauges move as tokens are spent. */
async function onDidChangeQuotas(listener) {
  const reader = await getCanonicalQuotaReader().catch(() => null);
  if (!reader || typeof reader.onDidChangeQuotas !== 'function') return { dispose() {} };
  return reader.onDidChangeQuotas((quotas) => listener(shapeQuotas(quotas)));
}

/** P17-W: whether the usage status-bar extension is there to read quotas from. */
async function quotaBridgeConnected() {
  try { return Boolean(await getCanonicalQuotaReader()); } catch { return false; }
}

module.exports = { readQuotas, onDidChangeQuotas, shapeQuotas, quotaBridgeConnected };
