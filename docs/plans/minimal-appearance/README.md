# Minimal appearance (UI-MIN-01): proposal and static mockups

**Status 2026-11-25:** Halo (B) was picked and is built: `aiChatPanel.appearance = "halo"`, Settings > General > Look,
`ai-chat-panel/media/halo.css` and `halo.js`. Clanker stays the default. Quiet (A) and Ledger (C) remain mockups. Where the
build differs from the mockup: the reply header keeps the agent's name beside the spark; the composer keeps its existing
placeholder; the clock and polish buttons stay hidden until they apply (an armed send time, typed text); usage lives in the
model menu rather than a low-usage chip (not built yet).

Open the mockups with `index.html` in a browser, which shows any variant, theme, state and width side by side.
To regenerate the pictures and measurements, run `node docs/plans/minimal-appearance/render.mjs` from the repo root.
It writes to `~/dev/scratch/minimal-ui/render`, with contact sheets `overview.png`, `overview-light.png` and
`<variant>-states|themes|widths.png`.

## The goal

This adds a second appearance mode, chosen in Settings. It's for people who use one or two AI subscriptions and
want a calm chat, without losing what developers need. It should feel flat and mostly borderless, like ChatGPT or
Gemini, with liquid glass kept to the floating layer (composer and menus). It should have far fewer nested
containers, and tool work stays folded until someone asks to see it.

## Pareto inventory: what the 20% is

The current panel shows 5 rail buttons, 3 usage rings, the Project and Recent stacks, and 7 composer controls. Every
tool call is a card, and diffs and errors are cards inside those cards. Here's where each piece goes in minimal mode:

| Kept in view (used on most turns) | Moved one tap away | Shown only when it matters |
|---|---|---|
| Prompt box, Send/Stop | Pop-out, Queue & schedule, Loops, Project: the **More** (⋯) menu | Usage: only when a plan is low, or in the model menu |
| Attach (+), Dictate | Model list, effort, permissions: the **model menu** | Permissions: a warning chip only when Full Access is on |
| Model picker (shows "Auto") | Steps and tool calls: **one line per turn** that opens | Queue count: a badge on More only when something is queued |
| New chat, Chats (history) | Settings: More menu and `Ctrl ,` | Errors: the folded line turns red and says Failed; one click opens it (as decided in TOOLS-01) |
| Copy and undo on a reply, "N files changed · Review" | | |

The model picker and history stay in view on purpose. Clanker's job is to switch between subscriptions, so the
active model is the one setting a non-technical user still needs to see.

## Three directions

All three use the same conversation, the same states, the same tokens (`shared/base.css`) and the same theme
harness (`shared/mock.js`). They differ in character, not in which controls exist.

| | A · Quiet (`quiet.html`) | B · Halo (`halo.html`) | C · Ledger (`ledger.html`) |
|---|---|---|---|
| Closest to | ChatGPT | Gemini | An editorial or terminal log |
| Prompt | Tinted bubble, right | Tinted bubble with a tail corner, right | No bubble: bold text after an accent `›` |
| Reply | Plain text, model credit under it | Plain text beside a gradient spark | Plain text, indented under the prompt |
| Work steps | Grey "Worked for 48s ›" line opens a thin-railed list | "7 steps · 48s ⌄" pill opens one soft panel | Mono line "sonnet-5.5 · 48s · 7 steps · steps ›" opens a log |
| Model picker | Header, left ("Auto ⌄") | Chip in the composer with the spark | Text button in the composer row |
| Composer | Floating glass card: + · mic · send | Larger glass pill; gradient halo while working | Docked to the edge, text labels, "Send ⏎" and "Stop Esc" |
| Empty chat | Centered "What can I help with?" and 3 chips | Gradient "Hi Alex" greeting and chips above the composer | Project path, one sentence, 3 "→" prompts |
| Settings | Two picture cards and select rows | Rounded cards with segmented pills | A plain document with radio buttons and mono values |
| Risk | Can feel generic, not "Clanker" | Gradient may clash with some themes' accent | Least friendly to non-technical users |

**My recommendation:** A as the base, plus two pieces of B: the working halo on the composer (a clear "busy" signal
that costs no space) and the segmented controls in menus and Settings. C's single-line meta (`model · time · steps`)
is the best folded-steps summary for developers. It could be the label of A's "Worked for" line once a user has opened
steps a few times.

## Settings toggle

- A new setting, `aiChatPanel.appearance` with values `"clanker"` (the default) and `"minimal"`, shown at the top of
  Settings › General as two picture cards. This is a new ID; no existing setting covers it (checked against the 72
  `aiChatPanel.*` settings).
- The minimal-only options sit directly under it: **Work steps** (Folded, While working, Always) and **Usage** (When
  low, Always).
- Settings stays one tap away in the More menu (and `Ctrl ,`), so switching back is two clicks. Switching applies live, with no reload: it's a body class
  (`body.ui-minimal`) plus a different render path for tool groups. Keeping the same DOM avoids two webviews.

## Themes

Each mockup is written only against VS Code's `--vscode-*` variables and body classes, the same ones the webview gets.
They're rendered in Clanker Ink (the theme on this machine), Dark Modern, a custom navy, Light Modern, Solarized Light,
High Contrast Dark and High Contrast Light.

- Surfaces are separated by tints of the foreground over the background (4.5%, 8% and 13%), never by borders.
- High contrast removes tints, glass and shadows and draws the theme's `contrastBorder` on every surface instead.
- Secondary text, diff and warning colours are lifted until they reach 4.5:1 on the most tinted surface
  (`readableInks` in `shared/mock.js`). Without this step, Solarized Light's secondary text measured 3.5:1 and Dark
  Modern's deleted-line red measured 3.6:1. The extension's `media/theme-palette.js` already does the same thing for
  the classic look, so minimal mode would reuse it.

## Measured (render.mjs, 2026-11-25)

There were 111 pictures (3 variants × 7 states in Clanker Ink, plus 4 states × 6 more themes, plus 320 and 900 px).
None had a page error, and none had sideways overflow at 320, 420 or 900 px. The lowest text contrast in any picture
was 4.57:1 (Solarized Light, whose own foreground is only 4.9:1 on its background). Gradient-filled and shimmering
text is skipped by the contrast probe. In high contrast it falls back to plain foreground colour.

## Not covered yet

- Motion is only sketched (the shimmer, the halo spin, the step chevron). The opening of steps and menus would use the
  existing spring and Dynamic Island rules in `docs/dynamic-island-composer-spec.md`.
- Several cases aren't drawn: queue, attachments, image previews, errors, the history list, and the rate-limit notice.
- The real webview fonts and the `backdrop-filter` cost on large transcripts are untested. The headless browser only
  approximates VS Code.

## Implementing the chosen direction (outline)

1. Add the setting and the `ui-minimal` body class, then a `minimal.css` scoped under it, built from these tokens.
2. Group consecutive tool events of a turn into one folded summary (`Worked for 48s`, files changed, failures)
   in `media/main.js`, reusing the existing thought and tool renderers inside the opened list.
3. Hide the rail in minimal mode. Move its actions to the header and More menu, and usage into the model menu, with
   a low-usage chip.
4. Add `ui-tester` scenarios for minimal mode in dark, light and both high-contrast themes at 320, 420 and 900 px.
