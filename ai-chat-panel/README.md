# Clanker Controller

Working across folders? Follow the short [project setup guide](PROJECTS.md). Chats keep their selected project even when you switch editor tabs or open a different workspace.

(Formerly "AI Chat Panel", renamed 2026-09-29. Only what people read changed: the name in the UI, command titles,
notifications and the icon, a game controller with a robot's antenna. The internal ids keep the old name on
purpose (`aiChatPanel.*` commands, views and settings, the `ai-chat-panel` folder), so existing settings and the
editor's calls into this extension keep working.)

Headless Claude Code, Codex, and Gemini chat, opened as movable Liquid Glass
floating windows (`vscode.window.createWebviewPanel`, `ViewColumn.Beside`)
from a lightweight launcher in the Activity Bar's Primary Side Bar. Because
chat lives in floating windows rather than the Primary Side Bar itself, the
File Explorer can stay open on the left at the same time (P13-J). Spec:
[`docs/ai-chat-studio-architecture.md`](../docs/ai-chat-studio-architecture.md).

## Architecture (and why it isn't node-pty)

The model picker and Settings use the installed CLIs' model lists, with a
persisted cache for startup and failed refreshes. Claude supplies models and
efforts through SDK initialization; Codex uses `debug models`; Antigravity
uses `models`. Display names use spaces, and each model's reasoning levels
stay together. Favorite models in Settings to choose which appear in the
picker; saved chats retain their exact model and effort.

Settings separates setup from customization: General contains CLI connections,
update status, Available Models, and shared defaults. Models edits each favorite
separately, with its prompt, permissions (or inheritance from General), reasoning,
and removal from favorites. These settings also apply to queued and scheduled
turns. Changing reasoning retains the favorite's configuration; Remote keeps its
Telegram and tunnel controls.

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

`lib/pty-session.js` takes the `vscode` API by injection rather than
requiring it directly, so the session lifecycle logic
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

1. Open this folder (`ai-chat-panel/`) in VS Code, press `F5` (Run →
   Start Debugging) → launches an Extension Development Host window with
   the extension loaded.
2. In that new window, click the Clanker Controller icon in the Activity Bar —
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

Auto chooses one available favorite for each task, keeping its exact model and
reasoning effort. It uses the existing Groq classifier to compare the live favorites,
their saved instructions, and quota; no provider has a fixed role. If classification
is unavailable, it falls back to task complexity, reasoning effort, and quota.
Exhausted favorites are excluded; low-quota favorites are avoided when alternatives exist.
Manual selections keep the model you chose. Codex
runs under the permission mode selected in Chat Settings. Headless Gemini cannot
show approval prompts: in Ask or Auto, it skips actions that need approval.

`claude`, `codex`, and `gemini` must be on `PATH`. Codex/Gemini also need
their own `login`/auth flow completed once before they're useful.

Each chat owns its queue and runs it in the background while the IDE is running.
For example, Codex and Claude Code can both work through separate queues while
you view a third chat or leave the chat panel closed. Tasks run in order within
each chat; separate chats run in parallel. Switching chats does not pause a queue.
The pause/play button holds or resumes that chat's pending tasks; Pause lets the
current task finish, while Stop interrupts it and holds the remaining queue.

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

## The launcher rail (no sidebar patch needed)

The launcher is a 64px rail (new chat, Manage chats, the Scheduled timer pill, Settings, usage rings, recent chats) down the far right edge of the chat in the **secondary sidebar** (`aiChatPanel.chatView`), inside the chat's own webview, split from the chat by a full-height divider (popups such as Settings cover the chat only, not the rail): `railMarkup()` in `extension.js`, styled by `media/launcher.css`, driven by `media/launcher.js`. The chat is wide anyway, so the IDE's minimum sidebar width no longer matters and nothing in the IDE is patched. Chats opened as editor tabs have no rail.

The Activity Bar icon (`aiChatPanel.mainView`) is only a doorway: showing that view focuses the chat view and closes the primary sidebar again, so the left sidebar flashes briefly.

### Legacy: `patch-sidebar-width.ps1`

Earlier versions locked the *primary* sidebar to 64px by editing the IDE's bundled workbench file. That is no longer needed. It was restored on 2026-09-29 (`-Restore`: the file's SHA-256 matches both the backup and the checksum in the IDE's `product.json`, so the "corrupt installation" notice is gone). To undo a patch applied by hand, run `powershell -ExecutionPolicy Bypass -File .\patch-sidebar-width.ps1 -Restore` and reload the window (the pristine copy sits next to the patched one as `workbench.desktop.main.js.orig`, under `%LOCALAPPDATA%\Programs\Antigravity IDE\resources\app\out\vs\workbench\`). An IDE update also removes the patch.

**Known, accepted while the patch is applied: "Your Antigravity IDE installation appears to be corrupt. Please reinstall."** shows at every launch. Antigravity compares the workbench file with a hash stored in `resources\app\product.json`, and the patched file no longer matches. The notice is cosmetic; the IDE works. It is dismissed, not fixed, on purpose: silencing it means writing the patched file's hash into `product.json`, i.e. editing the IDE's own integrity check, which was deliberately left alone. If that is ever wanted, the hash is `sha256`, base64, without `=` padding, and `product.json` should be backed up first (`-Restore` would then need to restore both files).

The launcher's sidebar header looks blank but is not: VS Code draws the container title ("Clanker Controller", which is also the Activity Bar tooltip) and cannot hide it. While the launcher is the visible sidebar view the extension writes `workbench.colorCustomizations["sideBarTitle.foreground"] = "#00000000"` (transparent, so the theme's sidebar background shows) to your user settings, and removes it again as soon as another view (Explorer, ...) is shown. If a window is closed while the launcher shows, the next start clears it. All sidebar titles share that one colour, which is why it is switched rather than set once. Any `sideBarTitle.foreground` you set yourself is remembered and put back.

