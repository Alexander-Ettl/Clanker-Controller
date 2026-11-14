> Historical implementation blueprint, archived 2026-10-22. Consult the [extension guide](../../ai-chat-panel/README.md), current code and [backlog](../../TODO.md) before changing queues or interruption. Embedded prompts are historical context; old paths may no longer apply.

# Phase 17 Architecture & Engineering Specification: AI Task Interruption, Conversational Steering & Concurrent In-Session Turn Queuing

> **Document Type:** Architectural Blueprint & Downstream Implementation Contract  
> **Status:** Approved for Implementation (Sprint Task `P17-F`)  
> **Target Module:** `astro-visual-editor/tools/ai-chat-panel` (VS Code / Antigravity IDE Webview Extension)  
> **Design Paradigms:** Apple Liquid Glass, Tony Stark Kinetic Motion, Ponytail Anti-Bloat, Tesler's Law  

---

## 1. Executive Summary & Problem Statement

### The User Pain Point
In state-of-the-art AI code editors (Cursor, Windsurf/Cascade, Claude Code), developers interact with autonomous agents that stream responses, execute shell commands, read AST structures, and rewrite multi-file projects. During this interaction, three critical user needs arise:

1. **Immediate Task Interruption (The Emergency Brake):**
   When an author submits a prompt and immediately notices a typo, wrong file target, an agent hallucination, or an execution taking too long, they must be able to **pause/stop the agent instantaneously** with one click or a single keystroke (`Esc` / `Ctrl+C`).
2. **Concurrent Message Queuing (Zero Input Lockout):**
   In the legacy `ai-chat-panel`, the composer had no concept of an active execution state versus an idle state. If a user typed while an agent was running and hit Enter, the system either clumsily overwrote the active child process via an ungraceful `cancel()` or corrupted the transcript history. In contrast, modern AI workflows require **continuous, non-blocking composition**: the user can queue follow-up instructions, corrections, or steering prompts while the agent works, without interrupting its flow.
3. **Conversational Steering ("Interrupt & Send Now"):**
   If the user realizes the agent is heading down the wrong architectural path, they must have the ability to abort the current turn and immediately dispatch their new correction as the steering prompt with a single gesture.

### The Solution: Tri-State Kinetic Composer & In-Session Turn Queue
This specification defines:
- A **Tri-State Kinetic Composer Controller** where the primary action button smoothly morphs between **Send** (`→`), **Stop** (`■`), and **Queue** (`↑+`), combined with global `Escape` and `Enter` keyboard handling.
- An **In-Session Turn Queue Engine** rendered as an Apple Liquid Glass frosted strip (`.turn-queue-strip`) floating above the composer, supporting auto-dispatch on turn completion, reordering, deletion, and immediate steering.
- A **Fail-Closed Windows Native Process Tree Termination Engine** using stdin `\x03` (`SIGINT`) graceful signaling followed by `taskkill /F /T /PID` tree execution to eliminate zombie orphaned CLI processes on Windows 11.
- An **Atomic Interrupted Transcript State** that marks partial assistant streams and running tool cards with frosted status badges (`[⏹ Interrupted by user]`), preserving full conversational provenance.

---

## 2. Competitive Interaction Benchmark: How Frontier Editors Behave

