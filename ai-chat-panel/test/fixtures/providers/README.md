# Recorded provider output

Real, anonymised output from each CLI for a short turn, replayed through Clanker's stream engine so a changed event shape fails a named test.

```
providers/<provider>/<cli version>/<case>.jsonl           one raw stdout line per line, exactly as the CLI printed it
providers/<provider>/<cli version>/<case>.expected.json   the events the engine emits for it (a golden file)
```

`<provider>` is `claude`, `codex`, `gemini` (Antigravity's `agy`) or `copilot`. Suggested cases per version: `text` (a plain answer), `tool` (a tool call), `error`, `rate-limit`, `signed-out`.

## Recording

You need your own sign-ins and a few real prompts, so this is done by hand and never in CI:

```bash
echo "Say hello in five words." | claude -p --output-format stream-json --verbose | tee raw.jsonl
```

Use the same flags Clanker passes (`ai-chat-panel/lib/stream-engine.js`). Then **redact before saving**: replace your username and home path, project paths, account names, email addresses, organisation and session ids, and any token with placeholders (`/home/user`, `user@example.com`, `session-0001`). Never commit a transcript of a real chat. `test/provider-fixtures.test.js` fails on a fixture that still contains a home path, an email address or something shaped like a token.

Keep the lines in order and unmodified apart from the redaction. Save the file as `<case>.jsonl`, then generate the golden file and read it before committing:

```bash
UPDATE_FIXTURES=1 node --test ai-chat-panel/test/provider-fixtures.test.js
```

A new CLI version adds a folder; old folders stay as regression guards.
