'use strict';

const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const { locate, resolveShim } = require('./binary-locator.js');
const { cliTelemetry } = require('./cli-telemetry.js');
const { launchFailure } = require('./providers/shared.js');

const REQUEST_TIMEOUT_MS = 30000;

/**
 * Composer commands backed by stable App Server methods. This is also the
 * dispatch table, so the menu and execution path cannot drift apart. The
 * installed protocol schema decides which entries are actually advertised.
 */
const APP_SERVER_COMMANDS = Object.freeze([
  { name: 'review', description: 'Review uncommitted changes, or use the text as custom review instructions', methods: ['review/start'] },
  { name: 'goal', description: 'Show, set, or clear the current Codex goal', methods: ['thread/goal/get', 'thread/goal/set', 'thread/goal/clear'] },
  { name: 'compact', description: 'Compact the current Codex thread context', methods: ['thread/compact/start'] },
  { name: 'status', description: 'Show the current thread, goal, and usage status', methods: ['thread/goal/get', 'account/usage/read', 'account/rateLimits/read'] },
  { name: 'model', description: 'List models available to this Codex installation', methods: ['model/list'] },
  { name: 'skills', description: 'List skills available in this workspace', methods: ['skills/list'] },
  { name: 'mcp', description: 'List configured MCP servers and their status', methods: ['mcpServerStatus/list'] },
  { name: 'hooks', description: 'List hooks available in this workspace', methods: ['hooks/list'] },
  { name: 'plugins', description: 'List Codex plugins available in this workspace', methods: ['plugin/list'] },
  { name: 'apps', description: 'List apps available to Codex', methods: ['app/list'] },
  { name: 'permissions', description: 'List permission profiles available in this workspace', methods: ['permissionProfile/list'] },
  { name: 'experimental', description: 'List Codex experimental features', methods: ['experimentalFeature/list'] },
  { name: 'usage', description: 'Show Codex usage and rate limits', methods: ['account/usage/read', 'account/rateLimits/read'] },
]);

function commandsForMethods(methods) {
  const available = methods instanceof Set ? methods : new Set(methods || []);
  return APP_SERVER_COMMANDS
    .filter((command) => command.methods.every((method) => available.has(method)))
    .map(({ name, description }) => ({ name, description }));
}

function processSpec(binary) {
  const shim = process.platform === 'win32' && /\.cmd$/i.test(binary) ? resolveShim(binary) : null;
  const shell = process.platform === 'win32' && /\.cmd$/i.test(binary) && !shim;
  return {
    command: shim?.command || (shell ? `"${binary}"` : binary),
    args: [...(shim?.args || []), 'app-server', '--stdio', ...cliTelemetry('codex').args],
    shell,
  };
}

class CodexAppServer extends EventEmitter {
  constructor({ cwd, env = process.env, locateImpl = locate, spawnImpl = spawn, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.env = env;
    this.locate = locateImpl;
    this.spawn = spawnImpl;
    this.timeoutMs = timeoutMs;
    this.child = null;
    this.ready = null;
    this.pending = new Map();
    this.nextId = 1;
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stderrTail = []; // the last stderr lines, so an early exit can say why
  }

  async connect() {
    if (this.ready) return this.ready;
    this.ready = this.open().catch((error) => { this.ready = null; throw error; });
    return this.ready;
  }

  async open() {
    const binary = this.locate('codex').path;
    if (!binary) {
      const error = new Error('Codex CLI was not found');
      error.code = 'CODEX_BINARY_MISSING';
      throw error;
    }
    const spec = processSpec(binary);
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.stderrTail = [];
    const child = this.spawn(spec.command, spec.args, {
      cwd: this.cwd,
      windowsHide: true,
      shell: spec.shell,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.stdout.on('data', (chunk) => { if (this.child === child) this.consumeStdout(chunk); });
    child.stderr.on('data', (chunk) => { if (this.child === child) this.consumeStderr(chunk); });
    child.on('error', (error) => this.close(child, error));
    child.on('close', (code) => this.close(child, new Error(this.exitMessage(code))));
    child.stdin.on('error', (error) => this.close(child, error));

    try {
      await this.requestRaw('initialize', {
        clientInfo: { name: 'clanker-controller', title: 'Clanker Controller', version: '1.0.0' },
        capabilities: { experimentalApi: true },
      });
      this.notify('initialized', {});
      return this;
    } catch (error) {
      if (this.child === child) {
        try { child.kill(); } catch { /* already gone */ }
        this.close(child, error);
      }
      throw error;
    }
  }

  consumeStdout(chunk) {
    this.stdoutBuffer += chunk.toString();
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop();
    for (const line of lines) this.consumeLine(line);
  }

  consumeStderr(chunk) {
    this.stderrBuffer += chunk.toString();
    const lines = this.stderrBuffer.split(/\r?\n/);
    this.stderrBuffer = lines.pop();
    for (const line of lines) if (line.trim()) { this.stderrTail = [...this.stderrTail, line.trim()].slice(-40); this.emit('diagnostic', line); }
  }

  // "exited with code 1" alone hides why; the launcher's own error (damaged install, missing module) is what to show.
  exitMessage(code) {
    const base = `Codex App Server exited${code == null ? '' : ` with code ${code}`}`;
    const pending = this.stderrBuffer.trim();
    const detail = launchFailure([...(this.stderrTail || []), pending].join('\n')) || (this.stderrTail || []).filter((line) => !/^WARNING:/i.test(line)).at(-1) || pending;
    return detail ? `${base}: ${detail.slice(0, 400)}` : base;
  }

  consumeLine(line) {
    if (!line.trim()) return;
    let message;
    try { message = JSON.parse(line); }
    catch { this.emit('diagnostic', line); return; }
    if ('id' in message && !message.method) {
      const pending = this.pending.get(String(message.id));
      if (!pending) return;
      this.pending.delete(String(message.id));
      clearTimeout(pending.timer);
      if (message.error) pending.reject(new Error(message.error.message || JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if ('id' in message && message.method) this.emit('request', message);
    else if (message.method) this.emit('notification', message);
  }

  write(message) {
    if (!this.child?.stdin?.writable) throw new Error('Codex App Server is not connected');
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  requestRaw(method, params = {}) {
    const id = String(this.nextId++);
    const child = this.child;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        const error = new Error(`${method}: no response from Codex App Server`);
        reject(error);
        // A server that went silent stays silent: drop it so the retry spawns a fresh one instead of hitting the same hang.
        if (child && this.child === child) {
          try { child.kill(); } catch { /* already gone */ }
          this.close(child, error);
        }
      }, this.timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.write({ method, id, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  async request(method, params = {}) {
    await this.connect();
    return this.requestRaw(method, params);
  }

  notify(method, params = {}) { this.write({ method, params }); }
  respond(id, result) { this.write({ id, result }); }
  reject(id, message, code = -32601) { this.write({ id, error: { code, message } }); }

  close(child, error) {
    if (!child || this.child !== child) return;
    this.child = null;
    this.ready = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.emit('close', error);
  }

  dispose() {
    const child = this.child;
    this.child = null;
    this.ready = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new Error('Codex App Server closed'));
    }
    this.pending.clear();
    try { child?.stdin?.end(); } catch { /* already gone */ }
    try { child?.kill(); } catch { /* already gone */ }
  }
}

module.exports = { APP_SERVER_COMMANDS, CodexAppServer, commandsForMethods, processSpec };
