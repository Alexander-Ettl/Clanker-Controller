> Deferred research linked to SEARCH-01 in the [backlog](../../TODO.md). Recheck code locations and storage assumptions against the [subsequent persistence changes](../performance-implementation.md); no search dependency has been selected for implementation.

**Manage Chats: message search research and implementation plan**

Research date: 2026-10-11. Scope: planning; no runtime changes or dependency installation.

Build local search over the complete visible conversation, show the passage that matched, and open that message when the user selects a result. My recommended engine is MiniSearch in one Node worker per extension host, backed by the existing chat JSON files. Keep literal substring matching alongside its token index because this is a coding chat application: filenames, settings IDs, error fragments, and punctuation matter.

This recommendation needs a benchmark before committing to the dependency. An asynchronous cached scan is the comparison baseline and the simpler shipping option if it meets the performance targets and the first release only needs literal search. No corpus measurements or engine benchmarks have been run during this research.

**What the code does today**

`ai-chat-panel/media/main.js:3914` creates the search field. `renderHistory()` lowercases the complete query and checks whether it occurs in the title, project names, preview, or latest-message excerpt. It searches synchronously in the webview and retains the Active Chats/day grouping.

`ai-chat-panel/lib/chat-store.js:150` lists chats by reading their JSON snapshots, with `.bak` recovery. `findLastMessage()` returns only the first 400 characters of the latest nonempty user/assistant message. `preview` repeats the title. Consequently, an older message, or a match after character 400 in the latest message, cannot match the current search.

The complete text already lives in `chat.messages[].text`; no CLI query or provider API is necessary. `ChatWindowManager.listChats()` adds project labels and state. Keep those rules, including which empty chats belong in history, as the source of chat eligibility.

Two existing behaviors require special treatment:

- `ChatStore.checkpoint()` saves every 250 ms during streaming. Rebuilding a complete index for each checkpoint would waste CPU and create stale-index cleanup pressure.
- `restoreChat()` in the webview always calls `scrollTranscriptToEnd(true)`. Search navigation must run after rendering and take precedence over that automatic scroll.

Stored messages do not consistently have persistent message IDs. The renderer also hides compaction turns and interleaves tool cards inside assistant replies; a DOM child number is not a reliable message address.

**Engine choice**

| Approach | What it provides | Decision for Clanker |
|---|---|---|
| Cached scan in a worker | Exact phrases and arbitrary substrings with no library; cost grows with total text | Benchmark baseline; valid first release if the measured corpus stays small |
| MiniSearch in a worker | Ranked token retrieval, field weights, prefixes, bounded fuzzy matching, incremental replacement | Recommended for the complete search experience; add explicit phrase/substring verification |
| Fuse.js | Approximate string matching, result offsets, weighted keys | Useful for short fields; less compelling for this message corpus. Its location defaults require adjustment for long text |
| SQLite FTS5 | Persistent full-text tables, BM25, phrase search, optional trigram substring indexing | Reconsider if the corpus exceeds acceptable in-memory limits; first verify SQLite availability in the IDE runtime |

MiniSearch runs in Node, has no external dependencies, and targets collections that fit in memory. Those properties fit the extension, but do not establish its speed on Clanker's corpus. [MiniSearch project documentation](https://github.com/lucaong/minisearch).

