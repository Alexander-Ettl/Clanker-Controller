'use strict';

// Clanker stores provider choices, never credentials. The CLIs own account creation and browser sign-in.
const { locate, refresh, resolveShim } = require('./binary-locator');
const os = require('node:os');
const { runCli } = require('./cli-tools');
const { callLanguageServer } = require('./antigravity-quota');
const providers = require('./providers'); // name, sign-in, install line and auth check per provider: lib/providers/<id>.js
const { launchFailure } = require('./providers/shared.js');

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
  constructor({ vscode, store, home = os.homedir(), languageServer = callLanguageServer, existingUser = false, cwd, broadcast, onChange, onChecked, find = locate, reset = refresh, run = runCli, spec = terminalSpec, now = Date.now }) {
    Object.assign(this, { vscode, store, home, languageServer, cwd, broadcast, onChange, onChecked, find, reset, run, spec, now });
    const saved = store.get();
    this.enabled = new Set((saved?.enabled || (existingUser ? providers.ids() : [])).filter(agent => providers.has(agent)));
    // Added but unusable: the plan ended, credits ran out, the sign-in was rejected. agent -> { kind, reason, detail, at }
    this.unavailable = Object.fromEntries(Object.entries(saved?.unavailable || {}).filter(([agent]) => this.enabled.has(agent)));
    this.completed = saved?.completed === true || (!saved && existingUser);
    this.auth = {}; this.codes = {}; this.damage = {}; this.notes = {}; this.terminals = new Map(); this.checking = false; this.pendingCheck = null;
    // Sign-in ended while Clanker was working: the status command may still say "logged in" for a token the server dropped, so
    // this stays until a sign-in is seen (agent -> { detail, sawBad }). checkedAt: when each CLI's status was last read.
    this.expired = {}; this.checkedAt = {}; this.looking = new Map(); this.signingIn = new Set();
  }
  // Why an added CLI cannot be used, or null when it works. The one answer behind the rail's red ring, the chat's sign-in banner,
  // the Windows popup and the gate that holds unattended prompts (lib/auth-gate.js). `code` is the exit code of the CLI's own
  // status command (null when there is none), `action` the message the ring's button sends, `steps` what fixes it. Raw CLI
  // output is never included here: only the damaged-install line, which is the point of showing it.
  fault(agent) {
    if (!this.enabled.has(agent)) return null;
    const { accountName, login } = providers.get(agent);
    const code = this.codes[agent] > 0 ? this.codes[agent] : null;
    const out = this.unavailable[agent];
    if (out?.kind === 'blocked') return { kind: 'blocked', code: 403, title: out.reason, detail: out.detail,
      action: 'restoreCli', label: 'Allow a retry', steps: ['The provider returned a Cloudflare security block; a local sign-in status check cannot confirm recovery.', 'Check https://status.claude.com/ and wait for the provider to recover. Then allow a retry and resume the paused queue manually.'] };
    if (out) return { kind: out.kind === 'credits' ? 'credits' : 'plan', code: out.code > 0 ? out.code : null, title: out.reason || `${accountName} is not available.`, detail: out.detail || '', action: 'restoreCli', label: 'Try again', steps: ['Fix the plan or subscription, then press the button.'] };
    switch (this.auth[agent]) {
      case 'missing': return { kind: 'missing', code: null, title: 'Not installed', detail: `${accountName} is not installed on this PC. Install it, then sign in.`, action: 'connectCli', label: 'Install & sign in', steps: ['Press the button to install it and sign in.'] };
      case 'broken': return { kind: 'broken', code, title: 'Cannot start', detail: this.damage[agent] || `${accountName} crashed on launch.`, action: 'connectCli', label: 'Repair & sign in', steps: ['Press the button to repair it in a setup terminal and sign in.'] };
      default: break;
    }
    const expired = this.expired[agent];
    if (!expired && this.auth[agent] !== 'signin') return null;
    // Antigravity has no sign-in command: it is signed in from its own app, and the next look notices.
    return { kind: 'signin', expired: Boolean(expired), code, title: expired ? 'Sign-in expired' : 'Not signed in',
      detail: expired ? `${accountName} ended your sign-in while Clanker was working. Sign in with your browser and it works again.` : `${accountName} has no signed-in account. Sign in with your browser and it works again.`,
      action: login.length ? 'fixCli' : 'connectCli', label: 'Sign in',
      steps: login.length ? ['Press the button to open your browser and sign in.'] : [`Sign in to ${accountName} in its own app.`] };
  }
  // "Enabled" is what the rest of Clanker asks (picker, Auto, scheduler, rail): added and not known to be out of access.
  // `connectedAgents` is what you added, which Settings lists and the setup flow checks.
  connectedAgents() { return providers.ids().filter(agent => this.enabled.has(agent)); }
  enabledAgents() { return this.connectedAgents().filter(agent => !this.unavailable[agent]); }
  isEnabled(agent) { return this.enabled.has(agent) && !this.unavailable[agent]; }
  isUnavailable(agent) { return Boolean(this.unavailable[agent]); }
  async markUnavailable(agent, failure) {
    if (!this.enabled.has(agent) || this.unavailable[agent]) return;
    this.unavailable[agent] = { ...failure, at: Date.now() };
    await this.save();
  }
  async restore(agent) {
    if (!this.unavailable[agent]) return;
    delete this.unavailable[agent];
    await this.save();
    await this.check(); // a plan that is still missing is flagged again straight away
  }
  snapshot() {
    return { type: 'cliConnections', setupNeeded: !this.completed, checking: this.checking,
      providers: Object.fromEntries(providers.ids().map(agent => [agent, { enabled: this.enabled.has(agent), unavailable: this.unavailable[agent] || null, installed: Boolean(this.find(agent).path), auth: this.auth[agent] || 'unknown', settingUp: this.terminals.has(agent) || this.signingIn.has(agent), note: this.notes[agent] || '', fault: this.fault(agent) }])) };
  }
  push() { this.broadcast(this.snapshot()); }
  async save() { await this.store.set({ enabled: this.connectedAgents(), unavailable: this.unavailable, completed: this.completed }); this.onChange?.(); this.push(); }
  async complete() { this.completed = true; await this.save(); }
  async connect(agent) {
    if (!providers.has(agent)) return;
    this.enabled.add(agent);
    delete this.unavailable[agent]; // signing in again is how an account gets fixed; the next failed turn would flag it anew
    await this.save();
    if (['connected', 'ready'].includes(this.auth[agent])) return;
    const previous = this.terminals.get(agent);
    if (previous && this.vscode.window.terminals.includes(previous)) { previous.show(true); return; }
    // A damaged install cannot sign in: the CLI dies before it asks anything. Show why, and run the install line to repair it.
    const file = this.find(agent).path;
    const damage = file ? await this.probe(agent, file) : '';
    try {
      const terminal = this.vscode.window.createTerminal({ name: `Clanker setup · ${providers.get(agent).accountName}`, cwd: this.cwd, ...this.spec(agent, damage ? null : file) });
      this.terminals.set(agent, terminal);
      this.notes[agent] = damage ? `${providers.get(agent).accountName} cannot start: ${damage} Repairing it in the setup terminal, then signing in.` : 'Finish sign-in in your browser or setup terminal, then check connections.';
      terminal.show(true);
    } catch {
      this.terminals.delete(agent);
      if (!damage) this.notes[agent] = 'Setup could not open. Try again, or install the CLI from its official website.';
    }
    this.push();
  }
  // Runs the CLI's own status check. Returns the real error when the CLI cannot start at all, '' otherwise (signed out is not damage).
  async probe(agent, file) {
    try {
      const { authStatus } = providers.get(agent);
      const result = await this.run(file, authStatus.args, 8000);
      const failure = authStatus.interpret(result) === 'broken' ? launchFailure(result.stderr || result.stdout) : '';
      if (failure) { this.auth[agent] = 'broken'; this.codes[agent] = result.code; this.damage[agent] = failure; this.notes[agent] = `${providers.get(agent).accountName} cannot start: ${failure}`; }
      return failure;
    } catch { return ''; }
  }
  async connectAll() { for (const agent of providers.ids()) await this.connect(agent); }
  async remove(agent) {
    if (!providers.has(agent)) return;
    this.enabled.delete(agent);
    delete this.unavailable[agent];
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
  // The plan behind a sign-in (providers' `entitlement`). What it finds is shown like a failed-turn flag, but it clears itself
  // once the plan is back, so only a flag that came from a failed turn waits for "Try again".
  async checkEntitlement(agent, result) {
    let found = null;
    try { found = ['connected', 'ready'].includes(this.auth[agent]) ? await providers.get(agent).entitlement?.({ result, home: this.home, env: process.env, languageServer: this.languageServer }) : null; } catch { found = undefined; }
    if (found === undefined) return;
    if (found && !this.unavailable[agent]) this.unavailable[agent] = { ...found, at: Date.now(), source: 'plan' };
    else if (!found && this.unavailable[agent]?.source === 'plan') delete this.unavailable[agent];
    else return;
    this.dirty = true;
  }
  async checkAgent(agent) {
    const file = this.find(agent).path;
    if (!file) { this.auth[agent] = 'missing'; return; }
    try {
      const { authStatus } = providers.get(agent);
      const result = await this.run(file, authStatus.args, 8000);
      this.auth[agent] = authStatus.interpret(result);
      this.codes[agent] = result.code;
      this.checkedAt[agent] = this.now();
      const gone = this.expired[agent]; // a sign-in that really ended is over once the CLI has been seen signed out and then signed in again
      if (gone) { if (!['connected', 'ready'].includes(this.auth[agent])) gone.sawBad = true; else if (gone.sawBad) delete this.expired[agent]; }
      await this.checkEntitlement(agent, result);
      if (['connected', 'ready'].includes(this.auth[agent])) this.notes[agent] = '';
      else if (this.auth[agent] === 'broken') { this.damage[agent] = launchFailure(result.stderr || result.stdout); this.notes[agent] = `${providers.get(agent).accountName} cannot start: ${this.damage[agent]}`; }
    } catch { this.auth[agent] = 'unknown'; this.notes[agent] = 'Could not check this CLI. Try again.'; }
  }
  // One CLI's sign-in, checked now (the CLI's own status command, no prompt sent). 'unknown' means the check itself failed.
  verify(agent) {
    if (!this.looking.has(agent)) this.looking.set(agent, this.look(agent).finally(() => this.looking.delete(agent)));
    return this.looking.get(agent);
  }
  async look(agent) {
    await this.checkAgent(agent);
    if (this.dirty) { this.dirty = false; await this.save(); } else this.push();
    return this.auth[agent];
  }
  // Same, but not again if the last look is recent: most of the time you are signed in, so a send costs one look, not one per prompt.
  async ensureFresh(agent, maxAgeMs = 30000) {
    const known = this.auth[agent];
    if (known && known !== 'unknown' && this.now() - (this.checkedAt[agent] || 0) < maxAgeMs) return known;
    return this.verify(agent);
  }
  // A turn failed with a login error although the status command said "logged in": the rail shows the same fault from now on.
  markSignedOut(agent, detail = '') {
    if (!this.enabled.has(agent)) return;
    this.expired[agent] = { detail, sawBad: false };
    this.push(); this.onChange?.();
  }
  // "I signed in myself": believe it without waiting for the status command to change its mind.
  trustSignIn(agent) { if (this.expired[agent]) { delete this.expired[agent]; this.push(); } }
  // Signs in without a terminal: the CLI opens the browser itself and exits once the sign-in has been handed back to it.
  async signIn(agent, { timeoutMs = 300000 } = {}) {
    const file = this.find(agent).path;
    const { login } = providers.get(agent) || {};
    if (!file || !login?.length) return { ok: false };
    const result = await this.run(file, login, timeoutMs);
    return { ok: result.ok };
  }
  // The one button behind the fault, wherever it is pressed (rail, chat banner, Windows popup): sign in through the browser,
  // repair or install in the setup terminal, or try the plan again. { ok: true } once the CLI works; `error` only for a
  // browser sign-in that did not finish. The caller keeps watching for the rest.
  async fix(agent) {
    const fault = this.fault(agent);
    if (!fault) return { ok: true };
    if (fault.action === 'restoreCli') { await this.restore(agent); return { ok: !this.fault(agent) }; }
    if (fault.action !== 'fixCli') { await this.connect(agent); return { ok: false }; }
    this.signingIn.add(agent); this.push();
    let result;
    try { result = await this.signIn(agent); } finally { this.signingIn.delete(agent); }
    if (!result.ok) { this.push(); return { ok: false, error: `The sign-in did not finish. Try again, or run "${providers.get(agent).cli} ${providers.get(agent).login.join(' ')}" in a terminal.` }; }
    this.trustSignIn(agent);
    await this.verify(agent);
    return { ok: !this.fault(agent) };
  }
  async checkAccounts() {
    await Promise.all(this.connectedAgents().map(agent => this.checkAgent(agent)));
    if (this.dirty) { this.dirty = false; await this.save(); } else this.onChange?.();
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
