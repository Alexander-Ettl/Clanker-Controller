'use strict';

/**
 * The "/" menu: every command the background CLIs and IDEs themselves offer,
 * read dynamically, never a hardcoded list:
 * - Codex: the installed App Server request schema (lib/codex-commands.js).
 * - Claude Code: live `init` event slash_commands probe + ~/.claude & workspace skills/commands.
 * - Antigravity (Gemini): live Connect-RPC query to Gemini IDE's LanguageServer
 *   GetSlashCommands endpoint + global & workspace skills pool (including antigravity-code-review).
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { locate, resolveShim } = require('./binary-locator.js');
const { fetchAntigravitySlashCommands } = require('./antigravity.js');

const PROBE_EVERY_MS = 30 * 60 * 1000;

/**
 * Claude Code's own list without waiting for a real turn: start it pointed at a
 * dead local API address, read the init event it prints before any request, and
 * stop it. Nothing leaves the machine and no usage is spent.
 */
function probeClaudeCommands(cwd) {
  const binary = locate('claude').path;
  if (!binary) return Promise.resolve(null);
  const shim = process.platform === 'win32' && /\.cmd$/i.test(binary) ? resolveShim(binary) : null;
  return new Promise((resolve) => {
    let child;
    let buffer = '';
    const done = (list) => { clearTimeout(timer); try { child?.kill(); } catch { /* already gone */ } resolve(list); };
    const timer = setTimeout(() => done(null), 20000);
    try {
      child = spawn(shim?.command || binary, [...(shim?.args || []), '-p', 'x', '--output-format', 'stream-json', '--verbose'], {
        cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...process.env, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' },
      });
    } catch { return done(null); }
    child.on('error', () => done(null));
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      for (const line of buffer.split('\n').slice(0, -1)) {
        try { const event = JSON.parse(line); if (event.type === 'system' && event.subtype === 'init') return done(event.slash_commands || null); } catch { /* not JSON */ }
      }
      buffer = buffer.slice(buffer.lastIndexOf('\n') + 1);
    });
    child.on('exit', () => done(null));
  });
}

function frontmatterDescription(file) {
  try {
    const head = fs.readFileSync(file, 'utf8').slice(0, 4000);
    const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(head);
    if (!fm) return '';
    const descMatch = /^description:\s*([^\r\n]*)/m.exec(fm[1]);
    if (!descMatch) return '';
    let val = descMatch[1].trim().replace(/^["']|["']$/g, '');
    if (/^[>|][+-]?$/.test(val)) {
      const rest = fm[1].slice(descMatch.index + descMatch[0].length);
      const lines = [];
      for (const line of rest.split(/\r?\n/)) {
        if (/^[ \t]+/.test(line)) lines.push(line.trim());
        else if (line.trim() === '') continue;
        else break;
      }
      val = lines.join(' ');
    }
    return val;
  } catch { return ''; }
}

/** ~/.claude/commands/git/commit.md -> "git:commit"; skills/<name>/SKILL.md -> "<name>". */
function claudeCommandsOnDisk(roots) {
  const found = new Map();
  const walk = (dir, prefix) => {
    let items = [];
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const full = path.join(dir, item.name);
      if (item.isDirectory()) walk(full, `${prefix}${item.name}:`);
      else if (item.name.endsWith('.md')) found.set(`${prefix}${item.name.slice(0, -3)}`, frontmatterDescription(full));
    }
  };
  for (const root of roots) {
    walk(path.join(root, 'commands'), '');
    let skills = [];
    try { skills = fs.readdirSync(path.join(root, 'skills'), { withFileTypes: true }); } catch { /* none */ }
    for (const skill of skills) {
      const file = path.join(root, 'skills', skill.name, 'SKILL.md');
      if (skill.isDirectory() && fs.existsSync(file)) found.set(skill.name, frontmatterDescription(file));
    }
  }
  return found;
}

/**
 * Scans directories for Antigravity / Gemini skills (e.g. .agents/skills, ~/.gemini/config/skills).
 * Any folder containing a SKILL.md becomes a slash command.
 */
function geminiCommandsOnDisk(roots) {
  const found = new Map();
  const visited = new Set();
  for (const root of roots) {
    if (!root) continue;
    const candidates = [root, path.join(root, 'skills')];
    for (const dir of candidates) {
      if (visited.has(dir)) continue;
      visited.add(dir);
      let items = [];
      try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const item of items) {
        if (!item.isDirectory()) continue;
        const file = path.join(dir, item.name, 'SKILL.md');
        if (fs.existsSync(file)) {
          const desc = frontmatterDescription(file);
          if (!found.has(item.name) || (!found.get(item.name) && desc)) {
            found.set(item.name, desc);
          }
        }
      }
    }
  }
  return found;
}