Its search options include BM25+, field boosts, AND combination, prefixes, and fuzzy-distance controls. Default term combination is OR, so Clanker must explicitly request AND. [Search options](https://lucaong.github.io/minisearch/types/MiniSearch.SearchOptions.html), [API reference](https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html).

Fuse's documentation warns that its default location settings effectively inspect the first roughly 60 characters of a field; `ignoreLocation: true` allows matching anywhere. [Fuse fuzzy-search documentation](https://www.fusejs.io/fuzzy-search.html).

FTS5 supports phrases and BM25, while its trigram tokenizer supports substrings of at least three characters. Shorter full-text trigram queries do not match. Those features make it a possible larger-corpus option, with additional integration work. [SQLite FTS5 documentation](https://www.sqlite.org/fts5.html).

**Search behavior to ship**

Search all visible user and assistant message text, including code blocks and retained older turns. Search titles and the same primary/touched project names available today. Exclude tool payloads, hidden compaction summaries, provider metadata, drafts, queued prompts, and attachment contents from the initial scope. Mirror the renderer's compaction visibility rules rather than checking only `message.compact`.

| Query | Expected behavior |
|---|---|
| `deadlock buffer` | Both terms occur in the same message, in either order, or in the chat metadata record |
| `"buffer is full"` | Contiguous phrase in one visible message or metadata field; no fuzzy expansion |
| `exitLocked`, `main.js`, `ERR_CONNECTION_RESET` | Preserve exact identifier/filename matching and punctuation |
| `lock` | Preserve substring matches such as `exitLocked`, while ranking an exact word match ahead of a fragment |
| `messeges` | Offer bounded typo matches for ordinary words, below exact results |
| `München` / `munchen` | Case-insensitive and accent-insensitive matching, with original text in excerpts |
| Empty input | Return the existing Manage Chats list and its grouping immediately |

Never satisfy a multiword query by finding one word in an unrelated old message and another in a different message. Project-plus-content searches should use a project filter; avoid silently distributing terms across the entire chat. Treat unrecognized punctuation literally. An unfinished opening quote temporarily behaves as literal input so typing does not produce parser errors.

Use Unicode-aware normalization shared by indexing and queries. Keep a punctuation-preserving literal form and a token form that can split camelCase and snake_case while retaining the whole identifier. Do not apply English stemming to a mixed German/English/code corpus. Accent folding does not imply `ß = ss` or `ü = ue`; add those equivalences only with explicit tests and a product decision.

Rank by match quality first: exact title or identifier, literal phrase, all exact terms, prefix matches, then fuzzy matches. Within a tier, use field weighting and MiniSearch relevance; use recency as a tie-breaker. Group message hits into one card per chat using the best hit plus a capped contribution from other good hits. Long conversations should not win merely because they repeat a word hundreds of times. Tune weights against a relevance fixture instead of inventing final constants now.

**Result experience**

Change the field label to “Search chats and messages”. A nonempty query gets a relevance-ordered list; active/current/waiting indicators remain on the cards, but the Active Chats heading must not place weaker matches ahead of stronger ones. Clearing the query restores the normal list.

Replace the last-message preview with a short excerpt around the strongest matching passage, with its speaker and time. Show the number of matching messages separately from the chat's total message count. Metadata-only matches keep the usual latest-message preview. Render original text and matched ranges through text nodes and `<mark>` elements, never interpolated HTML. Normalization can change string length, so map normalized positions back to source offsets.

Selecting a message result opens the chat, expands the containing collapsed turn if necessary, scrolls to the message, and briefly marks the matching passage. This also works when the result belongs to the current chat. Offer next/previous match navigation in the opened conversation; clear the search target when the user leaves it. Preserve the draft, running turn, and explicit project root throughout navigation.

Keep the existing bubble shapes, rim colors, glass tokens, narrow-sidebar layout, and reduced-motion behavior. Any control expansion must follow `docs/dynamic-island-composer-spec.md`. Keyboard users can reach the results, open with Enter, and return to the search field. Announce result counts through a polite live region. Keep searching, indexing, no-match, and search-error states distinct; incomplete indexing must not look like a definitive zero-result search.

**Implementation contract**

Use one search service shared by the launcher, sidebar, and detached chat windows in each extension host. Put file loading, normalization, indexing, and queries in a Node worker. Node documents workers as appropriate for CPU-intensive JavaScript; asynchronous file I/O should still use the normal Node APIs. Verify packaging and lifecycle in the actual Antigravity extension runtime. [Node worker documentation](https://nodejs.org/api/worker_threads.html).

Keep one metadata document per chat and one document per visible message; don't duplicate the chat title into every message. Each message document carries `chatId`, source message index, role, timestamp, and a content fingerprint. Keep original source text in the worker's cache for excerpt construction. MiniSearch term matches are not source-character offsets or native phrase verification, so Clanker must supply both.

Merge two retrieval paths before grouping results: literal substring/phrase matches over cached normalized text, and ranked MiniSearch token matches. The literal path preserves today's substring behavior and handles symbol-only queries; scan in batches and yield so newer queries can supersede older ones. Prefix expansion applies to the last unfinished ordinary word. Allow at most one edit for ordinary words of at least five characters; avoid fuzzy expansion for code-like terms and quoted phrases. Exact results always precede approximate ones.

The cached literal scan remains proportional to corpus size even with MiniSearch. Include it in benchmarks. If it becomes the bottleneck, evaluate an auxiliary trigram index or FTS5 rather than silently dropping substring matches.

Suggested webview messages:

```js
// Webview -> host
{ type: 'searchChats', requestId, query, limit: 50, cursor: null }

// Host -> webview
{ type: 'chatSearchResults', requestId, query, indexRevision,
  status: 'ready', totalChats, totalMatchingMessages,
  results: [{ chatId, matchedField, matchedMessageCount,
    target: { sourceIndex, fingerprint },
    snippet: { text, ranges }, role, at }], nextCursor: null }

// Open a result; existing ordinary restoreChat messages remain valid
{ type: 'restoreChat', id: chatId,
  searchTarget: { requestId, query, sourceIndex, fingerprint } }
```

Keep search-result enrichment separate from the ordinary `history` payload so full transcripts never travel to every webview. Debounce input by about 150 ms, handle IME composition, and reject responses whose request ID/query no longer match. Scope request IDs to the originating webview. Pagination cursors bind to query and index revision; invalidate them after changes. Live history refreshes should update card state without replacing search results with the unfiltered list or destroying keyboard focus.

Bind the target to a chat revision and validate its fingerprint against the loaded chat. Add source-message references to rendered message containers; don't infer them from DOM ordering. Expand and jump after restoration, suppressing scroll-to-bottom for that navigation. A stale target triggers a fresh search in the loaded chat; a deleted target produces a clear notice. Search requests must never call `runFor()` just to inspect a conversation, since constructing runs can have unrelated side effects.

Start with a lazy, in-memory index built when Manage Chats first needs it. Use bounded file-read concurrency, the store's primary/backup recovery rules, and partial progress reporting. Failed files count as skipped and do not crash the entire index. Avoid storing another persistent copy of transcripts until cold-start measurements justify one.

Update after successful save, rename, fork, and delete operations, including scheduled chats. Coalesce streaming updates around 750 ms and flush immediately at turn completion. Update only changed message documents; metadata changes need not rebuild all messages. MiniSearch `replace()`/`discard()` support this, but repeated replacement leaves obsolete references until vacuuming, so watch memory under long streams. [MiniSearch mutation API](https://lucaong.github.io/minisearch/classes/MiniSearch.MiniSearch.html).

Another IDE window can write the same history. Reconcile file size/mtime signatures on opening Manage Chats and periodically while search is visible, also detecting added/deleted files. Compare content before reindexing unchanged messages. Deletion removes cache entries and results immediately. Dispose timers and terminate the worker when the extension shuts down; a worker failure should report a retryable error.

**Delivery order and acceptance**

1. Build synthetic fixtures and a cached-scan benchmark. Cover older-message matches, hits deep inside long replies, identifiers, Unicode, phrase semantics, and backup recovery. Compare scan and MiniSearch at 1,000, 10,000, and 100,000 visible messages with varied lengths. Measure text bytes as well as message count.
2. Implement the worker/service, store invalidation, and request protocol. Add full-message retrieval, bounded results, accurate excerpts, and stale-response protection. Keep history eligibility/project labels consistent with `listChats()`.
3. Implement the polished result cards and validated message jump. Cover same-chat navigation, collapsed turns, running conversations, narrow layouts, keyboard focus, and reduced motion.
4. Tune relevance, add conservative prefix/fuzzy behavior, and validate packaging. Add project/speaker/date filters only after the basic flow works; semantic retrieval and attachment extraction remain separate future work.

Proposed targets, not measured results: warm end-to-end p95 below 100 ms after the debounce at 10,000 messages; below 250 ms at 100,000; first partial results within 500 ms on cold initialization. Record worker memory, index build duration, and extension-host responsiveness. If the large fixture misses those targets, document the supported corpus envelope and choose a storage/index change based on the actual bottleneck. Don't truncate indexed message text to pass the benchmark.

The test suite needs independent expected results for literal and phrase queries, plus a small human-authored relevance set for ranking. Check rename/fork/delete, scheduled writes, checkpoint coalescing, cross-window changes, corrupt primary with valid backup, symbol-only queries, IME input, reversed request completion, revision-bound pagination, stale targets, and safe rendering of HTML-looking message text.

Add dedicated Manage Chats scenarios to `ai-chat-panel/test/ui-tester/scenarios.mjs`; the current scenario catalog has no explicit history-search scenario. Run focused Node tests, `npm.cmd run check`, and the affected browser scenarios. Inspect report crops for spacing, glass layering, excerpt legibility, and focus indicators. Then run `npm.cmd test` for the runtime change. No real CLI prompts are needed. Reload Antigravity to verify worker packaging and extension-host changes.

Research limitations: this plan follows the current working-tree code, which contains pre-existing modifications. It leaves those files untouched. It does not inspect personal chat contents, establish production corpus size, or claim a measured performance advantage for any engine.
