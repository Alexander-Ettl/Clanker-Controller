# The AI bridge

Visor (`vscode-extension/`) and Clanker Controller (`tools/ai-chat-panel/`) are two independent
extensions. Either works alone. When both are installed, the editor's **Ask AI** button sends its prompts to
Clanker through the bridge described here, and that is the only thing they share.

| | Editor alone | Clanker alone | Both |
|---|---|---|---|
| Ask AI, Hand over batch | prompt copied to the clipboard | n/a | sent to Clanker |
| Editor controls | Activity Bar > Visor | none (Clanker has no editor UI) | same |
| Chats, quotas, scheduler | n/a | full | full |

## Rules

1. **The interface is a set of VS Code commands.** No extension ids, no file paths, no imports, no shared folders.
   Each side may be installed, updated, disabled or replaced without the other noticing.
2. **The caller detects, it does not assume.** It runs `aiChatPanel.bridge.info`; a rejection (no such command),
   an empty result or another `apiVersion` all mean "no provider". Every caller has a fallback (the clipboard).
3. **Capabilities, not extension names.** A caller uses a verb only if the provider lists it in `capabilities`.
   Any chat extension can implement the bridge; Clanker is the one that does today.
4. **Additive versioning.** `apiVersion` changes only when an existing verb changes meaning. A new verb is a new
   capability name under the same version.

## API v1 (provider: Clanker Controller)

| Command | Payload | Returns | Capability |
|---|---|---|---|
| `aiChatPanel.bridge.info` | none | `{ apiVersion: 1, name: string, capabilities: string[] }` | (always) |
| `aiChatPanel.routePrompt` | `{ prompt: string, newChat?: boolean, targetModel?: string }` | `true` when queued | `routePrompt` |
| `aiChatPanel.favoriteModels` | none | `{ id, label, agent }[]` | `favoriteModels` |
| `aiChatPanel.routingMode` | `{ mode?: 'manual' \| 'shadow' \| 'auto' }` | `{ mode, connected: { cloudflare, groq } }` | `routingMode` |
| `aiChatPanel.summarize` | `{ instruction: string, text: string, json?: boolean }` | the answer as a string (rejects when it fails) | `summarize` |
| `aiChatPanel.injectPrompt` | `{ targetModel, prompt, submit? }` | nothing | `injectPrompt` |
| `aiChatPanel.runNextBatchInCleanSession` | `{ targetModel, handoffSummary, batchPrompt }` | nothing | `runBatch` |

- `routePrompt`: the provider picks a model itself (Clanker's Auto router), and the prompt joins that model's
  "Routed prompts" chat, queued behind what is already running. The chat runs without a window.
  Visor's Ask AI sets `newChat: true`: each request creates a separate chat, opens it without taking focus,
  and returns delivery confirmation to the editor. Failed deliveries stay in the editor batch for retry.
  Its selector defaults to Auto and lists the provider's favorites through `favoriteModels`. A selected
  `targetModel` uses that exact favorite, including reasoning effort; a removed favorite rejects delivery.
- `summarize`: one stateless Gemini request (Flash, no tools, empty scratch folder) that returns a JSON object to the
  caller and creates no chat. `text` is quoted data the model never obeys; `instruction` describes the answer. The reply
  is `{ overview, items: [{ page, request, priority, comments }] }`; `json` is ignored. Visor's AI summary of client comments uses it and shows its
  own progress; without the capability it says so instead of falling back to a chat.
- `routingMode`: reads smart routing's mode, or sets it first when `mode` is given. The mode is the provider's own
  (one for all windows); a caller with its own model picker shows the same Manual / Shadow / Auto switch as the chat.
- `injectPrompt`: type the prompt into a specific model's chat and, unless `submit` is false, send it.
- `runBatch`: start a fresh session for one phase of a batch, after the provider's own confirmation.

## Who calls what

Editor side (`vscode-extension/src/aiBridge.ts`), used by `webviewPanel.ts` (the three relays behind Ask AI and the
batch sheet), `batchCollector.ts` (Hand over batch) and `siteSetup.ts` (the adapt prompt):

- `detectAiBridge()` returns the provider's info or `undefined`; `bridgeWith(capability)` also checks the verb.
- `copyInstead(text, what)` is the shared fallback: clipboard plus an honest message.

Provider side (`tools/ai-chat-panel/extension.js`, search `BRIDGE_API_VERSION`): registers the four commands above.

## What each side owns

**Editor:** the dev server, the overlay, the batch file (`<site>/.astro/session/batch-tasks.json`), setting the editor
up in a folder (`astroContentEditor.setup`, `astroContentEditor.copyAdaptPrompt`, `scripts/setup-site.mjs`) and its
control panel (`astroContentEditor.controls`, `src/controlsView.ts`). Its commands (`open`, `togglePreview`,
`handOverBatch`, `setup`, `copyAdaptPrompt`) are its own; nothing outside it needs them. Server startup and recovery
are automatic. The sidebar contains only setup/adaptation, Open editor, and Client reviews; Send batch lives in the editor dock.

**Clanker:** chats, model routing, quotas, the scheduler, Telegram. Its state lives in the extension's own
storage (`lib/session-dir.js`); on the first start after this split it copied `chats/`, `attachments/`, the
scheduler queue and the voice dictionary out of the old `site/.astro/session` once and never looks there again.
Chat attachments from before the copy keep their old paths, so their images no longer preview.
Its voice dictionary is its own file (`lib/voice-dictionary.js`), no longer the editor's.

## Adding to the bridge

Add the verb to the provider, list it in `BRIDGE_CAPABILITIES`, call it from the editor through `bridgeWith(...)`
with a fallback, add a line to the table above, and add a test to `vscode-extension/test/extension.test.js`
(the mock host has no chat extension unless a test provides `aiChatPanel.bridge.info`).
