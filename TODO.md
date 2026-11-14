# TODO

Single source of open work for Clanker Controller. Reviewed 2026-10-22 against the working tree and project docs. Status here distinguishes user requests from older research; it doesn't certify unfinished code as complete.

## How to answer “What's left?”

Read this file after the root [README](README.md). Summarize **Interrupted**, **Ready**, **Deferred** and **Needs investigation** separately, using task IDs. Follow only the linked documents needed for the question. Don't promote archived proposals or unchecked spec lists into new commitments. Before implementing, inspect current code and uncommitted changes; don't send test prompts to real CLIs.

Completed 2026-10-28: chat-window restoration startup handshake. Restored editor/pop-out webviews request their own saved conversation after JavaScript is ready; regression coverage restores two independent chats and drafts after dropping initial messages. Native IDE session restoration owns window placement.

Completed 2026-10-29: queued reset prompts display their saved `notBefore` deadline instead of the provider's next window. Expired waits show ready and clear the countdown. Scheduled Send Now is guarded in the host; queued Steer Now and automatic draining preserve an active reset wait by scheduling follow-ups for the same deadline. UI actions disable while waiting. Verified with 90 queue lifecycle tests, queue editor/stability checks, syntax checks and the reset UI scenario at 900/420/320px (zero errors or warnings; screenshots inspected in `out/ui-reset-review`). Requires an IDE reload.

## Interrupted

Completed 2026-11-14: chat and composer images now have a right-click context menu (`Copy`, `Download`) and a download button on each image chip and lightbox preview. Copying writes the PNG bitmap to the clipboard (with a Windows system-clipboard fallback via the host), and downloading opens the save dialog defaulted to the attachment's clean existing name (`image.png` or the user's renamed filename, stripping internal timestamp/UUID prefixes). Verified with unit tests in `turn-queue.test.js`, `message-dock.mjs`, syntax checks and browser UI checks at 900/420/320px (`out/ui-image-actions`, `out/ui-attachment-previews`, `out/ui-attachment-svg`). Requires an IDE reload.

Completed 2026-11-13: native Claude `Failed to authenticate. API Error: ...` lines now trigger the existing access-failure handling without requiring a Clanker error prefix. Cloudflare-branded 403s are a separate provider-block condition, not reported as an expired login/plan. The affected chat pauses durably, preserves the failed task (or continues partial work) ahead of follow-ups, and aborts architect/build handoff; headless schedules retain failures instead of marking them done and hold further Claude sends. Local auth-status success does not clear a Cloudflare block. The provider fault explains the error, links the status page and requires an explicitly allowed retry and manual queue resume. Confirmed four failures across Visor/TV chats and Anthropic's current authentication incident, reported 2026-11-13 09:58 UTC. Focused parser/account/auth-gate/queue lifecycle tests and syntax checks passed. Requires an IDE reload. No live model test prompts or sign-in changes.

Completed 2026-11-13: scheduled prompts now show the same attachment badge as ordinary queued turns, with image thumbnails where space permits, a file/photo count and filenames in the tooltip. Chat-window scheduler snapshots now include webview-safe metadata for staged attachments; the schedule manager also shows the badge. Confirmed the reported task still held its staged PNG. Verified staged preview metadata and unchanged dispatch paths, queue stability, syntax checks and browser snapshots/count updates at 900/420/320px (zero findings; `out/ui-scheduled-attachments`). Requires an IDE reload; no live model prompts sent.

Completed 2026-11-13: ready scheduled prompts now replace their clock with the existing drag grip as soon as their time/usage gate clears. The composer's scheduled rows now use the pointer-reorder interaction and persist through the scheduler's existing reorder API; future schedules keep their clocks and can also be dragged. Scheduled and ordinary queue groups retain their separate execution order. Verified real pointer dragging during a running reply, host snapshots during the drag, timer-to-grip transition at 900/420/320px (zero findings; `out/ui-ready-drag`), durable order across reload, existing queue stability and syntax checks. Reload Antigravity to activate.

