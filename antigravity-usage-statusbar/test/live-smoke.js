'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  findLatestCodexRateLimit,
  formatVisualStatus,
  parseClaudeCache,
  parseClaudeFiveHourState,
  parseClaudeWeeklyState,
} = require('../usage');

const claudeConfigPath =
  process.env.CLAUDE_CONFIG_DIR ||
  path.join(os.homedir(), 'Nextcloud', 'ClaudeConfig');
const claudePath = path.join(claudeConfigPath, 'usage-cache.json');
const claudeStatePath = path.join(claudeConfigPath, '.claude.json');
const sessionsPath = path.join(os.homedir(), '.codex', 'sessions');

function collectJsonl(directory, results = []) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collectJsonl(entryPath, results);
    if (entry.isFile() && entry.name.endsWith('.jsonl')) {
      results.push({
        filePath: entryPath,
        mtimeMs: fs.statSync(entryPath).mtimeMs,
      });
    }
  }
  return results;
}

let claude = null;
try {
  claude = parseClaudeCache(JSON.parse(fs.readFileSync(claudePath, 'utf8')));
} catch {}
if (!claude) {
  try {
    claude = parseClaudeFiveHourState(JSON.parse(fs.readFileSync(claudeStatePath, 'utf8')));
  } catch {}
}
const claudeWeekly = parseClaudeWeeklyState(
  JSON.parse(fs.readFileSync(claudeStatePath, 'utf8')),
);
const sessions = collectJsonl(sessionsPath).sort(
  (left, right) => right.mtimeMs - left.mtimeMs,
);
let codex = null;
for (const session of sessions.slice(0, 20)) {
  codex = findLatestCodexRateLimit(fs.readFileSync(session.filePath, 'utf8'));
  if (codex) break;
}

if (!claude || !codex) process.exitCode = 1;
console.log(
  claude
    ? formatVisualStatus('Claude', claude, claudeWeekly)
    : 'Claude: no data',
);
console.log(
  codex
    ? formatVisualStatus('Codex', codex, codex.secondary)
    : 'Codex: no data',
);
