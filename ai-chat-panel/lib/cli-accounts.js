'use strict';

// Clanker stores provider choices, never credentials. The CLIs own account creation and browser sign-in.
const { locate, refresh, resolveShim } = require('./binary-locator');
const { runCli } = require('./cli-tools');
const providers = require('./providers'); // name, sign-in, install line and auth check per provider: lib/providers/<id>.js

function terminalSpec(agent, file, platform = process.platform) {
  const provider = providers.get(agent);
  if (!provider) throw new Error('Unknown CLI');
  if (!file) {
    if (platform !== 'win32') throw new Error('Install this CLI from its official website, then check connections.');
    return { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', provider.install] };
  }
  const shim = /\.cmd$/i.test(file) ? resolveShim(file) : null;
  if (/\.cmd$/i.test(file) && !shim) {
    return { shellPath: 'powershell.exe', shellArgs: ['-NoLogo', '-NoProfile', '-NoExit', '-Command', `& '${file.replace(/'/g, "''")}' ${provider.login.join(' ')}`] };
  }
  return { shellPath: shim?.command || file, shellArgs: [...(shim?.args || []), ...provider.login] };
}

class CliAccounts {
  constructor({ vscode, store, existingUser = false, cwd, broadcast, onChange, onChecked, find = locate, reset = refresh, run = runCli, spec = terminalSpec }) {
    Object.assign(this, { vscode, store, cwd, broadcast, onChange, onChecked, find, reset, run, spec });
    const saved = store.get();
    this.enabled = new Set((saved?.enabled || (existingUser ? providers.ids() : [])).filter(agent => providers.has(agent)));
    this.completed = saved?.completed === true || (!saved && existingUser);
    this.auth = {}; this.notes = {}; this.terminals = new Map(); this.checking = false; this.pendingCheck = null;
  }
  enabledAgents() { return providers.ids().filter(agent => this.enabled.has(agent)); }
  isEnabled(agent) { return this.enabled.has(agent); }
  snapshot() {
    return { type: 'cliConnections', setupNeeded: !this.completed, checking: this.checking,
      providers: Object.fromEntries(providers.ids().map(agent => [agent, { enabled: this.isEnabled(agent), installed: Boolean(this.find(agent).path), auth: this.auth[agent] || 'unknown', settingUp: this.terminals.has(agent), note: this.notes[agent] || '' }])) };
  }
  push() { this.broadcast(this.snapshot()); }
  async save() { await this.store.set({ enabled: this.enabledAgents(), completed: this.completed }); this.onChange?.(); this.push(); }
  async complete() { this.completed = true; await this.save(); }
  async connect(agent) {
    if (!providers.has(agent)) return;
    this.enabled.add(agent);
    await this.save();
    if (['connected', 'ready'].includes(this.auth[agent])) return;
    const previous = this.terminals.get(agent);
    if (previous && this.vscode.window.terminals.includes(previous)) { previous.show(true); return; }
    try {
      const terminal = this.vscode.window.createTerminal({ name: `Clanker setup · ${providers.get(agent).accountName}`, cwd: this.cwd, ...this.spec(agent, this.find(agent).path) });
      this.terminals.set(agent, terminal);
      this.notes[agent] = 'Finish sign-in in your browser or setup terminal, then check connections.';
      terminal.show(true);
    } catch {
      this.terminals.delete(agent);
      this.notes[agent] = 'Setup could not open. Try again, or install the CLI from its official website.';
    }
    this.push();
  }
  async connectAll() { for (const agent of providers.ids()) await this.connect(agent); }
  async remove(agent) {
    if (!providers.has(agent)) return;
    this.enabled.delete(agent);
    const terminal = this.terminals.get(agent);
    this.terminals.delete(agent);
    terminal?.dispose();
    this.notes[agent] = '';
    await this.save();
  }
  check() {
    if (this.disposed) return Promise.resolve();
    if (this.pendingCheck) return this.pendingCheck;
    this.reset(); this.checking = true; this.push();
    this.pendingCheck = this.checkAccounts().finally(() => { this.checking = false; this.pendingCheck = null; this.push(); });
    return this.pendingCheck;
  }
  async checkAccounts() {
    await Promise.all(this.enabledAgents().map(async agent => {
      const file = this.find(agent).path;
      if (!file) { this.auth[agent] = 'missing'; return; }
      try {
        const { authStatus } = providers.get(agent);
        this.auth[agent] = authStatus.interpret(await this.run(file, authStatus.args, 8000));
        if (['connected', 'ready'].includes(this.auth[agent])) this.notes[agent] = '';
      } catch { this.auth[agent] = 'unknown'; this.notes[agent] = 'Could not check this CLI. Try again.'; }
    }));
    this.onChange?.();
    await this.onChecked?.();
  }
  terminalClosed(terminal) {
    for (const [agent, current] of this.terminals) if (current === terminal) { this.terminals.delete(agent); void this.check(); }
  }
  dispose() {
    this.disposed = true;
    const terminals = [...this.terminals.values()];
    this.terminals.clear();
    terminals.forEach(terminal => terminal.dispose());
  }
}

module.exports = { CliAccounts, terminalSpec };
