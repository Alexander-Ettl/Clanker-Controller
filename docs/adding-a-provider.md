# Adding a provider (Cursor, Grok, …)

Clanker drives coding-agent CLIs. Each one is a **descriptor** in `ai-chat-panel/lib/providers/`; the registry
(`lib/providers/index.js`) is the one list the rest of the extension reads. Nothing outside the registry needs to name
`claude`, `codex` or `gemini` for the steps below to work.

## What a descriptor gives you (done, data-driven)

| Area | Reads from the descriptor |
|---|---|
| Finding the binary (`binary-locator.js`) | `locate(helpers)`, `cli` |
| Version, update, "update available" (`cli-tools.js`) | `versionArgs`, `npmPackage` or `latestVersion(fetch)`, `updateArgs` |
| Sign-in and install terminals, connection check (`cli-accounts.js`) | `login`, `install`, `authStatus`, `accountName` |
| Model discovery, the picker and favorites (`cli-tools.js`, `model-catalog.js`) | `discoverModels({ file, runCli })` |
| Names, colours, logos, ring and API-value rows in both webviews | `name`, `company`, `color`, `icon` (a monogram is drawn without one) |
| Settings → General cards, company filter, permission note | all of the above, `headlessApprovals` |
| Scheduler, chat history, Telegram cockpit, `injectPrompt` targets | `has(id)` / `ids()` |

The webviews get `window.PROVIDERS` (no functions) and a generated accent stylesheet from `displayList()` and
`accentCss()`, so a new provider has its colour, name and mark everywhere without a CSS or HTML edit.

## Steps

1. Copy `lib/providers/codex.js` to `lib/providers/<id>.js` and fill the fields. The header comment in `index.js` lists
   every field. `id` is the `agent` value stored on chats and models (lower case, digits, dashes).
2. Add `require('./<id>.js')` to `BUILTIN` in `lib/providers/index.js`. (`register(descriptor)` does the same at run time.)
3. `discoverModels` returns raw entries `{ id, agent, model, effort, label, isDefault }`; the registry's callers
   normalize them. Return `null` when the CLI cannot list models, so a failed refresh keeps the last good list.
4. Optional: `icon` (an SVG string using `currentColor`), `headlessApprovals: false` if it cannot ask for approval headless.
5. Run `node --test test/providers.test.js`; add the provider's parser tests next to it.

`validate()` refuses a bad descriptor with every problem named, and `test/providers.test.js` registers a fake provider
and follows it through the whole list above.

## Not covered yet (the next step)

Tracked as PROVIDER-01 in the [root backlog](../TODO.md); the remaining work below is design context for that task.

These still know the three built-ins by name and need a provider-shaped seam before a new CLI can **run a chat**:

- **The runner (`commandFor` / `normalizeEvent`)**: `lib/stream-engine.js` now delegates command construction (`provider.commandFor(spec)`) and custom JSONL event normalization (`provider.normalizeEvent(raw)`) to the provider descriptor when present. See `ai-chat-panel/lib/providers/copilot.js` (`@github/copilot`, command `copilot -p`) for a working reference descriptor.
- **Usage rings**: `quota-bridge.js`, `claude-usage.js`, `antigravity-quota.js` read each provider's own limits. A provider
  without a reader shows an empty ring (and `optional: true` providers stay hidden from the default rail until connected). Add `quota(…)` to the descriptor when usage polling is needed.
- **API value**: prices are per model in `api-prices.js`; a provider's models are priced once they are added there (or the
  live LiteLLM table lists them). Until then its turns count as "unpriced", not as a guess.
- **Slash commands** (`slash-commands.js`, `codex-commands.js`) and a few `agent === 'claude'` special cases in
  `extension.js`.
