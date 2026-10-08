# Interface tester

The goal: stop being the human tester. A headless browser walks the real chat window, a script measures what is wrong, and a
model looks only at the few pictures where something new appeared. Gemini does the looking because its weekly quota is
the one that goes unused.

## Why it is built this way

Research (October 2026) points the same way in every source:

- **Deterministic checks first, model second.** Layered visual QA runs geometry, accessibility and diff checks before any
  vision model, and gives the model a fixed rubric with required evidence ([Machine-graded visual evals](https://www.agenticdesign.school/articles/machine-graded-visual-evals-for-design-agents),
  [Cornea](https://glama.ai/mcp/servers/AbduljabbarBXR/cornea)). A single `scrollWidth > clientWidth` comparison finds a
  large share of layout bugs with no ambiguity.
- **Text beats pixels.** Playwright's test agents (planner, generator, healer) read accessibility snapshots, 1 to 5 KB
  against 100 KB or more per screenshot ([Playwright Test Agents](https://testdino.com/blog/playwright-test-agents)). The
  CLI variant writes snapshots and screenshots to disk and lets the agent open only what it needs ([MCP vs CLI](https://scrolltest.medium.com/playwright-mcp-burns-114k-tokens-per-test-the-new-cli-uses-27k-heres-when-to-use-each-65dabeaac7a0)).
  Accessibility trees are diffed as text ([ARIA snapshots](https://playwright.dev/docs/aria-snapshots)).
- **Images cost a fixed amount.** Gemini 3 charges 280, 560, 1,120 or 2,240 tokens per image by `media_resolution`, and
  recommends high for text-heavy screenshots ([media resolution](https://ai.google.dev/gemini-api/docs/media-resolution)).
  So the pipeline sends few, small, cropped images instead of full pages.

What this repo adds: the browser never needs a model to drive it (a model driving Playwright turn by turn is the token
spiral this design avoids); each state is compared with the last accepted run so a quiet night costs nothing; a measured
problem becomes a replayable scenario id, so a fix is re-checked for free; and fixers get text evidence, not pictures.

## Pieces

| File | Role |
|---|---|
| `ai-chat-panel/test/ui-tester/probe.js` | Runs inside the page: overlap, clipping, covered controls, off-screen controls, sideways scroll, unnamed controls, tiny targets. Intentional overlays and SVG internals are ignored; an open popup is judged alone (`scope`). |
| `ai-chat-panel/test/ui-tester/run.mjs` | The harness and CLI. Scenarios x widths x (normal, 45% longer text). Baselines, pixel diff (canvas, no dependencies), accessibility-tree diff, crops, `report.json`, `report.md`. |
| `ai-chat-panel/test/ui-tester/scenarios.mjs` | The screens visited. Add one whenever a bug is found by hand. |
| `ai-chat-panel/test/ui-tester/boot.mjs`, `fake-host.mjs` | The real chat page against a fake VS Code host (shared with `investigations-ui.mjs`). |
| `ai-chat-panel/lib/investigation-tester.js` | One cycle: capture, triage, the Flash pass, report and handoff. |
| `ai-chat-panel/lib/investigation-runner.js` | `runFlash` gained `tools`, `readRoot`, `maxViews`: the one-tool, PNG-only agent. |

## Commands

```
npm.cmd run test:ui                      # whole matrix, about a minute, no tokens
npm.cmd run test:ui -- --only=model-menu # one scenario
npm.cmd run test:ui -- --update          # accept the current pictures as the baseline
npm.cmd run test:ui-tester               # tests of the harness itself
```

## Determinism

Baselines only help if two runs of an unchanged page match. The harness pins the page clock (`boot.mjs`), freezes CSS
animations in screenshots, waits for fonts and a still page height, and ignores a page height that rounds differently by 1-2px.
A scenario that opens something animated must wait for it in `setup` (the model menu waits 700ms for its spring). If
pictures change on a rerun with no code change, look for one of those first. Three consecutive runs over the 48 states
were identical after these fixes.

## Bugs it found

- Model menu cut off on the left at 320px: `placeModelMenu` anchored it to the picker's right edge only. It now keeps 10px
  from the left edge.

## Known limits

- Edge is not the Antigravity webview. Theme variables and the sidebar width patch are not reproduced.
- Pixel baselines are machine specific (fonts), so they stay out of git.
- A failed visual review pauses the loop without accepting its baseline. Its report says **Review incomplete**.
  A quiet interface report says **No new findings**; previously reported problems may still be present.
- The frozen interface copies regular media files, including the Shiki vendor bundle. Media content participates
  in the source fingerprint so image-only changes can trigger a new run.
- Contrast is not measured yet (glass backgrounds make a script unreliable); Flash judges it from the picture.
- Interaction is limited to what a scenario's `setup` does. Click-everything fuzzing and model-written edge-case scenarios
  (data only, never code) are the next steps.