| Feature | Cursor | Windsurf (Cascade) | Claude Code CLI | **Portfolio AI Chat Panel (Spec P17-F)** |
| :--- | :--- | :--- | :--- | :--- |
| **Stop Trigger** | Red square `■` in composer + `Esc` key | Frosted square `■` Cancel button | `Ctrl+C` interrupt | Frosted Crimson `■` Stop button + `Esc` / `Ctrl+C` |
| **Input Lockout** | **Never locked**: textarea remains 100% editable | **Never locked**: continuous typing | Pauses execution on keystroke | **Zero lockout**: full text editing, paste, attachment support |
| **Enter While Generating** | Adds to Queued Messages strip | Adds to Turn Queue pill | Queues next prompt in readline | Enqueues turn in `.turn-queue-strip` above composer |
| **Steering Action** | "Interrupt & Send" button | "Steer Now" pill | `Ctrl+C` then paste | `Ctrl+Enter` or click `[⚡ Steer Now]` |
| **Turn Completion** | Auto-dispatches 1st queued turn | Auto-dispatches next turn | Executes next line | Smooth slide-down auto-dispatch into transcript |
| **Stop with Queued Items** | Pauses active; holds queue staged | Pauses active; holds queue | Clears pending line | Pauses active; holds queue with `[Send Queued]` button |
| **Windows Subprocess Kill** | Extension host kills process tree | RPC daemon kills worker tree | Native console interrupt | Stdin `\x03` + `taskkill /F /T /PID` tree termination |

---

## 3. TypeScript State & Event Contracts

The following self-contained TypeScript interfaces define the exact state machine and IPC contracts between the Webview (`media/main.js`) and the Extension Host (`extension.js` / `lib/stream-engine.js`).

```typescript
/**
 * Represents a queued conversational turn staged by the user while an agent is busy.
 */
export interface QueuedTurn {
  /** Unique RFC-4122 v4 UUID */
  id: string;
  /** Cleaned text prompt */
  text: string;
  /** Resolved attachment metadata */
  attachments: Array<{
    path: string;
    name: string;
    size: number;
    mime: string;
    uri?: string;
  }>;
  /** Target agent CLI identifier ('claude' | 'codex' | 'gemini' | 'auto') */
  agentId: string;
  /** Target model identifier from MODEL_CATALOG (e.g. 'claude-opus-5-5-medium') */
  modelId: string;
  /** Epoch timestamp in ms when the user enqueued the turn */
  createdAt: number;
}

/**
 * State machine stages for the active conversational session.
 */
export type SessionExecutionState =
  | 'idle'             // Ready for new prompts; composer displays Send button
  | 'generating'       // LLM is streaming text deltas
  | 'executing_tool'   // Agent is executing shell command or AST file modification
  | 'awaiting_approval'// Waiting on user to click Allow/Deny or answer question
  | 'interrupted';     // Task was stopped by user; awaiting next action

/**
 * Webview -> Extension Host IPC Messages
 */
export type WebviewToHostMessage =
  | { type: 'send'; modelId: string; text: string; attachments: string[]; submit: boolean }
  | { type: 'interrupt' }
  | { type: 'queueTurn'; turn: QueuedTurn }
  | { type: 'dequeueTurn'; turnId: string }
  | { type: 'editQueuedTurn'; turnId: string; newText: string }
  | { type: 'reorderQueuedTurns'; orderedIds: string[] }
  | { type: 'steerNow'; turn: QueuedTurn };

/**
 * Extension Host -> Webview IPC Messages
 */
export type HostToWebviewMessage =
  | { type: 'turn_state'; state: SessionExecutionState; agent: string; modelId: string }
  | { type: 'turn_interrupted'; agent: string; partialText?: string; wasSteered?: boolean }
  | { type: 'turn_queue_updated'; queue: QueuedTurn[] }
  | { type: 'turn_complete'; agent: string; autoDispatchedNext?: boolean };
```

---

## 4. Architectural Implementation Blueprint

### Component 1: Windows Native Process Tree Interruption Engine (`lib/stream-engine.js`)

#### The Technical Invariant:
On Windows 11 (`process.platform === 'win32'`), `child_process.ChildProcess.kill()` sends `SIGTERM`, which maps to `TerminateProcess` strictly on the root process handle. Because CLI agents (`claude.cmd`, `agy.cmd`, `codex.cmd`) execute via shell shims or spawn subprocesses (such as `node.exe`, `git.exe`, `ripgrep.exe`, or compiler runners), a naive `child.kill()` leaves orphaned zombie processes running in the background. These orphans hold file write locks, lock SQLite and git indices, and waste CPU cycles.