## Voice input

The mic button (one per chat window) records from the same mic device
configured in
[`voice-router/daemon.config.json`](../voice-router/daemon.config.json)
(`ffmpeg`, same as the voice-router daemon), then runs it through
`voice-router/lib/groq-client.mjs`'s transcription and cleanup functions
(dynamically imported — this extension is CommonJS, that library is ESM).
Whisper Large v3 Turbo transcribes; GPT-OSS 120B cleans the text without
classifying intent. The cleaned prompt waits in the composer for review.
Dictation preserves Auto or your manual model selection. When you send,
the current chat router handles model selection; the microphone has no
separate routing rules.
Hovering the mic with a draft in the composer raises a small **Polish** button
(also on keyboard focus). It runs what you typed through the same cleanup model
in a typed-text mode (no spoken-form rules; it restructures, never adds
requirements) and replaces the draft in place, so Ctrl+Z brings your original
back. Drafts over 12,000 characters are refused, and a failure keeps your text.
No clipboard, no window-title guessing, no real terminal involved.

Needs `voice-router/.env` with `GROQ_API_KEY` set (loaded the same
way `router.mjs` loads it), or a Groq key saved through Chat Settings. When Groq is nearly used up
(80% of any limit by default, `groq_spill`) or answers 429, cleanup, titles and Auto go to GPT OSS 120B on
Cloudflare Workers AI instead, using the Cloudflare connection under Settings → Routing (or `CLOUDFLARE_ACCOUNT_ID` and
`CLOUDFLARE_API_TOKEN`). Dictation cleanup and titles share the router's budget checks and counters.
Cloudflare [does not train on prompts or share them with other customers](https://developers.cloudflare.com/workers-ai/platform/data-usage/).
Whisper transcription stays on Groq.

Correct a misheard word in the composer. After a typing pause, a visible
**Adding “word” to dictionary** notice starts a ten-second countdown. Click
its trash button to cancel; otherwise the spelling saves automatically and
a confirmation appears. The countdown pauses while the chat is hidden.
**Settings → Voice → Dictionary** is the full list: search, add, rename, switch off or delete words, scan a
project (or any folder) for its technical terms, or have a chat model edit it. Every list that reaches a model is
capped. See the
[microphone review and walkthrough](../docs/microphone-dictionary-review.md)
for routing, storage, behavior and verification details.

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

## Looking at UI changes

```bash
npm.cmd run render -- rail      # from the Clanker root; or: settings | queue
```
`test/render.mjs` draws a fixture with the real stylesheets in headless Chrome or Edge and prints the PNG's path
(`--scale=4`, `--width=<px>`, `--chrome=<path>` or `CHROME_PATH`). It is for reading a picture, not for asserting
anything. The fixtures are hand-written markup shaped like what `launcher.js` and `main.js` build; keep them in step.
