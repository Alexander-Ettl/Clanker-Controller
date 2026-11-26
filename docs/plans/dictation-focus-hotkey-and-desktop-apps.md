# Dictation focus, a configurable hotkey, and desktop apps vs CLIs

Status 2026-11-25: section 1 (animation per chat) is built, uncommitted; the rest is researched, not built. Backlog entries: VOICE-01 (dictation), DESKTOP-01 (apps vs CLIs) and DESKTOP-02 (app updates) in the root `TODO.md`.

## 1. Dictation animation belongs to one chat

### What happened before the change (built 2026-11-25)
- One microphone is shared. `ChatWindowManager.broadcastMic` (`extension.js`) sends every state (`starting`, `recording`, `processing`) to **every** chat window with `target: true` for one of them.
- A window that is not the target is on purpose still animated, quietly: `applyMicState` / `setVoiceState` in `media/main.js` set `.is-voice-mirror`, and `style.css` dims the waveform to 0.42 opacity and greys the mic button (`.mic-pill.recording.is-mirror`). That is the "P17-ZA: every window animated in step" design, and `test/voice-targets.mjs` asserts it.
- The same applies to **transcribing**: `processing` also goes to every window, so the ghost lines and shimmer play in both chats while the text lands in one.
- Clicking the mic in a window that is only mirroring does not just move the animation. `pointerdown` sends `windowActive`, which makes that window the target, and then the `click` handler sees a recording mic and sends `micToggle`, which **stops and transcribes** (the tooltip even says so: "Click here to stop and transcribe into this chat instead").

### Wanted
1. Only the chat that receives the text shows recording or transcribing UI. Other chats show nothing.
2. Starting from the mic in the right chat animates only the right chat.
3. Clicking the mic in the left chat while the right one records **moves** the animation to the left chat; the recording keeps running and the text will land in the left chat.

### Plan (as built; the click race in step 4 is the one refinement)
Refinement found while building: a click fires `pointerdown` first, which moves the target, and the host's reply can reach the webview before the `click` does, so the click would read "recording" and stop it. So non-target windows get `idle` plus `elsewhere: 'recording' | 'processing'` (no animation, only a flag). The mic button decides on `pointerdown` whether the press is a move (`elsewhere === 'recording'`) and ignores that click; while another chat transcribes, the mic does nothing and says so in its tooltip.
1. Host: in `broadcastMic`, send the full state only to the target. Every other window gets `{ state: 'idle' }` (so it also clears a stale mirror). Keep `cue` as is. `broadcastMicVolume` goes to the target only.
2. Host: when the target changes mid-recording (`setActive` already replays `this.mic`), also send `idle` to the window that lost it, and replay the current state (`recording` or `processing`) to the new one.
3. Webview: delete the mirror path (`voiceMirror`, `.is-voice-mirror`, `.is-mirror`, the 0.42 opacity rule, the "Listening for another chat" tooltip). `micState` for this window is now always its own.
4. The click in a non-target window: add `micState.owner` knowledge to the webview (`target` is already sent). If a recording belongs to another window, a mic click sends `micMoveHere` (host calls `setActive(this)` and nothing else) instead of `micToggle`. Stopping stays one click on the window that owns the recording. Decision needed from you: should the first click in the other chat only move the animation (planned), or also stop and transcribe as it does now?
5. Processing target: transcription is bound to `capture.owner` at the moment recording stops. Clicking another chat during transcription must not move it; `setActive` already ignores `processing`, and a test will pin that.
6. Tests: rewrite `test/voice-targets.mjs` for the new rules (idle for non-targets, move on click, transcribing stays put) and keep `test/message-dock.mjs` / the composer tests green. The behaviour is pure window messaging, so it is testable with fake windows as that file already does.

Risk: small. The code is already target-aware; this removes the echo and one click path. Needs an editor reload.

## 2. The F9 hotkey

### Why it does not work (verified on this machine)
- `aiChatPanel.voiceHotkey` is **Windows only**: `VoiceHotkey.start` returns false unless `process.platform === 'win32'` (`lib/voice-hotkey.js`), and its helper polls `GetAsyncKeyState` in PowerShell. On Linux the setting is silently ignored.
- On Linux the design is a desktop shortcut that runs `~/.clanker/clanker-dictate`, which talks to a per-window Unix socket. Two sockets are live right now, so the receiving side works. But **nothing is bound**: no entry for Clanker in `~/.config/kglobalshortcutsrc`, and F9 is free there (only `Meta+F9` is used by KWin). The session is Wayland, where an app cannot grab a global key itself.
- Inside VS Code, F9 is "Toggle Breakpoint" by default, so even a working global F9 would also fire that in an editor.

