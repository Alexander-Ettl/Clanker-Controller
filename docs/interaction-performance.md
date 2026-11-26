# Interaction performance, 2026-11-17

`node ai-chat-panel/test/interaction-performance.mjs` benchmarks the real webview against the fake host headlessly at 2x scale. Pass `--headed` to reproduce the historical desktop measurements. It visits all 113 current browser scenarios sequentially: theme changes, startup/page opening, composer states, paste and attachments, previews/markup, queue editing/reordering, scheduling, model menus, provider changes, sidebar previews, chat/history operations, settings/search and Investigations. The Investigations scenarios use the sidebar layout, where their launcher is visible.

Reports and CPU profiles live outside the synced source tree, under `C:/Dev/clanker-glass/`. The runner defaults there. Select actions with `--only=model-menu,chat-dialog-budget`, use `--repeat=3`, `--width=420`, `--theme=light`, or `--profile` for Chrome CPU profiles. `--out=...` chooses a report directory. Do not run GPU benchmarks concurrently.

Each scenario gets a fresh page. The report records main-thread, script, style and layout time, frame distributions, frames over 33ms, long tasks and event-handler-entry to next animation frame. Scenario setup time includes deliberate waits, so it is not click latency. An animation-frame callback is not proof of physical presentation. Scenarios which advance the fake clock omit frame/input timing; their CPU measurements remain available. Failed assertions and timeouts are reported as coverage gaps rather than successful measurements. This is browser rendering performance, not real CLI, network, microphone-device or IDE transport latency.

## Profiled changes

The menu profile attributed approximately 115ms to synchronous PNG `toDataURL` encoding during refraction settling. The history profile showed approximately 154ms in full date formatting plus repeated formatting in the history renderer, and 87ms in bubble-card painting. Samples are diagnostic, not a stable performance contract.

- Dock masks now encode through asynchronous `toBlob` and FileReader calls. The last eight settled geometries reuse encoded images; the two optical slabs share a bounded lens-tile cache. Geometry changes during encoding invalidate stale results. Refraction, resolution, masks and lens mathematics remain the same.
- The dock follows animations on its silhouette members, rather than every descendant. Pulsing controls inside the composer cannot keep the geometry loop running at rest.
- Chat, message and scheduled-date formatting reuse a bounded set of locale/clock-specific `Intl.DateTimeFormat` instances. History search checks ordinary text before formatting searchable date labels.
- Filtered-out history cards are reused while the dialog is open and released on close, instead of rebuilding them when the search clears. Session changes invalidate the corresponding card.
- Bubble and history-card sizing reads are batched before surface writes, avoiding a style/layout flush per card.
- Menu opening and message-dock emergence take 300ms; sheets and image previews take 240ms; composer buds and scheduling pickers take 320ms. Selected pills move in 220ms. Spring curves, optical fusion and reduced-motion rules remain intact. These were previously 360–550ms for the larger transitions.

`dock-motion.mjs` checks both optical slabs, retained filters, theme changes, composer growth, zero re-encoding on a repeated open/close, and no geometry polling for an animated inner control. Date tests cover locales, hour cycles, relative labels and invalid dates. The complete unit suite passes 713/713; paste acknowledgement/failure/navigation checks pass.

## Evidence and limits

The initial inventory pass is `C:/Dev/clanker-glass/actions-before/report.md` and its raw `benchmark.json`. It completed 93 scenarios and recorded 20 failures. Ten were Investigations scenarios launched from the editor layout, where their button is hidden; the runner now selects the sidebar for those. Remaining gaps include outdated glass-shadow/Claude-colour assertions, attachment-document loading, sidebar-loading fixture state, an Antigravity quota assertion and a CLI-repair assertion. They must not be presented as measured successful actions.

The after sweep completed 103/113 scenarios, with no new failures. The ten outstanding failures are the non-Investigations gaps listed above. Final history-card reuse was added after that sweep's history case, so `actions-final/` repeats the affected case with the final implementation, alongside menu and queue dragging.

| Scenario | Initial main-thread ms | Final main-thread ms, two runs |
|---|---:|---:|
| Mixed queue drag | 1483 | 997–1241 |
| Open/filter/reopen 212-chat history | 1684 | 1402–1443 |
| Model menu | 487 | 430–457 |

These are whole scripted sequences, including settling, not per-click latency. The final menu profile replaces the approximately 115ms synchronous `toDataURL` samples with approximately 65ms in `toBlob`: asynchronous APIs still have snapshot/readback cost. Cached repeated geometry avoids that cost entirely. History card measurement fell from approximately 87ms sampled in `paintCard` to 17ms in `measureCard` plus 16ms in the batched writer. Full-date formatting no longer appears among the largest sampled costs. Initial list construction and browser rendering remain expensive.

The longer GPU phases (`actions-dock/benchmark.json`) measured typing at 16.8ms/frame, menu cycling at 17.1ms, streaming at 16.0ms, and scrolling at 16.1ms. Streaming and scrolling had no frames over 33ms; typing had three and menus had four (menu maximum 105ms). Repeated sidebar hovers averaged 15.9ms, zero frames over 33ms and zero SVG path writes. These are samples, not guarantees. Synthetic storage measured 6.3ms median lazy open and 31ms durable synchronous save for 100 tool-heavy exchanges; durability was not weakened.

CPU profiles: `C:/Dev/clanker-glass/actions-profile/` and `actions-profile-final/`. Sweep reports: `actions-before/` and `actions-after/`; final repeated cases: `actions-final/`; paste and storage results: `actions-paste.log` and `actions-storage.log`. Dark/light model-menu/queue UI reports are under `actions-ui-model-menu-queue-*/`, with screenshots at 900/420/320. These six menu states have no geometry findings. The script checks card reuse, hidden-dialog release and real highlighting in `render-budgets.mjs`. Startup delayed-stylesheet and failure-path checks also pass (`actions-startup.log`).

`actions-ui-chat-dialog-budget/` has 80 overlap findings at narrow widths. Visual inspection and a 320px `getClientRects()` check show that the sender and wrapped preview text do not overlap; their union bounding rectangles do. The geometry probe currently mistakes these multiline inline spans for overlapping boxes. Functional history assertions pass; this report is not a clean geometry pass. Track fragment-aware inline checks with the other UI-04 probe maintenance.

Timings vary with machine load; the full pass is a discovery sweep, not a statistically controlled latency guarantee. A separate CPU micro-experiment overlapped part of the initial inventory sweep; use its per-scenario values as leads, not precise comparisons. The final repeated cases and GPU phases ran sequentially without another benchmark. Occasional slow frames and first-time surface construction still need profiling; this work does not claim every action is stutter-free. Real IDE verification requires reloading Antigravity/VS Code.
