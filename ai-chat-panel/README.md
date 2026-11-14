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
[original studio design](../docs/archive/ai-chat-studio-architecture.md) (historical).

## Architecture (and why it isn't node-pty)

PDF references and attachment chips open in the editor using its registered PDF viewer,
like opening a file from Explorer.
Use a Markdown file link or a path/filename in backticks, such as `out/report.pdf`
or `report.pdf`. Relative paths resolve from the chat's project root; web URLs
keep their normal link behavior.

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

A CLI can be signed in and still be unusable: its plan ended, credits ran out, or
its sign-in was rejected. Clanker checks the plan behind each sign-in on start, every
30 minutes and when Settings opens (a provider's optional `entitlement` in
`lib/providers/`: Codex reads the plan from its local token, Claude Code from
`auth status`, Antigravity from its language server's account tier), and also learns it from a failed turn (`lib/provider-access.js`, any
provider). It marks the CLI "Not available" in
General > Your CLIs with the reason and a Try again button, and drops its usage
ring, picker models and Auto routing. A plan flag clears itself once the plan is back;
a failed-turn flag waits for Try again or a new sign-in.
Limits that reset keep their gauge and scheduled-continue flow.

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

## Cross-agent briefings never lose what they shorten

When another agent answers in a chat, the next agent gets a condensed briefing
(`lib/chat-handoff.js`, 20,000 characters at most). Whatever it shortens stays
readable: each chat has a plain Markdown transcript at
`<session>/chats/transcripts/<chatId>.md` (`lib/chat-transcript.js`, written by
`ChatStore.transcript()` when a briefing is built, only if the chat changed).
It holds every user and assistant message in full and every tool call with its
complete command, result, diff and output (output as recorded: at most 16,000
characters per call). It lives in a subfolder, so the chat list and
`storage-gc.js` never see it; deleting the chat deletes it.

- Every omission is marked `[...N chars omitted; full text: <file> line L, turn T, message M...]`;
  the briefing's header names the file and the total omitted. The agent opens
  it with its normal Read tool at that line.
- Lists and headings are cut at item boundaries (`lib/handoff-clip.js`): every
  item keeps its number and first line, spare budget goes to the bodies of the
  most severe (then earliest) items, and a closing paragraph is kept.
- Intermediate messages shrink to a one-line digest each; tool calls keep the
  start of the command (200 characters) and `[ok]`, `[exit N: first error
  line]`, `[failed: ...]` or `[no result]`, duplicates counted.
- `node scripts/handoff-demo.mjs` builds such a briefing from a real chat and
  checks that every pointer lands on the omitted text.

## Revert starts a fresh session (decision, 2026-09-23)

Revert (`revertToMessage` in `extension.js`) forks the chat with the visible
messages only. The fork carries no agent session ids, so the next turn starts
a new session briefed by `lib/chat-handoff.js`: the oldest turns are dropped
(and pointed at), the rest arrive condensed. The context gauge then shows
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

## Signed-out CLIs hold the queue (2026-11-11)

A "continue", a queued prompt or a scheduled one is sent while nobody is watching. If its CLI was signed out in the
meantime (Codex opened elsewhere, a token that ended), the prompt used to go out anyway and come back as `401
Unauthorized`. `lib/auth-gate.js` now asks first, on top of the same account state the sidebar rings use:

- **One state, one text, one button.** `CliAccounts` (`lib/cli-accounts.js`) owns what is wrong (`fault()`: signed out,
  sign-in expired, cannot start, not installed, plan/credits), when it last looked (`ensureFresh`), and what fixes it
  (`fix()`). The red ring in the rail, the chat's sign-in card, the Windows popup and the gate all read and press those, so
  they cannot disagree: whatever the rail's own check (startup, every 30 minutes, a closed terminal) or the gate finds, the
  other already knows. The gate keeps only the waiting: the incident, the popup, a 10 s poll and the `resolved` event.
- **Before sending:** the CLI's own status command (`codex login status`, no prompt, no tokens), reused for 30 s. Only a
  definite fault blocks. A check that itself fails lets the prompt go; its own error is still read afterwards. Gates:
  `ChatRun.startTurn` for everything queued (`queued` turns, scheduled hand-overs and "continue" all end up there) and
  `SchedulerWatchdog.tick` for the Scheduled tab.
