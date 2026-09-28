'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const vscode = require('vscode');
const { fetchQuotaSummary } = require('./antigravity');
const {
  findLatestCodexRateLimit,
  formatReset,
  formatUsageTooltip,
  formatVisualStatus,
  parseAntigravityQuota,
  parseClaudeCache,
  parseClaudeFiveHourState,
  parseClaudeWeeklyState,
  renderGauge,
} = require('./usage');

const POLL_INTERVAL_MS = 5_000;
const CODEX_TAIL_BYTES = 512 * 1024;
const GEMINI_COLOR = '#4E89E8';
const CLAUDE_COLOR = '#D27354';
const CODEX_COLOR = '#91A2FE';
const OPUS_COLOR = '#A855F7';
const CLAUDE_CONFIG_PATH =
  process.env.CLAUDE_CONFIG_DIR ||
  path.join(os.homedir(), 'Nextcloud', 'ClaudeConfig');
const CLAUDE_CACHE_PATH = path.join(CLAUDE_CONFIG_PATH, 'usage-cache.json');
const CLAUDE_STATE_PATH = path.join(CLAUDE_CONFIG_PATH, '.claude.json');
const CLAUDE_CREDENTIALS_PATH = path.join(CLAUDE_CONFIG_PATH, '.credentials.json');
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_FETCH_MS = 60_000;
const CLAUDE_BACKOFF_MS = 5 * 60_000;
// Same default as ai-chat-panel's lib/quota-bridge.js cacheFile().
const PANEL_QUOTA_CACHE_PATH = process.env.AI_CHAT_PANEL_QUOTA_CACHE || path.join(os.tmpdir(), 'ai-chat-panel-quota-resets.json');
const CODEX_SESSIONS_PATH =path.join(os.homedir(), '.codex', 'sessions');

let timer;
let refreshInProgress = false;

// P12-F: this module is the single canonical source of truth for quota
// parsing (usage.js's pure parse functions) AND for actually reading the
// on-disk caches (this file's own async fs.promises reads). `getQuotas()`
// exposes the same read pipeline `refresh()` already runs for the status
// bar items themselves, so a consumer (`ai-chat-panel`'s quota-bridge.js)
// gets the real, live values instead of re-implementing its own copy of
// this file's read logic or, worse, guessing this file's own path on disk.
const quotaEvents = new EventEmitter();

async function readGeminiUsage() {
  try {
    const summary = await fetchQuotaSummary();
    if (!summary || !summary.data) return null;
    const parsed = parseAntigravityQuota(summary.data, 'Gemini Models');
    return parsed
      ? {
          ...parsed,
          source: `Antigravity Language Server (127.0.0.1:${summary.port})`,
        }
      : null;
  } catch {
    return null;
  }
}

// Claude Code only refreshes `cachedUsageUtilization` in .claude.json when its
// own usage view opens, so the bars went stale in between. This asks the same
// endpoint directly, at most once a minute, with the access token Claude Code
// already stores. It never refreshes that token: refresh tokens rotate, so
// doing it here could sign Claude Code out. With an expired token it just
// waits for Claude Code's next refresh and shows the cached figures meanwhile.
let liveClaudeUsage = null;
let nextClaudeFetch = 0;
async function fetchLiveClaudeUsage(now = Date.now()) {
  if (now < nextClaudeFetch) return liveClaudeUsage;
  nextClaudeFetch = now + CLAUDE_FETCH_MS;
  try {
    const content = await fs.promises.readFile(CLAUDE_CREDENTIALS_PATH, 'utf8');
    const oauth = JSON.parse(content.replace(/^\uFEFF/, '')).claudeAiOauth;
    // Expired: check the file again on every poll, so the first fetch follows Claude Code's own refresh.
    if (!oauth?.accessToken || !(oauth.expiresAt > now + 30_000)) { nextClaudeFetch = 0; return liveClaudeUsage; }
    const response = await fetch(CLAUDE_USAGE_URL, {
      headers: { Authorization: `Bearer ${oauth.accessToken}`, 'anthropic-beta': 'oauth-2025-04-20' },
      signal: AbortSignal.timeout(10_000),
    });
    if (response.status === 429) nextClaudeFetch = now + CLAUDE_BACKOFF_MS;
    if (response.ok) liveClaudeUsage = { fetchedAtMs: now, utilization: await response.json() };
  } catch {
    // Offline or unreadable credentials: keep the last figures.
  }
  return liveClaudeUsage;
}

