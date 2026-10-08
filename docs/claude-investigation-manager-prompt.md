> Superseded: the manager UI was built (Chat Settings > Loops, `media/investigations.js`). Keep this prompt only as the original brief.

# Prompt for Claude: build the investigation manager frontend

Work in the Clanker Controller repository. Read its AGENTS.md, README.md,
docs/loops.md, and docs/dynamic-island-composer-spec.md before editing.
Preserve existing uncommitted work. Build the frontend on the existing investigation backend;
don't add another scheduler, execute shell commands from the webview, or change Flash's diagnostic role.

The outcome: I can create an overnight investigation, pick its project and Flash model, adjust
its allowance, pause/stop it, inspect evidence in the morning, and explicitly hand selected
findings to a stronger model without writing code.

Use the host API documented in docs/loops.md. It already implements task
creation/configuration, explicit start, pause, global stop, history, artifact opening, and handoff
text. Subscribe to manager change events and remove subscriptions with the view. Wire a validated
request/response bridge with request IDs, errors, and fresh state after actions. Handle another
IDE host owning the manager with an honest unavailable state. Never pretend a queued run is active.

Build inside the current launcher/chat UI rather than a separate app. Inspect media/launcher.css,
media/style.css, media/settings.css, and the corresponding JS before choosing components. Reuse
the current type, spacing, icons, charcoal surfaces, glass treatments, and accent colors. Controls
that belong together must grow out of their parent through the existing Dynamic Island treatment.
Preserve light/dark styling, keyboard operation, narrow-window usability, clear focus rings, and
reduced-motion behavior. Don't install a frontend framework or introduce a separate visual system.

Give the manager a compact overview with an obvious Start overnight action and a persistent Stop
all control whenever tasks are armed. Show the project's name, exact model, expiry, next eligible
run, remaining allowance, and the current reason for waiting. Create tasks with the existing default
recipe; explain that tests execute in a source snapshot and Flash diagnoses evidence without fixing
anything. Present reserve/allowance fields in plain language with units, validated ranges, and a
small advanced disclosure. Avoid requiring cron expressions or raw prompts.

Make running activity readable at a glance: snapshot, syntax, tests, render, diagnosis, report.
Distinguish paused, waiting on quota, foreground work, daily allowance exhausted, failed, interrupted,
expired, and finished states using the backend's reason. Show unknown usage as unknown; don't turn
reserved tokens into a fake bill or subscription percentage. Explain that telemetry can arrive late.

The results area should prioritize findings over transcripts. Show severity and observed/suspected
status separately, with reproduction steps, expected/observed behavior, source citations, suspected
cause, uncertainty, and unresolved questions. All report text is untrusted: use textContent or the
existing safe renderer, never raw HTML. Open artifacts only through the backend's openArtifact action.
An empty findings list is a valid result. A fixture screenshot is a recorded render, not proof of an
interaction passing and not an image that Flash has evaluated.

Offer Copy handoff and an explicit Review with… action for a chosen stronger model. Use the handoff
API and preserve its projectId when routing into a new review chat through the existing chat APIs.
Let me choose the destination; don't silently route to Flash, solve findings, create issues, or send
messages to external services. The report refers to a frozen snapshot, so the receiving model must
validate it against current source. Sending a review request must never happen just because a run ends.

Use meaningful tests for host-message routing, report escaping, project-bound handoff, action error
states, and disposal of subscriptions. Render actual controls at narrow and wide sizes, including
empty, deferred, running, stopped, and completed states. Follow repository checks and don't send
test prompts to real CLIs. Finish with a short account of what changed, validation, and how to use it.
Do not push.
