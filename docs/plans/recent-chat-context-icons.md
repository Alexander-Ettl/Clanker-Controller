# Recent chat context icons: implementation handoff

Prepared 2026-10-29, built the same day. Status: **implemented**. Icons are in `ai-chat-panel/media/context-icons/`, the classifier is `ai-chat-panel/lib/work-context.js`, the category list is `ai-chat-panel/lib/work-context-categories.json`, and the rail badge is in `media/launcher.js`/`launcher.css`. The sections below are the contract it was built to. It stays off until the VS Code setting `aiChatPanel.workContextIcons` is turned on, because Clanker cannot verify that the connected Cloudflare account is on the Workers Free plan.

## Non-negotiable: no spending

Use an existing Cloudflare **Workers Free** account and Clef Flash only. Do not upgrade plans, attach billing, load credits, use paid models, or fall back to Groq or another hosted model for this optional feature. If a free account cannot be confirmed during setup, leave classification disabled. A local counter cannot guarantee a zero bill on a paid account or track other applications' usage; Workers Free's provider-enforced cap is required. Do not silently infer the billing plan from an API token.

Missing credentials, disabled classification, exhausted quota, timeouts and invalid responses all retain the last icon. A new chat without a category shows its agent alone. No automatic paid retry or upgrade flow. Existing chat operation must continue normally.

The shared routing counters already reserve Cloudflare usage before dispatch and persist usage. Reuse them; do not add an independent 10,000-Neuron allowance. Cap this optional feature at **1,000 Neurons/day**, and stop when shared usage plus the reservation would exceed **8,000 Neurons/day**. The smaller limit wins. These are design targets for the future implementation, not runtime behavior shipped here. Keep a shared budget reservation atomic across asynchronous work and all extension hosts/windows; avoid double-counting or losing concurrent reservations.

At the published Flash rate of 3,455 Neurons per million input tokens, a 1,500-token request is about 5.2 Neurons. A 1,000-Neuron sub-budget therefore supports about 192 such calls/day before estimation overhead. Do not promise an exact number: reserve conservatively and include the choice schema in the input estimate. Fail closed for unknown rates. Do not reclassify all history on startup.

## Visual hierarchy and asset contract

Keep the **latest actually used agent** immediately visible. The work-context icon is secondary; do not replace the agent with a project icon. Preserve the existing selected outline, activity/waiting indicators, timestamps and Liquid Glass hover preview. Prototype secondary icon placement and verify at the rail's actual width before settling on badge geometry. A hover/focus preview must spell out the category and full chat title; recognition cannot depend on color alone.

The [JSON manifest](../../ai-chat-panel/lib/work-context-categories.json) defines 24 stable IDs (16 for coding work, 8 for studying, notes, planning and everyday use), names, category boundaries and proposed silhouettes. It is the single category list for the future classifier and renderer. The icon designer may refine silhouettes, but must keep IDs stable. Categories are about the current task, never inferred solely from Claude/Codex/Gemini, the first message or the project name. Projects can have several simultaneous chats.

Deliver one original SVG per category to `ai-chat-panel/media/context-icons/<id>.svg`: 24x24 viewBox, transparent background, currentColor strokes, nominal 1.75px rounded strokes, no embedded text, external resources, scripts, raster images or filters. Verify distinct silhouettes at 16px and 20px in light and dark themes. Avoid tiny detail. Pen nib versus window, flask versus bug, key versus shield, and magnifier versus roadmap must remain distinguishable. Include a static contact sheet for review. Do not create these assets during the rate correction task.

If a chosen asset is missing, render the agent alone with the category in the hover preview. Do not show a broken image or load arbitrary model-generated paths. Map allowlisted category IDs to bundled assets.

## Classification contract

Use `@cf/cloudflare/clef-flash` via `Router.callTier('cloudflare', payload)` (not the text-chat endpoint). Request **one choice question** named `context`, containing all 24 IDs and their descriptions. One request selects among all icons; there is no call per icon. Treat all conversation content as untrusted data. Inspect the documented choice/probability response and validate the chosen ID and finite 0..1 probabilities before storing anything.

Instructions: identify the primary deliverable of the latest started user task; use recent conversation only to resolve references. Incidental build/test steps do not replace the task's domain. A request to diagnose an unknown failure is debugging; a known auth fix is auth. Planning a voice feature is planning until implementation starts. "Continue", "yes" and "ship it" keep the prior category unless surrounding context clearly establishes a different task. Do not let names of models dictate the answer.