### Plan: three layers, cheapest first
1. **In-editor shortcut (all platforms, works on Wayland).** Contribute `aiChatPanel.dictateToggle` (toggle only; VS Code has no key-up event) as a command with a keybinding that the user can rebind in VS Code's own Keyboard Shortcuts editor, which already warns about conflicts. Default binding scoped with a `when` clause for the chat view so F9 in an editor keeps toggling breakpoints. Works only while the editor has focus; that is stated in Settings.
2. **KDE/GNOME global shortcut without hand setup (Linux).** Preferred route: the `org.freedesktop.portal.GlobalShortcuts` portal (KDE Plasma 6 supports it). A small helper (python3 `gdbus` or `busctl`, no new dependency in the extension) registers "Dictate", asks for the user's preferred trigger, and receives `Activated` and `Deactivated`, so both toggle and hold mode work. The compositor shows its own binding dialog and reports conflicts itself. Fallback if the portal is missing: keep `clanker-dictate` and show the exact KDE steps plus a "Copy path" button in Settings. Check before building: the portal needs a registered app id, so confirm it works from an editor child process.
3. **Windows**: keep the current listener. Note that it polls keys and lets them through, so it cannot know a combination is already taken.

### Customising the key, with feedback
Settings > Voice already has a key-capture field (`media/voice-hotkey.js`, `fromKeyEvent`). Extend it:
- **"Press any key"**: capture, show the result live: green "usable", or the reason it is refused (bare letter or Shift+letter would fire while typing, a modifier alone, a key the platform cannot report).
- **Conflict warnings**, from sources that actually exist:
  - the user's `~/.config/Code/User/keybindings.json` and the keybindings that installed extensions contribute (read from each `package.json`);
  - a short built-in list of VS Code defaults (F9 breakpoint, F5, F10, F11, F12, Ctrl+P and similar), since VS Code does not expose its default table to extensions;
  - on KDE, `~/.config/kglobalshortcutsrc`; on Windows nothing can be checked, so the wording says "could not check other apps".
  - Conflicts warn but do not block, except for keys that cannot work.
- **Test button**: "Press the key now" confirms the key reaches Clanker (in-editor: command ran; global: the portal or socket fired).
- Mode (toggle or hold) stays as `aiChatPanel.voiceHotkeyMode`; hold is offered only where the layer supports it.
- Keep `aiChatPanel.voiceHotkey` as the stored value (setting IDs stay stable); `package.json` description changes from "(Windows only)" to what each platform does.

## 3. Desktop apps vs CLIs (research)

### Does Clanker use CLIs or the apps?
Clanker runs the CLIs headless: `codex app-server --stdio`, Claude Code in stream-json mode, and `agy` with its conversation database. For Codex that is the **same app-server protocol** the ChatGPT/Codex desktop app and the VS Code extension use. So Clanker already has the app's engine; what it lacks is the app's UI features and, on this machine, a shared login process.

### Findings per product
| | Desktop or IDE gives you | CLI gives you | Same engine? |
|---|---|---|---|
| **Codex** | Multiple threads, git worktrees, diff and Git panes, cloud tasks, computer use | Headless, SSH, scripting, `exec`, `app-server` for embedding | Yes, one app-server underneath |
| **Claude** | Visual diffs, parallel sessions, preview, PR monitoring, connectors. A Linux desktop **beta** exists (Ubuntu 22.04+, Debian 12+) without computer use or dictation | `claude -p`, `--output-format`, the Agent SDK, Bedrock/Vertex providers, environment-variable auth, agent teams, voice dictation | Yes; share CLAUDE.md, hooks and MCP |
| **Antigravity** | Editor with Tab completion, built-in browser, MCP store, agent panel (IDE); the 2.0 app | `agy -p`, JSON output, background agents, one binary, `/browser` opt-in, plugins and skills shared with the app | Same agent harness and settings; at launch the CLI lacked 1:1 parity with the old Gemini CLI |

Conclusion: no desktop-only model or quota. Everything Clanker needs (turns, tools, MCP, skills, models) is reachable through the CLIs, and they are the only route that scripts headlessly. The apps add UI that Clanker draws itself (diffs, worktrees, queue), so "use the app instead" would give the user a second UI, not more capability. Exceptions worth tracking: computer use (Codex app has it, Linux Claude Desktop does not) and cloud environments.