Completed 2026-11-13: Claude quota-reset prompts in the same chat/window now share the later deadline when saved reset readings differ by at most one minute. The screenshot's queue had mixed 23:09Z/23:10Z deadlines; enqueue/persistence and startup repair now align those records without moving fixed-time tasks, separate chats, weekly windows or later usage windows. Weekly reset selection is now retained in the saved task. Verified with 98 focused scheduler/queue tests, syntax checks and a real-scheduler browser fixture at 900/420/320px, zero findings (`out/ui-reset-aligned`). Requires an IDE reload to repair the running queue. No live CLI prompts sent.

Completed 2026-11-12: a Codex `already has an active writer` rejection before input acceptance now keeps the original pending turn and retries resume every 5 s, with one actionable waiting notice. Stop cancels the wait without interrupting the other app; the thread is never silently forked or replaced. Real metadata-only diagnosis reproduced the Unraid thread's writer-lock rejection even though `thread/read` said `notLoaded`; external writer ownership is separate from an in-progress answer. Close that conversation in the other app (or quit it if the lease remains held) before sending from Clanker. Requires an IDE reload. Added focused ownership-wait/recovery/Stop tests; no live model prompt was sent.

Completed 2026-11-12: open Codex chats poll native thread history every 2 s and import ChatGPT continuations with stable turn/item IDs, in-place partial replies and supported command/MCP/web/file tool records. Drafts and provider choice survive refresh; local turns retain their own sync anchor and pause importing, while external active turns hold Clanker's queue. Stop an external turn in ChatGPT. Read-only live verification against the Unraid thread recovered all four missing prompts plus replies and 27 tool records on a copy; a second read made no duplicate changes (`out/codex-chat-sync-live.json`). Browser scenario at 900/420/320px passed with no findings (`out/ui-chatgpt-sync`). Requires an IDE reload. Limits: open chats and locally accessible linked Codex threads only; deleted/forked histories and attachments are not fully mirrored, and concurrent sends from both apps cannot be locked atomically.

Completed 2026-11-12: Codex threads now receive `🤖 Project name · Chat name` through the native `thread/name/set` API, rather than displaying the PROJECT/TASK STATE handoff preview. Titles sync on session discovery, generated/custom chat titles, project renames and startup for saved Codex chats. A shared metadata-only connection sends no turns; failures remain non-fatal and retry on later syncs. Live migration renamed/read back 96 existing threads; six old IDs returned `thread not loaded` and were left unchanged (`out/codex-title-sync.json`). Focused title, session and queue checks plus syntax checks passed. Reload the IDE for ongoing synchronization; ChatGPT may need a refresh to display the renamed threads.

Completed 2026-11-12: Gemini delegated research now explicitly avoids terminal commands in plan/sandbox mode and returns a final report with inaccessible sources marked BLOCKED. Empty Gemini results retain provider status, conversation ID and denied actions in failure diagnostics/status.json. The original RPLS failure ended at a denied curl command, followed by empty SUCCESS (log lines 47–48); no final answer existed in the native transcript. The deployed launcher already loads maintained source. Twelve runner regression tests and syntax checks pass, including Codex output handling. Real Argon Medium simple and file-read runs returned saved answers. Web runs searched and returned sourced snippets, but report no original-page reader in their active toolset, so source-opening verification and the original research retry remain blocked. Original evidence was preserved; no RPLS product files were edited.

Completed 2026-11-12: submitted bubbles now receive a host confirmation keyed to their local turn ID. A chat replay during send planning can no longer leave the prompt invisible while the model responds; confirmations deduplicate local and restored bubbles. The reported prompt and image were present in saved history. The exact initiating UI event was not logged. Verified the replay race and duplicate prevention in the browser at 900/420/320px, host lifecycle coverage and syntax checks. Requires an IDE reload.

Completed 2026-11-12: the composer countdown follows the selected provider, so a pending Claude usage-reset task no longer displays its timer beside GPT models. The scheduled Claude row retains its deadline. Verified provider switching in the browser at 900/420/320px (zero errors or warnings) and syntax checks; report in `out/ui-provider-countdown`. Requires an IDE reload.