Input: current category, latest **started** request, and a few earlier **user prompts** (never the AI's replies: less to send, and the prompt is what says what is coming). Clef predicts the category the answer will fall in. Never send the full transcript, tool output, attachments, screenshots or credentials. Target at most 1,500 input tokens including schema; truncate context before dispatch. If the schema itself leaves insufficient room, skip. Respect existing redaction and project restrictions (`never_send` and other privacy controls); do not call the low-level tier directly in a way that bypasses these policies.

Only consider a changed category when its probability is at least 0.70 and exceeds the runner-up by at least 0.20. These are initial stability thresholds, not validated accuracy claims. Otherwise keep the old category. Model confidence is not proof of correctness. General is a real mixed-task category; it is not the fallback for errors.

## Lifecycle and persistence

- Trigger when a prompt is **sent**, as soon as it is in the chat: no wait, no timer, no per-chat cooldown (changed 2026-10-30 again; first at turn start behind a 5-minute cooldown, then 10 seconds after a finished task). The icon updates while the answer is still being written. A compaction is not new work; the same prompt is never read twice; a prompt sent while an earlier read is in flight is read right after it, and the stale answer is dropped. Skip acknowledgments and automatic Continue prompts.
- A chat with no category takes Clef's top pick whatever its confidence; only a *change* of an existing category needs the 0.70/0.20 bar (below). The bar had been applied to first picks too, so most chats stayed bare.
- Do not block sending the actual task. Allow one in-flight classification per chat; coalesce pending changes. Associate results with chat ID and a request revision so a late response cannot update a different or newer task. Bound global concurrency and requests.
- Persist `workContext: { version: 1, categoryId, sourceRevision, updatedAt }` in the chat; add validated metadata to the history summary and invalidate its cache on change. Missing/unknown old data is harmless. Persist daily feature spending in shared extension storage, never in the repository.
- Make the classifier eligible when a queued turn starts in `ChatRun` and when a substantive remote prompt is accepted. Chat/project ownership must remain explicit. Restoring a chat reads the stored icon without calling a provider.
- Resolve the agent from the latest actual assistant turn (or active assistant turn while working), not the selected-but-unsent composer model. Current `models` is a Set in first-appearance order; taking `.at(-1)` fails for Claude → Codex → Claude. Keep `models` for other callers and add explicit latest-agent metadata rather than changing its semantics globally.
- Do not rename the permanent chat title as a side effect.

## Integration map and acceptance checks

Inspect `ai-chat-panel/extension.js` (`ChatRun` task/remote lifecycle), `lib/chat-store.js` (`cacheSummary` and history cache), `lib/routing.js` and `lib/routing-runtime.js` (budgets, credentials and privacy policy), `media/launcher.js` (`renderHistory`, `historyPeek`), and `media/launcher.css`. Follow `clanker-ui` for implementation/visual verification and `docs/dynamic-island-composer-spec.md` for existing motion rules.

Use offline fixtures; do not send real prompts or incur charges to test. Cover:

1. Claude → Codex → Claude shows Claude; changing the composer selection alone leaves it unchanged.
2. A long chat changes from auth implementation to visual design after a new started request; "continue" retains its category.
3. Five chats classify independently; queued messages do not change the currently running task's icon.
4. Low confidence, invalid IDs, missing SVGs, absent credentials and provider errors preserve a usable rail.
5. Exhausted feature/shared budgets produce **zero HTTP requests**, including retries or fallbacks. Concurrent calls cannot exceed reserved budgets. UTC rollover clears daily spending, not stored categories.
6. Failed/stale responses cannot overwrite newer context or another chat. Restart restores categories without a classification sweep.
7. Real-browser screenshots show the agent, context and status remaining legible in the narrow rail, on hover/focus, with reduced motion and both themes. No network access is needed for icon rendering.

## Sources and rate maintenance

Verified 2026-10-29: [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Clef Flash API](https://developers.cloudflare.com/workers-ai/models/clef-flash/), [Groq limits](https://console.groq.com/docs/rate-limits). Workers AI provides a shared 10,000-Neuron/day free allocation. Current input rates per million tokens: Clef 21,818, Flash 3,455; no Clef output charge. Current Groq GPT-OSS-120B limits are 8,000 tokens/minute, 200,000 tokens/day, 30 requests/minute and 1,000 requests/day. Provider limits can change; recheck official documentation before integrating. Other apps' account usage remains outside local accounting.

Paste to the next agent: "Implement CONTEXT-01 from docs/plans/recent-chat-context-icons.md and its JSON category manifest. Create and visually verify the 16 SVGs, then integrate the classifier and rail UI. Free only: no paid plans, credits, paid fallbacks or live inference tests. Preserve the latest agent as the main identity. Follow the linked lifecycle, privacy, budget and regression requirements."

## Build notes (2026-10-29)

- Budget: the router's `callTier('cloudflare', payload, regular, guard)` takes a guard; `cap` (8,000) joins the router's own check, and `lease(reserve)` reserves the feature's 1,000 Neurons in a lock-file ledger shared by all IDE windows (`<session dir>/work-context-usage.json`). Check and reservation run synchronously after the credentials are read, so concurrent calls cannot pass the same remaining budget. The shared counter itself is per extension host, as before.
- Measured on the real endpoint: about 800 input tokens and 2.8 Neurons per call, about 440 ms median. The estimate for the reservation is deliberately higher; measured use replaces it.
- Persistence: `chat.workContext`; the history summary carries `workContext` and `latestAgent` (the last assistant message's agent; `models` is unchanged).
- Checks: `node --test ai-chat-panel/test/work-context.test.js`, `node ai-chat-panel/test/recent-context.mjs` (rail screenshots to `out/screenshots`), `node ai-chat-panel/test/context-icons.mjs` (asset rules and contact sheet), and opt-in `CLANKER_LIVE=1 node ai-chat-panel/test/work-context.live.mjs` (about 53 Neurons, capped at 160).