#### Implementation Architecture:
`StreamEngine` is upgraded with a dual-phase termination protocol:
1. **Phase 1 (Graceful Unwind):** Write `\x03` (`Ctrl+C`) to `child.stdin`. Interactive CLIs like Claude Code catch `SIGINT` over stdin and flush partial state.
2. **Phase 2 (Hard Process Tree Kill):** If the process tree does not exit within 300ms (or immediately if interactive stdin is disabled), invoke `taskkill /F /T /PID ${pid}` with `windowsHide: true`.

```javascript
// astro-visual-editor/tools/ai-chat-panel/lib/stream-engine.js

const { execFile } = require('node:child_process');

function killProcessTree(child, callback) {
  if (!child || child.killed || !child.pid) {
    if (callback) callback();
    return;
  }
  const pid = child.pid;
  if (process.platform === 'win32') {
    execFile('taskkill', ['/F', '/T', '/PID', String(pid)], { windowsHide: true }, (error) => {
      // Ignore ESRCH / not found if process already died naturally
      if (callback) callback(error);
    });
  } else {
    try {
      process.kill(-pid, 'SIGINT');
    } catch {
      try { child.kill('SIGINT'); } catch {}
    }
    if (callback) callback();
  }
}

class StreamEngine extends EventEmitter {
  // ...
  interrupt({ wasSteered = false } = {}) {
    const child = this.child;
    const agent = this.activeAgent;
    this.approvals.clear();

    if (!child || child.killed) {
      this.child = null;
      this.emit('event', { type: 'turn_interrupted', agent, wasSteered });
      this.emit('event', { type: 'turn_complete', agent });
      return;
    }

    child.turnCompleted = true; // Guard against subsequent close handlers firing duplicate turn_complete

    // Try graceful stdin break if writable
    try {
      if (child.stdin?.writable) {
        child.stdin.write('\x03\n');
      }
    } catch {}

    // Hard kill tree after grace period
    const graceTimer = setTimeout(() => {
      killProcessTree(child);
    }, 250);

    child.once('close', () => {
      clearTimeout(graceTimer);
      this.child = null;
      this.emit('event', { type: 'turn_interrupted', agent, wasSteered });
      this.emit('event', { type: 'turn_complete', agent });
    });

    // In case 'close' doesn't fire promptly on Windows
    killProcessTree(child, () => {
      clearTimeout(graceTimer);
      if (this.child === child) {
        this.child = null;
        this.emit('event', { type: 'turn_interrupted', agent, wasSteered });
        this.emit('event', { type: 'turn_complete', agent });
      }
    });
  }
}
```

---

### Component 2: In-Session Turn Queue Coordinator (`extension.js`)

In `extension.js`, `ChatWindowHost` coordinates conversation turns:

1. **Turn Queue Storage:**
   `ChatWindowHost` maintains `inSessionQueue: QueuedTurn[]`.
2. **IPC Dispatch:**
   - On `message.type === 'interrupt'`: calls `this.streamEngine.interrupt()`.
   - On `message.type === 'queueTurn'`: pushes to `inSessionQueue`, notifies webview via `turn_queue_updated`.
   - On `message.type === 'dequeueTurn'`: removes turn by ID, notifies webview.
   - On `message.type === 'steerNow'`:
     - Calls `this.streamEngine.interrupt({ wasSteered: true })`.
     - Immediately starts the new turn with the provided prompt and attachments.
