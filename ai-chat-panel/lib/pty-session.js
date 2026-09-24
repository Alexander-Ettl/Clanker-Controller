'use strict';

// No node-pty: spec docs/unified-ai-panel-spec.md §3.1 allows either node-pty
// or vscode.window.createTerminal. This machine has no C++ build toolchain
// (no cl.exe/node-gyp), and a native module would in any case need to match
// VS Code's bundled Electron/Node ABI, not the system Node — a second,
// separate failure point. createTerminal gives a real OS PTY for free (it's
// how VS Code's own integrated terminal works), so CLI spinners/ANSI/raw
// keyboard input all just work, with zero native dependencies.
//
// Takes the `vscode` module by injection rather than requiring it directly,
// so this file's lifecycle logic (start/reuse/recreate-on-close) is
// unit-testable with a plain mock object — see test/session.test.js.

class AgentSession {
  constructor(vscodeApi, id, label, command) {
    this.vscode = vscodeApi;
    this.id = id;
    this.label = label;
    this.command = command;
    this.terminal = null;
  }

  /** Starts the terminal + launches the CLI if not already running; reuses it otherwise. */
  ensureStarted() {
    const isAlive = this.terminal && this.vscode.window.terminals.includes(this.terminal);
    if (isAlive) return this.terminal;

    this.terminal = this.vscode.window.createTerminal({ name: `AI Panel: ${this.label}` });
    this.terminal.sendText(this.command, true);
    return this.terminal;
  }

  /** Brings this agent's terminal into view and gives it keyboard focus. */
  focus() {
    this.ensureStarted().show(false);
  }

  /** Sends text into the agent's stdin. submit=false leaves it unsent (no Enter). */
  send(text, submit = true) {
    this.ensureStarted().sendText(text, submit);
  }

  /**
   * P12-D: Supervised Fresh-Session Chaining. Clears this terminal and
   * injects the next phase's prompt, prefixed with a compact micro-handoff
   * summary from the phase that just finished.
   *
   * Real, confirmed platform limit (not a style choice): VS Code's stable
   * Terminal API (createTerminal + sendText, chosen over node-pty per this
   * file's own top comment) has no readback channel at all -- there is no
   * stable way to inspect what a terminal has printed, so an automatic
   * "wait for the idle prompt regex (`> $` / `❯`) before clearing" is not
   * actually implementable here. The proposed `onDidWriteTerminalData` API
   * would allow that, but proposed APIs require `enableProposedApi` and
   * only run in Insiders/an explicit allowlist -- incompatible with this
   * extension shipping as a normal, installable one (see P12-K).
   *
   * The real safety mechanism is therefore the caller's own explicit,
   * supervised confirmation (extension.js's
   * `aiChatPanel.runNextBatchInCleanSession` command shows a modal before
   * ever calling this) rather than blind automatic keystroke-pumping --
   * this method itself does nothing but the two sends once called.
   */
  runNextBatchInCleanSession(handoffPromptPrefix, batchPrompt) {
    const terminal = this.ensureStarted();
    terminal.sendText('/clear', true);
    const combined = handoffPromptPrefix ? `${handoffPromptPrefix}\n\n---\n\n${batchPrompt}` : batchPrompt;
    terminal.sendText(combined, true);
  }

  /** Called when VS Code reports this session's terminal was closed by the user. */
  handleClosed(closedTerminal) {
    if (this.terminal === closedTerminal) {
      this.terminal = null;
    }
  }

  dispose() {
    if (this.terminal) {
      this.terminal.dispose();
      this.terminal = null;
    }
  }
}

class TerminalSessionManager {
  constructor(vscodeApi, agents) {
    this.vscode = vscodeApi;
    this.sessions = new Map();
    for (const agent of agents) {
      this.sessions.set(agent.id, new AgentSession(vscodeApi, agent.id, agent.label, agent.command));
    }
  }

  ensureAllStarted() {
    for (const session of this.sessions.values()) session.ensureStarted();
  }

  get(id) {
    return this.sessions.get(id);
  }

  /** P16-I: re-located binaries apply from each agent's next terminal start. */
  refreshCommands(agents) {
    for (const agent of agents) {
      const session = this.sessions.get(agent.id);
      if (session) session.command = agent.command;
    }
  }

  list() {
    return [...this.sessions.values()];
  }

  /** Wire this to vscode.window.onDidCloseTerminal so a manually-closed terminal restarts next use. */
  handleTerminalClosed(closedTerminal) {
    for (const session of this.sessions.values()) session.handleClosed(closedTerminal);
  }

  dispose() {
    for (const session of this.sessions.values()) session.dispose();
  }
}

module.exports = { TerminalSessionManager, AgentSession };
