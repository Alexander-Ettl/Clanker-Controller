# TODO


Single source of open work for Clanker Controller. Reviewed 2026-10-22 against the working tree and project docs. Status here distinguishes user requests from older research; it doesn't certify unfinished code as complete.

## How to answer "What's left?"

Read this file after the root [README](README.md). Summarize **Interrupted**, **Ready**, **Deferred** and **Needs investigation** separately, using task IDs. Follow only the linked documents needed for the question. Don't promote archived proposals or unchecked spec lists into new commitments. Before implementing, inspect current code and uncommitted changes; don't send test prompts to real CLIs.

## Ready

### CONTEXT-01 Â· Recent chat work-context icons (free only)

- [x] 24 SVG icons (`ai-chat-panel/media/context-icons/`, contact sheet in [docs/plans](docs/plans/recent-chat-context-icons-sheet.html)), the Clef Flash classifier (`lib/work-context.js`), the latest-agent fix and the rail badge are built per the [contract](docs/plans/recent-chat-context-icons.md); categories live in `lib/work-context-categories.json`.
- [x] 2026-11-18: Recent tiles glide (260 ms, FLIP) when the list reorders, so an opened chat visibly swaps with the old first one. Rendered in dark and light; not yet seen in the live IDE.
- [x] Enabled `aiChatPanel.workContextIcons` in Antigravity user settings on 2026-10-29 after the requested live check passed. Reload the IDE to load the integrated extension code.
- [ ] Watch whether icons match real chats over a few days; synthetic checks do not establish real-chat accuracy.
- [x] Fixed the category badge protruding below the Recent hover preview: hide it during hover/focus and restore it after retraction, while keeping the category icon in the preview label. Recent items share one click/keyboard target. Initial classification now uses the last substantive request when a saved chat ends in an acknowledgement; established icons still survive â€œcontinueâ€. Verified with 17 classifier tests, the sidebar browser regression, syntax checks and the UI scenario at 900/420/320px (zero measured errors or warnings); inspected the motion screenshot. Remaining missing icons can still reflect confidence abstention; their individual causes are not recorded in saved chat data.
- [x] Recent tiles now lead with the chat's project icon (favicon or initials) instead of the provider logo; the provider shows as the tint of the work-icon badge. A chat without a project keeps the logo. Verified in the sidebar browser test (`recent-context.mjs`, `project-rail.mjs`) and screenshots. Requires an IDE reload.
- [x] Fixed startup integration after enabled icons remained invisible: restored runs resolve routing through their manager, the five recent nonempty chats request missing categories on startup or enable, and opening older chats requests their first category. Regression coverage restores a run before routing initialization. Requires an IDE reload for this extension-host fix.
- [x] Categories are now read when a task finishes: 10 s after the chime and last reply, skipped if a new turn began, a turn failed or was stopped, or the task was already read; the 5-minute cooldown and the turn-start trigger are gone. A chat with no category now takes Clef's top pick (only changes of an existing category need 0.70/0.20); that bar was why only 2 of ~446 saved chats had ever received one. Covered by `work-context.test.js` and a `ChatRun` turn-complete check in `recent-context.mjs`. Requires an IDE reload; chats that are already finished get theirs when opened (or among the five newest at startup), not retroactively for older ones.
- [x] Categories are now predicted from your prompt, not read from the finished answer: Clef gets the latest prompt plus a few earlier prompts (no AI replies) and the request goes out the moment the prompt is sent, so the icon updates while the answer is still being written. This replaces the 10 s after-the-chime wait above (`settleMs`, the idle check and `cancel` are gone). Covered by `work-context.test.js` and a `ChatRun.begin` check in `recent-context.mjs`. Requires an IDE reload.
- [x] agy file steps now show what they open: the card said only "View" because newer agy builds send `read_file`/`write_file`/`edit_file` with other parameter names than `view_file`'s `AbsolutePath`. `geminiToolTarget` now takes any path-like parameter (`path`, `file_path`, `DirectoryPath`, `paths`). The real parameter names of the new build are not captured anywhere yet; if a card still shows no target, check the step's parameters in `agy`'s stream. Older saved chats keep their empty cards (the path was never stored).
- [x] 8 non-coding categories (Studying, Notes and minutes, Organizing, Schedule and tasks, Math and numbers, Language, Ideas, Everyday life) are wired in after your rating: icons in `media/context-icons/`, categories in `work-context-categories.json`, the three description tweaks and one classifier sentence applied, and `LIMITS.inputTokens` raised from 1500 to 2000 (about 4 Neurons per call; roughly 250 classifications a day under the 1,000 cap, still free). Offline only: not yet run against the real endpoint with 24 categories, so a live check (`CLANKER_LIVE=1 node ai-chat-panel/test/work-context.live.mjs`, about 100 Neurons) is still open if you want one.
- [x] Manual category selection is available in Manage Chats (Choose work category), with Automatic to resume classification; Settings > General includes the work-context icon switch. Offline classifier and browser checks verified 2026-11-16.

**Built 2026-10-29:** offline tests (`work-context.test.js`, `recent-context.mjs`, `context-icons.mjs`) and one live run of `work-context.live.mjs` against the real endpoint: 19/19 synthetic requests picked the right category, 16 cleared the 0.70/0.20 thresholds, none wrongly; 52.6 Neurons in total (about 2.8 per call, so the 1,000/day cap allows roughly 350 classifications). Synthetic prompts only: accuracy on your real chats is unmeasured.

**Done when:** you have run it on real chats for a while and the icons are right often enough to keep it on.

**24-category live check 2026-10-29:** 27/27 synthetic requests chose the expected category, including all eight non-coding categories; 24 cleared confidence thresholds, zero wrong applications. The three abstentions were Writing, Everyday life and a context-dependent Visual design request. Used 106.27 Neurons of the test's 160 cap. All 16 focused unit tests, the 24-icon asset check and the real-rail browser check passed. The live script now covers all 24 categories and exits unsuccessfully on missing results or misclassification.

### 2026-11-24 outside review: what we take from it

An outside reviewer sent a six-pillar roadmap (cross-platform, ACP adapters, worktrees, checkpoints and diff review, background daemon, contributor hardening). Reviewed against the code on 2026-11-24; several of its premises were stale (Linux support, one-click turn undo, loop worktrees and structured Claude and Codex streams already exist), which is task DOCS-01. Decision: take the safety and reliability pieces, then chat worktrees, and skip the platform-expansion and rewrite pieces for now (see Deferred: MAC-01, ACP-01, DAEMON-01, LOOP-04, and the SQLite note). Order below is a suggested sequence, not a release commitment. Estimates are focused working days with AI assistance, including verification.