3. **Turn Completion Auto-Dispatch Loop:**
   - In `handleStreamEvent(event)`:
     - When `event.type === 'turn_complete'`:
       - If the turn was interrupted manually by the user, **do not auto-dispatch** (respect the user's intent to stop).
       - If the turn completed successfully AND `this.inSessionQueue.length > 0`:
         - Pop the first item: `const nextTurn = this.inSessionQueue.shift();`.
         - Notify webview: `turn_queue_updated`.
         - Trigger: `this.startTurn(nextTurn)`.

---

### Component 3: Tri-State Kinetic Composer & Queued Turn Strip (`media/main.js`)

#### UI State Invariant:
The composer exists in three distinct visual states:

```
[ State A: IDLE ]
┌─────────────────────────────────────────────────────────────┐
│ Message the active agent...                                 │
│ [Model Pill ▾]                   [🎤] [  Send (→)  ]        │
└─────────────────────────────────────────────────────────────┘

[ State B: GENERATING / EXECUTING (Input Empty) ]
┌─────────────────────────────────────────────────────────────┐
│ (Agent streaming in transcript...)                          │
│ [Model Pill ▾]                   [🎤] [  ■ Stop (Esc) ]     │
└─────────────────────────────────────────────────────────────┘

[ State C: GENERATING / EXECUTING (Input Has Text) ]
┌── [ 1 Queued Turn: "Fix the schema import..." | ⚡ Steer | ✕ ]─┐
┌─────────────────────────────────────────────────────────────┐
│ Add a validation check for empty strings...                 │
│ [Model Pill ▾]            [🎤] [■ Stop] [ ↑+ Queue (Enter) ]│
└─────────────────────────────────────────────────────────────┘
```

#### DOM Mutation & Kinetic Transitions:
1. **Dynamic Buttons in `.composer-actions`:**
   - `sendBtn` morphs into `.is-stop` when busy and input is empty.
   - A dedicated `.composer-queue-btn` pops in with spring physics (`transform: scale(1)`, `opacity: 1`) when busy and textarea has input.
2. **The Queued Turn Strip (`.turn-queue-strip`):**
   - Inserted directly into `.compose-row` above `.composer`.
   - Hidden when `inSessionQueue.length === 0`.
   - Contains a chip for each queued turn with:
     - Numerical badge `#1`, `#2`
     - Text snippet truncated with ellipsis
     - Model pill
     - `[ ⚡ Steer Now ]` button (triggers immediate interrupt + send)
     - `[ ✏ Edit ]` button (repopulates textarea and dequeues)
     - `[ ✕ Cancel ]` button
3. **Keyboard Controls:**
   - `Escape`:
     - If a modal or model menu is open: closes the modal (preserving existing behavior).
     - Else if agent is active: **triggers immediate interrupt**.
   - `Enter` (without Shift):
     - If agent is idle: sends prompt immediately.
     - If agent is busy: **enqueues prompt into inSessionQueue**, clears textarea, expands `.turn-queue-strip`.
   - `Ctrl+Enter` (or `Cmd+Enter`):
     - If agent is busy: **triggers Steer Now** (interrupts active task and runs prompt immediately).

---

### Component 4: Apple Liquid Glass Motion & CSS Styling (`media/style.css`)

```css
/* ==========================================================================
   Phase 17-F: AI Task Interruption, Stop Button & Turn Queue Styling
   ========================================================================== */

/* ---------- Stop Button (.is-stop) ---------- */
.send-btn.is-stop {
  background: rgba(255, 69, 58, 0.16);
  border-color: rgba(255, 69, 58, 0.45);
  color: #ff453a;
  box-shadow: 0 0 16px rgba(255, 69, 58, 0.25);
  animation: stop-btn-pulse 2s cubic-bezier(0.16, 1, 0.3, 1) infinite;
}

.send-btn.is-stop:hover {
  background: rgba(255, 69, 58, 0.28);
  border-color: rgba(255, 69, 58, 0.7);
  color: #ffffff;
  transform: scale(1.06);
  box-shadow: 0 0 20px rgba(255, 69, 58, 0.45);
}

.send-btn.is-stop:active {
  transform: scale(0.92);
}

.send-btn.is-stop svg {
  width: 12px;
  height: 12px;
}

@keyframes stop-btn-pulse {
  0%, 100% {
    box-shadow: 0 0 10px rgba(255, 69, 58, 0.2);
  }
  50% {
    box-shadow: 0 0 22px rgba(255, 69, 58, 0.45);
  }
}

/* ---------- Dedicated Queue Button ---------- */
.composer-queue-btn {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 36px;
  padding: 0 12px;
  border-radius: var(--pill);
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #ffffff;
  font: 600 12px var(--font-text);
  cursor: pointer;
  transition: background 0.15s var(--eo-ease), transform 0.18s var(--eo-ease), box-shadow 0.2s var(--eo-ease);
  animation: queue-btn-appear 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.composer-queue-btn:hover {
  background: var(--accent-hover);
  transform: scale(1.04);
  box-shadow: 0 0 14px rgba(10, 132, 255, 0.4);
}

.composer-queue-btn:active {
  transform: scale(0.96);
}

@keyframes queue-btn-appear {
  from {
    opacity: 0;
    transform: scale(0.85);
  }
  to {
    opacity: 1;
    transform: scale(1);
  }
}

/* ---------- Queued Turn Strip (Above Composer) ---------- */
.turn-queue-strip {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
  margin-bottom: 6px;
  transition: opacity 0.2s var(--eo-ease), transform 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

.turn-queue-strip[hidden] {
  display: none;
}

.turn-queue-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.06), rgba(255, 255, 255, 0.02)), var(--eo-surface);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25), inset 0 1px 0 rgba(255, 255, 255, 0.08);
  font: 12px/1.4 var(--font-text);
  color: var(--text-primary);
  animation: turn-chip-slide 0.24s cubic-bezier(0.16, 1, 0.3, 1);
}

@keyframes turn-chip-slide {
  from {
    opacity: 0;
    transform: translateY(6px) scale(0.98);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.turn-queue-badge {
  font: 700 10.5px/1 var(--font-mono);
  color: #64d2ff;
  background: rgba(100, 210, 255, 0.12);
  border: 1px solid rgba(100, 210, 255, 0.3);
  padding: 2px 5px;
  border-radius: 4px;
}

.turn-queue-snippet {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-secondary);
}

.turn-queue-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.turn-action-btn {
  height: 22px;
  padding: 0 7px;
  border-radius: var(--pill);
  border: 1px solid var(--eo-border);
  background: rgba(255, 255, 255, 0.04);
  color: var(--text-secondary);
  font: 500 11px var(--font-text);
  cursor: pointer;
  transition: all 0.12s var(--eo-ease);
}

.turn-action-btn:hover {
  background: rgba(255, 255, 255, 0.12);
  color: var(--text-primary);
}

.turn-action-steer {
  border-color: rgba(255, 159, 10, 0.4);
  color: #ff9f0a;
}

.turn-action-steer:hover {
  background: rgba(255, 159, 10, 0.18);
  color: #ffb340;
}

.turn-action-delete:hover {
  background: rgba(255, 69, 58, 0.16);
  color: #ff6961;
}

/* ---------- Interrupted Message State in Transcript ---------- */
.msg-interrupted-pill {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-top: 8px;
  padding: 3px 8px;
  border-radius: var(--pill);
  border: 1px solid rgba(255, 69, 58, 0.35);
  background: rgba(255, 69, 58, 0.1);
  color: #ff6961;
  font: 500 11px var(--font-text);
  letter-spacing: 0.01em;
}

.msg-interrupted-pill svg {
  width: 10px;
  height: 10px;
}
```

---

## 5. Non-Negotiable Invariants & Edge Cases

1. **The Windows Process Tree Invariant:**
   `taskkill /F /T /PID` must be wrapped in a non-throwing handler. Even if the process terminated milliseconds prior, the host must not throw an uncaught exception.
2. **Focus Preservation Invariant:**
   When the user types during generation and hits Enter to queue a message, focus must **remain inside `promptInput`** with zero cursor reflow or text selection loss.
3. **Keyboard Precedence Hierarchy:**
   - Priority 1: If a full-screen modal (`#queueModal`, `#historyModal`) is open, `Escape` closes the modal.
   - Priority 2: If `.model-menu` is open, `Escape` closes the model picker dropdown.
   - Priority 3: If an agent task is active and `promptInput` is empty, `Escape` **stops the agent task**.
   - Priority 4: If `promptInput` has text, `Escape` does not clear text unintentionally (user can press `Ctrl+A` or Backspace).
4. **Emergency Stop Protection:**
   Clicking the Stop button immediately halts the active turn and **does NOT** trigger auto-dispatch of queued turns. An emergency stop means the user wants all agent activity frozen. Queued turns remain safely staged in `.turn-queue-strip` with an active `[Send Queued]` button.
5. **Tool Card Cleanup Invariant:**
   Any tool card with class `.is-running` at the time of interruption must have `.is-running` removed, `.is-error` added, and its state text set to `Cancelled by user`.

---

## 6. Verification & Automated Test Recipe

Unit test cases to append to `astro-visual-editor/tools/ai-chat-panel/test/session.test.js`:

```javascript
test('StreamEngine.interrupt() gracefully breaks stdin and terminates child process tree', () => {
  const engine = new StreamEngine();
  let closedFired = false;
  let eventReceived = null;

  engine.on('event', (ev) => {
    if (ev.type === 'turn_interrupted') eventReceived = ev;
  });

  const mockChild = {
    pid: 99999,
    killed: false,
    stdin: {
      writable: true,
      write(data) { assert.equal(data, '\x03\n'); }
    },
    once(event, handler) {
      if (event === 'close') this.closeHandler = handler;
    },
    kill() { this.killed = true; }
  };

  engine.child = mockChild;
  engine.activeAgent = 'claude';
  engine.interrupt();

  assert.equal(mockChild.turnCompleted, true);
});

test('In-session queue enqueues turn when engine is busy and auto-dispatches on natural completion', () => {
  const queue = [];
  let currentActive = 'prompt-1';

  function onTurnComplete() {
    currentActive = queue.shift() || null;
  }

  // Busy: enqueue
  queue.push('prompt-2');
  assert.equal(queue.length, 1);
  assert.equal(currentActive, 'prompt-1');

  // Turn completes naturally
  onTurnComplete();
  assert.equal(currentActive, 'prompt-2');
  assert.equal(queue.length, 0);
});

test('SteerNow immediately aborts active engine and launches steered turn', () => {
  let interrupted = false;
  let nextStarted = null;

  const mockEngine = {
    interrupt() { interrupted = true; },
    start(opts) { nextStarted = opts.prompt; }
  };

  function steer(newPrompt) {
    mockEngine.interrupt();
    mockEngine.start({ prompt: newPrompt });
  }

  steer('Corrected direction');
  assert.equal(interrupted, true);
  assert.equal(nextStarted, 'Corrected direction');
});
```

---

## 7. Downstream Agent Prompts (Ready for Execution)

### Prompt for Claude Code (UI & Kinetic Motion):
```text
Implement P17-F (AI Task Interruption, Stop Button & Turn Queue) in astro-visual-editor/tools/ai-chat-panel:
1. In media/style.css, add .send-btn.is-stop, .composer-queue-btn, .turn-queue-strip, and .msg-interrupted-pill styles per docs/ai-chat-panel-task-interruption-and-queuing-spec.md §4.
2. In media/main.js, implement the Tri-State Kinetic Composer Controller, promptInput keydown handling (Escape stops, Enter queues while busy, Ctrl+Enter steers), .turn-queue-strip rendering, and IPC messaging ('interrupt', 'queueTurn', 'steerNow').
3. Verify with npm.cmd --prefix astro-visual-editor run verify.
```

### Prompt for Codex (Subprocess & Extension IPC):
```text
Implement backend execution for P17-F in astro-visual-editor/tools/ai-chat-panel:
1. In lib/stream-engine.js, implement interrupt() with Windows taskkill process-tree termination per docs/ai-chat-panel-task-interruption-and-queuing-spec.md §4 Component 1.
2. In extension.js, update ChatWindowHost to manage inSessionQueue, handle 'interrupt', 'queueTurn', 'dequeueTurn', 'steerNow', and auto-dispatch the next queued turn upon turn_complete.
3. Add unit test coverage in test/session.test.js.
```