### The re-login problem you described (Codex)
This is real and documented in `openai/codex` issues #31459, #41973, #45663, #46438. Several processes share one `~/.codex/auth.json`. ChatGPT sign-in uses rotating refresh tokens; when one process refreshes, the others still hold the old token in memory, the next refresh is refused and Codex says "refresh token was revoked, sign in again". Desktop and CLI can also keep a stale token after a logout and login.
On this machine right now: the ChatGPT desktop app runs its own `codex app-server` (pid 3336) and an `exec-server`, Clanker starts more `codex app-server` children, and `~/.codex/config.toml` has no `cli_auth_credentials_store` setting, so the file store is used. That is exactly the reported setup.

Your observation that the app avoids this fits: the desktop app owns the credentials and its server is the one long-lived refresher. Clanker's children are extra refreshers.

### Options for Codex login (to decide)
1. **Keyring storage:** set `cli_auth_credentials_store = "keyring"` (KDE Wallet is installed). Reported workaround; all clients then read one store. Needs a live test with the desktop app running.
2. **One app-server for all Clanker chats** instead of one per process, so Clanker is a single refresher (fits DAEMON-01).
3. **Attach to the desktop app's login** via `account/login/start` with `chatgptAuthTokens` (host-supplied tokens). Most invasive; only worth it if 1 and 2 fail.
4. **Detect and explain:** when a turn fails with "refresh token revoked", show one clear message ("another Codex process refreshed the login; sign in once in Clanker") instead of a raw error, and restart Clanker's server after a login so it reloads the file.

Recommended order: 4 (cheap, helps today), then 1 (config only, test), then 2. Item 3 only if needed.

## 4. Updating the apps from Clanker (DESKTOP-02)

Yes, it is possible. How depends on how each app is installed, and on whether an update needs the system password.

### What exists today
The update badge and `aiChatPanel.autoUpdateClis` run each CLI's own updater (`<cli> update`, `lib/cli-tools.js`). Nothing touches the apps.

