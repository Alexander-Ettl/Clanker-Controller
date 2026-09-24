# Voice Router

Voice-to-LLM quota-aware router. Spec: [`docs/voice-quota-router-spec.md`](../../docs/voice-quota-router-spec.md).

Speak a prompt, and it transcribes (Groq Whisper), cleans it up and classifies
its intent (Groq `openai/gpt-oss-120b`), then routes it to Claude, Codex, or
Gemini based on the task type and your live token quotas — reading the same
caches as [`astro-visual-editor/tools/antigravity-usage-statusbar/`](../antigravity-usage-statusbar/).

Two ways to use it: a manual CLI, or a background hotkey daemon.

## Setup

1. `astro-visual-editor/tools/voice-router/.env` (gitignored, never commit it):
   ```
   GROQ_API_KEY=your-key-here
   ```
   Get a key at console.groq.com.
2. Node 18+ (uses native `fetch`/`FormData`). Nothing to `npm install` — no
   dependencies.
3. For audio input, [ffmpeg](https://ffmpeg.org/) on `PATH` (already present
   on this machine via winget).

## CLI

```bash
node router.mjs --text "add a new button to the styleguide with glassmorphism"
node router.mjs --audio some-clip.wav
node router.mjs --text "..." --file site/src/content.config.ts   # extra context
node router.mjs --text "..." --json                              # raw contract output
```

Prints the routing decision and copies the cleaned prompt to your clipboard.

## Batch mode

Synthesizes a whole staged batch of tasks (from the Content Editor's "Finish
Edit" flow, or any hand-written JSON array of `{ prompt, file }` objects) into
one master directive per target model, instead of routing them one at a time:

```bash
node router.mjs --batch                                   # defaults to site/.astro/session/batch-tasks.json
node router.mjs --batch path/to/tasks.json
node router.mjs --batch path/to/tasks.json --json          # raw packages/breakdown/quotasUsed
```

Classification (`lib/batch-synthesizer.mjs`) is a deterministic keyword/file
classifier, not an LLM call — same UI/backend/planning buckets as the
single-prompt pipeline, plus the same `< 20%` Claude-quota failover to Codex.
Prints a breakdown and every synthesized package, then copies the first
one to the clipboard. See [`docs/batch-synthesis-workflow.md`](../../docs/batch-synthesis-workflow.md)
for the full design (and its own corrected-status note on what's actually
implemented vs. originally envisioned).

The browser side of this (`overlay.js`'s "Finish Edit" button) calls the same
`synthesizeBatch()` over HTTP via a `/batch-tasks/synthesize` route on the
Content Editor's dev server — one classifier, shared by both entry points.

## Daemon (hotkey, mic capture, auto-dispatch)

`daemon.ps1` runs in the background, listens for a global hotkey, records
from your mic, and runs the recording through the same pipeline as the CLI.

**Start it:** double-click `start-daemon.bat`, or:
```powershell
powershell -File daemon.ps1
```
A tray icon appears; right-click it to Exit.

**Use it:** press the hotkey (default `Ctrl+Alt+Shift+V`, toggle mode) to
start recording, press it again to stop. A toast shows the routing decision.

**Config:** `daemon.config.json`
```jsonc
{
  "hotkey": { "modifiers": ["Control", "Alt", "Shift"], "key": "V" },
  "micDevice": "Mikrofonarray (Realtek(R) Audio)",
  "ffmpegPath": "ffmpeg",
  "nodePath": "node",
  "windowTitles": { "claude": "Claude Code", "codex": "Codex" },
  "autoSubmit": true,
  "submitDelayMs": 1200,
  "recordingsDir": ".recordings"
}
```

- **`micDevice`** must match a DirectShow device name exactly. List yours
  with `ffmpeg -list_devices true -f dshow -i dummy`.
- **`hotkey`** — if registration fails at startup (a toast + log line say
  so), something else already owns that combo; pick another. `Ctrl+Alt+Space`
  is commonly taken by an IME/input-switcher shortcut.
- **`windowTitles`** — substrings matched against open windows'
  `MainWindowTitle`. Only matters for auto-dispatch (see below); Gemini has
  no entry on purpose (routes to clipboard-only, a browser tab isn't a
  reliably targetable window).

### How dispatch actually works

After routing, the daemon looks for an open window whose title contains the
target model's `windowTitles` entry.

- **Found:** activates it, pastes the cleaned prompt (`Ctrl+V`), and — if
  `autoSubmit` is on — presses Enter after `submitDelayMs`. **Press Esc
  during that delay to cancel** the send; the text stays pasted but unsent.
- **Not found:** clipboard-only. A toast names the target model; paste it
  in yourself.

**This only auto-submits into a window it can positively identify by
title.** It will never paste-and-Enter into whatever happens to be
focused — if the target window isn't found, it stops at clipboard-only. That
matters because `autoSubmit` sends an unreviewed prompt straight into a
live coding agent that can act on it.

**If Claude Code and Codex both run as tabs inside one VS Code window**,
their `MainWindowTitle` is the same VS Code window — the daemon can't tell
them apart, so it always falls back to clipboard-only for both, regardless
of the `windowTitles` config. To get real auto-dispatch, run each in its own
OS-level window with a distinguishing title, e.g. a Windows Terminal window
per agent:
```powershell
wt --title "Claude Code" pwsh -NoExit -Command "claude"
wt --title "Codex" pwsh -NoExit -Command "codex"
```

Recordings are written to `.recordings/` and deleted immediately after each
one is processed (gitignored either way).

## Tests

```bash
node test/test-scenarios.mjs           # single-prompt routing matrix + quota-reader smoke test
node test/test-batch-synthesizer.mjs   # batch classifier + package synthesis + quota failover
```

Both are deterministic — no network call, no API key needed. The Groq call
itself is only exercised by actually running the CLI or daemon; batch mode's
classifier never calls Groq at all (see "Batch mode" above).