Completed 2026-11-11: scheduled prompts have a Change model action that opens the existing composer model picker. Switching providers clears the old quota-reset deadline and its countdown; confirmation releases the editing hold and wakes the scheduler, preserving chat/project/context and quota/auth checks. Same-provider edits and fixed-time schedules retain their waits. Scheduled rows wrap on narrow screens. Verified with queue lifecycle/persistence tests and browser scenarios at 900/420/320px. Requires an IDE reload.

Completed 2026-11-11: cross-vendor bridge jobs appear in their originating chat's robot chip and Agents sheet, with model, effort, task, background/terminal state and result path. New CLI processes inherit CLANKER_CHAT_ID; --from can supply an explicit chat ID. Durable job files restore entries when that chat opens. Verified with fake-worker tests and browser checks at 900/420/320px. Requires an IDE reload and fresh parent CLI processes; older untagged jobs cannot be assigned to a chat automatically.

Completed 2026-11-11: sign-in check before unattended sends, on the same state as the sidebar rings (`CliAccounts.fault/ensureFresh/fix`; the gate only holds and releases). "Continue", queued and scheduled prompts ask the CLI's own status command first (`lib/auth-gate.js`, looks reused for 30 s); a signed-out, broken, missing or out-of-plan CLI keeps them queued, shows a card in the chat and a Windows popup (`lib/auth-prompt.ps1`) whose button (also on the rail's red ring) signs in through the browser, then sends everything in order by itself. A turn that ends in a 401 mid-run opens the same popup and re-queues its prompt (or "continue") behind the sign-in. Verified with unit/lifecycle tests on the real `CliAccounts`, the full suite, and the card (900/420/320px), the rail ring and the popup rendered. Not verified: a real `codex login` browser round trip (it would replace your live sign-in), and whether `codex login status` notices a token the server revoked while `auth.json` is intact; that case relies on the mid-run path. Requires an IDE reload. Open follow-ups: Run Now on an interrupted card bypasses the gate; Claude's `auth login` may want a pasted code when run headless (falls back to Check again).

Completed 2026-10-29: Claude error/limit results now end turns even with tracked background shell commands; numeric hour limit notices trigger the existing reset continuation flow. Missing automatic titles retry on later turns using the original prompt.

Completed 2026-10-30: Robot chip for Antigravity subagents. agy's `invoke_subagent` (async; params Role, TypeName, Prompt) now opens an Agents entry, and `lib/agy-subagents.js` follows the subagent's own `brain/<id>/.system_generated/logs/transcript.jsonl` for its steps and its finish; the process ending closes the rest. Found from saved agy conversations, not a raw `-p` stream: if the chip still stays away, capture one `invoke_subagent` step_update to check its `tool_info.parameters`. Also fixed the Agents sheet squashing every step to a sliver on long runs (`.agents-log > *` can no longer shrink), which affected Claude's agents too.

Completed 2026-10-30: Settings > Compliance became Settings > Loops. The two switches (`aiChatPanel.complianceScout`, `aiChatPanel.complianceRedact`, IDs unchanged) moved there; the data-flow list, pre-ship checklist and legal links were dropped (provider terms are linked in `docs/compliance-eu.md`).

Completed 2026-10-30: chat dates. A chat's "last active" (rail and Manage Chats) is its newest user or assistant message time, not the last save, so closing or restoring a day-old chat no longer reads "Just now" (`lastActivityAt` in `lib/chat-store.js`; a running reply still counts as now). Message stamps read "06:07" today, "Yesterday, 21:07", then "Feb 27, 18:07" (`messageTime` in `media/chat-time.js`), and Manage Chats search also matches dates ("yesterday", "oct 10", "october").

