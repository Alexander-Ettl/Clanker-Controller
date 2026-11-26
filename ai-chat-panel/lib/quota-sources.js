'use strict';

// Where the quota numbers come from: Antigravity's language server (Gemini and Claude/GPT), Claude Code's own files and
// usage endpoint (Claude), and Codex's session logs (Codex). Ported from the retired usage status-bar
// extension, so the panel no longer needs a second extension for its gauges. lib/quota-bridge.js shapes
// what this returns; nothing here touches `vscode`.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { fetchQuotaSummary } = require('./antigravity-quota.js');
const { readCopilotUsage } = require('./copilot-usage.js');

const POLL_INTERVAL_MS = 5_000;
const CODEX_TAIL_BYTES = 512 * 1024;
const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const CLAUDE_FETCH_MS = 60_000;
const CLAUDE_BACKOFF_MS = 5 * 60_000;

const claudeConfigPath = () => process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), 'Nextcloud', 'ClaudeConfig');
const codexSessionsPath = () => path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'sessions');
const stripBom = (text) => text.replace(/^﻿/, '');

// ---- Parsers (pure) -------------------------------------------------------------------------------------

function finiteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function percent(value) {
  const number = finiteNumber(value);
  if (number === null) return null;
  return Math.round(Math.min(100, Math.max(0, number)));
}

function parseClaudeCache(value) {
  if (!value || value.hasData !== true) return null;
  const used = percent(value.used);
  const resetsAt = finiteNumber(value.resetsAt);
  if (used === null || resetsAt === null) return null;
  const suppliedRemaining = percent(value.remaining);
  return {
    model: typeof value.model === 'string' ? value.model : null,
    used,
    remaining: suppliedRemaining === null ? 100 - used : suppliedRemaining,
    resetsAt,
    updatedAt: finiteNumber(value.updatedAt),
    windowMinutes: 300,
  };
}

function parseClaudeFiveHourState(value) {
  const fiveHour = value?.cachedUsageUtilization?.utilization?.five_hour;
  if (!fiveHour) return null;
  const used = percent(fiveHour.utilization ?? fiveHour.used_percentage);
  const reset = fiveHour.resets_at ?? fiveHour.resetsAt;
  const resetMilliseconds = Date.parse(reset);
  // No reset time means no window is running yet (nothing used): full, not unknown.
  if (used === null || (reset != null && !Number.isFinite(resetMilliseconds))) return null;
  return {
    model: null,
    used,
    remaining: 100 - used,
    resetsAt: reset == null ? null : resetMilliseconds / 1000,
    updatedAt: finiteNumber(value?.cachedUsageUtilization?.fetchedAtMs),
    windowMinutes: 300,
  };
}

// `key` 'seven_day_opus' reads the account's Opus-only weekly cap (null on plans without one).
function parseClaudeWeeklyState(value, key = 'seven_day') {
  const weekly = value?.cachedUsageUtilization?.utilization?.[key];
  if (!weekly) return null;
  const used = percent(weekly.utilization ?? weekly.used_percentage);
  const resetMilliseconds = Date.parse(weekly.resets_at ?? weekly.resetsAt);
  if (used === null || !Number.isFinite(resetMilliseconds)) return null;
  return { used, remaining: 100 - used, resetsAt: resetMilliseconds / 1000, windowMinutes: 7 * 24 * 60 };
}

function normalizeWindow(window) {
  if (!window) return null;
  const used = percent(window.used_percent ?? window.usedPercent);
  const windowMinutes = finiteNumber(window.window_minutes ?? window.windowDurationMins);
  const resetsAt = finiteNumber(window.resets_at ?? window.resetsAt);
  if (used === null || windowMinutes === null || resetsAt === null) return null;
  return { used, remaining: 100 - used, windowMinutes, resetsAt };
}

function parseCodexRateLimitLine(line) {
  let event;
  try { event = JSON.parse(line); } catch { return null; }
  const rateLimits =
    event?.payload?.rate_limits ??
    event?.payload?.rateLimits ??
    event?.payload?.info?.rate_limits ??
    event?.payload?.info?.rateLimits ??
    event?.rate_limits ??
    event?.rateLimits ??
    null;
  const primary = normalizeWindow(rateLimits?.primary);
  if (!primary) return null;
  return {
    ...primary,
    secondary: normalizeWindow(rateLimits.secondary),
    observedAt: typeof event.timestamp === 'string' ? event.timestamp : null,
    planType: rateLimits.plan_type ?? rateLimits.planType ?? null,
  };
}

