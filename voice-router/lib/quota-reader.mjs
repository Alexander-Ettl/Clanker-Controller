'use strict';

// Synchronous port of tools/ai-chat-panel/lib/quota-sources.js.
// The panel reads async (fs.promises) because VS Code doesn't mind
// the latency; the router needs the same data inline in its <5ms quota-read stage,
// so every read here uses the *Sync fs variants instead.
//
// P12-F: the actual *parsing* (as opposed to the sync-vs-async file I/O,
// which genuinely has to differ) is no longer duplicated here -- it's
// require()'d straight from quota-sources.js (CommonJS, loadable from this ESM
// module via createRequire) so a bug fix like P11-I's weekly-quota
// fallback lands here automatically instead of needing a second,
// hand-applied patch to a second copy of the same logic.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { parseClaudeCache: parseClaudeCacheCanonical, parseClaudeWeeklyState: parseClaudeWeeklyStateCanonical, findLatestCodexRateLimit } =
  require('../../ai-chat-panel/lib/quota-sources.js');

const CODEX_TAIL_BYTES = 512 * 1024;
const CODEX_CANDIDATE_FILES = 5;

function claudeConfigDir() {
  return process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), 'Nextcloud', 'ClaudeConfig');
}

// Thin adapters: usage.js's canonical parsers return the full shape
// (windowMinutes, resetsAt, etc.) this module's own two call sites below
// have never needed -- they only ever read `.remaining`, so the adapter
// just narrows the return value rather than duplicating the parse itself.
function parseClaudeCache(value) {
  const parsed = parseClaudeCacheCanonical(value);
  return parsed ? { used: parsed.used, remaining: parsed.remaining } : null;
}

function parseClaudeWeeklyState(value) {
  const parsed = parseClaudeWeeklyStateCanonical(value);
  return parsed ? { used: parsed.used, remaining: parsed.remaining } : null;
}

function readJsonSync(filePath) {
  const content = fs.readFileSync(filePath, 'utf8').replace(/^﻿/, '');
  return JSON.parse(content);
}

function readClaude5hRemaining() {
  try {
    const usage = parseClaudeCache(readJsonSync(path.join(claudeConfigDir(), 'usage-cache.json')));
    return usage ? usage.remaining : null;
  } catch {
    return null;
  }
}

function readClaude7dRemaining() {
  try {
    const weekly = parseClaudeWeeklyState(readJsonSync(path.join(claudeConfigDir(), '.claude.json')));
    return weekly ? weekly.remaining : null;
  } catch {
    return null;
  }
}

function dateDirectory(root, date) {
  return path.join(
    root,
    String(date.getFullYear()),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  );
}

function listRecentCodexSessionFiles() {
  const root = path.join(os.homedir(), '.codex', 'sessions');
  const files = [];
  const directories = new Set();
  for (let daysBack = 0; daysBack < 3; daysBack += 1) {
    directories.add(dateDirectory(root, new Date(Date.now() - daysBack * 86_400_000)));
  }

  for (const directory of directories) {
    let entries;
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const stat = fs.statSync(filePath);
        files.push({ filePath, mtimeMs: stat.mtimeMs });
      } catch {
        // Session can move mid-scan while Codex archives it.
      }
    }
  }

  return files.sort((left, right) => right.mtimeMs - left.mtimeMs).slice(0, CODEX_CANDIDATE_FILES);
}

function readFileTailSync(filePath) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const stat = fs.fstatSync(fd);
    const length = Math.min(stat.size, CODEX_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, stat.size - length);
    return buffer.toString('utf8');
  } finally {
    fs.closeSync(fd);
  }
}

function readCodex5hRemaining() {
  try {
    const files = listRecentCodexSessionFiles();
    const candidates = [];

    for (const file of files) {
      let usage;
      try {
        usage = findLatestCodexRateLimit(readFileTailSync(file.filePath));
      } catch {
        continue;
      }
      if (!usage) continue;

      const parsedObservedAt = usage.observedAt ? Date.parse(usage.observedAt) : file.mtimeMs;
      candidates.push({
        ...usage,
        observedAtMs: Number.isFinite(parsedObservedAt) ? parsedObservedAt : file.mtimeMs,
      });
    }

    candidates.sort((left, right) => right.observedAtMs - left.observedAtMs);
    const newest = candidates[0];
    if (!newest) return null;
    if (newest.resetsAt !== null && newest.resetsAt * 1000 <= Date.now()) return null;
    return newest.remaining;
  } catch {
    return null;
  }
}

// Shared by every consumer that makes a routing decision off these
// percentages (groq-client.mjs's routeDecision, batch-synthesizer.mjs's
// synthesizeBatch) so the "what counts as low quota" number lives in one
// place, next to the values it's compared against.
export const LOW_QUOTA_THRESHOLD = 20;

/**
 * Reads live Claude + Codex quota percentages from disk, synchronously.
 * Falls back to 100% (healthy) for any source that can't be read, so a
 * missing cache never blocks routing — it just loses the override signal.
 */
export function readQuotas() {
  const claude5hRemainingPct = readClaude5hRemaining();
  const claude7dRemainingPct = readClaude7dRemaining();
  const codex5hRemainingPct = readCodex5hRemaining();

  return {
    claude5hRemainingPct: claude5hRemainingPct ?? 100,
    claude7dRemainingPct: claude7dRemainingPct ?? 100,
    codex5hRemainingPct: codex5hRemainingPct ?? 100,
    geminiStatus: 'healthy',
  };
}
