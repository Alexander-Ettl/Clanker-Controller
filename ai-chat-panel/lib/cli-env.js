'use strict';

// Prepares the environment inherited by spawned agent CLIs (agy, claude, codex, copilot):
// 1. Repairs or drops half-empty GIT_CONFIG_COUNT sets that break every `git` call inside child shells.
// 2. Appends VS Code / Antigravity IDE's bundled ripgrep (`rg`) directory to the END of PATH when
//    `rg` is not already available on PATH, so CLIs never fall back to slow scans or fail with
//    `rg: command not found` on machines without system ripgrep.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { repairGitConfigEnv } = require('./git-env.js');

let configuredAppRoot = '';
const rgDirCache = new Map();

function isUsableBinary(file, platform = process.platform) {
  try {
    if (!fs.statSync(file).isFile()) return false;
    if (platform !== 'win32') fs.accessSync(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathKeyOf(env, platform = process.platform) {
  if ('PATH' in env) return 'PATH';
  if (platform === 'win32' && 'Path' in env) return 'Path';
  return 'PATH';
}

function pathEntries(raw) {
  return String(raw || '')
    .split(path.delimiter)
    .map((dir) => dir.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** True when `name` is already executable on `env`'s PATH. */
function hasOnPath(name, env = process.env, { platform = process.platform } = {}) {
  const dirs = pathEntries(env[pathKeyOf(env, platform)]);
  const candidates = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const dir of dirs) {
    for (const bin of candidates) {
      if (isUsableBinary(path.join(dir, bin), platform)) return true;
    }
  }
  return false;
}

// Newest-first `<base>/<prefix>*/resources/app` directories (e.g. ~/.local/opt/vscode-1.147.0/resources/app).
function versionedAppRoots(base, prefix) {
  let names;
  try { names = fs.readdirSync(base); } catch { return []; }
  return names
    .filter((name) => name.startsWith(prefix))
    .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
    .map((name) => path.join(base, name, 'resources', 'app'));
}

function fallbackAppRoots({ platform = process.platform, home = os.homedir(), env = process.env } = {}) {
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const prog = env.ProgramFiles || 'C:\\Program Files';
    return [
      path.join(local, 'Programs', 'Microsoft VS Code', 'resources', 'app'),
      path.join(prog, 'Microsoft VS Code', 'resources', 'app'),
      path.join(local, 'Programs', 'Antigravity', 'resources', 'app'),
    ];
  }
  if (platform === 'darwin') {
    return [
      '/Applications/Visual Studio Code.app/Contents/Resources/app',
      '/Applications/Visual Studio Code - Insiders.app/Contents/Resources/app',
      '/Applications/Antigravity.app/Contents/Resources/app',
    ];
  }
  const localOpt = path.join(home, '.local', 'opt');
  return [
    ...versionedAppRoots(localOpt, 'vscode-'),
    ...versionedAppRoots(localOpt, 'antigravity-ide-'),
    '/usr/share/code/resources/app',
    '/usr/share/code-insiders/resources/app',
    '/usr/share/antigravity/resources/app',
  ];
}

function ripgrepSubdirs(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  return [
    path.join('node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', target),
    path.join('node_modules', '@vscode', 'ripgrep-universal', 'bin', target),
    path.join('node_modules.asar.unpacked', '@vscode', 'ripgrep', 'bin'),
    path.join('node_modules', '@vscode', 'ripgrep', 'bin'),
  ];
}

/** Register the running IDE's `vscode.env.appRoot` so bundled ripgrep lookup hits it first. */
function configureAppRoot(appRoot) {
  configuredAppRoot = typeof appRoot === 'string' ? appRoot.trim() : '';
  rgDirCache.clear();
}

/** Locates a directory containing VS Code / Antigravity's bundled `rg` binary, or null. */
function findBundledRipgrepDir({ appRoot = configuredAppRoot, platform = process.platform, arch = process.arch, home = os.homedir(), env = process.env, skipCache = false } = {}) {
  const key = `${appRoot || ''}|${platform}|${arch}|${home}`;
  if (!skipCache && rgDirCache.has(key)) return rgDirCache.get(key);
  const binName = platform === 'win32' ? 'rg.exe' : 'rg';
  const roots = [appRoot, ...fallbackAppRoots({ platform, home, env })].filter(Boolean);
  const subdirs = ripgrepSubdirs(platform, arch);
  let found = null;
  for (const root of new Set(roots)) {
    for (const rel of subdirs) {
      const dir = path.join(root, rel);
      if (isUsableBinary(path.join(dir, binName), platform)) { found = dir; break; }
    }
    if (found) break;
  }
  if (!skipCache) rgDirCache.set(key, found);
  return found;
}

/**
 * Returns a clean child-process environment clone with broken `GIT_CONFIG_*` variables repaired
 * and a fallback `rg` directory appended to the end of PATH if `rg` is not already on PATH.
 */
function prepareCliEnv(baseEnv = process.env, { appRoot = configuredAppRoot, rgDir, platform = process.platform, arch = process.arch } = {}) {
  const env = { ...(baseEnv || {}) };
  repairGitConfigEnv(env);
  if (!hasOnPath('rg', env, { platform })) {
    const dir = rgDir !== undefined ? rgDir : findBundledRipgrepDir({ appRoot, platform, arch, env });
    if (dir) {
      const key = pathKeyOf(env, platform);
      const current = pathEntries(env[key]);
      const normalized = platform === 'win32' ? dir.toLowerCase() : dir;
      const exists = current.some((entry) => (platform === 'win32' ? entry.toLowerCase() : entry) === normalized);
      if (!exists) env[key] = current.length ? `${env[key]}${path.delimiter}${dir}` : dir;
    }
  }
  return env;
}

module.exports = { configureAppRoot, findBundledRipgrepDir, hasOnPath, prepareCliEnv };
