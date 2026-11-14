# Performance and memory audit — 21 October 2026

This is an audit and implementation order. Application behavior and stored user data were not changed. Measurements use the current checkout, file metadata and aggregate chat-field sizes. Browser experiments use synthetic conversations without calling any AI CLI.

The subsequent implementation is documented in [Rendering and persistence improvements](performance-implementation.md): hidden-dialog rendering, lazy highlighting, byte budgets, compressed lazy tool output and serialized asynchronous checkpoints are now implemented. The audit below describes the earlier state; user storage migrates only as conversations are saved.

## What occupies space

| Area | Approximate size | Interpretation |
|---|---:|---|
| Chat-panel media | 8.7 MiB | PDF support 5.1 MiB, Shiki 2.2 MiB, KaTeX 0.53 MiB, plus UI code/assets |
| Root Playwright dependencies | 17.7 MiB | Development tooling, outside the extension folder; no runtime npm dependencies are declared |
| User investigation storage | 255 MiB | Reports, snapshots and workspaces; excludes linked dependency directories |
| User attachments | 136 MiB | Original user files; not all cache or safely disposable |
| Primary chat snapshots | 93 MiB | 212 conversations when counted |
| Chat backups | 78 MiB | Recovery data; retain recovery guarantees |

Tool records account for about **84 MiB** of the primary chats, compared with roughly 1 MiB of user messages and 6.9 MiB of assistant records. The largest chat is about 6.9 MiB. These figures can move as active conversations save.

A lossless, in-memory gzip-level-3 experiment reduced 93.3 MiB of primary snapshots to **26.9 MiB**, a **71.2% reduction**. This demonstrates compressibility, not a recommendation to compress the entire active history every checkpoint. No user files were rewritten. [Experiment](../out/performance-audit/storage-experiment.json).

Development artifacts are separate: `out/pdfjs-package` alone occupies about 41 MiB. Packaging exclusions and deliberate cleanup can shrink the checkout without affecting the running extension. Recovery directories and baseline pictures require separate retention decisions. The [backlog](../TODO.md) tracks remaining investigations and packaging work; the original priorities below include work completed in the implementation follow-up.

## Priority 1: avoid building hidden interfaces

[renderHistory](../ai-chat-panel/media/main.js) rebuilds Manage Chats on incoming history messages even while its modal is closed. A synthetic 212-chat refresh created **212 hidden cards, increasing total DOM nodes from 1,982 to 11,115 and event listeners from 233 to 1,294**. The measured JavaScript heap changed only from 7.00 to 7.22 MiB; DOM/native allocations are not fully represented by that number.

Keep summaries current while the modal is closed, build cards when opened, and reconcile visible cards instead of rebuilding the list. Render large lists in batches if measurements justify it. This should be an early, contained change. [Measurement](../out/performance-audit/hidden-history.json).

## Priority 2: separate hot chat state from cold tool output

[ChatStore](../ai-chat-panel/lib/chat-store.js) still synchronously reads/parses the previous full snapshot, serializes the replacement, parses that serialized text again, copies a full backup, writes and fsyncs the replacement. Streaming checkpoints can request this every 250 ms; tool events also save immediately. UI paging reduces transfer/rendering, but does not remove that backend work.

Store large tool outputs separately and keep references plus preview metadata in the hot conversation. Load full output when its tool card is opened or an export needs it. Compress cold output losslessly. Then move writes to a serialized asynchronous writer or a journal with periodic snapshots, preserving ordering, recovery and cross-window ownership checks. Never silently truncate original output. This targets CPU, temporary allocations, disk traffic and file size together.

The handoff builder already omits raw tool output, so most of this payload is UI/archive data rather than essential cross-agent prompt context. Migration must still preserve forks, backups, exports and old conversations.

## Priority 3: manage retained webview lifetimes and eager libraries

[Chat windows and the sidebar](../ai-chat-panel/extension.js) use `retainContextWhenHidden: true`. Each retained view keeps its DOM, caches and initialized UI libraries. Suspend UI timers/rendering when hidden. Consider releasing long-idle view contexts after saving drafts, attachments, mentions, model choice and scroll state, while host-owned queues and running agents continue independently. Reopening speed versus RAM should be measured before choosing a timeout.

