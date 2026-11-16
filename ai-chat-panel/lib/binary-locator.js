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

const isExecutable = (file) => { try { fs.accessSync(file, fs.constants.X_OK); return isFile(file); } catch { return false; } };
const WIN = process.platform === 'win32';

// P17-O: walks PATH in-process (what where.exe did, minus a console subprocess per lookup).
// Elsewhere the CLIs are bare executables (e.g. ~/.local/bin/claude from install.sh).
function onPath(name) {
  const dirs = (process.env.PATH || process.env.Path || '').split(path.delimiter).map((dir) => dir.trim().replace(/^"|"$/g, '')).filter(Boolean);
  if (!WIN) return dirs.map((dir) => path.join(dir, name)).filter(isExecutable);
  return dirs.flatMap((dir) => ['.exe', '.cmd'].map((ext) => path.join(dir, name + ext))).filter(isFile);
}

/** Providers list Windows paths; off Windows `foo.exe` is just `foo`, and npm `.cmd` shims don't exist. */
const forPlatform = (file) => (WIN ? [file] : /\.cmd$/i.test(file) ? [] : [file.replace(/\.exe$/i, '').replace(/windows-x86_64/, `linux-${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}`)]);

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
  return provider.locate({ onPath, inExtensions, join: path.join, home: os.homedir(), local, npmGlobal }).flatMap(forPlatform);
}

const cache = new Map();

/** @returns {{ agent: string, path: string | null, checked: string[] }} */
function locate(agent) {
  if (!cache.has(agent)) {
    const checked = [...new Set(candidates(agent))];
    cache.set(agent, { agent, path: checked.find(WIN ? isFile : isExecutable) || null, checked });
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

/** Terminal line for a resolved binary: PowerShell's call operator on Windows, a quoted path elsewhere. */
function terminalCommand(agent, args = '') {
  const found = locate(agent).path;
  const bin = found ? (WIN ? `& "${found}"` : `'${found.replace(/'/g, `'\\''`)}'`) : providers.get(agent)?.cli || agent;
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

/**
 * Environment for running a CLI headless. Every agy start spawns its own background updater when the last check is over 15
 * minutes old, and on Windows that opens a visible terminal window. Clanker updates the CLIs itself (`agy update` still works
 * with this set), so agy is told not to. Only the exact value `true` counts: `1` is ignored.
 */
const headlessEnv = (file) => {
  // ANTIGRAVITY_NO_CHIME silences ~/.gemini/config/hooks.json's Stop hook; Clanker plays the chime once when the reply renders.
  if (/(?:^|[\\/])agy(?:\.exe|\.cmd)?$/i.test(String(file))) return { AGY_CLI_DISABLE_AUTO_UPDATE: 'true', ANTIGRAVITY_NO_CHIME: '1' };
  // Older codex launchers only flag an npm install when npm itself started them, so `codex update` run from here
  // (no npm_config_user_agent) failed with "Could not detect the Codex installation method".
  if (/(?:^|[\\/])codex\.cmd$/i.test(String(file))) return { CODEX_MANAGED_BY_NPM: '1' };
  return {};
};

module.exports = { locate, refresh, resolveShim, terminalCommand, candidates, headlessEnv, BinaryNotFoundError };
