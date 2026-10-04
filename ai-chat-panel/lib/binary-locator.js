'use strict';

// P16-I: finds each agent CLI on *this* workstation instead of assuming one
// machine's layout. On a fresh sync nothing is guaranteed to be on PATH:
// Claude and Codex usually exist only inside the IDE's own extension folders
// (anthropic.claude-code-*/resources/native-binary/claude.exe,
// openai.chatgpt-*/bin/windows-x86_64/codex.exe). Resolved paths are cached;
// refresh() re-probes (extension activation, the "Auto-Locate" button).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const providers = require('./providers');

const EXTENSION_ROOTS = ['.antigravity-ide', '.antigravity', '.vscode'].map((dir) => path.join(os.homedir(), dir, 'extensions'));

const isFile = (file) => { try { return fs.statSync(file).isFile(); } catch { return false; } };

// P17-O: walks PATH in-process (what where.exe did, minus a console subprocess per lookup).
function onPath(name) {
  if (process.platform !== 'win32') return [];
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).map((dir) => dir.trim().replace(/^"|"$/g, '')).filter(Boolean);
  return dirs.flatMap((dir) => ['.exe', '.cmd'].map((ext) => path.join(dir, name + ext))).filter(isFile);
}

/** Newest-first `<extensions>/<prefix>*<rel>` across every IDE's extension dir. */
function inExtensions(prefix, rel) {
  const found = [];
  for (const root of EXTENSION_ROOTS) {
    let names;
    try { names = fs.readdirSync(root); } catch { continue; }
    for (const name of names) if (name.startsWith(prefix)) found.push({ name, file: path.join(root, name, rel) });
  }
  // Highest extension version first, whichever IDE's folder it sits in.
  return found.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true })).map((entry) => entry.file);
}

/** Where a provider's binary may be, best first: the provider's own `locate()` (lib/providers) given the helpers it needs. */
function candidates(agent) {
  const provider = providers.get(agent);
  if (!provider) return [];
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const npmGlobal = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'npm');
  return provider.locate({ onPath, inExtensions, join: path.join, home: os.homedir(), local, npmGlobal });
}

const cache = new Map();

/** @returns {{ agent: string, path: string | null, checked: string[] }} */
function locate(agent) {
  if (!cache.has(agent)) {
    const checked = [...new Set(candidates(agent))];
    cache.set(agent, { agent, path: checked.find(isFile) || null, checked });
  }
  return cache.get(agent);
}

function refresh() { cache.clear(); }

/**
 * P17-O: an npm .cmd shim only runs `node <pkg>/cli.js %*`. Spawning that
 * directly skips the cmd.exe (and its console) a shell: true spawn needs.
 * Null when the shim isn't that shape or node isn't on PATH.
 */
function resolveShim(cmdFile) {
  let text;
  try { text = fs.readFileSync(cmdFile, 'utf8'); } catch { return null; }
  const script = /"%dp0%\\([^"%]+\.[cm]?js)"/i.exec(text)?.[1];
  const node = onPath('node').find((file) => /\.exe$/i.test(file));
  if (!script || !node) return null;
  const entry = path.join(path.dirname(cmdFile), script);
  return isFile(entry) ? { command: node, args: [entry] } : null;
}

/** PowerShell terminal line for a resolved binary (the call operator handles spaces). */
function terminalCommand(agent, args = '') {
  const found = locate(agent).path;
  const bin = found ? `& "${found}"` : providers.get(agent)?.cli || agent;
  return args ? `${bin} ${args}` : bin;
}

class BinaryNotFoundError extends Error {
  constructor(result) {
    super(`Agent binary not found: "${result.agent}"`);
    this.code = 'AGENT_BINARY_NOT_FOUND';
    this.agent = result.agent;
    this.checked = result.checked;
  }
}

module.exports = { locate, refresh, resolveShim, terminalCommand, candidates, BinaryNotFoundError };
