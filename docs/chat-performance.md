# Chat switching performance

The previous switch path read the selected chat, sent every message to the webview, and rebuilt every Markdown bubble, code block and tool card synchronously. History refreshes also read and parsed every saved conversation. Leaving a conversation with a typing flag triggered another full snapshot write even when nothing had changed.

The switch path now sends and renders up to 12 recent turns. A turn includes its user message, assistant replies and tool records. Pages use a soft budget of 120 records and always finish at a turn boundary; a single oversized turn stays intact. Scrolling upward within 320 pixels of the top automatically fetches the preceding page and inserts it while preserving the current reading position and the live tail's DOM. Only one request runs at a time. Short pages automatically fill the viewport; opening a long chat keeps its recent tail without fetching older pages. Revert uses absolute user-message indices, including hidden compaction turns. Older replies, tools, and attachments stay available, and agent handoffs still use the complete backend conversation.

History summaries are cached in memory without retaining full transcripts or tool output. File metadata for both the primary and backup snapshot invalidates entries after external changes. Project attribution is resolved again on each listing, so registry changes take effect immediately. Save and rename prime the summaries; deletion removes them. Leaving an idle conversation flushes pending edits instead of rewriting an unchanged snapshot.

Live assistant text renders at most once per animation frame. Tail-scroll requests are coalesced, historical replay scrolls once, and user-bubble measurements are collected before changing clamp classes.

Queue refreshes also preserve DOM nodes. Previously every host acknowledgement, including each queue edit and unrelated scheduler refresh, recreated all queue rows and restarted their fade-in animations. Rows and controls now update in place by their queued-turn or scheduled-task ID. Unchanged snapshots cause no queue DOM mutations; editing one prompt preserves its siblings, focus and scroll position. Entrance animations apply only to newly inserted rows. Host updates received during drag are reconciled on release, with scheduled rows excluded from draggable positions. Run `node ai-chat-panel/test/queue-stability.mjs` for the browser regression in normal and reduced-motion modes, or use the `queue-edit-stability` UI scenario. Its visual report is in `out/ui-queue-review/report.md`.

## Reproducible measurements

Run `node ai-chat-panel/test/chat-performance.mjs`. It uses Edge, the real webview scripts and synthetic histories, with no model calls. Results are written to `out/chat-performance/benchmark.json`.

On this machine, the final development run measured:

| Exchanges | Full transcript replay | Recent-page replay | DOM elements, full → paged | Payload, full → paged |
|---|---:|---:|---:|---:|
| 100 | 484 ms | 54 ms | 12,690 → 1,525 | 364 KB → 44 KB |
| 500 | 7,247 ms | 35 ms | 63,090 → 1,513 | 1,827 KB → 44 KB |

These are medians of five warm synchronous browser replays using the same renderer with full versus paged payloads. They exclude disk reads, IDE transport, and later layout/paint, and are not end-to-end IDE switching measurements. Each synthetic exchange includes Markdown, code, a table and four tool cards. Timing varies with machine load.

For 30 saved chats with 100 exchanges each, a fresh summary scan took 153 ms; a cached listing took 5.6 ms. The cache still checks file metadata rather than assuming that another IDE has not changed the files.

## Verification and remaining limits

`chat-history.test.js` covers page boundaries, tool-heavy turns, metadata reuse, external edits, backup recovery and deletion. `turn-queue.test.js` covers the real host protocol, cross-chat request rejection, full backend history, and draft flushing. The browser scenario `chat-paged-history` checks paging during streaming, live DOM preservation, scroll anchoring, Revert indices, compaction indices and stale responses after navigation.

Visual reports are in `out/ui-auto-history/report.md`, `out/ui-stream-review/report.md` and `out/ui-background-review/report.md`. Streaming and background-switch scenarios pass at 900, 420 and 320 pixels. Automatic paging assertions pass at all three widths, covering the prefetch threshold, request deduplication, exhausted history and navigation during a request. Inspected screenshots show the first loaded turn without the earlier-message button. The paging geometry probe still reports one covered control per width at the fixed composer's lower viewport edge; those findings remain unresolved.

The subsequent [rendering and persistence work](performance-implementation.md) moves large tool output into lossless compressed blobs and resolves it lazily for requested pages. Opens still synchronously parse the remaining metadata and inline messages. Streaming checkpoint writes now run asynchronously in per-chat order, with synchronous final saves and shutdown flushes. Snapshot durability, backups and the 250 ms checkpoint interval are preserved. Older pages accumulate in the DOM as you scroll back; this is incremental loading, not a recycling virtual list. A huge individual turn can still be expensive.

Reload Antigravity to load the extension-host changes.