### DOCS-01 · Say what Clanker already does (first)

The review called Clanker Windows-only, said rolling back a turn "needs manual Git" and called provider handling "stdout scraping". All three are wrong today, so our own pages undersell the product. `site/public/index.html` still lists "Linux and macOS are untested" (Linux is verified on Ubuntu 24.04, see the README Platform paragraph, which sits below the fold). The README never mentions undo turn, auto-verify, `/architect`, per-turn reply cost, the Agents sheet or the cross-vendor `clanker-load-agent` bridge.

- [x] 2026-11-25: inventory written as [docs/capabilities.md](docs/capabilities.md) from the command list, settings, slash commands and `lib/` (the single source the README and site copy from).
- [x] 2026-11-25: site platform line, README platform paragraph and four Windows-only setting descriptions in `ai-chat-panel/package.json` fixed (Windows, Ubuntu 24.04 and Kubuntu verified; macOS untested; only the system-wide hotkey is Windows-only). The Marketplace page text comes from the README at the next release. Not deployed: the site change goes live with `site/deploy.sh`.
- [x] 2026-11-25: "What it already does" added to the README, grouped as listed, linking to docs/capabilities.md.
- [ ] Mirror the list on the site (only its platform line is fixed so far) and re-render the real-UI screenshots for undo and the reply-cost row (`docs/images/`, `node scripts/readme-shots.mjs` rewrites every screenshot, so review that diff). docs/capabilities.md is the one source.
- [ ] Consider the in-product side: Settings > General help or the onboarding (ONBOARD-01) should show the same list, so users find features without reading the README.

**Estimate (AI-assisted):** 2-4 hours (the screenshots dominate).

**Done when:** a first-time reader of the README, the site and the store page can name Clanker's safety, platform and scheduling features without opening the code, and none of the three pages contradicts the others or the code. Re-run the reviewer's checklist against the pages as a test.

### CI-01 · Run the tests on Ubuntu too

Linux support (2026-11-22) has no regression guard: `.github/workflows/ci.yml` runs only on `windows-latest`.

- [x] 2026-11-25: `ci.yml` runs a `windows-latest` and `ubuntu-latest` matrix (`npm run check`, `npm test`); the Windows-only and tool-dependent tests now skip with a reason string. Every `powershell.exe`/`taskkill` call in `lib/` was read and sits behind a `win32` branch.
- [ ] Watch the first pull request's Ubuntu run (it has not run on GitHub yet) and fix whatever a clean runner shows. Locally on Kubuntu 770 of 773 unit tests pass; the 3 failures are `loop-engine` cases that need `npm`, which this PC lacks and a runner has.

**Estimate (AI-assisted):** 1-2 hours, mostly waiting for CI runs. **Done when:** pull requests run both jobs and a Linux-only break turns the check red.

### LINUX-01 · Make Linux the development host (Kubuntu, from 2026-11-24)

The main machine moves from Windows 11 to Kubuntu 26.04 (KDE Plasma 6, Wayland). Linux was only verified on Ubuntu 24.04 GNOME, so Kubuntu is untested. Do this together with CI-01.

- [x] 2026-11-25: `C:/Dev` defaults became `~/dev` on Linux in `scripts/typecheck.mjs` (it now passes `--typeRoots`, so `tsconfig.json` needs no path), `scripts/theme-shots.mjs` (uses `code`, kills the process group instead of `taskkill`) and the three `*-performance.mjs` tests. Not run: `theme-shots.mjs` needs a display and a VS Code launch.
- [x] 2026-11-25: `ai-chat-panel/install-into-antigravity.sh` (wraps `scripts/install-extension.mjs`), `site/deploy.sh`, `router.sh` added; `patch-sidebar-width.ps1` deleted. `voice-router/daemon.ps1` and `start-daemon.bat` stay Windows-only on purpose: it is a tray hotkey app that the in-editor dictation and `scripts/linux/clanker-dictate` replace. `deploy.sh` has not been run (it deploys the live site).
- [x] 2026-11-25: media pause (MPRIS via `busctl`) and capture (`ffmpeg`/`pactl`) were already Linux-ready; verified on this Kubuntu/Wayland desktop with `scripts/linux/system-check.cjs` (clipboard, keep-awake, media pause, tree kill pass; notification toast is sent but cannot be read back without dunst). The dictation hotkey is now a Unix socket per editor window (`lib/dictate-socket.js`, `test/dictate-socket.test.js`) plus `scripts/linux/clanker-dictate` for a KDE shortcut. Not done: binding the shortcut in System Settings (yours), and a real end-to-end dictation (needs your Groq key in Settings > Voice).
- [x] 2026-11-25: `AGENTS.md`, `docs/publishing.md` and `docs/development.md` now describe npm, bash and `~/dev` (Windows kept as a second path). `core.autocrlf` is unset, which on Linux already means no conversion; the `.sh` files are executable and git keeps the bit.
- [ ] Re-add every project in Clanker (stored roots are `C:\Users\...` paths); old chats keep their Windows paths. Yours: it needs the Projects UI and your folders.
- [x] 2026-11-25: `scripts/linux/` holds `system-check.cjs`, `fake-mpris.py`, `vscode-run.sh`, `vscode-dictate.sh`, `clanker-dictate` and a README. `vscode-run.sh` and `vscode-dictate.sh` need `xvfb xdotool imagemagick`, which this PC lacks, so they are syntax-checked only.

