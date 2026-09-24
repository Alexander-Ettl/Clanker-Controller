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

// P16-M: the full window objects (used, remaining, resetsAt, windowMinutes),
// not just a percentage, so the launcher can draw 5h and 7d gauges with
// reset countdowns. `remaining`/`windowLabel` stay for the chat header.
function windowOf(raw, windowLabel) {
  if (!raw || typeof raw.remaining !== 'number') return null;
  return { remaining: raw.remaining, used: raw.used, resetsAt: raw.resetsAt ?? null, windowMinutes: raw.windowMinutes ?? null, windowLabel };
}

// P17-B: Opus runs on the same Anthropic account, so its 5h window is
// Claude's; its 7d gauge is the account's Opus-only weekly cap when one is
// reported, else the all-models week.
function shapeQuotas(quotas) {
  const claude = windowOf(quotas.claude, '5h');
  const claudeWeekly = windowOf(quotas.claudeWeekly, '7d');
  const claudeOpus = windowOf(quotas.claudeOpus, '7d');
  const codex = windowOf(quotas.codex, '5h');
  const gemini = windowOf(quotas.gemini, '5h');
  return {
    claude: claude && { ...claude, secondary: claudeWeekly },
    claudeWeekly,
    claudeOpus,
    opus: claude && { ...claude, secondary: claudeOpus || claudeWeekly },
    codex: codex && { ...codex, secondary: windowOf(quotas.codex.secondary, '7d') },
    gemini: gemini && { ...gemini, secondary: windowOf(quotas.gemini.secondary, '7d') },
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