// The usage endpoint throttles hard (429s), so the AI chat panel's readings are the
// fresher source: it records every turn's exact rate-limit event to this file.
async function readPanelClaudeUsage(now = Date.now()) {
  try {
    const live = JSON.parse(await fs.promises.readFile(PANEL_QUOTA_CACHE_PATH, 'utf8')).claudeLive;
    const window = (w) => w && w.resetsAt * 1000 > now
      ? { utilization: w.used, resets_at: new Date(w.resetsAt * 1000).toISOString() } : undefined;
    const utilization = { five_hour: window(live?.fiveHour), seven_day: window(live?.sevenDay) };
    return live?.at && (utilization.five_hour || utilization.seven_day) ? { fetchedAtMs: live.at, utilization } : null;
  } catch {
    return null;
  }
}

async function readClaudeState() {
  const [state, live, panel] = await Promise.all([
    fs.promises.readFile(CLAUDE_STATE_PATH, 'utf8')
      .then((content) => JSON.parse(content.replace(/^\uFEFF/, '')))
      .catch(() => null),
    fetchLiveClaudeUsage(),
    readPanelClaudeUsage(),
  ]);
  // Newest reading wins per window: our fetch, Claude Code's own, or the panel's. Older
  // readings still fill windows the newer one lacks (the panel never reports Opus).
  const readings = [state?.cachedUsageUtilization, live, panel]
    .filter((r) => r?.utilization && Number.isFinite(r.fetchedAtMs))
    .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
  if (!readings.length) return state;
  const utilization = {};
  for (const r of readings) {
    for (const [key, w] of Object.entries(r.utilization)) if (w) utilization[key] = w;
  }
  return { ...state, cachedUsageUtilization: { fetchedAtMs: readings.at(-1).fetchedAtMs, utilization } };
}

async function readClaudeUsage(claudeState) {
  let cacheUsage = null;
  try {
    const content = await fs.promises.readFile(CLAUDE_CACHE_PATH, 'utf8');
    const value = JSON.parse(content.replace(/^\uFEFF/, ''));
    const parsed = parseClaudeCache(value);
    if (parsed) {
      cacheUsage = { ...parsed, source: CLAUDE_CACHE_PATH };
    }
  } catch {
    // Cache file may not exist yet or be temporarily locked
  }

  let stateUsage = null;
  if (claudeState) {
    const parsed = parseClaudeFiveHourState(claudeState);
    if (parsed) {
      stateUsage = { ...parsed, source: CLAUDE_STATE_PATH };
    }
  }

  if (cacheUsage && stateUsage) {
    const cacheTime = cacheUsage.updatedAt || 0;
    const stateTime = stateUsage.updatedAt || 0;
    if (stateTime > cacheTime + 5_000) {
      if (cacheUsage.model && !stateUsage.model) {
        stateUsage.model = cacheUsage.model;
      }
      return stateUsage;
    }
    return cacheUsage;
  }

  return cacheUsage || stateUsage || null;
}

function dateDirectory(root, date) {
  return path.join(
    root,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

async function listRecentCodexSessionFiles() {
  const files = [];
  const directories = new Set();
  for (let daysBack = 0; daysBack < 3; daysBack += 1) {
    directories.add(
      dateDirectory(
        CODEX_SESSIONS_PATH,
        new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000),
      ),
    );
  }

  for (const directory of directories) {
    try {
      const entries = await fs.promises.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(directory, entry.name);
        try {
          const stat = await fs.promises.stat(filePath);
          files.push({ filePath, mtimeMs: stat.mtimeMs });
        } catch {
          // A session can move while Codex archives it.
        }
      }
    } catch {
      // Missing date directories are normal when Codex has not run recently.
    }
  }

  return files
    .sort((left, right) => right.mtimeMs - left.mtimeMs)
    .slice(0, 20);
}