// Codex rounds down and logs its last reading before the call that runs the window dry, so a spent plan reads
// 99% used. The turn then ends with a `usage_limit_exceeded` error and no further reading: that error is the
// proof the fullest window is at 100%, and without it the gauge sits on "1% left" until the reset.
function spentWindows(usage) {
  const secondaryFuller = usage.secondary && usage.secondary.used > usage.used;
  const spend = (window) => ({ ...window, used: 100, remaining: 0 });
  return secondaryFuller
    ? { ...usage, secondary: spend(usage.secondary) }
    : { ...usage, ...spend(usage) };
}

function findLatestCodexRateLimit(text) {
  const lines = text.split(/\r?\n/);
  let limitHit = false;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (line.includes('"codex_error_info":"usage_limit_exceeded"')) limitHit = true;
    if (!line.includes('rate_limits') && !line.includes('rateLimits')) continue;
    const usage = parseCodexRateLimitLine(line);
    if (usage) return limitHit ? spentWindows(usage) : usage;
  }
  return null;
}

function normalizeAntigravityBucket(bucket) {
  if (!bucket || typeof bucket !== 'object') return null;
  const rawReset = bucket.resetTime ?? bucket.reset_time;
  const resetMs = typeof rawReset === 'number'
    ? (rawReset > 1e12 ? rawReset : rawReset * 1000)
    : Date.parse(rawReset);
  const hasReset = Number.isFinite(resetMs);
  const description = bucket.description ?? null;
  const rawFraction = bucket.remainingFraction ?? bucket.remaining_fraction;
  let remainingFraction = finiteNumber(rawFraction);
  // Proto3 JSON omits 0-valued numeric fields: an active or limit-hit bucket with no remainingFraction means 0% left.
  if (remainingFraction === null && rawFraction == null && (hasReset || /hit your .* limit|exhausted|depleted|\b0%/i.test(String(description || '')))) {
    remainingFraction = 0;
  }
  if (remainingFraction === null) return null;
  const remaining = percent(remainingFraction * 100);
  if (remaining === null) return null;
  const bucketId = String(bucket.bucketId ?? bucket.bucket_id ?? '');
  const weekly = bucket.window === 'weekly' || /weekly|7d/i.test(bucketId);
  // An untouched bucket has remainingFraction 1 and no "You have used..." description (and may omit resetTime altogether).
  return {
    used: 100 - remaining,
    remaining,
    windowMinutes: weekly ? 7 * 24 * 60 : 300,
    resetsAt: !hasReset || (remainingFraction >= 1 && !description) ? null : resetMs / 1000,
    displayName: bucket.displayName ?? bucket.display_name ?? null,
    description,
  };
}

function parseAntigravityQuota(data, groupName = 'Gemini Models') {
  const groups = data?.response?.groups ?? data?.groups;
  if (!Array.isArray(groups)) return null;
  const want = groupName.toLowerCase();
  let group = groups.find(
    (g) => g.displayName === groupName ||
      (typeof g.displayName === 'string' && g.displayName.toLowerCase().includes(want)),
  );
  // Fall back to the 3p bucket / Claude+GPT description if Google renames the "Claude and GPT models" group title.
  if (!group && want.includes('claude')) {
    group = groups.find((g) => Array.isArray(g.buckets) && (
      g.buckets.some((b) => /^3p[-_]/i.test(String(b?.bucketId ?? b?.bucket_id ?? ''))) ||
      (/\b(?:claude|gpt)\b/i.test(`${g.displayName || ''} ${g.description || ''}`) && !/^gemini\b/i.test(String(g.displayName || '')))
    ));
  }
  if (!group || !Array.isArray(group.buckets)) return null;

  const isWeekly = (b) => b?.window === 'weekly' || /weekly|7d/i.test(String(b?.bucketId ?? b?.bucket_id ?? ''));
  const isFiveHour = (b) => b?.window === '5h' || /5h|five[_-]?hour/i.test(String(b?.bucketId ?? b?.bucket_id ?? ''));
  const fiveHourUsage = normalizeAntigravityBucket(group.buckets.find(isFiveHour));
  const weeklyUsage = normalizeAntigravityBucket(group.buckets.find(isWeekly));
  // The language server sometimes reports only the weekly bucket: that is then the one window there is.
  const primary = fiveHourUsage ?? weeklyUsage;
  if (!primary) return null;
  return {
    ...primary,
    primary,
    secondary: fiveHourUsage ? weeklyUsage : null,
    displayName: group.displayName,
    description: group.description,
  };
}