Completed 2026-10-30: Antigravity usage circle choice. The Gemini ring in the launcher draws one pool, picked in Settings > General (`aiChatPanel.antigravityRing`): `argon` (default, a single 7d circle at the outer ring's width), `gemini` (5h + 7d) or `claude-gpt`. A missing Argon pool falls back to Gemini's rings; the hover card still lists every group, and the burn-rate line follows the circle's pool.

Completed 2026-10-30: multi-file drag and drop. `droppedUris` in `media/drop-zone.js` now merges every list the IDE may put a multi-selection in (URI lists, the `ResourceURLs`/`CodeEditors` JSON, a plain-text path list as last resort) and a JSON-only drag counts as an attachment drag; attachment files saved in one tick no longer share a timestamp prefix (`attachmentStamp` in `extension.js`), so same-named files can't overwrite each other. Not verified in the live IDE: which of those lists Antigravity really sets for a multi-select (rendered with a synthetic three-file drop only).

Completed 2026-10-30: quota discovery regression. Finding the Antigravity language server took ~4.8 s (PowerShell start plus `Get-NetTCPConnection`) against a 4 s timeout, so every Antigravity quota group, Argon included, came back empty. The port scan now uses `netstat` and the timeout is 12 s.

Completed 2026-10-30: agy context gauge. It read the turn's fresh input + output from the result event and ignored `cache_read_tokens`, so it showed the size of the turn and dropped after short replies. It now uses the latest step's usage (fresh input + cache reads + output, one model call, like Claude's per-message usage and Codex's `last` reading); with no step reading it adds the turn's new tokens to the previous value. Not verified: whether real agy builds put `usage` on `step_update` (the fallback covers it if not).

Completed 2026-10-30: Gemini 4 Argon usage. Antigravity quota discovery finds the new `agy.exe --hub --hub-port=… --csrf_token=…` process (all three copies); the Argon group (weekly-only) is read as `antigravityArgon`, shown as a third group in the Gemini ring's hover pill, and Argon models are gated by it in routing (falling back to the Gemini pool when the group is absent, e.g. Ultra). Untouched Antigravity buckets (`remainingFraction >= 1` and no usage description) report `resetsAt: null` instead of a rolling placeholder countdown, `SessionWarmup` warms `antigravityArgon` once per 7-day window with `Gemini 4 Argon Low` on plans with a separate Argon pool, and `headlessEnv` sets `ANTIGRAVITY_NO_CHIME=1` for `agy` so `~/.gemini/config/hooks.json` doesn't play a duplicate chime or stall final output by 2 s. Not verified: Argon's burn rate and any thinking-effort advice.

### LOOP-01 · Resume loop integration

- [ ] Reconcile the interrupted Codex work with the [redesign proposal](docs/plans/loop-redesign.md), [loop guide](docs/loops.md) and existing changes in the loop/investigation modules.

**Next:** identify which changes already exist and which redesign requirements remain; use the earlier conversation if available, otherwise record the missing context. Don't restart or apply an old private-checkout patch blindly.

**Done when:** the remaining integration has focused checks, the loop guide matches shipped behavior, and any unresolved redesign requirements have explicit follow-up tasks. The proposal itself is not proof of implementation.

## Ready

### CONTEXT-01 · Recent chat work-context icons (free only)

- [x] 24 SVG icons (`ai-chat-panel/media/context-icons/`, contact sheet in [docs/plans](docs/plans/recent-chat-context-icons-sheet.html)), the Clef Flash classifier (`lib/work-context.js`), the latest-agent fix and the rail badge are built per the [contract](docs/plans/recent-chat-context-icons.md); categories live in `lib/work-context-categories.json`.
- [x] Enabled `aiChatPanel.workContextIcons` in Antigravity user settings on 2026-10-29 after the requested live check passed. Reload the IDE to load the integrated extension code.
- [ ] Watch whether icons match real chats over a few days; synthetic checks do not establish real-chat accuracy.
- [x] Fixed the category badge protruding below the Recent hover preview: hide it during hover/focus and restore it after retraction, while keeping the category icon in the preview label. Recent items share one click/keyboard target. Initial classification now uses the last substantive request when a saved chat ends in an acknowledgement; established icons still survive “continue”. Verified with 17 classifier tests, the sidebar browser regression, syntax checks and the UI scenario at 900/420/320px (zero measured errors or warnings); inspected the motion screenshot. Remaining missing icons can still reflect confidence abstention; their individual causes are not recorded in saved chat data.
- [x] Recent tiles now lead with the chat's project icon (favicon or initials) instead of the provider logo; the provider shows as the tint of the work-icon badge. A chat without a project keeps the logo. Verified in the sidebar browser test (`recent-context.mjs`, `project-rail.mjs`) and screenshots. Requires an IDE reload.
- [x] Fixed startup integration after enabled icons remained invisible: restored runs resolve routing through their manager, the five recent nonempty chats request missing categories on startup or enable, and opening older chats requests their first category. Regression coverage restores a run before routing initialization. Requires an IDE reload for this extension-host fix.
- [x] Categories are now read when a task finishes: 10 s after the chime and last reply, skipped if a new turn began, a turn failed or was stopped, or the task was already read; the 5-minute cooldown and the turn-start trigger are gone. A chat with no category now takes Clef's top pick (only changes of an existing category need 0.70/0.20); that bar was why only 2 of ~446 saved chats had ever received one. Covered by `work-context.test.js` and a `ChatRun` turn-complete check in `recent-context.mjs`. Requires an IDE reload; chats that are already finished get theirs when opened (or among the five newest at startup), not retroactively for older ones.
- [x] Categories are now predicted from your prompt, not read from the finished answer: Clef gets the latest prompt plus a few earlier prompts (no AI replies) and the request goes out the moment the prompt is sent, so the icon updates while the answer is still being written. This replaces the 10 s after-the-chime wait above (`settleMs`, the idle check and `cancel` are gone). Covered by `work-context.test.js` and a `ChatRun.begin` check in `recent-context.mjs`. Requires an IDE reload.
- [x] agy file steps now show what they open: the card said only "View" because newer agy builds send `read_file`/`write_file`/`edit_file` with other parameter names than `view_file`'s `AbsolutePath`. `geminiToolTarget` now takes any path-like parameter (`path`, `file_path`, `DirectoryPath`, `paths`). The real parameter names of the new build are not captured anywhere yet; if a card still shows no target, check the step's parameters in `agy`'s stream. Older saved chats keep their empty cards (the path was never stored).
- [x] 8 non-coding categories (Studying, Notes and minutes, Organizing, Schedule and tasks, Math and numbers, Language, Ideas, Everyday life) are wired in after your rating: icons in `media/context-icons/`, categories in `work-context-categories.json`, the three description tweaks and one classifier sentence applied, and `LIMITS.inputTokens` raised from 1500 to 2000 (about 4 Neurons per call; roughly 250 classifications a day under the 1,000 cap, still free). Offline only: not yet run against the real endpoint with 24 categories, so a live check (`CLANKER_LIVE=1 node ai-chat-panel/test/work-context.live.mjs`, about 100 Neurons) is still open if you want one.
- [ ] Optional: a manual override of a chat's category, and a control for the setting in Clanker's own Settings pane (today only VS Code Settings).

**Built 2026-10-29:** offline tests (`work-context.test.js`, `recent-context.mjs`, `context-icons.mjs`) and one live run of `work-context.live.mjs` against the real endpoint: 19/19 synthetic requests picked the right category, 16 cleared the 0.70/0.20 thresholds, none wrongly; 52.6 Neurons in total (about 2.8 per call, so the 1,000/day cap allows roughly 350 classifications). Synthetic prompts only: accuracy on your real chats is unmeasured.

**Done when:** you have run it on real chats for a while and the icons are right often enough to keep it on.

**24-category live check 2026-10-29:** 27/27 synthetic requests chose the expected category, including all eight non-coding categories; 24 cleared confidence thresholds, zero wrong applications. The three abstentions were Writing, Everyday life and a context-dependent Visual design request. Used 106.27 Neurons of the test's 160 cap. All 16 focused unit tests, the 24-icon asset check and the real-rail browser check passed. The live script now covers all 24 categories and exits unsuccessfully on missing results or misclassification.

LOOP-02 is a high-priority loop feature requested on 2026-10-22. Text/code and tables remain the next attachment-preview work. No other ordering here implies a release commitment.

### LOOP-02 · Headless end-to-end exploration with 10 Gemini scouts (high priority)

User request recorded 2026-10-22. Integrate this into the loop alongside LOOP-01; record the feature now, without starting scout runs.

- [ ] Add a system of **10 Antigravity Gemini scouts** that open the target software headlessly and operate its real UI like human users, navigating controls and completing workflows rather than only inspecting source or fixed screenshots.
- [ ] Give scouts distinct exploration goals and isolated sessions so they can discover and compare navigation paths, recommend the clearest successful routes, and identify confusing interactions, dead ends, broken layouts and functional bugs.
- [ ] Report each scout's results, including successful journeys, snags and usability feedback. Capture reproducible action sequences, expected versus observed behavior, screenshots and relevant runtime errors; distinguish confirmed defects from subjective feedback and blocked exploration.
- [ ] Feed deduplicated findings and their evidence into the loop's verification/repair queue, retaining the original reproduction for checks after a fix. Report coverage and failures explicitly so an incomplete run cannot appear to be a clean pass.

**Next:** design the headless interaction/tool contract for Antigravity Gemini, building on the [UI tester](docs/ui-tester.md), [loop guide](docs/loops.md) and [redesign proposal](docs/plans/loop-redesign.md). Establish how scouts access the actual application and its backend, share coverage, and manage concurrency, quotas and timeouts. Existing diagnostic roles' no-tool constraints must not prevent this new interactive role from navigating the software; define its permitted tools explicitly.

**Done when:** a loop run can launch all 10 scouts, exercise real user journeys through the application, compare navigation routes and produce an evidence-linked report with actionable defects and usability feedback. Replaying a reported sequence must reproduce the issue or clearly mark it inconclusive; repaired issues must be checked again through the same UI journey.

**Inspiration:** the user cites similar functionality at companies such as Anthropic; review relevant computer-use approaches during design. Expected benefit: reduce manual exploration and loop review time.

### AGENT-01 · Cross-vendor agents: live check and chat integration

Built 2026-11-11 (see [agent-bridge](docs/agent-bridge.md)): `lib/clanker-agent.js`, launcher `~/.clanker/clanker-agent.js` written by the extension, global skill `ClaudeConfig/skills/clanker-load-agent`, tests in `test/clanker-agent.test.js`. Only fake CLIs were run.

- [ ] Run the smoke task once per vendor (a few tokens each, command in the doc). Confirm Antigravity `--mode plan` returns the findings and Codex `web_search="live"` is accepted; fix the recipes in `researchSpec` if not.
- [ ] Start a task from inside a Codex chat and check that its sandbox allows the background worker and the other CLIs' sign-in files; if not, decide between `run`-only for Codex and a broker in the extension.
- [ ] Show running tasks in the chat's Agents sheet, and queue a "task finished: <path>" turn into the chat that started it (the extension could pass its chat id in an environment variable and watch `_work/clanker/*/status.json`).
- [ ] Ask `CliAccounts.ensureFresh` before starting, so a signed-out CLI fails at once with the sidebar's text.

**Done when:** a Claude chat starts a Codex and an Antigravity task, sees both finish with tagged sources, and a deliberately signed-out CLI ends as `failed` with a hint, with no manual file hunting.

### ATT-01 · Text, code and table attachment previews

- [ ] Preview TXT, Markdown, JSON, logs and source files in both the composer and chat bubbles.
- [ ] Preview the first rows of CSV/TSV attachments alongside text/code support.

**Next:** extend the existing attachment viewer and metadata paths; define bounded previews that preserve the original files.

**Done when:** picked and restored attachments work in both locations, table/text content renders safely, and originals still reach the CLI unchanged.

### ATT-04 · Image markup (draw, erase, type) and agent visual-intent metadata

User request recorded 2026-11-13.

- [ ] Add direct image annotation tools (draw/pen, highlight, erase, text/type) to staged image attachments in the composer.
- [ ] Dispatch annotated image composites while preserving original sources in user storage.
- [ ] Inject markup metadata and intent hints into the prompt/payload sent to AI agents so models focus on the drawn/highlighted regions (ChatGPT-style markup).

**Next:** design the lightweight canvas annotation layer in the composer attachment preview and define the prompt/metadata format for agent dispatch across CLIs.

**Done when:** users can draw, erase, and type on image attachments in the composer, and dispatches include explicit markup metadata signaling the edited regions to downstream agents.

## Deferred

### ONBOARD-01 · First-install setup and configuration

User request recorded 2026-10-22; design before implementation.

- [ ] Define a repository configuration file covering Clanker settings, including filename, format and relationship to existing settings and user storage.
- [ ] Open a Clanker chat on first installation and start onboarding with the selected model.
- [ ] Give that model the feature list, documentation links and configuration format so it can ask about preferences and generate the configuration.
- [ ] Provide a feature help section/wiki accessible from Settings or another suitable location, and include it in onboarding context.

**Next:** map existing settings and decide precedence, secret handling and what stays in per-user storage.

**Done when:** first-install onboarding produces a valid configuration, existing installations retain their settings, and help documents supported features.

### SEARCH-01 · Search full conversation messages

Older research, not a started implementation. [Plan](docs/plans/manage-chats-search-plan.md).

- [ ] Benchmark a cached asynchronous scan before choosing an indexing dependency; then implement message search and navigation if taken up.

**Next:** recheck the plan against current paged history and compressed tool-output storage.

**Done when:** older visible messages can produce excerpts and open at the matching message, with stale-result handling and explicit project roots preserved.

### ATT-02 · Additional preview formats

- [ ] Add audio/video controls and video thumbnails in the composer and bubbles.
- [ ] Recognize AVIF as an image for picked and restored attachments.
- [ ] Add DOCX/XLSX previews; lower priority because rendering needs more work.

**Next:** choose one format and check its metadata and restoration path; split formats into separate tasks when started.

**Done when:** each implemented format works after restoration and preserves its original file.

### QUOTA-01 · Other services and daily usage windows (low priority)

User idea recorded 2026-10-22; research only when revisited. The benefit may be small.

- [ ] Clarify which Nextcloud service/integration the user means and whether scheduling helps there or with Grok.
- [ ] Establish whether each service uses first-request, fixed-boundary or rolling limits. If a controllable 24-hour start exists, assess a midnight start and spreading work across providers; distinguish added allowance from shifted timing.

**Next:** name the intended service and check its actual quota documentation. Don't issue unnecessary warmup requests or paid API calls during research.

**Done when:** a documented go/no-go decision names the service, billing and actual reset rules.

### PROVIDER-01 · Finish provider runner and quota integration

Existing technical follow-up from [adding a provider](docs/adding-a-provider.md); a descriptor alone doesn't make a new CLI runnable.

- [ ] When adding a provider, define its runner/event/interrupt contract and quota reader; review slash commands, pricing and provider-specific host branches.

**Next:** choose an actual provider before extracting interfaces.

**Done when:** the selected provider runs through the real turn lifecycle and reports supported usage without fabricated prices or reset rules.

## Needs investigation

These come from recent performance reviews, not new confirmed defects. Reproduce or measure before changing behavior.

| ID | Follow-up and next action | Completion criterion / evidence |
|---|---|---|
| UI-01 | Reproduce controls reported as covered at the fixed composer's lower edge at 900, 420 and 320 px. Distinguish detector errors from product defects. | Resolve or disprove each finding using the same scenario. [Chat performance](docs/chat-performance.md); local reports may be absent on another checkout. |
| VOICE-01 | Long dictation (built 2026-11-08: 5-minute segments, 7-day archive, recovery command, then transcription and cleanup while recording, silence trimming and per-chunk cleanup fallback; see [Voice input](ai-chat-panel/README.md)) is verified with unit tests, real ffmpeg and a dry run over a real 30-minute recording, but the live pipeline has not run inside the IDE yet. After a reload, record 10+ minutes, check `meta.json` `finishMs` in the recording folder, and note Groq's audio-seconds-per-hour limit (free tier believed to be 7,200 s). Possible follow-ups: `reasoning_effort: low` for the cleanup call (needs the router to forward it; unverified against Groq), a pause button, and overlap at segment boundaries. | A real long recording ends up complete in the composer with a short wait after the hotkey, or the failing step is recorded here. |
| PERF-01 | Profile remaining whole-reply Markdown parsing, collapsed tool-body allocation and accumulation of older history pages. | Record a representative measurement; optimize only the demonstrated bottleneck while preserving scroll, selection and tool state. [Audit priority 5](docs/performance-opportunities.md). |
| PERF-02 | Measure retained hidden views and original-image thumbnail decoding; consider further suspension, lazy initialization or smaller image previews. | Document measured tradeoffs and preserve drafts, attachments and host-owned running work. [Audit priorities 3 and 6](docs/performance-opportunities.md). |
| STORAGE-01 | Design reviewable retention for completed investigations, reports, shared tool-output blobs and attachment caches. Trace snapshots, backups, forks, schedules and drafts before removal. | Cleanup preserves active/resumable work, originals still referenced and recoverable snapshots. [Storage implementation](docs/performance-implementation.md). |
| HANDOFF-01 | Decide whether a tool call may keep more than the 16,000 characters `recordToolEnd` stores; about 1,100 of 22,800 outputs in real chats stop exactly there, so the chat transcript (`<session>/chats/transcripts/`) can only show them truncated. `tool-output-store.js` could hold longer output losslessly. Only Codex reports an exit code; Claude and Gemini give an error flag, so their failures read `failed: <first line>`. | Measure chat size and save time with a higher cap or blob-backed output before raising it; the transcript marks truncated output until then. [Cross-agent briefings](ai-chat-panel/README.md). |
| PACKAGE-01 | Review an extension packaging allowlist or `.vscodeignore`. | Verify the packaged file list includes runtime modules, vendor assets and licenses while excluding tests and generated output. [Audit priority 7](docs/performance-opportunities.md). |

## Planning rules

Consider providers beyond the main coding CLIs, including **Groq**. Keep **Groq** distinct from **Grok** and check billing, quota scope and reset rules per service; don't apply one universal five-hour or 24-hour timer. This is a design constraint, not a task to mark complete.

## Recently closed / reconciled

| Date | Item | Evidence |
|---|---|---|
| 2026-11-14 | Live elapsed timer on running tool cards (`.tool-card .tool-time`) plus persisted `startedAt` and `durationMs` across reloads, completion, and interruption, and right-click Copy / Download actions on attached images and lightboxes preserving original or renamed filenames. | `ai-chat-panel/extension.js`, `ai-chat-panel/media/main.js`, `ai-chat-panel/media/style.css`; unit tests in `turn-queue.test.js`, `message-dock.mjs`, and UI scenarios `tool-running-timer`, `attachment-image-actions`. |
| 2026-10-26 | ATT-03: Click PDF references and attachment chips to open them in the editor, like Explorer, including Markdown links and filenames shown as code. Verified Codex's `[label](</C:/.../file.pdf>)` format with spaces and Unicode against the supplied screenshot. Uses the editor?s registered viewer for every document size. | `ai-chat-panel/media/main.js`, `ai-chat-panel/extension.js`; host regression in `turn-queue.test.js` and browser scenarios `pdf-file-links`, `codex-pdf-file-links`. |
| 2026-10-22 | Repository organization and backlog review requested by the user; replaces the old “remind me to clean up later” task. | README navigation, documentation index, archive labels and generated screenshot relocation. Runtime folders retain their installed paths. |
| 2026-10-22 | Earlier performance audit's hidden-dialog rendering, lazy highlighting, byte-bounded caches/logs, compressed tool output and serialized checkpoints already have implementation records. | [Rendering and persistence improvements](docs/performance-implementation.md). Remaining investigation is listed above; don't repeat the audit's original implementation order. |
| 2026-10-22 | Original loop-manager frontend brief already says it was superseded by the built UI. | [Historical brief](docs/archive/claude-investigation-manager-prompt.md); LOOP-01 tracks subsequent loop work. |

## Maintaining this file

Give each new task a stable ID, status section, concrete next action and completion criterion. Record the request date when known; don't invent dates or priorities. Keep detailed designs in `docs/plans/` and link them here. Deferred means wait until selected; needs investigation means no confirmed fix yet.

When work finishes, remove its open checkbox and leave a short dated evidence link in Recently closed. Keep that section short; Git retains older history. Move superseded plans to `docs/archive/`, update incoming links and label them historical. Never silently drop an unresolved user request because it is old.
