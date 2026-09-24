# AI Chat Panel

Headless Claude Code, Codex, and Gemini chat, opened as movable Liquid Glass
floating windows (`vscode.window.createWebviewPanel`, `ViewColumn.Beside`)
from a lightweight launcher in the Activity Bar's Primary Side Bar. Because
chat lives in floating windows rather than the Primary Side Bar itself, the
File Explorer can stay open on the left at the same time (P13-J). Spec:
[`docs/ai-chat-studio-architecture.md`](../../docs/ai-chat-studio-architecture.md).

## Architecture (and why it isn't node-pty)

The spec allows either `node-pty` or `vscode.window.createTerminal`. This
machine has no C++ build toolchain (no `cl.exe`/`node-gyp`), and a native
module would in any case need to match VS Code's bundled Electron/Node ABI,
not the system Node — a second, independent failure point, and one that can
resurface on every VS Code update. `createTerminal` gives a real OS PTY for
free (it's what VS Code's own integrated terminal uses), so `claude`,
`codex`, and `gemini`'s interactive menus, spinners, and ANSI output all
render correctly, with zero native dependencies.

**The tradeoff:** terminal output is not mirrored pixel-for-pixel inside the
custom webview the way the spec's `xterm.js` panels envisioned. Each agent
can still get a real, normal VS Code terminal named `AI Panel: <agent>`, but
day-to-day chat no longer runs through it — `lib/stream-engine.js` spawns
`claude`/`codex`/`agy` headlessly (NDJSON over stdio) and streams the
normalized events straight into the chat window, so no real terminal ever
has to pop up. The `[ >_ ]` button per chat window is the escape hatch: it
reveals that agent's real terminal on demand, for when the renderer breaks
or you need to inspect the raw session.

`lib/pty-session.js` and `lib/quota-bridge.js` take the `vscode` API by
injection rather than requiring it directly, so the session lifecycle logic
is unit-testable with a plain mock object — no `@vscode/test-electron`
(a full downloaded VS Code test instance) needed for this tool's size.

## Revert starts a fresh session (decision, 2026-09-23)

Revert (`revertToMessage` in `extension.js`) forks the chat with the visible
messages only. The fork carries no agent session ids, so the next turn starts
a new session briefed by `lib/chat-handoff.js`: the oldest turns are dropped,
the rest arrive condensed without tool output. The context gauge then shows
that new session's real size, which is far below what the original chat had
used.

**Considered and rejected for now:** a true Claude rewind. The Agent SDK
documents `resume`, `forkSession` and `resumeSessionAt` (resume up to a given
message UUID, Claude Code v2.1.223+, also read by print-mode resumes). Storing
each reply's assistant message UUID and passing
`--resume <id> --fork-session --resume-session-at <uuid>` on the fork's first
turn would keep the full context up to the reverted message. Codex and agy
have no documented equivalent and would keep the handoff either way.

We kept the handoff because in practice it works well: the condensed briefing
is enough to carry on, and replies come back noticeably faster in the much
smaller context. Revisit if a revert ever loses something the summary can't
carry.

## Try it

1. Open this folder (`astro-visual-editor/tools/ai-chat-panel/`) in VS Code, press `F5` (Run →
   Start Debugging) → launches an Extension Development Host window with
   the extension loaded.
2. In that new window, click the AI Chat Panel icon in the Activity Bar —
   this opens the Launcher (not a full chat), so the File Explorer stays
   available in the same sidebar slot.
3. Click **`[ ➕ New Chat Window ]`** to open a chat as a floating panel on
   the right (`ViewColumn.Beside`) — drag it into any editor group, the
   Secondary Side Bar, or detach it into its own OS window. Open several at
   once for different agents/threads; each has its own thread and its own
   headless subprocess. Pick a tab (Auto/Claude/Codex/Gemini) — Auto
   auto-routes every message and stays selected across turns — type, Enter
   to send.
4. The launcher's **Recent** list reopens (or reveals, if already open) a
   past thread in its own window; `[ × ]` deletes it from disk.

`claude`, `codex`, and `gemini` must be on `PATH`. Codex/Gemini also need
their own `login`/auth flow completed once before they're useful.

## Installation into Antigravity IDE

To install into Antigravity IDE (`~/.antigravity-ide/extensions/local.ai-chat-panel-0.1.0`), use the bundled installer script:

```powershell
# Copy files into ~/.antigravity-ide/extensions and register in extensions.json:
powershell -ExecutionPolicy Bypass -File .\install-into-antigravity.ps1

# Or create a Directory Junction for live development (recommended):
powershell -ExecutionPolicy Bypass -File .\install-into-antigravity.ps1 -Link
```

Then run **Developer: Reload Window** (`Ctrl+Shift+P`) in Antigravity.

> [!WARNING]
> **Windows PowerShell UTF-8 BOM Pitfall:** Never use PowerShell 5.1's `Set-Content -Encoding utf8` or `Out-File -Encoding utf8` to edit `package.json`. It prepends a 3-byte Byte Order Mark (`0xEF 0xBB 0xBF`), which crashes Antigravity's Shared Process manifest scanner (`JSON.parse`) with `SyntaxError: Unexpected token '﻿'` and causes the extension to be silently ignored. See [`docs/antigravity-extension-discovery.md`](../../docs/antigravity-extension-discovery.md) for full architectural documentation.

## Voice input

The mic button (one per chat window) records from the same mic device
configured in
[`astro-visual-editor/tools/voice-router/daemon.config.json`](../voice-router/daemon.config.json)
(`ffmpeg`, same as the voice-router daemon), then runs it through
`astro-visual-editor/tools/voice-router/lib/groq-client.mjs`'s transcribe → clean → classify →
route pipeline (dynamically imported — this extension is CommonJS, that
library is ESM) and sends the cleaned prompt through that window's own
headless `send` pipeline, targeting whichever agent the classifier picked.
No clipboard, no window-title guessing, no real terminal involved.

Needs `astro-visual-editor/tools/voice-router/.env` with `GROQ_API_KEY` set (loaded the same
way `router.mjs` loads it).

## Voice router command integration

`aiChatPanel.injectPrompt` — callable from anywhere (another extension, a
task, a future daemon.ps1 wiring):
```js
vscode.commands.executeCommand('aiChatPanel.injectPrompt', {
  targetModel: 'claude', // 'claude' | 'codex' | 'gemini'
  prompt: 'add a glassmorphism hover effect to the project cards',
  submit: true, // optional, defaults true
});
```
Targets the active floating chat window (or opens a new one on the right if
none is open), switches it to `targetModel`, and sends the prompt through
the headless pipeline — it never touches the Activity Bar or a real
terminal. `submit: false` drops the prompt into that window's composer for
review instead of sending it immediately.

## Tests

```bash
npm test
```
Exercises the terminal session lifecycle against a mock `vscode` object
(start/reuse/idempotent-restart/recreate-after-close/dispose), runs
`node --check` over every source file, and checks `package.json`'s
contributed views/commands. No live VS Code instance required.
