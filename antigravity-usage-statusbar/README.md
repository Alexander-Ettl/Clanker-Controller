# Gemini, Claude & Codex Usage for Antigravity IDE

A small local VS Code extension that adds three adjacent, right-aligned visual
gauges to the Antigravity IDE status bar:

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

## Requirements

Windows with Antigravity IDE. Each gauge appears once its source exists: Antigravity's language server for Gemini, a Claude Code sign-in for Claude, and Codex rollout files for Codex. It is part of [Clanker Controller](https://github.com/Alexander-Ettl/Clanker-Controller) and works on its own.

## Installation

Install it from Open VSX (Antigravity IDE) or the Marketplace, then restart the IDE. To run it from source, copy this directory to `%USERPROFILE%\.antigravity-ide\extensions\<publisher>.antigravity-usage-statusbar-<version>`.

## Test

```powershell
npm test
```

## Not affiliated

An independent project, not affiliated with or endorsed by Anthropic, OpenAI or Google. Claude, Codex, Gemini and Antigravity are trademarks of their owners. The extension only reads usage data your own sign-ins already produce.

## License

[MPL-2.0](LICENSE)