### Facts per app (this machine, 2026-11-25)
| App | Installed how | Latest version readable without root | Updated by |
|---|---|---|---|
| ChatGPT / Codex (Linux) | `chatgpt` deb from OpenAI's apt repo (`/etc/apt/sources.list.d/chatgpt.sources`); 26.1120.41243, **26.1120.50957 is available now** | Yes: `<repo>/dists/stable/main/binary-amd64/Packages` is a small public file with `Version:`, `Filename:`, `SHA256:` | `apt` (root) |
| Claude Desktop (Linux beta) | apt repo from Anthropic (not installed here) | Same `Packages` layout | `apt` only: the Linux app does not update itself |
| Antigravity IDE (Linux) | Tarball in `~/.local/opt/antigravity-ide-2.8.0`, started by a wrapper in `~/.local/bin` | Google's releases page | Nothing: no auto-update in this install; user-owned, so no root needed |
| Windows | Codex/ChatGPT from the Microsoft Store | `winget` | Store or `winget upgrade --id 9PLM9XGG6VKS -s msstore` (Store updates can fail on a locked MSIX, issue #25770) |
| macOS | The apps update themselves (Sparkle); Clanker can only show their version | - | the app |

The ChatGPT deb also contains `/usr/lib/chatgpt/resources/codex`, the copy Clanker ran before the locator fix. **Updating that app updates that engine too.** So an app update is the right update for anyone who runs the app's bundled binary, and the CLI updater is the wrong one (it failed with "Could not detect the Codex installation method").

### Design
1. **One descriptor per provider**, next to `npmPackage` / `latestVersion`: `desktopApp: { detect, installedVersion, latestVersion(fetch), update(onLine), needsRoot }`. Detection: `dpkg-query -W -f='${Version}' <pkg>`, the source URI read from the apt source file (not hard-coded), `winget list` on Windows, the app bundle's `Info.plist` on macOS.
2. **Version check** is a plain GET of the `Packages` index, compared with the same `isNewer` the CLIs use. No root, no `apt update`, no prompt.
3. **Update button (Linux apt):** `pkexec sh -c 'apt-get update -o Dir::Etc::sourcelist=<this source file> -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0 && apt-get install --only-upgrade -y <pkg>'`. The desktop shows its own password dialog; Clanker never sees the password. The refresh is limited to that one source so it does not rewrite the user's other lists. **Untested here**: it needs root, so it must be tried on a real machine before it ships. The download is 500 MB for the ChatGPT app, so the progress bar needs the `Size:` from the index.
4. **Auto-update, honestly:** apps that need no elevation (Antigravity tarball, user-level installs) can update silently like the CLIs. apt apps cannot: a password dialog appearing while you work is worse than a badge. For them auto-update means "check, notify, one click"; fully silent only if the user has `unattended-upgrades` or their own polkit rule. Clanker should not write polkit rules.
5. **Running apps:** apt replaces the files; the open window keeps running the old version. The row says "Restart ChatGPT to finish", and Clanker does not close the app.
6. **Which copy is updated:** the update row follows the copy `locate()` picked (CLI on PATH or the app's bundled binary), and the setting that chooses CLI or app engine (if added) chooses the updater with it.
7. **UI:** Settings > Models/Connections shows a second line per provider ("App 26.1120.41243 -> 26.1120.50957 [Update]"); the toolbar badge counts both; one new switch `aiChatPanel.autoUpdateApps` (default off for apt apps, on where no elevation is needed). Existing setting IDs stay.
8. **Antigravity IDE tarball:** possible (download, verify, extract beside the old one, switch the wrapper) but it replaces 270 MB of code from a download, and no checksum source was found. Do the apt case first, then decide; until then show the version and link the release page.

### Risks
- `pkexec` and the source-limited `apt-get update` are unverified on this machine.
- Windows/macOS update paths come from third-party write-ups and a GitHub issue, not from OpenAI's or Anthropic's own docs; confirm before building.
- The apt index and package names can change; the descriptor must fail quietly to "unknown" like the CLI check does.

## Status (2026-11-25)
Built, uncommitted: dictation focus (section 1), the in-editor F9 command (section 2, layer 1), and the Linux apt part of section 4 (`lib/desktop-apps.js`; ChatGPT app and Claude Desktop; the `pkexec` upgrade itself is not yet run by hand). Added later the same day: Claude Desktop's repository layout checked against Anthropic's Linux page and live index, Antigravity from a third-party apt repository (multi-package upgrade), and an agy feedback-survey switch-off (agy has no other telemetry control in print mode). Open: the key-capture UI, the portal shortcut, Codex login hardening, Windows/macOS/Antigravity app updates.

## 5. Order of work
1. Dictation focus (section 1), including the decision in step 4. Small, testable.
2. In-editor dictation command and the key-capture feedback UI (section 2, layers 1 and the UI). Works everywhere.
3. Linux global shortcut through the portal, with the documented fallback.
4. Codex login hardening (section 3, options 4 then 1).
5. App updates (section 4), apt apps first; then Windows/macOS; the Antigravity tarball last.
6. Revisit apps vs CLIs only if a user-visible gap appears (computer use, cloud tasks).

## Sources
- [Windows Store Codex fails to update, locked MSIX (#25770)](https://github.com/openai/codex/issues/25770)
- [Claude Desktop installation and updates on Linux](https://claude.com/docs/third-party/claude-desktop/installation)
- [Antigravity Linux packages and update options](https://x3m-industries.github.io/antigravity-packages/docs.html)
- [Codex Desktop keeps using revoked ChatGPT OAuth token (#31459)](https://github.com/openai/codex/issues/31459)
- [Refresh token revoked after ChatGPT login, 401 in Desktop and CLI (#41973)](https://github.com/openai/codex/issues/41973)
- [Windows Codex Desktop authentication loop while CLI works (#45663)](https://github.com/openai/codex/issues/45663)
- [Windows app fails when CLI refresh token is revoked (#46438)](https://github.com/openai/codex/issues/46438)
- [The Codex App Server: a complete guide](https://codex.danielvaughan.com/2026/04/15/codex-app-server-complete-guide/)
- [Codex CLI vs App vs VS Code Extension](https://bettertoken.ai/en/blog/codex-cli-vs-desktop-app/)
- [Claude Code Desktop vs CLI (2026)](https://www.agentastic.dev/compare/claude-code-desktop-vs-cli)
- [Claude on Linux: Desktop App and CLI](https://www.ssdnodes.com/learn/claude-on-linux-desktop-and-cli)
- [Choosing your surface: Antigravity 2.0, CLI, IDE or SDK](https://cloud.google.com/blog/topics/developers-practitioners/choosing-your-surface-antigravity-20-antigravity-cli-antigravity-ide-or-antigravity-sdk)
- [Antigravity CLI (agy): commands, modes](https://www.aibuilderclub.com/blog/antigravity-cli-guide)

Third-party comparison sites and GitHub issues were used; Google's and OpenAI's own docs were not opened, so feature lists should be confirmed there before building on them.