// ---- Readers (disk and network) ---------------------------------------------------------------------------

async function readAntigravityUsage() {
  try {
    const summary = await fetchQuotaSummary();
    const group = (name) => {
      const parsed = summary?.data ? parseAntigravityQuota(summary.data, name) : null;
      return parsed && { ...parsed, source: `Antigravity Language Server (127.0.0.1:${summary.port})` };
    };
    return { gemini: group('Gemini Models'), antigravityClaudeGpt: group('Claude and GPT models'), antigravityArgon: group('Gemini 4 Argon') };
  } catch {
    return {};
  }
}

// Claude Code only refreshes `cachedUsageUtilization` in .claude.json when its own usage view opens, so the
// figures went stale in between. This asks the same endpoint directly, at most once a minute, with the access
// token Claude Code already stores. It never refreshes that token: refresh tokens rotate, so doing it here
// could sign Claude Code out. With an expired token it waits for Claude Code's next refresh.
let liveClaudeUsage = null;
let nextClaudeFetch = 0;
async function fetchLiveClaudeUsage(now = Date.now()) {
  if (now < nextClaudeFetch) return liveClaudeUsage;
  nextClaudeFetch = now + CLAUDE_FETCH_MS;
  try {
    const content = await fs.promises.readFile(path.join(claudeConfigPath(), '.credentials.json'), 'utf8');
    const oauth = JSON.parse(stripBom(content)).claudeAiOauth;
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

async function readClaudeState() {
  const [state, live] = await Promise.all([
    fs.promises.readFile(path.join(claudeConfigPath(), '.claude.json'), 'utf8')
      .then((content) => JSON.parse(stripBom(content)))
      .catch(() => null),
    fetchLiveClaudeUsage(),
  ]);
  // The newer reading wins per window; the older one still fills windows the newer lacks.
  const readings = [state?.cachedUsageUtilization, live]
    .filter((r) => r?.utilization && Number.isFinite(r.fetchedAtMs))
    .sort((a, b) => a.fetchedAtMs - b.fetchedAtMs);
  if (!readings.length) return state;
  const utilization = {};
  for (const r of readings) for (const [key, w] of Object.entries(r.utilization)) if (w) utilization[key] = w;
  return { ...state, cachedUsageUtilization: { fetchedAtMs: readings.at(-1).fetchedAtMs, utilization } };
}

async function readClaudeUsage(claudeState) {
  const cachePath = path.join(claudeConfigPath(), 'usage-cache.json');
  let cacheUsage = null;
  try {
    const parsed = parseClaudeCache(JSON.parse(stripBom(await fs.promises.readFile(cachePath, 'utf8'))));
    if (parsed) cacheUsage = { ...parsed, source: cachePath };
  } catch {
    // The cache may not exist yet or be locked for a moment.
  }
  const parsedState = claudeState && parseClaudeFiveHourState(claudeState);
  const stateUsage = parsedState && { ...parsedState, source: path.join(claudeConfigPath(), '.claude.json') };

  if (cacheUsage && stateUsage) {
    if ((stateUsage.updatedAt || 0) > (cacheUsage.updatedAt || 0) + 5_000) {
      if (cacheUsage.model && !stateUsage.model) stateUsage.model = cacheUsage.model;
      return stateUsage;
    }
    return cacheUsage;
  }
  return cacheUsage || stateUsage || null;
}

async function listRecentCodexSessionFiles() {
  const files = [];
  const root = codexSessionsPath();
  for (let daysBack = 0; daysBack < 3; daysBack += 1) {
    const date = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const directory = path.join(root, String(date.getFullYear()), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0'));
    try {
      for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
        const filePath = path.join(directory, entry.name);
        try {
          files.push({ filePath, mtimeMs: (await fs.promises.stat(filePath)).mtimeMs });
        } catch {
          // A session can move while Codex archives it.
        }
      }
    } catch {
      // No directory for a day Codex did not run.
    }
  }
  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, 20);
}

async function readFileTail(filePath) {
  const handle = await fs.promises.open(filePath, 'r');
  try {
    const { size } = await handle.stat();
    const length = Math.min(size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    return buffer.toString('utf8');
  } finally {
    await handle.close();
  }
}

async function readCodexUsage() {
  try {
    const candidates = [];
    for (const file of await listRecentCodexSessionFiles()) {
      try {
        const usage = findLatestCodexRateLimit(await readFileTail(file.filePath));
        if (!usage) continue;
        const observedAt = usage.observedAt ? Date.parse(usage.observedAt) : file.mtimeMs;
        candidates.push({ ...usage, observedAtMs: Number.isFinite(observedAt) ? observedAt : file.mtimeMs, source: file.filePath });
      } catch {
        // Concurrent writes and archive moves are not errors.
      }
    }
    candidates.sort((left, right) => right.observedAtMs - left.observedAtMs);
    return candidates[0] || null;
  } catch {
    return null;
  }
}

// ---- Snapshot and live updates ----------------------------------------------------------------------------

// The caches are snapshots: a window whose reset time has passed has refilled since, so it reads as full.
function refilled(window, nowMs = Date.now()) {
  if (!window || !(window.resetsAt * 1000 <= nowMs)) return window;
  return { ...window, used: 0, remaining: 100, resetsAt: null };
}

// Claude's snapshots only come from Claude Code (or our fetch with its token). One taken before the window
// reset says nothing about use since, so it is "waiting for data" rather than a made-up 100% left.
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

/**
 * Live Antigravity model pools, Claude Code and Codex readings.
 * @param {{ readAntigravity?: () => Promise<object>, readGemini?: () => Promise<object|null> }} [sources] swap the language-server read (tests).
 */
async function getQuotas({ readAntigravity = readAntigravityUsage, readGemini, readCopilot = readGemini ? async () => null : readCopilotUsage } = {}) {
  const [antigravity, claudeState, codexUsage, copilotUsage] = await Promise.all([
    readGemini ? readGemini().then(gemini => ({ gemini })) : readAntigravity(), readClaudeState(), readCodexUsage(), readCopilot().catch(() => null),
  ]);
  const claudeUsage = await readClaudeUsage(claudeState);
  const now = Date.now();
  // A weekly snapshot from before its reset is simply unknown (the 5h window carries the "waiting" state).
  const weekly = (key) => {
    const window = parseClaudeWeeklyState(claudeState, key);
    return claudeWindow(window, now)?.stale ? null : window;
  };
  return {
    gemini: withRefills(antigravity.gemini, now),
    antigravityClaudeGpt: withRefills(antigravity.antigravityClaudeGpt, now),
    antigravityArgon: withRefills(antigravity.antigravityArgon, now),
    claude: claudeWindow(claudeUsage, now),
    claudeWeekly: weekly('seven_day'),
    claudeOpus: weekly('seven_day_opus'),
    codex: withRefills(codexUsage, now),
    copilot: copilotUsage,
  };
}

// One shared poll for every listener, running only while somebody listens.
const quotaEvents = new EventEmitter();
let timer = null;
let polling = false;
async function poll() {
  if (polling) return;
  polling = true;
  try { quotaEvents.emit('change', await getQuotas()); } catch { /* the next tick tries again */ } finally { polling = false; }
}

/** @returns {{dispose: () => void}} */
function onDidChangeQuotas(listener) {
  quotaEvents.on('change', listener);
  if (!timer) {
    timer = setInterval(() => void poll(), POLL_INTERVAL_MS);
    void poll();
  }
  return {
    dispose() {
      quotaEvents.off('change', listener);
      if (!quotaEvents.listenerCount('change') && timer) { clearInterval(timer); timer = null; }
    },
  };
}

module.exports = {
  getQuotas,
  onDidChangeQuotas,
  parseAntigravityQuota,
  parseClaudeCache,
  parseClaudeFiveHourState,
  parseClaudeWeeklyState,
  findLatestCodexRateLimit,
  refilled,
};
