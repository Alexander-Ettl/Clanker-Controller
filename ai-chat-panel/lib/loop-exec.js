'use strict';

// Process helpers shared by the loop engine: a child runner with an inactivity watchdog (a run is stopped when it goes quiet,
// not when a fixed wall clock runs out), command resolution for Windows (.cmd shims, npm), a counting semaphore and git.

const fs = require('node:fs');
const path = require('node:path');
const { spawn, execFileSync } = require('node:child_process');
const { resolveShim, headlessEnv } = require('./binary-locator');
const { killTree } = require('./stream-engine');

/** The real node.exe when there is one; inside the IDE `process.execPath` is Electron and needs ELECTRON_RUN_AS_NODE to behave as node. */
function nodeCommand() {
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    const file = path.join(dir.trim().replace(/^"|"$/g, ''), process.platform === 'win32' ? 'node.exe' : 'node');
    try { if (fs.statSync(file).isFile()) return { command: file, env: {} }; } catch { /* not here */ }
  }
  return { command: process.execPath, env: { ELECTRON_RUN_AS_NODE: '1' } };
}

/** npm without a shell: `node npm-cli.js` next to node.exe, else the .cmd shim's script. Null when neither exists. */
function npmCommand() {
  const node = nodeCommand();
  const beside = path.join(path.dirname(node.command), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (fs.existsSync(beside)) return { command: node.command, args: [beside], env: node.env };
  // Unix installs keep npm in <prefix>/lib/node_modules next to <prefix>/bin/node.
  const unix = path.join(path.dirname(node.command), '..', 'lib', 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (process.platform !== 'win32' && fs.existsSync(unix)) return { command: node.command, args: [unix], env: node.env };
  for (const dir of (process.env.PATH || process.env.Path || '').split(path.delimiter)) {
    const clean = dir.trim().replace(/^"|"$/g, '');
    if (!clean) continue;
    if (process.platform !== 'win32') {
      // Version managers (Volta, nvm, asdf) put an executable `npm` on PATH; it runs without a shell.
      const bin = path.join(clean, 'npm');
      try { fs.accessSync(bin, fs.constants.X_OK); if (fs.statSync(bin).isFile()) return { command: bin, args: [], env: node.env }; } catch { /* not here */ }
      continue;
    }
    const shim = path.join(clean, 'npm.cmd');
    if (fs.existsSync(shim)) { const resolved = resolveShim(shim); if (resolved) return { ...resolved, env: node.env }; }
  }
  return null;
}

/**
 * Runs a child and resolves `{code, output, stderr}`. Rejects on abort, on `timeoutMs` (hard cap) and on `idleMs` of silence.
 * `onActivity` fires on every chunk, which is how callers show liveness and reset their own clocks.
 */
function run(command, args, { cwd, signal, input = '', env, onLine, onActivity, timeoutMs = 600000, idleMs = 0, maxBytes = 4 * 1024 * 1024, onSpawn } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const child = spawn(command, args, { cwd, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], shell: false, env: env ? { ...process.env, ...env } : process.env });
    onSpawn?.(child.pid, path.basename(command));
    let output = '', stderr = '', pending = '', failure = null, bytes = 0, idle = null;
    const stop = error => { failure ||= error; killTree(child); };
    const abort = () => stop(signal.reason || new Error('Stopped'));
    signal?.addEventListener('abort', abort, { once: true });
    const timer = setTimeout(() => stop(new Error('Process time limit reached')), timeoutMs);
    const touch = () => {
      onActivity?.();
      if (!idleMs) return;
      clearTimeout(idle);
      idle = setTimeout(() => stop(new Error(`No activity for ${Math.round(idleMs / 60000)} minutes`)), idleMs);
    };
    touch();
    child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      touch();
      bytes += Buffer.byteLength(chunk); if (bytes > maxBytes) return stop(new Error('Process output limit reached'));
      output += chunk; pending += chunk;
      const lines = pending.split('\n'); pending = lines.pop();
      try { for (const line of lines) onLine?.(line); } catch (error) { stop(error); }
    });
    child.stderr.on('data', chunk => { touch(); stderr = (stderr + chunk).slice(-16000); });
    child.stdin.on('error', () => {}); child.stdin.end(input);
    child.on('error', error => { failure ||= error; });
    child.on('close', code => {
      clearTimeout(timer); clearTimeout(idle); signal?.removeEventListener('abort', abort);
      try { if (pending) onLine?.(pending); } catch (error) { failure ||= error; }
      if (failure) reject(failure); else resolve({ code, output, stderr });
    });
  });
}

/** `.cmd` and `.ps1` shims cannot be spawned directly on Windows; run them through the script they wrap, or cmd.exe as a last resort. */
function shimmed(file, args) {
  if (/\.cmd$/i.test(file)) {
    const shim = resolveShim(file);
    if (shim) return { command: shim.command, args: [...shim.args, ...args], env: nodeCommand().env };
    return { command: process.env.ComSpec || 'cmd.exe', args: ['/d', '/s', '/c', `"${file}"`, ...args], env: {} };
  }
  if (/\.ps1$/i.test(file)) return { command: 'powershell.exe', args: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], env: {} };
  return { command: file, args, env: headlessEnv(file) };
}

class Semaphore {
  constructor(size) { this.size = Math.max(1, size); this.used = 0; this.waiting = []; }
  /** Resolves with a release function. Rejects if the signal aborts while waiting. */
  acquire(signal) {
    if (signal?.aborted) return Promise.reject(signal.reason);
    if (this.used < this.size) { this.used++; return Promise.resolve(this.releaser()); }
    return new Promise((resolve, reject) => {
      const entry = { resolve: () => { signal?.removeEventListener('abort', onAbort); this.used++; resolve(this.releaser()); } };
      const onAbort = () => { this.waiting = this.waiting.filter(item => item !== entry); reject(signal.reason); };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
    });
  }
  releaser() { let done = false; return () => { if (done) return; done = true; this.used--; this.waiting.shift()?.resolve(); }; }
  resize(size) { this.size = Math.max(1, size); while (this.used < this.size && this.waiting.length) this.waiting.shift().resolve(); }
}

const git = (cwd, args, { allowFail = false } = {}) => {
  // Private snapshots and fix worktrees add enough nesting to exceed Windows' legacy path limit.
  // Apply this per command so existing workspaces and the initial `git init` are covered too.
  try { return execFileSync('git', ['-c', 'core.longpaths=true', ...args], { cwd, windowsHide: true, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).toString(); }
  catch (error) { if (allowFail) return ''; throw error; }
};

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  signal?.addEventListener('abort', onAbort, { once: true });
});

module.exports = { run, nodeCommand, npmCommand, shimmed, Semaphore, git, sleep };
