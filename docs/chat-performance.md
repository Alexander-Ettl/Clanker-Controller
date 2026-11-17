# Chat switching performance

For the 2026-11-17 browser interaction sweep, profiling and motion changes, see [interaction performance](interaction-performance.md). That benchmark covers the scenario inventory rather than only chat switching.

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

## Dock glass

Typing in the composer was the most visible slowdown: in a long chat the frames took 64 to 96 ms (11 to 15 fps). The dock's rim refraction was one SVG `backdrop-filter` (displacement, blur, then a mask) over the whole dock, and a backdrop filter reruns whenever anything inside its box changes, so every keystroke re-ran it. Splitting it into thin strips along each shape's edge, with the mask done by CSS, means typing damages none of them. Measured with `node ai-chat-panel/test/dock-performance.mjs --gpu --sidebar` (headed Edge, so frames include real GPU compositing; on this machine that is AMD Radeon integrated graphics at 2x scale), the real page against the fake host, 900 px wide, a 24-message chat; `--no-glass` gives the floor with the glass engine off and `--phases=typing,menu,stream,scroll` picks phases (a headless run uses software rendering and exaggerates filters). Results go to `out/dock-performance/benchmark.json`:

| Interaction | Before | After |
|---|---:|---:|
| Typing in the composer, long chat, sidebar layout | 64 to 96 ms per frame | 16.6 to 17.4 ms per frame |
| Typing in the composer, no dock glass at all | 16.4 ms | (the floor) |
| Streaming a reply, 60 fps | 800 to 850 ms main thread per 4 s | 1000 to 1100 ms |
| Scrolling a long chat, 60 fps | 240 to 270 ms main thread per 3 s | 330 to 420 ms |

The last two rows are the price: the strips are extra compositor layers, so they cost a little more main-thread time without changing the frame rate. Other changes in the same pass: the island follow loop asked `getAnimations({ subtree: true })` every frame (about 2 ms, flushing style) and now asks every sixth frame; the silhouette, lighting and ring images are set on elements instead of inherited custom properties (a property change on the glass cost 2.8 ms of style per recalc); `--dock-h` is only written when it changes; the global glass scan ignores the transcript; lens tiles copy their identical middle columns and skip neutral pixels. Appearance was compared against a reconstruction of the previous dock code in dark, light and a high-contrast stripe pattern behind the dock: at most 13 of 765 summed channel levels apart on normal content, and the lens at the end caps matches.

PERF-03 follow-up (2026-11-17): moving docks now reuse a document SVG mask and an inline lighting SVG with persistent filter graphs, updating only geometry. The same blur, threshold and lighting math remains. Positioned rim strips still receive one silhouette image when motion settles. Headed Edge sidebar menu runs reduced style work from 798 ms to 143–178 ms per 3 s and main-thread work from 2858 ms to 1263–1476 ms. Typing averaged 16.6 ms. Occasional frames above 33 ms remain (menu max 172–202 ms), so the original frame-time criterion is still open, along with fresh lens tiles after resize. `node ai-chat-panel/test/dock-motion.mjs` verifies graph reuse, no animated SVG image writes, composer growth and theme changes. Menu geometry passes at 900/420/320 px; comparison renders are under `C:\Dev\clanker-glass\perf03-*.png`. Not a hotspot, measured and left alone: the `.drop-overlay` and tooltip backdrops at opacity 0.

Reload Antigravity to load the extension-host changes.

## Glass on the popups and their controls

Settings now override the original treatment below with one neutral glass sheet, subtle card hairlines and matte controls, as recorded in the composer spec. They retain the overlay blur but omit coloured sheet washes and nested highlights.