- [x] 2026-11-25, first days in VS Code on Kubuntu: Antigravity sign-in no longer assumes the Antigravity IDE. "Sign in" opens a setup terminal with bare `agy`, presses Enter on its "Google OAuth" menu so the browser opens, watches `agy models` and closes the terminal once the account works (`autoSelectLogin`, `watchSignIn` in `lib/providers/gemini.js`, `CliAccounts.autoSelectLogin`). The Linux install line for `agy` (`antigravity.google/cli/install.sh`) is wired in. Covered by `cli-accounts.test.js`, `auth-gate.test.js`, `auth-hold-ui.mjs`; not yet run end to end with a real browser sign-in.
- [x] 2026-11-25: the VS Code install is now a link (`node scripts/install-extension.mjs vscode --link`), not a stale `.vsix` copy; reload the window after code changes.
- [x] 2026-11-25: opening a chat. Long tool outputs now arrive as a 1,200-character preview and the full text is fetched when the card is opened (`requestToolOutput`/`toolOutput`, `test/tool-output-lazy.mjs`). The Codex title repair re-parsed every saved Codex chat on each start and logged 22 "no rollout found" warnings for threads that only exist on the old PC; it now remembers settled names in `codex-thread-titles.json`. The browser's harmless ResizeObserver note is no longer logged as an error. Opens slower than 150 ms are logged as `chat open` with the split. A headless render of this 144-record chat took about 230 ms, so the remaining cost is unmeasured in the real window: if it is still slow, read that log line first.
- [ ] Known on this host: no system Node/npm (only the ChatGPT app's bundled Node), so three `loop-engine.test.js` cases that need `npm` fail; `chat-performance.mjs` times out at its scroll wait on Linux (same before and after these changes). Clanker-spawned shells inherit `GIT_CONFIG_COUNT=10` without `GIT_CONFIG_VALUE_0` from the launching app, which makes every `git` call fail there; unset it, and check where VS Code is launched from.

**Estimate (AI-assisted):** 3-5 hours plus checking each item on KDE. **Done when:** a fresh clone under `~/dev` passes `npm run check` and `npm test`, and voice, notifications, clipboard and keep-awake are checked on Plasma.

### PROVIDER-02 · Provider contract tests against recorded CLI output

Upstream CLI releases can change flags or event shapes overnight; today only hand-written fakes guard this.

- [ ] For each provider (Claude, Codex, Antigravity, Copilot) record real, anonymized output from a short turn per CLI version (text turn, tool call, error, rate limit, sign-out) as fixtures under `ai-chat-panel/test/fixtures/providers/<provider>/<version>/`. Redact tokens, paths and account names; never commit transcripts of real chats.
- [ ] Replay each fixture through `normalizeEvent` and the stream engine and assert the normalized events. New CLI versions add fixtures; old ones stay as regression guards.
- [ ] A scheduled (weekly) GitHub Action that installs the latest public CLI versions and checks `--version` and `--help` for the flags Clanker passes, opening an issue on drift. CI cannot sign in, so it must not claim to test turns. Don't send prompts to real CLIs from CI.
- [ ] When a provider's output no longer parses, show the sign-in or "update CLI" hint and the raw stderr path in the chat instead of an empty reply (reuse `auth-gate.js` and the log viewer).

**Estimate (AI-assisted):** 0.5-1 day including the weekly job. Recording real CLI output needs your logins and a few real prompts, so that part is yours. **Done when:** a CLI flag or event rename fails a named fixture test or the weekly job, and one broken provider never stops the others.

### DIFF-01 · Show what a turn changed, and open it as a diff

One-click undo exists (`lib/turn-undo.js`, snapshots from `git stash create` in `stream-engine.js`). What's missing is seeing the change before deciding.

- [x] 2026-11-25: after a turn that changed files, a collapsible "N files changed +A −D" line sits under the reply's actions, per repo, computed from the pre-turn snapshot (`lib/turn-diff.js`, `media/main.js` `turnDiffList`). Rendered in dark and light (`test/turn-diff-ui.mjs`, `SHOT_DIR=` saves pictures); not yet seen in the live editor.
- [x] 2026-11-25: clicking a file runs `vscode.diff` with the snapshot copy on the left through a `clanker-snapshot:` document provider; created files have an empty left side, deleted ones an empty right side (`ChatWindowHost.openTurnDiff`, `test/turn-diff-host.test.js`). The page sends only a list index; the host rebuilds the paths from the turn's own record.
- [x] 2026-11-25: it reads `planUndo`'s set, so the list and undo always agree (tested), and shows nothing when git pruned the snapshot. Not covered: a file that was untracked before the turn and edited by it (undo ignores it too).
- [ ] Stretch, only after the basics ship: attach selected diff lines as a review comment to the next prompt.

**Estimate (AI-assisted):** 3-6 hours including the rendered light and dark check. **Done when:** a turn that edits, creates and deletes files lists all three, each opens a correct diff, and undo still restores exactly the same set. Keep Liquid Glass styling.

### WORKTREE-01 · Optional git worktree per chat

The loop engine already creates a worktree per fix (`lib/loop-workspace.js`); chats can't, so two agents on one repo overwrite each other.

- [ ] An opt-in "Isolated worktree" choice when starting a chat: `git worktree add -b clanker/<slug>` under a managed folder outside the repo tree (not inside Nextcloud), with a setup list for ignored essentials (`.env`, dependency folders linked, not copied).
- [ ] The chat's project root stays explicit: the worktree path becomes the chat's working root for every queued and scheduled turn, and the original project stays visible as its parent (see `ai-chat-panel/PROJECTS.md`).
- [ ] Chat header shows branch, worktree path and a dirty-file count. Actions: open in new window, show diff against base (reuse DIFF-01), remove worktree. Merge and cherry-pick stay in git for the first version.
- [ ] Single-root sequential chat remains the default. Suggest a worktree when a second chat starts on a repo that already has a running one.
- [ ] Refuse or warn on repos with submodules and on a dirty base; clean up on delete chat; survive restarts and chat recovery (`chat-recovery.js`).

**Estimate (AI-assisted):** 1-1.5 days; the concurrency and cleanup edge cases need real testing. **Done when:** two chats edit the same file in one repo at once with no overwrites or index-lock errors, and either worktree can be diffed or removed from the UI without leaving a stale `git worktree` entry.

### SCHED-01 · Headless runner for due scheduled turns

Scheduled prompts and quota-reset continuations only fire while the IDE is open (`scheduler-queue.js`). A full daemon is out of scope (DAEMON-01); a small runner covers the 2 a.m. case.

- [ ] A `clanker run-due` entry (node script next to the `~/.clanker/clanker-agent.js` launcher pattern) that reads the disk-backed queue, runs due turns through the stream engine in the chat's explicit project root, and writes the result into the chat store so it shows when the IDE reopens.
- [ ] Guard against double runs: a lock so the IDE and the runner never execute the same task, and the IDE takes over when it's open.
- [ ] An opt-in command to register it with Task Scheduler (Windows) and `systemd --user` (Linux); nothing is installed silently.
- [ ] Telegram or OS notification when a headless turn ends; reuse `telegram-bridge.js` and `notify.js` only if they work without the IDE, otherwise ship without and note the gap.

**Estimate (AI-assisted):** 1-1.5 days; the lock and shared store access are the risk. **Done when:** with the IDE closed, a prompt scheduled for a quota reset runs on time, appears in the chat after reopening, and never runs twice. Test with fake CLIs, not real prompts.

LOOP-02 is a high-priority loop feature requested on 2026-10-22. Text/code and table previews shipped on 2026-11-16. No other ordering here implies a release commitment.

### LOOP-02 Â· Headless end-to-end exploration with 10 Gemini scouts (high priority)

User request recorded 2026-10-22. Integrate this into the loop alongside LOOP-01; record the feature now, without starting scout runs.

- [ ] Add a system of **10 Antigravity Gemini scouts** that open the target software headlessly and operate its real UI like human users, navigating controls and completing workflows rather than only inspecting source or fixed screenshots.
- [ ] Give scouts distinct exploration goals and isolated sessions so they can discover and compare navigation paths, recommend the clearest successful routes, and identify confusing interactions, dead ends, broken layouts and functional bugs.
- [ ] Report each scout's results, including successful journeys, snags and usability feedback. Capture reproducible action sequences, expected versus observed behavior, screenshots and relevant runtime errors; distinguish confirmed defects from subjective feedback and blocked exploration.
- [ ] Feed deduplicated findings and their evidence into the loop's verification/repair queue, retaining the original reproduction for checks after a fix. Report coverage and failures explicitly so an incomplete run cannot appear to be a clean pass.

**Next:** design the headless interaction/tool contract for Antigravity Gemini, building on the [UI tester](docs/ui-tester.md), [loop guide](docs/loops.md) and [redesign proposal](docs/plans/loop-redesign.md). Establish how scouts access the actual application and its backend, share coverage, and manage concurrency, quotas and timeouts. Existing diagnostic roles' no-tool constraints must not prevent this new interactive role from navigating the software; define its permitted tools explicitly.

**Done when:** a loop run can launch all 10 scouts, exercise real user journeys through the application, compare navigation routes and produce an evidence-linked report with actionable defects and usability feedback. Replaying a reported sequence must reproduce the issue or clearly mark it inconclusive; repaired issues must be checked again through the same UI journey.

**Inspiration:** the user cites similar functionality at companies such as Anthropic; review relevant computer-use approaches during design. Expected benefit: reduce manual exploration and loop review time.

### LOOP-03 · Borrow ideas from Claude Code's `/loop`

Comparison recorded 2026-11-17 (read from the bundled text of `claude.exe` v2.1.326; nothing built yet). The two share a name but differ: Clanker's loops are a durable scan-and-fix pipeline over a registered project (`loop-engine.js`, `investigation-manager.js`), Claude Code's `/loop` is a skill that re-runs any one prompt on a timer through `CronCreate` and `ScheduleWakeup`. Clanker is ahead on resuming after a crash, quota and token accounting, isolated worktrees and verification before anything reaches the project. What it lacks is cheap, general repetition. Extracted text for reference: `C:/Dev/loop-compare/`. The `CronCreate` internals (jitter, exact expiry) were not read.

- [ ] **Repeat a prompt.** There is no `/loop 5m <prompt>`. The Scheduled queue (`scheduler-queue.js`) is a one-shot, disk-backed queue (50 tasks) that already re-queues into a chat, so add a recurrence field (interval, optional max runs, expiry) and re-enqueue after each run. The Antigravity `schedule` tool is only drawn as a card in `stream-engine.js` today and does not repeat anything.
- [ ] **Model-chosen delay.** Overnight loops wait a fixed 10 minutes (`intervalMinutes`) even when nothing changed. Let a cycle end with a next delay (clamped, for example 1 to 60 minutes), a one-line reason and a "nothing changed" flag, as `ScheduleWakeup` does with `delaySeconds`, `reason` and `noop`. The identical-source-hash skip already covers the unchanged-source case, so this is about quiet nights costing less, not correctness.
- [ ] **Event wake-ups.** A loop waiting on a CI run or an editor's quota reset should wake on the event, with the timer only as a long fallback (Claude Code arms a `Monitor` and keeps a 20 to 30 minute heartbeat). Today it only polls on `nextRunAt` and watches quota.
- [ ] **Re-arm as a decision.** Make "run another cycle?" an explicit per-cycle decision with a stated reason, instead of a default that the four-clean-cycles rule and the run cap end. Claude Code treats re-arming this way.
- [ ] **Outcome message on stop.** A stopped loop has no next tick to explain itself. `docs/plans/loop-redesign.md` already asks for explicit end states ("Verified patch ready", "Waiting for quota", "Budget exhausted"); make the run card always show one, and state the outcome in the chat or notification.
- [ ] **Check, don't assume:** whether a prompt sent through Clanker to the Claude CLI can use `/loop` or the `ScheduleWakeup` tool, and whether a session loop would survive the extension's headless runs. Not tested.

**Next:** start with the recurrence field on the Scheduled queue; the other four reuse the same "next run" decision. Keep the loop engine's resumability, budgets and worktree isolation; none of this should weaken them.

**Done when:** a scheduled prompt can repeat on an interval and be cancelled from the queue, an overnight loop can choose a shorter or longer wait and records why, and every stop shows a specific end state. Cover each with a test; don't send real prompts to CLIs.

### AGENT-01 Â· Cross-vendor agents: live check and chat integration

Built 2026-11-11 (see [agent-bridge](docs/agent-bridge.md)): `lib/clanker-agent.js`, launcher `~/.clanker/clanker-agent.js` written by the extension, global skill `ClaudeConfig/skills/clanker-load-agent`, tests in `test/clanker-agent.test.js`. Only fake CLIs were run.

- [x] 2026-11-18: the Agents button never showed for tasks started with a `--cwd` outside the chat's folder (a Codex chat running five Gemini searches). Tasks now leave a `~/.clanker/jobs/<chat>/` pointer that the viewer follows (`lib/bridge-agents.js`, test in `test/bridge-agents.test.js`). Not yet seen in the live IDE.
- [ ] Run the smoke task once per vendor (a few tokens each, command in the doc). Confirm Antigravity `--mode plan` returns the findings and Codex `web_search="live"` is accepted; fix the recipes in `researchSpec` if not.
- [ ] Start a task from inside a Codex chat and check that its sandbox allows the background worker and the other CLIs' sign-in files; if not, decide between `run`-only for Codex and a broker in the extension.
- [ ] Show running tasks in the chat's Agents sheet, and queue a "task finished: <path>" turn into the chat that started it (the extension could pass its chat id in an environment variable and watch `_work/clanker/*/status.json`).
- [ ] Ask `CliAccounts.ensureFresh` before starting, so a signed-out CLI fails at once with the sidebar's text.

**Done when:** a Claude chat starts a Codex and an Antigravity task, sees both finish with tagged sources, and a deliberately signed-out CLI ends as `failed` with a hint, with no manual file hunting.

### STORE-01 · Ship the new icon, banner and theme to the stores

Done 2026-11-19 (uncommitted): `ai-chat-panel/media/icon.png` is now white on black with a squircle (superellipse) outline instead of the orange tile with circular corners; `galleryBanner` is `#000000`/dark; `docs/images/*.png` re-rendered from the current Liquid Glass 2.0 UI (`node scripts/readme-shots.mjs`, `node scripts/render-store-assets.mjs`); `clanker-theme/` (Clanker Paper and Clanker Ink, generated from the site's colours by `clanker-theme/build.mjs`) is rendered in real VS Code with `node scripts/theme-shots.mjs`, built by `package-marketplace.mjs --only theme`, and live at https://clankercontroller.com/theme/ with the `.vsix` for download. The Marketplace page cannot follow the viewer's colour theme, so the page is fixed dark.

- [x] 2026-11-19: version bumped to 0.1.1, `.github/workflows/release.yml` restored (tag `v*` publishes chat, usage and theme to Open VSX, and to the Marketplace when `VSCE_PAT` is set), attachment grid and sidebar divider shipped, "Antigravity IDE" used for the host editor.
- [ ] Add the `VSCE_PAT` Actions secret (Azure DevOps token, scope Marketplace > Manage). Without it the Marketplace keeps 0.1.0 and only Open VSX updates. Never found in the repo's secrets; `OVSX_PAT` is set.
- [ ] The Impressum and Datenschutz pages hold a private address and phone number, so `site/public/impressum/` and `datenschutz/` are gitignored and deploy only from this machine (`site/deploy.ps1`).

## Deferred

Decided on 2026-11-24 after the outside review (see "2026-11-24 outside review" under Ready). These are not forgotten, just not now; don't re-propose them without new information.

### LOOP-04 · Loop guardrails (with the loop rewrite)

Per-loop caps for wall-clock time, files touched and "stop on test regression", plus OS or per-CLI sandbox modes for unattended runs. Skipped on 2026-11-24 because the current loop setup will be replaced by a complete rewrite; building on it would be thrown away. Fold these into the rewrite's design: explicit end states, caps in the run card, and each CLI's own read-only versus workspace-write flag by mode. Anthropic's `sandbox-runtime` covers macOS and Linux only, so it doesn't help on the primary platform.

- [ ] When the rewrite is planned, make the guardrail caps part of its first spec, not a later add-on.

**Done when:** the rewrite's design names its caps and sandbox levels and the run card shows them.

### MAC-01 · macOS and remote workspaces

macOS is untested and WSL, SSH and Dev Containers are unsupported; the extension reads local `~/.codex`, Antigravity's local language server and local hotkeys, so a remote extension host breaks its premise. Estimate if revived: macOS 3-5 days plus a Mac (the Windows and Linux paths are done, the blocker is hardware), remote 1-2 weeks and uncertain. Webview `getUserMedia` for dictation isn't needed while ffmpeg and PulseAudio work, and VS Code webviews don't reliably grant microphone access (not verified here).

- [ ] Revisit when someone with a Mac offers to test, or users on WSL or SSH ask.

**Done when:** a go/no-go note names who tests macOS and which remote setups matter.

### ACP-01 · Agent Client Protocol transports

Claude and Codex already stream structured events (`codex-app-server.js`, Claude stream-json), so ACP would replace working code for little gain, at 1.5-3 weeks. Open question to settle before any work: whether `claude-agent-acp` and `codex-acp` run on a plain subscription login, which is Clanker's premise. Copilot already uses ACP for model discovery. Gemini or Antigravity is the likeliest place it would help.

- [ ] After PROVIDER-02 ships, check whether drift in any provider still hurts; only then evaluate ACP for that provider.

**Done when:** a note says which provider (if any) gets an ACP transport, with the subscription-login check done.

### DAEMON-01 · Background daemon with an IDE client

Splitting the 4.5k-line `extension.js` into a daemon and thin client (IPC, state ownership, Telegram bridge, service installers) is 4-8 weeks, doubles the failure modes, and Antigravity quota discovery needs the IDE running anyway. SCHED-01 covers the overnight case cheaply. Revisit only if SCHED-01 proves too limited or users ask for phone-only use.

- [ ] Reassess after SCHED-01 has run for a few weeks.

**Done when:** a note records what SCHED-01 couldn't do and whether that justifies a daemon.

### HARDEN-01 · Contributor harness and diagnostics

A packaged mock-CLI provider (`npm run dev:mock`: streaming, handoff, quota exhaustion, reset) and a *Clanker: Export Diagnostic Report* command that zips OS, IDE and CLI versions and logs with tokens, keys and repo contents scrubbed. 3-5 days together; the fake CLIs in `ai-chat-panel/test/` are the starting point. Worth doing once outside contributors appear. SQLite storage is rejected for now: it needs a native or experimental dependency in the extension host and solves no shown problem; atomic writes and a lock would be cheaper if chat-store corruption is ever observed.

- [ ] Build the diagnostic export first; it also helps with bug reports on Linux.

**Done when:** an exported bundle contains no secrets (tested with planted fake ones) and a contributor on any OS can run a chat against the mock provider.

### TS-01 Â· Adopt TypeScript incrementally

User request recorded 2026-11-16, following Jonas's recommendation. Start with shared contracts and selected modules; avoid a repository-wide rename or broad `any`/suppression shortcuts.

- [x] Pilot JavaScript type checking with JSDoc and `// @ts-check`, using a scoped TypeScript configuration and a repeatable check command. Done 2026-11-17: `tsconfig.json` (strict, `noEmit`, only `// @ts-check` files), `npm.cmd run typecheck` (`scripts/typecheck.mjs`, TypeScript in `C:/Dev/tools/ts`, skipped with a hint when absent), shared types in `ai-chat-panel/types/chat.d.ts`, and `lib/chat-store.js` plus `lib/tool-output-store.js` pass under strict. Next candidates, smallest first: `lib/chat-history.js`, `lib/chat-handoff.js`, `lib/scheduler-queue.js`, then the stream engine's event types.
- [ ] Define shared types for provider descriptors, normalized CLI events, chat messages, attachments, queue/scheduler entries and extension/webview messages. Keep runtime validation for external data.
- [ ] Establish mixed JavaScript/TypeScript build and watch support before converting runtime files. Keep dependencies, caches and compiled output under `C:\Dev`, outside Nextcloud; preserve extension entry points, installed junctions and browser-test asset loading.
- [ ] Convert small modules as they change, with meaningful strict checking. Leave the large `extension.js` and `media/main.js` conversions until the shared contracts and build path work; retain lifecycle and browser tests.

**Decision 2026-11-17:** no runtime file is converted to `.ts` yet. The installed extensions are junctions to `ai-chat-panel/` and run `extension.js` and `media/*.js` directly, so a compiled language would need generated output in a folder this repo forbids in Nextcloud, plus a build step before every reload and a path rewrite for the browser harness. Typed JavaScript gets the checking without that cost and does not change what runs. Revisit when the shared contracts below cover the extension/webview messages.

**Next:** pilot the provider descriptor contract and one small module, measure the diagnostics and workflow cost, then choose the next boundary. Type checking should catch incompatible fields and missing event cases; GitHub's language percentages aren't a migration goal.

**Done when:** the pilot passes type checking and existing checks without broad escape hatches, the extension and browser harness load the intended runtime files, and the documented workflow supports further module-by-module conversion. Track remaining conversions explicitly; finishing the pilot doesn't mean the whole repository uses TypeScript.

### ONBOARD-01 Â· First-install setup and configuration

User request recorded 2026-10-22; design before implementation.

- [ ] Define a repository configuration file covering Clanker settings, including filename, format and relationship to existing settings and user storage.
- [ ] Open a Clanker chat on first installation and start onboarding with the selected model.
- [ ] Give that model the feature list, documentation links and configuration format so it can ask about preferences and generate the configuration.
- [ ] Provide a feature help section/wiki accessible from Settings or another suitable location, and include it in onboarding context.

**Next:** map existing settings and decide precedence, secret handling and what stays in per-user storage.

**Done when:** first-install onboarding produces a valid configuration, existing installations retain their settings, and help documents supported features.

### SEARCH-01 Â· Search full conversation messages

Older research, not a started implementation. [Plan](docs/plans/manage-chats-search-plan.md).

- [ ] Benchmark a cached asynchronous scan before choosing an indexing dependency; then implement message search and navigation if taken up.

**Next:** recheck the plan against current paged history and compressed tool-output storage.

**Done when:** older visible messages can produce excerpts and open at the matching message, with stale-result handling and explicit project roots preserved.

### ATT-02 Â· Additional preview formats

- [x] Audio/video controls and video thumbnails implemented in composer and bubbles. Real IDE codec/playback validation remains open.
- [x] AVIF recognized for picked and restored attachments.
- [x] Bounded DOCX text and XLSX sheet previews implemented; complex real-world Office file validation remains open.

**Next:** verify actual media playback/codecs and complex Office documents after restoration in the IDE; bounded previews are implemented.

**Done when:** each implemented format works after restoration and preserves its original file.

### QUOTA-01 Â· Other services and daily usage windows (low priority)

User idea recorded 2026-10-22; research only when revisited. The benefit may be small.

- [ ] Clarify which Nextcloud service/integration the user means and whether scheduling helps there or with Grok.
- [ ] Establish whether each service uses first-request, fixed-boundary or rolling limits. If a controllable 24-hour start exists, assess a midnight start and spreading work across providers; distinguish added allowance from shifted timing.

**Next:** name the intended service and check its actual quota documentation. Don't issue unnecessary warmup requests or paid API calls during research.

**Done when:** a documented go/no-go decision names the service, billing and actual reset rules.

### PROVIDER-01 Â· Finish provider runner and quota integration

Existing technical follow-up from [adding a provider](docs/adding-a-provider.md); descriptor runner hooks (`commandFor`, `normalizeEvent`) and the GitHub Copilot CLI (`ai-chat-panel/lib/providers/copilot.js`) foundation are now wired into `StreamEngine`.

- [x] Add descriptor-level `commandFor` and `normalizeEvent` hooks in `lib/stream-engine.js` and ship a foundational `copilot` provider descriptor (`@github/copilot`) plus modernized onboarding (`Setup guide`, `Voice`, `Routing`, and `Set up with AI` in `#cliSetupModal`).
- [ ] Fine-tune `copilot` quota reading and pricing against a live `@github/copilot` installation. (Turn output and tool/session events: done 2026-11-17, see the log below.)

**Next:** choose an actual provider before extracting interfaces.

**Done when:** the selected provider runs through the real turn lifecycle and reports supported usage without fabricated prices or reset rules.

## Needs investigation

These come from recent performance reviews, not new confirmed defects. Reproduce or measure before changing behavior.

| ID | Follow-up and next action | Completion criterion / evidence |
|---|---|---|
| UI-01 | Reproduce controls reported as covered at the fixed composer's lower edge at 900, 420 and 320 px. Distinguish detector errors from product defects. | Resolve or disprove each finding using the same scenario. [Chat performance](docs/chat-performance.md); local reports may be absent on another checkout. |
| VOICE-01 | Long dictation (built 2026-11-08: 5-minute segments, 7-day archive, recovery command, then transcription and cleanup while recording, silence trimming and per-chunk cleanup fallback; see [Voice input](ai-chat-panel/README.md)) is verified with unit tests, real ffmpeg and a dry run over a real 30-minute recording, but the live pipeline has not run inside the IDE yet. After a reload, record 10+ minutes, check `meta.json` `finishMs` in the recording folder, and note Groq's audio-seconds-per-hour limit (free tier believed to be 7,200 s). Possible follow-ups: `reasoning_effort: low` for the cleanup call (needs the router to forward it; unverified against Groq), a pause button, and overlap at segment boundaries. | A real long recording ends up complete in the composer with a short wait after the hotkey, or the failing step is recorded here. |
| VOICE-02 | Per-project voice dictionary (built 2026-11-18, no AI: see [Managing the dictionary](docs/microphone-dictionary-review.md)) is verified with unit tests, a browser test of Settings and a copy of the real dictionary, but not in the live IDE. After a reload, open Settings → Voice → Dictionary, click **Scan all projects**, read the per-project list, then dictate in two projects and note which names still need correcting. If the ranking stays noisy, tune `lib/voice-scan.js` first; only then consider an optional AI rerank of a short candidate list (no project files uploaded). | Fewer project terms need correcting in real dictation, or the noisy words are recorded here. |
| PERF-01 | Whole-reply Markdown parsing while streaming is done (incremental, see the overnight pass above). Still open: collapsed tool-body allocation, accumulation of older history pages, lists (a list with blank lines keeps its whole block in the re-rendered tail until a paragraph follows). | Record a representative measurement; optimize only the demonstrated bottleneck while preserving scroll, selection and tool state. [Audit priority 5](docs/performance-opportunities.md). |
| PERF-02 | Measure retained hidden views and original-image thumbnail decoding; consider further suspension, lazy initialization or smaller image previews. | Document measured tradeoffs and preserve drafts, attachments and host-owned running work. [Audit priorities 3 and 6](docs/performance-opportunities.md). |
| PERF-03 | Per-frame image rebuilding fixed; settling masks now encode asynchronously and reuse eight settled geometries, with shared bounded lens tiles. Inner control animations no longer keep stationary geometry polling. Fresh geometry still has readback/map construction and browser raster cost; menu GPU sample max105ms. | Continue profiling first-time geometry and resize spikes without changing lens mathematics. Regression: `node ai-chat-panel/test/dock-motion.mjs`; benchmark: `node ai-chat-panel/test/dock-performance.mjs --gpu --sidebar --phases=menu`. See `docs/interaction-performance.md`. |
| PERF-04 | A 212-chat history dialog still builds/renders every card on first open. Locale formatting, bubble-read batching and filter-card reuse reduce work, but final repeated samples still have 326–355ms worst frames. | Profile viewport/chunked materialization while preserving complete search/filter/sort, keyboard focus, rename/delete actions, scroll position and release on close. Fixture: `chat-dialog-budget`; timing: `test/interaction-performance.mjs --only=chat-dialog-budget --repeat=3`. |
| UI-04 | The `glass-depth-*` scenarios assert that `.compose-row` has the old goo drop-shadow `filter` (`/10px 26px/`), but under `body.lg-island` the row is `filter: none`, so they stop at that assertion. The probe also reports the transcript running under the top bar and dock (`streamed-reply-chunks`), which is the glass design, and an overlap in `message-dock-hover`. All fail identically on the dock code from before the 2026-11-17 optimization. | Update the assertion to the island state, whitelist the intentional transcript-under-dock overlap in `probe.js`, and re-run the three scenarios clean at 900, 420 and 320 px. |
| STORAGE-01 | Design reviewable retention for completed investigations, reports, shared tool-output blobs and attachment caches. Trace snapshots, backups, forks, schedules and drafts before removal. | Cleanup preserves active/resumable work, originals still referenced and recoverable snapshots. [Storage implementation](docs/performance-implementation.md). |
| HANDOFF-01 | Decide whether a tool call may keep more than the 16,000 characters `recordToolEnd` stores; about 1,100 of 22,800 outputs in real chats stop exactly there, so the chat transcript (`<session>/chats/transcripts/`) can only show them truncated. `tool-output-store.js` could hold longer output losslessly. Only Codex reports an exit code; Claude and Gemini give an error flag, so their failures read `failed: <first line>`. | Measure chat size and save time with a higher cap or blob-backed output before raising it; the transcript marks truncated output until then. [Cross-agent briefings](ai-chat-panel/README.md). |
| PACKAGE-01 | Review an extension packaging allowlist or `.vscodeignore`. | Verify the packaged file list includes runtime modules, vendor assets and licenses while excluding tests and generated output. [Audit priority 7](docs/performance-opportunities.md). |
| COST-01 | API value follow-ups after the 2026-11-15 price audit: Codex turns saved without token detail still assume 95/4/1 (your logs show 98.4/1.3/0.3, about $25 too high); Gemini 4 Argon doubles on 2026-12-01 per secondary sources only (confirm on Google's page); check whether Antigravity counts cached input as fresh; 342 turns on unlisted models are uncounted. | Each point confirmed or fixed against logs or the provider page; the Â±20% band stays only if the recomputed total still holds it. |

## Planning rules

Consider providers beyond the main coding CLIs, including **Groq**. Keep **Groq** distinct from **Grok** and check billing, quota scope and reset rules per service; don't apply one universal five-hour or 24-hour timer. This is a design constraint, not a task to mark complete.

## Recently closed / reconciled

- 2026-11-22 · LINUX: every Windows-only code path now has a Linux counterpart (see README, Platform), including `antigravity-usage-statusbar` `/proc` + `ss` discovery, and is verified on an Ubuntu 24.04 QEMU VM (VS Code 1.147 installed via `install-extension.mjs`, full unit suite 785/785 pass + 1 Windows-only skip, `npm run check`, `verify:models`, 11 real-tool X11/PulseAudio/MPRIS/dunst/systemd-inhibit/proc/killTree/ffmpeg checks, and 6 Wayland Sway `wl-copy`/`wl-paste`, statusbar RPC, `StreamEngine` turn/cancel, and XDG recovery checks). Fixed `image-shrink.js` nested `min()`, `keep-awake.js` `--what=sleep`, `antigravity-usage-statusbar/antigravity.js` Linux discovery, and Voice Settings narrow-sidebar wrapping / unsupported hotkey button hiding. **Open (physical hardware only):** sign in to real CLIs and dictate with a real physical microphone on a Linux desktop.

- 2026-11-19 · CHAT-RECOVERY: Antigravity package cleanup coincided with loss of chat history and project icon settings. The live store moved outside the extension-ID directory. Signed chat snapshots and independent local backups recover overwritten and missing history and preserve deliberate deletion. [Storage and recovery](docs/chat-recovery.md).

| Date | Item | Evidence |
|---|---|---|
| 2026-11-17 | Copilot chat output: turns ran `copilot -p` in text mode and the provider's `normalizeEvent` had only placeholder mappings, so every stdout line became a delta with its line break stripped. Tool-call log lines and the reply ran together in one paragraph. Turns now run with `--output-format json --stream off`; `session.start`, `assistant.message`, `assistant.reasoning`, `tool.execution_start`/`_complete` (edit/create with diffs, `report_intent` hidden, subagent-internal steps skipped), `session.error`/`warning` and the final `result` record map to session, text blocks, thoughts, tool cards, notices and turn completion. | `lib/providers/copilot.js` (`commandFor`, `normalizeEvent`); tests in `test/providers.test.js`. |
| 2026-11-17 | Copilot models: discovery ran `copilot models --json`, a command the CLI does not have, so Settings always showed the five hard-coded fallbacks. It now asks the CLI's ACP server (`copilot --acp`: `initialize` + `session/new`, no prompt) for the account's model list, the same one `/model` and VS Code's Copilot show; disabled models are left out, the account's current model is the default. The empty probe session folder is removed again. There is no fallback list: when discovery fails, Settings > Models shows the reason under Copilot (also in the log) and drops its cached models. | `lib/providers/copilot.js` (`discoverModels`, `parseAcpModels`, `removeProbeSession`), `lib/cli-tools.js` (`fetchModels`, `CliHub.modelErrors`), `media/settings.js`; tests in `test/providers.test.js`, `test/cli-tools.test.js`. |
| 2026-11-17 | Copilot sign-in: VS Code's `copilot` shim on PATH (without the real CLI behind it, it exits 127 with "GitHub Copilot CLI was not found") is now treated as *not installed*, not *not signed in*. Its button reads **Install & sign in** and runs the shim in a setup terminal, where it offers the install. `copilot login` always runs in a visible terminal (device code, token storage prompt), never as a hidden background run; closing the terminal checks again. The CLI's own install places are tried before PATH. | `lib/providers/copilot.js` (`terminalLogin`, `missing`), `lib/cli-accounts.js` (`fix`, `connect({ force })`, `terminalClosed`); test in `test/cli-accounts.test.js`. Requires an IDE reload. Open: `copilot --version` cannot tell a signed-out account, so that only shows after a failed turn. |
| 2026-11-17 | Log viewer: Settings › General › **Logs** (or the *Clanker Controller: Show Logs* command) lists extension errors, webview messages whose handler threw, uncaught webview errors and rejections, console warnings and every error/warning notification the extension shows; Debug level adds each click and each webview message, and errors name the click just before them. Entries expand to their stack, can be copied or put into the composer (*Ask in chat*). The same log goes to the "Clanker Controller" output channel (*Show Log in Output Panel*). | `ai-chat-panel/lib/log.js` (shared logger, 2000 newest entries in memory), `media/error-report.js` (loaded first in the webview), `media/log-viewer.js`; `ChatWindowHost.receive` wraps every webview message; `test/log.test.js`. Requires an IDE reload. |
| 2026-11-17 | Sluggishness: typing in the composer ran at 11 to 15 frames per second in a long chat because the dock's rim refraction was one full-size SVG filter (displace, blur, then mask), which re-ran on every keystroke. It is now thin strips along each shape's edge with CSS masks, so typing damages no backdrop filter (about 64 to 96 ms per frame down to about 17 ms, the same as having no dock glass). Also: the island follow loop checks `getAnimations` every sixth frame instead of every frame, big images are set on elements instead of inherited custom properties, `--dock-h` is only written when it changes, the glass scan ignores the transcript, and lens tiles copy their identical middle columns. Dark, light and a high-contrast stripe test render within 13/765 of the old dock. | [Chat performance](docs/chat-performance.md), "Dock glass"; `ai-chat-panel/test/liquid-glass.test.js` (strip coverage, byte-identical column copy). |
| 2026-11-16 | Light mode: the chat, rail and settings webviews follow the IDE's colour theme live (`body.vscode-light` / `vscode-high-contrast-light`). The dark palette is unchanged; colours now go through tokens at the top of `style.css` (`--ink`/`--sheen` channels, `--charcoal`, `--panel*`, `--fg-*`, `--shadow-k`/`--well-k`) or `light-dark()`, and the painted message bubbles repaint on a theme switch. | `ai-chat-panel/media/*.css`, `bubble-shape.js`; `test/theme.test.js` guards against new dark-only literals; `node scripts/readme-shots.mjs --theme=light` renders the README shots light (dark renders pixel-identical to before). Requires an IDE reload. |
| 2026-11-15 | API value corrected: Claude turns are priced from token counts (Claude Code's own figure ran about 1.8x too high for Sonnet 5.x), Sonnet cache-read price fixed, 1-hour cache writes and Gemini 4 Argon added; saved chats rebuild their totals on next start. Total $2,314 to $1,751, October $1,465 to $989. | `ai-chat-panel/lib/api-cost.js`, `ai-chat-panel/lib/api-prices.js`, `ai-chat-panel/test/api-cost.test.js`; README and `docs/images/cost.svg` updated. |
| 2026-11-14 | Modernized onboarding modal (`#cliSetupModal` with Voice, Routing, and `Set up with AI` shortcuts plus `Setup guide` in Settings > General) and added the GitHub Copilot CLI provider foundation (`ai-chat-panel/lib/providers/copilot.js`) with descriptor runner hooks (`commandFor`, `normalizeEvent`) in `StreamEngine`. | `ai-chat-panel/lib/providers/copilot.js`, `ai-chat-panel/lib/providers/index.js`, `ai-chat-panel/lib/stream-engine.js`, `ai-chat-panel/media/settings.js`, `ai-chat-panel/media/main.js`; verified with `providers.test.js`, `cli-accounts.test.js`, `cli-setup.mjs`, and `settings-general` UI tester. |
| 2026-11-14 | Live elapsed timer on running tool cards (`.tool-card .tool-time`) plus persisted `startedAt` and `durationMs` across reloads, completion, and interruption, and right-click Copy / Download actions on attached images and lightboxes preserving original or renamed filenames. | `ai-chat-panel/extension.js`, `ai-chat-panel/media/main.js`, `ai-chat-panel/media/style.css`; unit tests in `turn-queue.test.js`, `message-dock.mjs`, and UI scenarios `tool-running-timer`, `attachment-image-actions`. |
| 2026-10-26 | ATT-03: Click PDF references and attachment chips to open them in the editor, like Explorer, including Markdown links and filenames shown as code. Verified Codex's `[label](</C:/.../file.pdf>)` format with spaces and Unicode against the supplied screenshot. Uses the editor?s registered viewer for every document size. | `ai-chat-panel/media/main.js`, `ai-chat-panel/extension.js`; host regression in `turn-queue.test.js` and browser scenarios `pdf-file-links`, `codex-pdf-file-links`. |
| 2026-10-22 | Repository organization and backlog review requested by the user; replaces the old â€œremind me to clean up laterâ€ task. | README navigation, documentation index, archive labels and generated screenshot relocation. Runtime folders retain their installed paths. |
| 2026-10-22 | Earlier performance audit's hidden-dialog rendering, lazy highlighting, byte-bounded caches/logs, compressed tool output and serialized checkpoints already have implementation records. | [Rendering and persistence improvements](docs/performance-implementation.md). Remaining investigation is listed above; don't repeat the audit's original implementation order. |
| 2026-10-22 | Original loop-manager frontend brief already says it was superseded by the built UI. | [Historical brief](docs/archive/claude-investigation-manager-prompt.md); LOOP-01 tracks subsequent loop work. |

## Maintaining this file

Give each new task a stable ID, status section, concrete next action and completion criterion. Record the request date when known; don't invent dates or priorities. Keep detailed designs in `docs/plans/` and link them here. Deferred means wait until selected; needs investigation means no confirmed fix yet.

When work finishes, remove its open checkbox and leave a short dated evidence link in Recently closed. Keep that section short; Git retains older history. Move superseded plans to `docs/archive/`, update incoming links and label them historical. Never silently drop an unresolved user request because it is old.
