# Routing configuration

Open **Settings → Routing**. Task profiles define task names, matching keywords, excluded keywords, priority (higher wins), and fallback complexity. Assign preferred tasks and excluded tasks to any favorite model. Assignments use the current model IDs; the router does not interpret model names as task rules.

Claude Code, Codex, Antigravity and Copilot manage their own compaction thresholds. The router's **Start a new session at** setting applies to harnesses without active native auto-compaction. Clanker can still create a checkpoint for those harnesses using the context window reported by the CLI or configured for the model.

**Open config** opens the shared `routing-config.json` in Clanker's private session storage. Settings writes this same file. External edits are read on the next routing request or Settings refresh, without a reload. Invalid JSON or invalid values leave the last valid configuration active and show an error in Settings. Credentials stay in SecretStorage.

**Edit with AI** opens an unsent chat draft containing the config path. Add the changes you want, then send it using your selected model. The AI should read the current file, preserve unrelated values, and validate before saving. There is no automatic feedback training or background AI editing.

Example request: “Add a translation profile and assign it to my new favorite model. Give Gemini twice the target task share of the other providers. Keep my confidence threshold.”

## Third-party benchmark table

Every Auto routing request automatically hands Clef (and Groq) an objective, compact benchmark table (`state.benchmarks`) plus per-candidate benchmark summaries alongside remaining quota percentages, built from [model-benchmarks.js](../ai-chat-panel/lib/model-benchmarks.js):

- **Artificial Analysis Intelligence Index v5** (`AA-Intelligence`) and speed tier (`fast` / `medium` / `slow`)
- **Coding Agent / CursorBench / SWE-bench** (`Coding`, 0–100)
- **Terminal-Bench 4.1** (`Terminal-Bench`, %)
- **WebDev Arena (LMArena)** (`WebDev-Arena`, Elo)

Task categories weight the matching benchmark axes (for example, `Coding` + `Terminal-Bench` for backend/debugging/builds, `WebDev-Arena` + `Coding` for visual UI work, `Speed` + `AA-Intelligence` for quick docs/research) while accounting for remaining quota so exhausted or low-quota pools are avoided.

To update scores immediately when a new model drops without waiting for an extension update:
- Drop overrides into `<session>/routing-benchmarks.json` (keyed by model family id, e.g. `"gemini-4-neon": { "intelligence": 61, "coding": 94, "terminal": 65.2, "frontend": 1765, "speed": "fast" }`), or
- Set a free `ARTIFICIAL_ANALYSIS_API_KEY` (cached daily from `https://artificialanalysis.ai/api/v2/language/models`).

## Editable fields

- `models`: keyed by favorite ID. Overrides include `description`, `tasks`, `avoid_tasks`, `context`, `vision`, `complexity` (0–1), `speed`, `costTier`, `enabled`, and `auto_enabled`. Empty `tasks` means no preferred task profile. `avoid_tasks` excludes a model from Auto when that profile matches; manual selection still wins.
- `task_profiles`: keyed by arbitrary IDs. Each profile has `label`, `keywords`, `exclude_keywords`, `priority`, and `complexity`. Matching uses word/phrase boundaries. Several matches resolve by priority. Profiles are advisory context for Clef and explicit preferences for local fallback.
- `fallback_order`: ordered list of `profiles`, `probabilities`, and `capacity`. Unavailable steps are skipped. An explicitly configured eligible `default_model` wins in low-confidence fallback. API failures use the local steps, since probabilities are unavailable. If the list produces no candidate, capacity ranking remains the final safety net.
- `provider_weights`: provider IDs and positive weights. Omitted providers have weight 1. All weights 1 target equal task shares; a weight of 2 targets twice the share. Balancing is among similarly suitable candidates, not forced allocation. Counts include real manual sends, exclude benchmarks, and reset daily UTC. They measure task count, not token usage.
- `policy`: `default_complexity` and `groq_max_complexity` (0?1), `quota_low` (remaining percent), `probability_margin` and `fit_margin` (0–1), `default_context` and `long_context` (tokens), `prompt_chars`, `prompt_head`, `recent_messages`, `recent_chars`, `description_chars`. Input limits bound what is sent to the classifier; original destination attachments are preserved.
- `prompts`: editable `choice`, `complexity`, `vision`, `long_context`, `continuation`, and `groq` instructions. Preserve the requested output format in the Groq prompt. The choice schema and returned candidate IDs remain validated.
- `groq_spill` (0–1, default 0.8): the share of any Groq limit (tokens or requests, a day or a minute) past which Groq's text work (summaries, the Groq routing tier, the Groq destination, dictation cleanup and titles) goes to GPT OSS 120B on Cloudflare Workers AI instead. The same work also moves to Cloudflare whenever Groq refuses or fails, and Groq is skipped for a minute after a 429. Cloudflare chat uses the shared `cloudflare_neurons` budget (about 0.032 Neurons per input token and 0.068 per output token). Calls reserve the maximum output before dispatch and reconcile reported usage afterwards. Dictation and titles share both providers' counters and budget checks. Saved `openrouter` tiers and primary become `cloudflare` on load.

Cloudflare says it does not train on Customer Content or share it with other customers; content may be stored if a storage service is used with Workers AI ([data policy](https://developers.cloudflare.com/workers-ai/platform/data-usage/)). Clanker calls Workers AI directly without a Cloudflare storage service. Use the Workers Free plan for a provider-enforced free cap; Clanker's counters cover calls made here, not other applications using the account.
- Existing confidence, retry, tier order, session thresholds, screenshot, privacy, retention and budget controls remain available. Advanced JSON exposes every supported field. Provider API formats, secret handling, and free-tier safety ceilings remain code constraints.

New installations use generic routing defaults. The one-time migration preserves the existing Opus/build, Sonnet/visual, Sol/backend, and Flash/information preferences as editable assignments; Sol High remains manual-only until changed. Reset clears those model-specific assignments.

## Free-tier rates (verified 2026-10-29)

Clef Flash costs **3,455 input Neurons per million tokens** (previous estimate: 8,182); regular Clef remains 21,818. Neither charges for output tokens. See [Cloudflare pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/). Existing spent counters are retained when rates change; new reservations and reported-token reconciliation use the corrected rate.

Groq GPT-OSS-120B's published free ceiling is **8,000 tokens/minute**, 200,000 tokens/day, 30 requests/minute and 1,000 requests/day ([source](https://console.groq.com/docs/rate-limits)). Saved integer `groq_tpm` values between 8,001 and the formerly accepted 18,000 migrate down to 8,000; lower custom limits stay unchanged. Settings enforce the same ceiling. Cloudflare remains capped locally at 10,000 Neurons/day. Use Workers Free for a provider-enforced zero-spend cap; local estimates cannot track other applications or guarantee zero charges on a paid account. No billing settings are changed by this correction.

The optional recent-chat context classifier ([contract](plans/recent-chat-context-icons.md)) uses Clef Flash with its own 1,000-Neuron daily sub-budget (stops at 8,000 shared) and no paid fallback. It is off until `aiChatPanel.workContextIcons` is set.

## Validate an AI edit

Run this from the Clanker Controller repository, replacing the path with the config path shown in Settings:

```powershell
node -e "const fs=require('fs'); const {config}=require('./ai-chat-panel/lib/routing'); config(JSON.parse(fs.readFileSync(process.argv[1],'utf8'))); console.log('Valid routing config');" 'C:/path/to/routing-config.json'
```

Do not optimize confidence numbers alone. Compare final choices with independent user labels, and separately inspect classifier errors, retries, exclusions, fallback decisions and provider distribution.