- **Blocked:** the prompts stay where they are (chat queue, Scheduled tab), a card in the chat says what is wrong, and a
  Windows popup (`lib/auth-prompt.ps1`, not an IDE notification, since the IDE is often minimised) has the button that
  fixes it. **Sign in** (popup, card and the rail's ring) runs `<cli> login` headless (the CLI opens your browser),
  **Repair/Install** opens the setup terminal, **Try again** re-reads a plan flag. Antigravity has no sign-in command, so
  its popup only explains.
- **Released:** when the CLI answers "signed in" (our own sign-in finished, a 10 s background look, the rail's check, or
  **Check again**), the gate emits `resolved` once; the chats drain and the watchdog ticks, so everything goes out in its
  original order.
- **Expired mid-run:** a turn that ends with an auth error (`accessFailure` kind `auth`) calls
  `CliAccounts.markSignedOut`: the ring turns red as well, and the same popup opens. The prompt that hit the error goes back
  to the front of the queue (or "continue", if it had already worked) and waits behind the sign-in. Here the status command
  may still say "logged in" for a token the server dropped, so only a sign-in, **Check again**, or seeing the CLI signed
  out and then in again releases it, never a passing status look alone. Plan and credit failures keep their old
  "unavailable, Try again" flow.

Tests: `test/auth-gate.test.js`, `test/auth-hold.test.js` (both on the real `CliAccounts`, only the CLI process faked:
`test/auth-fixture.js`), `test/auth-hold-ui.mjs` (screenshots in `out/auth-hold-review`), `test/rail-fault-ui.mjs`
(`out/rail-fault`). Redo the popup picture with `AUTH_SHOT=<png>` set and the `AUTH_*` variables from `lib/auth-prompt.ps1` (it renders without showing).

## Agents can start other vendors' models (2026-11-11)

Claude's, Codex's and Antigravity's own sub-agents only run their own vendor's models. `lib/clanker-agent.js` is a shell
command any of them can call to start another vendor's model in the background and read its answer from
`<project>\_work\clanker\<task>\result.md`, with a `status.json` that says running, done or failed and why. The extension writes
the launcher `~/.clanker/clanker-agent.js` and the picker's model list (`~/.clanker/agent-bridge.json`) at every start and
whenever the models change; the global skill `clanker-load-agent` (in `ClaudeConfig/skills`, seen by all three CLIs) tells the
agents how to use it. Design, file layout, rules and what is still unverified: [docs/agent-bridge.md](../docs/agent-bridge.md).
Tests: `test/clanker-agent.test.js`.

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
> **Windows PowerShell UTF-8 BOM Pitfall:** Never use PowerShell 5.1's `Set-Content -Encoding utf8` or `Out-File -Encoding utf8` to edit `package.json`. It prepends a 3-byte Byte Order Mark (`0xEF 0xBB 0xBF`), which crashes Antigravity's Shared Process manifest scanner (`JSON.parse`) with `SyntaxError: Unexpected token '﻿'` and causes the extension to be silently ignored. See [`docs/antigravity-extension-discovery.md`](../docs/antigravity-extension-discovery.md) for full architectural documentation.

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

**Long recordings and the 7-day archive.** There is no length limit. The microphone writes WAV files of 5 minutes each
straight into `<session storage>/voice/<start time>/`. **Work happens while you speak:** as soon as a 5-minute part is
finished it is transcribed in the background, and the text is cleaned in chunks of about 3,500 characters as soon as a
chunk can no longer change. Pressing the hotkey then only has the last part left. A prompt of a minute or less never
reaches the first boundary and behaves as before (one transcription, one cleaning).

- **Silence is not uploaded.** For parts over 45 seconds, pauses of 1.2 s or more are cut to 0.4 s and the rest is sent
  as FLAC (a real 30-minute recording: 57 MB of WAV became 14 MB, in under 3 s of ffmpeg time). A part that is only
  silence costs no request. The WAV in the archive is not touched.
- **Cleanup waits instead of giving up.** The router allows 8,000 Groq tokens a minute, which a 30-minute dictation
  used to exceed in its first minute. A chunk that hits that limit is retried after 6, 20 and 45 s. A chunk that still
  fails is put in the composer as its raw text (the others stay cleaned) and the warning says how many.
- **Nothing is lost.** Every part's text is saved the moment it returns (`seg-000.txt`, ...), `transcript.raw.txt` is
  rebuilt after each part, and the cleaned text is saved as `transcript.txt`. A part that still fails after two retries
  is marked in the text with the path of its audio. `meta.json` records `finishMs` (how long the wait after the hotkey
  was) and the cleanup errors.
- **7 days.** Audio and text stay for 7 days (swept every six hours; a recording still being written is never swept),
  except when you cancel with Esc. If the IDE closes or the network drops mid-way, the next start offers the unfinished
  recording once. **Clanker Controller: Recover Voice Recording** picks any recording from the last week, transcribes
  only the missing parts and puts the text in the composer; **Open Voice Recordings Folder** opens the archive for
  manual transcription (`voice/README.txt` explains the files and how to join them). A hard crash of the recorder
  loses at most the part being written. A word spoken exactly at a 5-minute boundary can be clipped.

Correct a misheard word in the composer. After a typing pause, a visible
**Adding “word” to dictionary** notice starts a ten-second countdown. Click
its trash button to cancel; otherwise the spelling saves automatically and
a confirmation appears. The countdown pauses while the chat is hidden.
**Settings → Voice → Dictionary** is the full list: search, add, rename, switch off or delete words, scan a
project (or any folder) for its technical terms, or have a chat model edit it. The dictionary keeps thousands of words;
Clanker picks the ones that go to the models for each recording (recent use, the chat's project) and there is
nothing to pin. See the
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

## AGY question cards

AGY's headless JSON stream reports native `ask_question` steps as `unknown`, without their text or options, and auto-skips the answer. Clanker reads the original tool arguments from that conversation's local SQLite trajectory in read-only mode, shows the usual question card, and ends the turn before AGY continues past the question. Your answer starts the next turn on the model that asked it. Cards and their answered state are saved with the chat.

This bridge uses AGY's current local protobuf trajectory layout. If the database cannot be read, Clanker shows a notice. Regression checks: `node --test ai-chat-panel/test/agy-question.test.js ai-chat-panel/test/turn-queue.test.js` and `node ai-chat-panel/test/agy-question-ui.mjs` from the repository root. They do not send prompts to a live CLI.