Shiki is loaded and initialized on every page load, including chats without code. Load it and needed grammars when code first appears. Settings and investigation UI initialization are further candidates for loading on first use.

PDF.js is **already dynamically imported**, its thumbnail cache is bounded to 32 entries, and PDF tasks are destroyed after use. Preserve that behavior. Removing PDF CMaps, fonts or decoders indiscriminately would break supported documents. Splitting library loading reduces startup work and per-view memory; it does not automatically reduce total installation size.

## Priority 4: bound expensive caches and long-running logs by bytes

The syntax highlight cache is capped by entry count, but its keys contain complete code strings and its values contain highlighted HTML. Streaming prefixes can consume a large budget despite the 300-entry limit. Cache completed blocks, enforce a byte budget, and release obsolete themes when switching editor themes.

The host subagent log has a 3,000-event cap, but event sizes vary. The current webview's agent event arrays and the stream runner's diagnostic-line array can grow during a long run. Use bounded recent views plus archived logs on disk where full history matters. Add maximum protocol-frame handling that reports oversized input rather than corrupting JSON by truncating it. Persist unsaved draft state before considering eviction of draft caches.

These are code-supported growth risks, not measured leaks in the current audit.

## Priority 5: render growing content incrementally

[renderAssistantBody](../ai-chat-panel/media/main.js) still reparses the entire accumulated reply on each rendered frame. Keep completed Markdown blocks stable and update the unfinished block. Schedule expensive syntax colouring separately and avoid caching every intermediate prefix. Collapsed tool bodies should be materialized when opened instead of allocating all their text/diff DOM immediately.

Earlier history pages accumulate when requested. If long reading sessions prove costly, add eviction of distant pages with measured-height placeholders, preserving scroll, keyboard focus, open tool cards and text selection. The current initial paging already solves much of the common switching cost; a full virtualization framework is not the first step.

## Priority 6: use small attachment thumbnails

Image attachment chips and queued-image badges use original image URIs at thumbnail sizes. Generate and cache small previews while retaining original files for the viewer and CLI. Lazy-load previews outside the visible area and release viewer canvases/resources on close.

The largest PNG found was 2,880 × 1,620: a full RGBA buffer at that resolution is **17.8 MiB**. This is a pixel-size calculation, not measured Chromium memory; decoding/downsampling and GPU allocations vary. The important distinction is that a small compressed image file can still require substantial decoded memory.

## Priority 7: retention and packaging

Add a storage breakdown and a reviewable cleanup operation for completed investigation snapshots, old reports and generated caches. Preserve active, paused and resumable work. Attachment cleanup must follow references from conversations, backups, forks, schedules and drafts; use content hashes to avoid duplicate original files. Preserve at least one recoverable snapshot while compressing cold backups.

Define an explicit extension packaging allowlist or `.vscodeignore`. Neither is currently present. Include runtime modules, required vendor assets and licenses; exclude tests, screenshots and temporary artifacts. Minification is a later size optimization. Large font/decoder removal needs coverage for the document types actually supported.

## What the memory test did and did not find

An isolated Edge test switched 60 times among five synthetic chat IDs, each with 12 exchanges, with garbage collection before sampling. At 20, 40 and 60 switches, the DOM stayed at **2,557 nodes and 268 listeners**; JavaScript heap was **7.58, 7.68 and 7.73 MiB**. That does not show a runaway DOM/listener leak in the tested path. [Results](../out/performance-audit/memory.json).

These are browser JavaScript heap measurements, not total Antigravity, extension-host, GPU or provider-CLI RAM. A live IDE profile is needed before assigning RAM savings to any change.

Recommended first batch: lazy Manage Chats, on-demand highlighter initialization, byte-bounded caches/logs, and hidden-view suspension. Follow with tool-output separation and serialized persistence; then add storage retention and packaging rules. Keep the existing appearance, recovery behavior and full original attachments throughout.