`ai-chat-panel/media/glass-ui.css` gives the settings popup, the other full-screen popups and every card, button, input, tag, switch and menu inside them the liquid-glass look: a clear sheet with colour washes, a lit edge (two offset inset shadows), a sheen gradient, recessed wells and glass beads on the switches. It is paint only: no per-control backdrop filter and no SVG refraction, because a backdrop filter per control would rerun on every scroll frame. The only backdrop filters in it are the popup overlay's blur (as before) and the sticky search bar. Everything sits behind `body.lg-on:not(.vscode-high-contrast, ...)`, so high contrast and reduced transparency are untouched; `test/glass-ui.test.js` checks that. Measured in headed Edge on the GPU (scrolling the General and Voice tabs at 420 px wide): 16 ms per frame with and without the file, no frame over 33 ms. A headless software-raster screenshot of the open popup is about twice as slow with it (the washes and shadows are large areas), which is a test-harness cost, not a real one.

## Streaming and saving (2026-11-17, overnight pass)

Two costs grew with the length of a conversation rather than with what changed.

**Streaming replies.** Every frame, the whole reply was parsed again and replaced, so a long answer cost quadratic work and lost any text selection. `renderAssistantBody` in `media/main.js` now keeps finished blocks in the DOM and rebuilds only the tail. `stableCut` chooses cuts the renderer would have made anyway: the end of a closed code fence, and a blank line that no list, table, maths block or footnote can reach across (a list is only cut at when the next line starts with a letter). Replies containing footnotes or `<details>` render whole, as before. `node ai-chat-panel/test/stream-incremental.mjs` streams seven corpora in six chunkings each and requires the same HTML as a one-shot render. `node ai-chat-panel/test/stream-performance.mjs [--old] [--kb=80]` measures an 80 KB reply: 113 s main thread and 249 ms p95 frames with the old renderer, 9 s and 27 ms with the new one (headless, so paint is exaggerated; script time fell from 29 s to 1.6 s).

**Saving a long chat.** A checkpoint (every 250 ms while text streams, plus tool boundaries, session ids and draft edits) used to stringify the whole conversation, re-read and parse the existing file to check whether another IDE window owned it, copy it to `.bak`, list the chats folder and stat every stored tool output, all on the extension host's thread. An 18.6 MB chat cost about 190 ms of stringify and 116 ms of parse each time. `ChatStore.checkpoint(chat, { settled })` now keeps the serialised form of the messages that cannot change during the turn (bytes, encoded once; rebuilt at least every 60 s and whenever a full save happens), serialises only the tail, skips the parse while the file still carries the stamp this store left on it, refreshes `.bak` at most every 15 s, remembers the chat's file path, and writes less often when a write is slow. Idle chats use the same path for draft changes, so typing in a long chat no longer rewrites the conversation. Measured with a synthetic 11.5 MB chat streaming for 8 s: event-loop p99 stall 107 ms before, 19 ms after. Ownership is still checked whenever the file changed behind the store's back (`chat-persistence.test.js`, cross-window case). Tool boundaries and session ids are written within about 50 ms, off the host thread; they used to be written synchronously. Final saves are unchanged.

**Delivery.** `ChatRun.postEvent` sends reply text to the window in batches of about 33 ms; the first chunk after a pause leaves at once. Any other message, a window attaching, or a replay flushes the batch first, so order and content are unchanged (`turn-queue.test.js`).

**Off-screen turns.** Settled turns in the transcript use `content-visibility: auto` with a remembered height. Scrolling a 150-turn chat end to end took 4.7 s of main thread instead of 10.1 s; renders are identical apart from a 1 px shift from layout containment, and the accessibility tree is the same. The UI tester's unnamed-control probe reports the controls inside skipped turns because it reads rendered text; that is a probe limit, not a screen-reader one.

**Startup listing.** The first listing of saved chats after a restart (the work-context refresh and the launcher's recent chats run it during activation) parsed every snapshot: 2.4 s synchronously for 285 chats and 350 MB. `ChatStore` now persists the summaries to `session/chat-summaries.json` (about 1 MB), keyed by each snapshot's stamp (inode, size, mtime, ctime of the file and its backup); a listing re-reads only chats whose stamp changed. Measured on the real folder: 2,094 ms cold before, 81 ms with the index. The file is a cache written asynchronously two seconds after a change, outside the `chats` folder so nothing lists it as a chat; a damaged index or one with an older `SUMMARY_SCHEMA` is ignored and rebuilt.
