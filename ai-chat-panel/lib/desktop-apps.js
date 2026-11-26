'use strict';

// Desktop apps that ship their own engine (the ChatGPT/Codex app, Claude Desktop) and are installed from an apt
// repository on Linux. Everything is read without root: the installed version from dpkg, the repository from
// `apt-cache policy`, and the newest version from the repository's public `Packages` index. The only step that needs the
// system password is the update itself, which goes through `pkexec`: the desktop shows its own dialog and Clanker
// never sees the password. Other installs (Store, winget, Sparkle, tarballs) are not handled here and report nothing.

const fs = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SOURCE_DIR = '/etc/apt/sources.list.d';
const PACKAGE_NAME = /^[a-z0-9][a-z0-9+.-]{1,100}$/;

/** Per provider: the apt packages that can be its desktop app, and the folder its bundled CLI lives in. */
const APPS = {
  codex: { name: 'ChatGPT', packages: ['chatgpt'], bundledDirs: ['/usr/lib/chatgpt/'] },
  claude: { name: 'Claude Desktop', packages: ['claude-desktop'], bundledDirs: ['/usr/lib/claude-desktop/', '/opt/Claude/'] },
  // Google ships Antigravity 2.x only as a tarball; the .deb packages come from a third-party apt repository (or Google's
  // legacy 1.x one). Only a copy the user installed through apt is found here. All of its installed packages are upgraded together.
  gemini: { name: 'Antigravity', packages: ['antigravity-ide', 'antigravity'], bundledDirs: [] },
};

