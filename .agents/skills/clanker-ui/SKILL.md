---
name: clanker-ui
description: Implement or visually verify Clanker Controller's chat panel UI using its existing design rules and browser harness.
---

Work from the Clanker Controller repository root.

- Read `docs/dynamic-island-composer-spec.md` for controls, docks, menus and motion. Reuse the tokens in `ai-chat-panel/media/style.css` and the existing component styles; the established design takes precedence over generic UI recipes.
- Find the relevant scenario in `ai-chat-panel/test/ui-tester/scenarios.mjs`. Run `npm run test:ui -- --only=<scenario> --out=out/ui-review` for the affected interaction. Use `npm.cmd` on Windows. The harness captures headlessly on both platforms and makes no model calls.
- Read `out/ui-review/report.md` first. Read the relevant saved crops or screenshots listed in `report.json` directly with the agent’s image-reading tool. Keep the desktop free of browser windows, report previews and image viewers. Use headed profiling only when the user requests a visible run. Geometry checks do not establish visual quality: inspect spacing, hierarchy, glass layering and motion in the affected states.
- Preserve the baseline while reviewing; `--update` and `--accept` change it. For a new scenario or an intentional redesign, inspect the result before adopting a new baseline.
- Keep reports and pictures on disk and cite their paths. Report measured failures separately from visual observations. See `docs/ui-tester.md` only when deeper harness guidance is needed.

Extension-host changes require an Antigravity reload; the headless browser is an approximation of the IDE webview.