async function readFileTail(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const stat = await handle.stat();
    const length = Math.min(stat.size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readCodexUsage() {
  try {
    const files = await listRecentCodexSessionFiles();
    const candidates = [];

    for (const file of files) {
      try {
        const usage = findLatestCodexRateLimit(await readFileTail(file.filePath));
        if (!usage) continue;

        const parsedObservedAt = usage.observedAt
          ? Date.parse(usage.observedAt)
          : file.mtimeMs;
        candidates.push({
          ...usage,
          observedAtMs: Number.isFinite(parsedObservedAt)
            ? parsedObservedAt
            : file.mtimeMs,
          source: file.filePath,
        });
      } catch {
        // Concurrent writes and archive moves should not surface as UI errors.
      }
    }

    candidates.sort((left, right) => right.observedAtMs - left.observedAtMs);
    const newest = candidates[0];
    return newest || null;
  } catch {
    return null;
  }
}

function emptyStatus(label) {
  return `${label}   ${renderGauge(0)}--%   $(history) --`;
}

function setMarkdownTooltip(item, markdownText) {
  const md = new vscode.MarkdownString(markdownText);
  md.isTrusted = true;
  md.supportThemeIcons = true;
  item.tooltip = md;
}

function renderGemini(item, usage) {
  if (!usage || !usage.primary) {
    item.text = emptyStatus('Gemini');
    setMarkdownTooltip(
      item,
      '### $(sparkle) Gemini Models (Antigravity)\n\n> $(info) No readable Gemini usage data from Antigravity Language Server',
    );
    return;
  }

  item.text = formatVisualStatus('Gemini', usage.primary);
  const meta = [`$(server) **Source:** \`${usage.source}\``];
  const mdText = formatUsageTooltip({
    title: 'Gemini Models (Antigravity)',
    icon: 'sparkle',
    subtitle: usage.displayName ?? 'Google AI Quota',
    primary: usage.primary,
    secondary: usage.secondary,
    description: usage.description,
    meta,
  });
  setMarkdownTooltip(item, mdText);
}

function renderClaude(item, usage, weekly) {
  if (usage?.stale) {
    item.text = '$(hubot) Claude $(sync~spin)';
    setMarkdownTooltip(
      item,
      '### $(hubot) Claude Code\n\n> $(sync) The last usage snapshot is from before the 5h reset. Fresh figures appear as soon as Claude Code renews its sign-in (any prompt, or its Account & Usage view).',
    );
    return;
  }
  if (!usage) {
    item.text = emptyStatus('Claude');
    setMarkdownTooltip(
      item,
      `### $(hubot) Claude Code\n\n> $(info) No readable Claude usage data at \`${CLAUDE_CACHE_PATH}\` or \`${CLAUDE_STATE_PATH}\``,
    );
    return;
  }

  item.text = formatVisualStatus('Claude', usage);
  const updated = usage.updatedAt
    ? new Date(usage.updatedAt).toLocaleTimeString()
    : 'unknown';
  const meta = [
    `$(clock) **Cache updated:** ${updated}`,
    `$(file) **Source:** \`${usage.source}\``,
  ];
  const mdText = formatUsageTooltip({
    title: 'Claude Code',
    icon: 'hubot',
    // The limits are account-wide across every Claude model, so no single model is named.
    subtitle: 'Claude Models',
    primary: usage,
    secondary: weekly,
    meta,
  });
  setMarkdownTooltip(item, mdText);
}

// P17-B: Opus burns the shared Claude allowance faster, so it gets its own
// item while it's in play: the account reports an Opus-only weekly cap, or
// the Claude cache says the current model is Opus. Text shows the 5h window
// every Opus turn draws on; the tooltip adds the Opus week.
function renderOpus(item, usage, opusWeekly, weekly) {
  if (!usage || usage.stale || !(opusWeekly || /opus/i.test(usage.model || ''))) {
    item.hide();
    return;
  }
  item.text = formatVisualStatus('Opus', usage);
  setMarkdownTooltip(item, formatUsageTooltip({
    title: 'Claude Opus 5.5',
    icon: 'star-full',
    subtitle: opusWeekly ? 'Shared 5h window · Opus weekly cap' : 'Shared 5h window · all-models week',
    primary: usage,
    secondary: opusWeekly || weekly,
    meta: [`$(file) **Source:** \`${usage.source}\``],
  }));
  item.show();
}

function renderCodex(item, usage) {
  if (!usage) {
    item.text = emptyStatus('Codex');
    setMarkdownTooltip(
      item,
      `### $(terminal) Codex (ChatGPT)\n\n> $(info) Codex is closed or idle. Rate limits will update automatically during active Codex sessions under \`${CODEX_SESSIONS_PATH}\`.`,
    );
    return;
  }

  item.text = formatVisualStatus('Codex', usage);
  const meta = [];
  if (usage.observedAt) {
    meta.push(
      `$(history) **Snapshot:** ${new Date(usage.observedAt).toLocaleTimeString()}`,
    );
  }
  meta.push(`$(file) **Source:** \`${usage.source}\``);

  const mdText = formatUsageTooltip({
    title: 'Codex (ChatGPT)',
    icon: 'terminal',
    subtitle: usage.planType
      ? `Plan: ${usage.planType.toUpperCase()}`
      : 'Codex Rate Limits',
    primary: usage,
    secondary: usage.secondary,
    meta,
  });
  setMarkdownTooltip(item, mdText);
}

/**
 * Reads live Gemini (Antigravity)/Claude/Codex quota usage from disk.
 * Exported (see module.exports at the bottom) as the one real, canonical
 * read path -- `refresh()` below and any external consumer both call this
 * exact function, so there is only ever one place these caches get parsed.
 * @returns {Promise<{gemini: object|null, claude: object|null, claudeWeekly: object|null, codex: object|null}>}
 */
// The caches are snapshots: a window whose reset time has passed has refilled
// since, so it reads as full instead of showing stale use (or nothing).
function refilled(window, nowMs = Date.now()) {
  if (!window || !(window.resetsAt * 1000 <= nowMs)) return window;
  return { ...window, used: 0, remaining: 100, resetsAt: null };
}

// Claude's snapshots only come from Claude Code (or our fetch with its token).
// One taken before the window reset says nothing about use since, so after a
// restart it is shown as "waiting for data" instead of a made-up 100% left.
function claudeWindow(window, nowMs) {
  if (!window || window.resetsAt == null || !(window.resetsAt * 1000 <= nowMs)) return window;
  return { ...window, used: null, remaining: null, stale: true };
}

function withRefills(usage, nowMs) {
  const current = refilled(usage, nowMs);
  if (!current) return current;
  for (const key of ['primary', 'secondary']) if (usage[key]) current[key] = refilled(usage[key], nowMs);
  return current;
}

async function getQuotas() {
  const claudeStatePromise = readClaudeState();
  const [geminiUsage, claudeState, codexUsage] = await Promise.all([
    readGeminiUsage(),
    claudeStatePromise,
    readCodexUsage(),
  ]);
  const claudeUsage = await readClaudeUsage(claudeState);
  const now = Date.now();
  return {
    gemini: withRefills(geminiUsage, now),
    claude: claudeWindow(claudeUsage, now),
    // A weekly snapshot from before its reset is simply unknown (the 5h item carries the "waiting" state).
    claudeWeekly: claudeWindow(parseClaudeWeeklyState(claudeState), now)?.stale ? null : parseClaudeWeeklyState(claudeState),
    claudeOpus: claudeWindow(parseClaudeWeeklyState(claudeState, 'seven_day_opus'), now)?.stale ? null : parseClaudeWeeklyState(claudeState, 'seven_day_opus'),
    codex: withRefills(codexUsage, now),
  };
}

/**
 * Subscribes to every quota refresh this extension's own status-bar poll
 * timer performs (every `POLL_INTERVAL_MS`), instead of a consumer running
 * a second independent poll loop against the same disk caches.
 * @param {(quotas: Awaited<ReturnType<typeof getQuotas>>) => void} listener
 * @returns {{dispose: () => void}}
 */
function onDidChangeQuotas(listener) {
  quotaEvents.on('change', listener);
  return { dispose: () => quotaEvents.off('change', listener) };
}

async function refresh(geminiItem, claudeItem, codexItem, opusItem) {
  if (refreshInProgress) return;
  refreshInProgress = true;
  try {
    const quotas = await getQuotas();
    renderGemini(geminiItem, quotas.gemini);
    renderClaude(claudeItem, quotas.claude, quotas.claudeWeekly);
    renderOpus(opusItem, quotas.claude, quotas.claudeOpus, quotas.claudeWeekly);
    renderCodex(codexItem, quotas.codex);
    quotaEvents.emit('change', quotas);
  } finally {
    refreshInProgress = false;
  }
}

function activate(context) {
  const geminiItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1003,
  );
  geminiItem.name = 'Gemini (Antigravity) usage';
  geminiItem.text = emptyStatus('Gemini');
  geminiItem.color = GEMINI_COLOR;

  const claudeItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1002,
  );
  claudeItem.name = 'Claude Code usage';
  claudeItem.text = emptyStatus('Claude');
  claudeItem.color = CLAUDE_COLOR;

  const codexItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1001,
  );
  codexItem.name = 'Codex usage';
  codexItem.text = emptyStatus('Codex');
  codexItem.color = CODEX_COLOR;

  // Hidden until renderOpus sees Opus in play; sits between Claude and Codex.
  const opusItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    1001.5,
  );
  opusItem.name = 'Claude Opus usage';
  opusItem.color = OPUS_COLOR;

  geminiItem.show();
  claudeItem.show();
  codexItem.show();
  context.subscriptions.push(geminiItem, claudeItem, codexItem, opusItem);

  void refresh(geminiItem, claudeItem, codexItem, opusItem);
  timer = setInterval(
    () => void refresh(geminiItem, claudeItem, codexItem, opusItem),
    POLL_INTERVAL_MS,
  );
  // VS Code hands this return value (not module.exports) to other extensions as ext.exports.
  return { getQuotas, onDidChangeQuotas };
}

function deactivate() {
  if (timer) {
    clearInterval(timer);
    timer = undefined;
  }
}

module.exports = { activate, deactivate, getQuotas, onDidChangeQuotas, refilled };