class SlashCommandCatalog {
  constructor({
    codexCommands,
    workspaceDir,
    cacheFile,
    claudeHome = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'),
    geminiHome = path.join(os.homedir(), '.gemini', 'config'),
    probe = probeClaudeCommands,
    probeGemini = fetchAntigravitySlashCommands,
  }) {
    this.codexCommands = codexCommands;
    this.cacheFile = cacheFile;
    this.workspaceDir = workspaceDir;
    this.probe = probe;
    this.probeGemini = probeGemini;
    this.probedAt = 0;
    this.probing = null;
    this.geminiProbedAt = 0;
    this.probingGemini = null;
    this.roots = [claudeHome, workspaceDir && path.join(workspaceDir, '.claude')].filter(Boolean);
    this.geminiRoots = [
      geminiHome,
      path.join(geminiHome, 'skills'),
      path.join(os.homedir(), '.gemini', 'antigravity-cli', 'builtin', 'skills'),
      path.join(os.homedir(), '.agents', 'skills'),
      workspaceDir && path.join(workspaceDir, '.agents', 'skills'),
      workspaceDir && path.join(workspaceDir, '.agent', 'skills'),
    ].filter(Boolean);

    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(cacheFile, 'utf8')) || {}; } catch { cache = {}; }
    this.claudeLive = Array.isArray(cache.claude) ? cache.claude : [];
    this.geminiLive = Array.isArray(cache.gemini) ? cache.gemini : [];
  }

  _persistCache() {
    try {
      let existing = {};
      try { existing = JSON.parse(fs.readFileSync(this.cacheFile, 'utf8')) || {}; } catch {}
      existing.claude = this.claudeLive;
      existing.gemini = this.geminiLive;
      fs.mkdirSync(path.dirname(this.cacheFile), { recursive: true });
      fs.writeFileSync(this.cacheFile, JSON.stringify(existing, null, 2));
    } catch { /* best effort */ }
  }

  /** From a Claude run's init event: the authoritative list for headless Claude Code. */
  recordClaude(names) {
    const list = [...new Set((Array.isArray(names) ? names : []).map((name) => String(name).replace(/^\//, '')).filter(Boolean))].sort();
    if (!list.length || list.join('\n') === this.claudeLive.join('\n')) return false;
    this.claudeLive = list;
    this._persistCache();
    return true;
  }

  recordGemini(commands) {
    const list = Array.isArray(commands)
      ? commands
          .map((c) => ({
            name: String(c.name || '').replace(/^\//, ''),
            description: c.description || c.title || '',
          }))
          .filter((c) => c.name)
      : [];
    if (!list.length) return false;
    const map = new Map();
    for (const c of list) {
      const key = c.name.toLowerCase();
      if (!map.has(key) || (!map.get(key).description && c.description)) {
        map.set(key, c);
      }
    }
    const clean = [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
    if (JSON.stringify(clean) === JSON.stringify(this.geminiLive)) return false;
    this.geminiLive = clean;
    this._persistCache();
    return true;
  }

  claude() {
    const disk = claudeCommandsOnDisk(this.roots);
    const names = new Set([...this.claudeLive, ...disk.keys()]);
    return [...names].sort().map((name) => ({ name, description: disk.get(name) || '', agent: 'claude' }));
  }

  gemini() {
    const disk = geminiCommandsOnDisk(this.geminiRoots);
    const byName = new Map();

    // 1. Live / cached commands from the Gemini IDE library of comments (GetSlashCommands RPC)
    for (const cmd of this.geminiLive) {
      byName.set(cmd.name.toLowerCase(), {
        name: cmd.name,
        description: cmd.description || '',
        agent: 'gemini',
      });
    }

    // 2. Existing skills from the Skills Pool (including antigravity-code-review)
    for (const [name, desc] of disk.entries()) {
      const key = name.toLowerCase();
      if (!byName.has(key)) {
        byName.set(key, { name, description: desc, agent: 'gemini' });
      } else if (desc && !byName.get(key).description) {
        byName.get(key).description = desc;
      }
    }

    // 3. User convenience alias: /grillme for /grill-me
    if (byName.has('grill-me') && !byName.has('grillme')) {
      byName.set('grillme', {
        name: 'grillme',
        description: byName.get('grill-me').description || 'Interview me to align on a plan (alias for /grill-me)',
        agent: 'gemini',
      });
    }

    return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Ask Claude for its list: awaited when nothing is known yet, else refreshed in the background every 30 min. */
  refreshClaude() {
    if (this.probing || Date.now() - this.probedAt < PROBE_EVERY_MS) return this.probing;
    this.probedAt = Date.now();
    this.probing = this.probe(this.workspaceDir).then((list) => { this.recordClaude(list); }).catch(() => {}).finally(() => { this.probing = null; });
    return this.probing;
  }

  /** Ask Antigravity IDE LanguageServer for its slash commands list via Connect-RPC. */
  refreshGemini() {
    if (this.probingGemini || Date.now() - this.geminiProbedAt < PROBE_EVERY_MS) return this.probingGemini;
    this.geminiProbedAt = Date.now();
    this.probingGemini = Promise.resolve(this.probeGemini(this.workspaceDir))
      .then((commands) => {
        if (commands && commands.length) this.recordGemini(commands);
      })
      .catch(() => {})
      .finally(() => {
        this.probingGemini = null;
      });
    return this.probingGemini;
  }

  async list() {
    const refreshingClaude = this.refreshClaude();
    if (!this.claudeLive.length && refreshingClaude) await refreshingClaude;
    const refreshingGemini = this.refreshGemini();
    if (!this.geminiLive.length && refreshingGemini) await refreshingGemini;

    const codex = (await this.codexCommands.list()).map((command) => ({ ...command, agent: 'codex' }));
    // The panel's own command (headless runs can't do it; extension.js starts it in a terminal).
    // `panel` ones are Clanker's own and show under every model (main.js handles them before anything is sent).
    const panel = [
      { name: 'remote-control', description: 'Continue this chat from the Claude app on your phone', agent: 'claude' },
      { name: 'undo', description: 'Put the last turn\'s file changes back (asks first)', agent: 'claude', panel: true },
      { name: 'verify', description: 'Auto-Verify on/off; /verify npm test pins the check to run', agent: 'claude', panel: true },
      { name: 'architect', description: 'One model plans, another builds: /architect <task>', agent: 'claude', panel: true },
    ];
    return [
      ...panel,
      ...this.claude().filter((command) => command.name !== 'remote-control'),
      ...codex,
      ...this.gemini(),
    ];
  }

  /** Which CLI runs "/name ...": an explicit model never borrows another provider's command. */
  async owner(text, preferred) {
    const name = /^\/([^\s]+)/.exec(String(text || '').trim())?.[1]?.toLowerCase();
    if (!name) return null;
    if (preferred === 'codex') return (await this.codexCommands.list()).some((command) => command.name.toLowerCase() === name) ? 'codex' : null;
    if (preferred === 'claude') {
      const refreshing = this.refreshClaude();
      if (!this.claudeLive.length && refreshing) await refreshing;
      return this.claude().some((command) => command.name.toLowerCase() === name) ? 'claude' : null;
    }
    if (preferred === 'gemini') {
      const refreshing = this.refreshGemini();
      if (!this.geminiLive.length && refreshing) await refreshing;
      return this.gemini().some((command) => command.name.toLowerCase() === name) ? 'gemini' : null;
    }
    const owners = (await this.list()).filter((command) => command.name.toLowerCase() === name).map((command) => command.agent);
    return owners[0] || null;
  }
}

module.exports = { SlashCommandCatalog, claudeCommandsOnDisk, geminiCommandsOnDisk, frontmatterDescription };
