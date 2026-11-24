# What Clanker already does

One list, one place per capability. The README, the site and the store page copy their short version from here; if you change a line, change it here first. Checked against the code and tests on 2026-11-25. "Verified" below means exercised on that platform, not "shipped".

## Providers and handoffs

- **Claude Code, Codex, Antigravity (Gemini) and GitHub Copilot in one chat**, one model per message. Clanker runs the official CLIs headlessly and parses their structured streams, using your own sign-ins. Code: `ai-chat-panel/lib/providers/`, `lib/stream-engine.js`. Guide: [adding a provider](adding-a-provider.md).
- **Handoffs with a briefing.** The next agent gets a condensed summary of what the others did; shortened parts point to a full transcript. Code: `lib/chat-history.js`, `lib/chat-recovery.js` ([recovery](chat-recovery.md)).
- **Cross-vendor agents.** `clanker-load-agent` starts a Claude, Codex or Antigravity task from inside another agent; the chat's **Agents** sheet shows the running tasks. Guide: [agent bridge](agent-bridge.md). Only fake CLIs have been run end to end.
- **`/architect <task>`**: one model plans and another builds ([`aiChatPanel.architectModel`, `editorModel`](../ai-chat-panel/package.json)). Other slash commands: `/undo`, `/verify`, `/remote-control`, `/grillme`.
- **Sign-in help.** A signed-out CLI shows a red ring, a card in the chat and a sign-in action (on Linux, Antigravity's browser sign-in runs in a setup terminal). Code: `lib/auth-gate.js`, `lib/cli-accounts.js`.

## Quota and scheduling

- **Usage rings** per provider with the percentage left in the 5-hour window and the reset time (`lib/quota*.js`, the rail). The optional second extension `antigravity-usage-statusbar/` puts the gauges in the status bar.
- **Scheduler.** A prompt that hits a limit queues **Continue** for the reset; you can schedule prompts for a clock time, queue them behind the running turn, reorder them and move one to another provider. The editor must stay open (`lib/scheduler-queue.js`).
- **Early usage windows.** A tiny ping every 5 hours starts each subscription window (`lib/session-warmup.js`); an optional Google Cloud variant runs it without your PC ([guide](cloud-usage-windows.md)).
- **API value meter and per-turn reply cost**: every turn priced at pay-per-token rates, as a comparison and not a bill (`lib/cost-meter.js`).

## Safety and undo

- **Undo turn.** Each turn snapshots the working tree (`git stash create`); `/undo` or the button restores what the turn changed and leaves other files alone (`lib/turn-undo.js`).
- **What a turn changed.** Under a reply, "N files changed +A −D" opens to the files; a file opens the editor's diff against the pre-turn copy (`lib/turn-diff.js`).
- **Auto-verify.** After a turn Clanker can run your check (`/verify`, `aiChatPanel.verifyCommand`) and report the result.
- **Permission modes** per chat (`aiChatPanel.permissionMode`) and a log viewer for every CLI run (**Show Logs**).
- **Compliance options** for loops: scout redaction and an EU compliance guide ([compliance](compliance-eu.md)).

## Voice

- **Dictation** with Groq Whisper: record in the chat or by hotkey, cleanup, a personal dictionary, long recordings kept 7 days and recoverable (**Recover Voice Recording**). Needs a free Groq key (Settings > Voice). Code: `voice-router/`, `lib/voice-*.js`.
- **Hotkey.** System-wide on Windows (`voiceHotkey`). On Linux a desktop shortcut runs `scripts/linux/clanker-dictate`, which talks to the editor through a Unix socket (`lib/dictate-socket.js`).
- **Model routing** by prompt and quota ([routing](routing-config.md)).

## Projects and loops

- **Projects.** Register folders; a chat has one primary project root that stays explicit across queued and scheduled turns (`ai-chat-panel/PROJECTS.md`).
- **Loops.** A durable scan, fix and verify pipeline over a project, fixes made in an isolated worktree, with budgets and resumption ([loops](loops.md), `lib/loop-engine.js`).
- **Remote control.** Telegram ([setup](telegram-setup.md), [risks](telegram-security-and-risks.md)) and an optional Cloudflare tunnel.
- **UI.** Liquid Glass chat windows, a launcher rail, pinned chats, a composer that behaves like a Dynamic Island, attachment previews, and the Clanker Paper and Ink colour themes (`clanker-theme/`).

## Platforms

| Platform | Status |
|---|---|
| Windows 10/11 | Primary; a Windows CI job runs the unit tests. |
| Linux | Verified on Ubuntu 24.04 (GNOME) and Kubuntu (KDE Plasma, Wayland, VS Code), an Ubuntu CI job runs the unit tests: notifications, chime, keep-awake, clipboard, media pause, dictation, process cleanup. The system-wide hotkey is replaced by `scripts/linux/clanker-dictate`. |
| macOS | Untested. |
| Editors | VS Code and Antigravity IDE. |

## Not built yet

See [`TODO.md`](../TODO.md): a worktree per chat, a headless runner for scheduled turns, recurring prompts, provider contract tests.