function isNewer(latest, current) {
  const a = String(latest || '').split(/[.+~-]/).map((part) => parseInt(part, 10) || 0);
  const b = String(current || '').split(/[.+~-]/).map((part) => parseInt(part, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  return false;
}

/** Runs a command to completion with stdin closed; never rejects. */
function run(file, args, { timeout = 15000, onLine } = {}) {
  return new Promise((resolve) => {
    const child = execFile(file, args, { timeout, windowsHide: true, maxBuffer: 16 << 20, env: { ...process.env, LC_ALL: 'C' } },
      (error, stdout, stderr) => resolve({ ok: !error, code: error ? (Number.isInteger(error.code) ? error.code : null) : 0, stdout: String(stdout), stderr: String(stderr || '') }));
    child.stdin?.on('error', () => {});
    child.stdin?.end();
    if (onLine) for (const stream of [child.stdout, child.stderr]) stream?.on('data', (chunk) => String(chunk).split(/\r?\n/).map((line) => line.trim()).filter(Boolean).forEach(onLine));
  });
}

/** `apt-cache policy <pkg>`: the installed and candidate versions, and the first network repository that carries it. */
function parsePolicy(text) {
  const installed = /^\s*Installed:\s*(\S+)/m.exec(text)?.[1];
  const candidate = /^\s*Candidate:\s*(\S+)/m.exec(text)?.[1];
  const repo = /^\s+\d+\s+(https?:\/\/\S+)\s+([^\s/]+)\/(\S+)\s+(\S+)\s+Packages\s*$/m.exec(text);
  return {
    installed: installed && installed !== '(none)' ? installed : null,
    candidate: candidate && candidate !== '(none)' ? candidate : null,
    repo: repo ? { uri: repo[1].replace(/\/+$/, ''), suite: repo[2], component: repo[3], arch: repo[4] } : null,
  };
}

/** The `Packages` stanza for one package: its newest `Version` and `Size`. */
function parsePackagesIndex(text, pkg) {
  let best = null;
  for (const stanza of String(text).split(/\r?\n\r?\n/)) {
    if (new RegExp(`^Package:\\s*${pkg.replace(/[.+]/g, '\\$&')}\\s*$`, 'm').test(stanza)) {
      const version = /^Version:\s*(\S+)/m.exec(stanza)?.[1];
      const size = Number(/^Size:\s*(\d+)/m.exec(stanza)?.[1]) || null;
      if (version && (!best || isNewer(version, best.version))) best = { version, size };
    }
  }
  return best;
}

/** The apt source file that serves `uri` (deb822 `.sources` or one-line `.list`), or null. */
function findSourceFile(uri, dir = SOURCE_DIR) {
  const wanted = String(uri).replace(/\/+$/, '');
  let names = [];
  try { names = fs.readdirSync(dir).filter((name) => /\.(sources|list)$/.test(name)).sort(); } catch { return null; }
  for (const name of names) {
    const file = path.join(dir, name);
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const uris = name.endsWith('.sources')
      ? [...text.matchAll(/^URIs:\s*(.+)$/gim)].flatMap((match) => match[1].split(/\s+/))
      : [...text.matchAll(/^\s*deb(?:-src)?\s+(?:\[[^\]]*\]\s+)?(\S+)/gim)].map((match) => match[1]);
    if (uris.some((candidate) => candidate.replace(/\/+$/, '') === wanted)) return file;
  }
  return null;
}

/**
 * The desktop app for a provider, when one is installed from an apt repository: { name, package, version, candidate, repo,
 * sourceFile }. Null on any other platform or install.
 */
async function detectApp(agent, { exec = run, platform = process.platform, sourceDir = SOURCE_DIR } = {}) {
  const app = APPS[agent];
  if (!app || platform !== 'linux') return null;
  let found = null;
  const packages = [];
  for (const pkg of app.packages) {
    const installed = await exec('dpkg-query', ['-W', '-f=${db:Status-Abbrev}\t${Version}', pkg]);
    const [status, version] = installed.ok ? installed.stdout.split('\t') : [];
    if (!/^ii/.test(status || '') || !version) continue;
    packages.push(pkg);
    if (found) continue;
    const policy = parsePolicy((await exec('apt-cache', ['policy', pkg])).stdout);
    found = { agent, name: app.name, package: pkg, version: version.trim(), candidate: policy.candidate, repo: policy.repo,
      sourceFile: policy.repo ? findSourceFile(policy.repo.uri, sourceDir) : null };
  }
  return found && { ...found, packages };
}

/** The newest version the repository publishes: its `Packages` index, else apt's own candidate (as of the last `apt update`). */
async function latestAppVersion(app, fetchText) {
  if (app.repo) {
    try {
      const url = `${app.repo.uri}/dists/${app.repo.suite}/${app.repo.component}/binary-${app.repo.arch}/Packages`;
      const found = parsePackagesIndex(await fetchText(url), app.package);
      if (found) return { latest: found.version, size: found.size, error: null };
    } catch { /* fall back to apt's own candidate below */ }
  }
  return { latest: app.candidate, size: null, error: app.candidate ? null : 'The repository did not report a version' };
}

/** Every provider's installed desktop app with its newest version: { [agent]: { name, package, version, latest, outdated, error } }. */
async function checkApps({ exec = run, fetchText, platform, sourceDir } = {}) {
  const result = {};
  await Promise.all(Object.keys(APPS).map(async (agent) => {
    const app = await detectApp(agent, { exec, platform, sourceDir });
    if (!app) return;
    const { latest, size, error } = await latestAppVersion(app, fetchText);
    result[agent] = { name: app.name, package: app.package, version: app.version, latest, size, error, outdated: Boolean(latest && isNewer(latest, app.version)) };
  }));
  return result;
}

/** True when this binary is the copy bundled inside the provider's desktop app: that app, not the CLI's updater, replaces it. */
function isBundledBinary(agent, file) {
  return Boolean(file && APPS[agent]?.bundledDirs.some((dir) => String(file).startsWith(dir)));
}

/**
 * Upgrades one app through the system's privilege dialog. Only that package and, when known, only its own repository
 * are refreshed, so the user's other package lists are left alone. The arguments go to the shell as positional
 * parameters, never as part of the script.
 * @returns {Promise<{ ok: boolean, message: string, version?: string }>}
 */
async function updateApp(agent, { exec = run, onLine, platform, sourceDir, timeout = 20 * 60 * 1000 } = {}) {
  const app = await detectApp(agent, { exec, platform, sourceDir });
  if (!app) return { ok: false, message: `${APPS[agent]?.name || 'The app'} is not installed from an apt repository` };
  if (!app.packages.every((pkg) => PACKAGE_NAME.test(pkg))) return { ok: false, message: 'Unexpected package name' };
  const refresh = app.sourceFile && path.isAbsolute(app.sourceFile) && !/[\r\n\0'"$`;&|<>]/.test(app.sourceFile)
    ? 'apt-get update -o Dir::Etc::sourcelist="$src" -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 && ' : '';
  // "$1" is the source file (or empty); the installed package names follow it.
  const script = `src="$1"; shift; ${refresh}DEBIAN_FRONTEND=noninteractive apt-get install --only-upgrade -y -o Dpkg::Options::=--force-confold -- "$@"`;
  const result = await exec('pkexec', ['/bin/sh', '-c', script, 'sh', app.sourceFile || '', ...app.packages], { timeout, onLine });
  // pkexec: 126 = the dialog was dismissed, 127 = not authorized or no agent to ask.
  if (!result.ok && (result.code === 126 || result.code === 127)) return { ok: false, message: 'Cancelled: the system password was not given' };
  const after = await detectApp(agent, { exec, platform, sourceDir });
  if (!result.ok) {
    const lines = `${result.stderr}\n${result.stdout}`.split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !/^WARNING: apt/i.test(line));
    return { ok: false, message: lines.at(-1) || 'Update failed' };
  }
  return { ok: true, message: after && after.version !== app.version ? `Updated to ${after.version}. Restart ${app.name} to finish.` : 'Already up to date', version: after?.version };
}

module.exports = { APPS, isNewer, parsePolicy, parsePackagesIndex, findSourceFile, detectApp, latestAppVersion, checkApps, isBundledBinary, updateApp, run };
