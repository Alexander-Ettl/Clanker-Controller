# Rendering and persistence improvements

Implemented after the October 2026 performance audit. Existing user storage was not rewritten during development; conversations adopt compressed tool output on their next save.

## Rendering and memory

- Manage Chats keeps incoming summaries but creates no cards while closed or the document is hidden. Opening builds the latest list. Visible refreshes reuse unchanged cards, preserve focus and scroll, and defer changes during an inline rename. Closing releases the cards.
- All Projects builds its gallery when opened and releases it on close. The Agents dialog records recent events while closed, materializes its log on opening, and releases its log DOM on close. Its display timer pauses when hidden. Settings initialization and the main streaming transcript are unchanged.
- Shiki's bundle is fetched and initialized only when a code block approaches the viewport. Code stays readable as plain text while it loads. Hidden and distant blocks wait; disconnected blocks are unobserved. Individual blocks over 100,000 characters remain plain text. The current vendor bundle still initializes all its included grammars together on first use.
- Only closed code fences enter the highlight cache: unfinished streaming prefixes do not. The cache has a 2 MiB UTF-16 string budget and a 300-entry ceiling. Theme replacement clears the cache and disposes the old highlighter context; this bundled Shiki has no theme-unload API.
- Recent host subagent replay has a 2 MiB serialized UTF-8 budget and a 3,000-event ceiling. The webview retains at most 300 events / 256 KiB of serialized UTF-16 text per agent and 2 MiB across agents. Saved agent-view state keeps up to six chats / 2 MiB total. These are recent activity views, not full log archives. They do not truncate persisted conversation tool output.
- The CLI runner retains only the latest relevant diagnostic, limited to 16,384 characters, rather than every stderr line. Diagnostic events continue to be emitted normally.

String budgets approximate retained text; they are not measurements of total Chromium or extension-host RAM.

## Storage and write ordering

Tool-output strings of at least 16 KiB UTF-8 move into immutable gzip-level-3 files under `chats/tool-output/`. SHA-256 references deduplicate identical output across snapshots, backups and forks. Smaller strings, non-string output and strings with unpaired UTF-16 surrogates remain inline. No original output is shortened.

The snapshot has `storageFormat: clanker-tool-output-v1`. Legacy JSON still loads. A newly saved snapshot references durable blobs; its preceding good snapshot remains the backup. Backup recovery and cross-window ownership checks remain in place. Each blob read validates the decoded length and content hash. Missing or damaged output raises an error when accessed rather than becoming empty text.

Loaded tool output uses an enumerable accessor. Normal exports and webview serialization receive the original string; reading a chat or its summaries does not decompress old tool bodies. Paging resolves only the requested records. Saving a loaded snapshot reuses references without decoding. Successfully saved in-memory bodies also become lazy accessors, releasing their original strings. Decoded output shares an 8 MiB UTF-16 LRU cache; larger individual bodies are read without being retained in that cache.

Streaming checkpoints keep the existing 250 ms throttle. Temporary-file writes and fsync run asynchronously, serialized per chat; superseded checkpoints are skipped. The commit rechecks ownership and the current write generation before replacing the primary. Final saves, renames, deletion and synchronous shutdown flushes invalidate older pending writes. Failed checkpoints remain flushable. Tool-event/final saves remain synchronous, as do new blob compression, snapshot serialization, ownership checks, backup copying and the final rename. This is not a journal or a complete asynchronous storage rewrite.

Keep the entire `chats` directory together when backing up or moving storage: new snapshots depend on its `tool-output` directory. Older builds do not understand the new reference format. Blob cleanup is deliberately deferred until all primary snapshots, backups and forks can be traced safely; deleting a conversation alone does not delete shared blobs.

## Verification

- `npm.cmd run check`, `npm.cmd test`, and `npm.cmd run verify:models`.
- `node ai-chat-panel/test/render-budgets.mjs`: hidden 212-chat history, card identity, latest summaries on reopen, real lazy Shiki loading, theme replacement, finished/unfinished code caching, byte-pressure eviction and bounded agent logs.
- `chat-persistence.test.js`: legacy migration, exact Unicode/whitespace preservation, forks, exports, lazy paging, backup recovery, bounded decoded cache, corruption, final-save/flush/delete ordering, ownership changes and failed writes.
- `node ai-chat-panel/test/persistence-performance.mjs`: synthetic-only benchmark, written to `out/persistence-performance/benchmark.json`. The measured 100-exchange fixture went from 7,817,316 bytes of inline JSON to a 29,675-byte snapshot plus 321,200 bytes of compressed tool output. Median warm filesystem open was 49.7 ms for legacy read/parse versus 6.0 ms for lazy loading; tool decoding is deferred in the latter. These numbers exclude IDE transport, rendering and cold-disk behavior. Backups are not counted in this size comparison.

UI reports: `out/ui-render-budgets/report.md` and `out/ui-persistence-history/report.md`. See `out/ui-render-budgets/review.md` for screenshot review and the separate geometry findings. No model prompts were sent by these checks.

Reload Antigravity to load both the extension-host and webview changes.
