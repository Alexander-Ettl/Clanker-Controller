'use strict';

// Is a CLI paid for by a subscription (usage windows, no per-prompt charge) or billed per token through an API key?
// The session warm-up only makes sense for the first; for the second every ping is real money. Reads only which sign-in
// each CLI uses, never a credential's value. A subscription must be positively seen (Claude, Codex); Antigravity has no
// readable sign-in file, so it counts as a subscription unless a Google API key or Vertex is configured.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const set = (env, ...names) => names.some((name) => String(env[name] ?? '').trim() && !/^(0|false)$/i.test(String(env[name]).trim()));
const readJson = (file) => { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')); } catch { return null; } };

/** true when `agent` is signed in with a subscription and nothing makes it bill per token. */
function subscriptionBilled(agent, { env = process.env, home = os.homedir(), readFile = readJson } = {}) {
  if (agent === 'claude') {
    if (set(env, 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX', 'CLAUDE_CODE_USE_FOUNDRY')) return false;
    // The same folders the quota reader tries: the configured one, Claude's default, and the synced config folder.
    const dirs = [env.CLAUDE_CONFIG_DIR, path.join(home, '.claude'), path.join(home, 'Nextcloud', 'ClaudeConfig')].filter(Boolean);
    const settings = dirs.map((dir) => readFile(path.join(dir, 'settings.json')));
    if (settings.some((item) => item?.apiKeyHelper || item?.env?.ANTHROPIC_API_KEY || item?.env?.ANTHROPIC_AUTH_TOKEN)) return false;
    return dirs.some((dir) => readFile(path.join(dir, '.credentials.json'))?.claudeAiOauth || readFile(path.join(dir, '.claude.json'))?.oauthAccount);
  }
  if (agent === 'codex') {
    if (set(env, 'CODEX_API_KEY', 'OPENAI_API_KEY')) return false;
    const auth = readFile(path.join(env.CODEX_HOME || path.join(home, '.codex'), 'auth.json'));
    return /^chatgpt/i.test(String(auth?.auth_mode || '')) && !auth?.OPENAI_API_KEY;
  }
  return !set(env, 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'GOOGLE_GENAI_USE_VERTEXAI');
}

module.exports = { subscriptionBilled };
