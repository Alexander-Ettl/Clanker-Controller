'use strict';

// Look before you send. A "continue", a queued prompt or a scheduled one goes out while you are away, and a CLI that was
// signed out in the meantime (you opened it somewhere else, the token ended) only says so after the prompt is gone:
// "401 Unauthorized", a lost turn, a retry that fails the same way. So every such send asks this gate first.
//
// The gate owns no account state. What is wrong is `CliAccounts.fault()`, the same answer the rail's red ring shows, and the
// button is `CliAccounts.fix()`, the same one the ring has. The check is the CLI's own status command (no prompt, no tokens),
// reused for half a minute because most of the time you are signed in. Only a definite fault blocks; a check that itself fails
// lets the prompt through, since the turn's own error is still read afterwards (`expired`).
//
// What the gate adds is the waiting: while a CLI has a fault, held prompts stay where they are (chat queue, Scheduled tab), a
// Windows popup says what is wrong, and a quick poll watches for the fix. When the CLI works again it emits 'resolved' once;
// the owner of the held prompts sends them then. A sign-in that ended mid-turn is only cleared by a sign-in, since the status
// command may still say "logged in" for a token the server has dropped.

const { EventEmitter } = require('node:events');
const providers = require('./providers');

const OK = new Set(['connected', 'ready']);
const POLL_MS = 10000;
const FRESH_MS = 30000;

const waiting = (count) => (count > 1 ? `${count} prompts are waiting` : count === 1 ? '1 prompt is waiting' : 'Your next prompt is waiting');

class AuthGate extends EventEmitter {
  /**
   * @param accounts   CliAccounts (fault, ensureFresh, verify, fix, markSignedOut, trustSignIn, connectedAgents, check)
   * @param showPrompt ({ title, message, steps, button, error }) => { result: Promise<'act'|'later'>, close() } | null (Windows popup)
   * @param pending    (agent) => how many prompts are held for that CLI
   */
  constructor({ accounts, showPrompt = null, pending = () => 0, pollMs = POLL_MS, freshMs = FRESH_MS }) {
    super();
    Object.assign(this, { accounts, showPrompt, pending, pollMs, freshMs });
    this.incidents = new Map(); this.disposed = false;
  }

  /** null when `agent` may be sent to; otherwise what is wrong (the block `describe` returns). */
  async check(agent) {
    if (this.disposed || !providers.has(agent) || !this.accounts.connectedAgents().includes(agent)) return null;
    if (!this.incidents.has(agent)) await this.accounts.ensureFresh(agent, this.freshMs).catch(() => 'unknown');
    return this.settle(agent);
  }

  /** A turn failed with a login error although the status check passed: the sign-in ended mid-run. */
  expired(agent, detail = '') {
    if (this.disposed || !providers.has(agent)) return null;
    this.accounts.markSignedOut(agent, detail);
    return this.settle(agent);
  }

  incident(agent) { const open = this.incidents.get(agent); return open ? this.describe(open) : null; }

  /** The single answer: the CLI's fault opens (or keeps) the incident, no fault closes it and releases what was held. */
  settle(agent) {
    const inc = this.incidents.get(agent);
    if (!this.accounts.fault(agent)) { if (inc) this.resolve(inc); return null; }
    return this.describe(inc || this.open(agent));
  }

  /** The popup's / banner's / rail's main button: the same `fix` for all three. */
  async act(agent) {
    const inc = this.incidents.get(agent);
    if (inc?.busy) return;
    if (inc) { inc.busy = true; inc.error = ''; this.changed(inc); }
    let result;
    try { result = await this.accounts.fix(agent); } catch (error) { result = { ok: false, error: String(error?.message || error).slice(0, 200) }; }
    const now = this.incidents.get(agent);
    if (!now) return; // pressed in the rail with nothing held: the rail's own state shows the outcome
    now.busy = false; now.error = result.error || '';
    this.settle(agent); // fixed: releases what was held
    this.changed(now);
  }

  /** "I signed in myself": look now, and if the CLI answers, send what was held. A reactive incident trusts you. */
  async recheck(agent) {
    const state = await this.accounts.verify(agent).catch(() => 'unknown');
    if (OK.has(state)) this.accounts.trustSignIn(agent);
    const inc = this.incidents.get(agent);
    if (this.settle(agent) && inc) { inc.error = state === 'unknown' ? 'Could not check yet. Try again.' : OK.has(state) ? '' : 'Still not signed in.'; this.changed(inc); }
  }

  open(agent) {
    const inc = { agent, error: '', busy: false, closed: false, popup: null, timer: null, sig: '' };
    this.incidents.set(agent, inc);
    this.poll(inc);
    void this.ask(inc);
    this.changed(inc);
    return inc;
  }

  describe(inc) {
    const fault = this.accounts.fault(inc.agent) || { kind: 'signin', title: '', detail: '', steps: [], label: '', action: 'none' };
    const name = providers.get(inc.agent).accountName;
    const count = this.pending(inc.agent);
    const signin = fault.kind === 'signin';
    const canFix = fault.action !== 'none' && !(signin && fault.action === 'connectCli'); // a CLI without a sign-in command or setup terminal cannot sign in from here
    return { agent: inc.agent, kind: fault.kind, expired: Boolean(fault.expired), action: canFix ? fault.action : 'none', busy: inc.busy, error: inc.error, count,
      title: `${name} · ${fault.title}`,
      message: `${fault.detail} ${waiting(count)}.`,
      steps: [...fault.steps, 'Clanker then sends the waiting prompts by itself.'],
      button: !canFix ? '' : signin ? `Sign in to ${name}` : fault.label };
  }

  // Speaks only when something the person can see has changed.
  changed(inc) {
    if (inc.closed) return;
    const block = this.describe(inc);
    const sig = JSON.stringify(block);
    if (sig !== inc.sig) { inc.sig = sig; this.emit('change', block); }
  }

  // The popup. 'later' keeps the incident (banner, held prompts, polling); a failed sign-in asks again with the reason.
  async ask(inc) {
    while (!inc.closed && this.showPrompt) {
      const handle = this.showPrompt({ ...this.describe(inc), error: inc.error });
      if (!handle) return;
      inc.popup = handle;
      const choice = await handle.result.catch(() => 'later');
      inc.popup = null;
      if (inc.closed || choice !== 'act') return;
      await this.act(inc.agent);
      if (!inc.error) return;
    }
  }

  // Sign-ins also happen elsewhere (the CLI's own app, the rail, a terminal): look often while prompts wait.
  poll(inc) {
    inc.timer = setTimeout(async () => {
      if (inc.closed || this.disposed) return;
      await this.accounts.verify(inc.agent).catch(() => {});
      if (inc.closed || this.disposed) return;
      if (this.settle(inc.agent)) { this.changed(inc); this.poll(inc); }
    }, this.pollMs);
    inc.timer.unref?.();
  }

  resolve(inc) {
    if (inc.closed) return;
    inc.closed = true;
    clearTimeout(inc.timer);
    this.incidents.delete(inc.agent);
    inc.popup?.close();
    this.emit('resolved', inc.agent);
    void this.accounts.check?.(); // the rail and the model list catch up
  }

  dispose() {
    this.disposed = true;
    for (const inc of this.incidents.values()) { inc.closed = true; clearTimeout(inc.timer); inc.popup?.close(); }
    this.incidents.clear();
    this.removeAllListeners();
  }
}

module.exports = { AuthGate };
