# Gemini, Claude & Codex Usage for Antigravity

A small local VS Code extension that adds three adjacent, right-aligned visual
gauges to Antigravity's native status bar:

- **Gemini** reads live quota (5-hour limit and weekly limit) directly from
  Antigravity's local Language Server Connect-RPC endpoint
  (`RetrieveUserQuotaSummary`).
- **Claude** reads its 5-hour window from `usage-cache.json` and its official
  cached 7-day window from `.claude.json` under `CLAUDE_CONFIG_DIR`. If that
  variable is unset, it uses `~/Nextcloud/ClaudeConfig`.
- **Codex** reads the latest server-reported `token_count.rate_limits`
  snapshot from recent JSONL rollout files under `~/.codex/sessions`.

Each item shows a sleek, compact five-dot slanted gauge (`▰▰▰▱▱`) for the
5-hour remaining percentage with its reset countdown:

```text
Gemini   ▰▰▰▱▱ 60%   ↻ 3h22m
Claude   ▰▰▰▱▱ 58%   ↻ 2h17m
Codex    ▰▰▰▰▰100%   ↻ 4h59m
```

Hover any item to reveal a graphical Markdown dashboard showing:
- 10-step high-resolution visual progress meters (`▰▰▰▰▰▰▱▱▱▱`)
- A clean breakdown table comparing **5-Hour** and **Weekly (7d)** limits
- Exact percentage used, percentage remaining, and time to full refresh
- Model / plan information, quota policies, and connection source details

All sources are polled every five seconds. Missing, expired, or malformed data
shows placeholder values (`--%`); errors are not surfaced as IDE notifications.

## Local installation

Copy this directory to:

```text
C:\Users\user\.antigravity-ide\extensions\local.antigravity-usage-statusbar-0.2.0
```

(or update your existing installed extension folder) then restart Antigravity.

## Test

```powershell
npm test
```

