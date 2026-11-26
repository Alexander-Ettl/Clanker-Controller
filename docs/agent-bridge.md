# Cross-vendor agents (`clanker-agent` and the `clanker-load-agent` skill)

An agent in Claude, Codex, Antigravity or GitHub Copilot can hand a task to a model of **another** vendor and get the answer back as a
file, from any chat, terminal or scheduled run. Built 2026-11-11 after a Claude chat asked a second session to start
"Gemini 4 Argon Medium" and "Codex Sol 6.1 Medium" for a web search. That session reported it had done so, but nothing came
back: the only link between the two was a peer-session message, with no agreed place for the result, no status and no
way to see whether the search was still running or had been blocked.

## What each vendor offers natively

| | Claude Code | Codex | Antigravity (`agy`) |
|---|---|---|---|
| Spawn | `Agent` tool (type, model alias, background), `.claude/agents/*.md`, `--agents`, `claude --bg`; peer sessions through `ListAgents` / `SendMessage` | `multi_agent` feature flag (stable); `agent_message_board` still in development; `codex exec` for a headless run | `invoke_subagent` (async), `/swarm` preview (workers on a shared message board), `--agent`, `agy acp` |
| Models a sub-agent can use | Claude only | OpenAI only | Anything `agy models` lists: Gemini, plus Claude Opus/Sonnet 5.5 and GPT-OSS. Not the Claude CLI's own routes and not Codex's GPT-6.1 |
| Result comes back as | tool result, or a notification for background ones | inside the thread | the sub-agent's own transcript; Clanker follows it (`lib/agy-subagents.js`) |
| Cross-vendor | no | no | partly, through agy's model list |

Every one of these stops at its own vendor's door, and each has its own mechanism. What all three share is a shell. So the
bridge is a shell command with one file layout, not a tool of any vendor.

## How it works

```
agent (any vendor) --shell--> clanker-agent start --to "<model>" ... --> detached worker --> that model's CLI
        |                                                                      |
        +---- clanker-agent wait / status ----> <project>\_work\clanker\<task>\ <+  status.json, result.md
```

- **Launcher.** The extension writes `~/.clanker/clanker-agent.js` (a three-line stub with the real path of
  `lib/clanker-agent.js`, rewritten at every start) and `~/.clanker/agent-bridge.json` (the model picker's list for enabled
  CLIs). A moved checkout fixes itself the next time the IDE starts. Without the extension the command still works from
  `node lib/clanker-agent.js`, with models read from Codex's cache and `agy models`.
- **Names.** `--to "Codex Sol 6.1 Medium"`, `"Gemini 4 Argon Medium"`, an id, or `agent:model`. Every word must match the
  label, id, vendor or company; a name that leaves only the effort open takes medium; the native CLI beats the same model
  reached through agy; anything else is an error that lists the candidates.
- **Recipes.** Not new: `lib/investigation-fixer.js` already knows how to run each CLI unattended. `researchSpec` was added
  next to `readerSpec`/`fixerSpec`: Claude gets `dontAsk` with only WebSearch, WebFetch, Read, Glob and Grep allowed (and
  `--safe-mode`, so the user's chime hooks and CLAUDE.md stay out); Codex runs `exec` in its read-only sandbox with live web
  search; Antigravity runs in plan mode inside its sandbox. Effort is passed as `--effort` (Claude) and
  `model_reasoning_effort` (Codex). Copilot accepts `--to copilot` for the default and `--to "copilot:<model-id>"` for a specific model.
  Its research mode exposes file reads and web tools. `--mode edit` uses `fixerSpec` and enables Copilot's file editing tools in the workspace.
- **One folder per task**, `<cwd>/_work/clanker/<task>/`:

  | File | Holds |
  |---|---|
  | `prompt.md` | What was sent: the rules below plus the caller's task |
  | `status.json` | `state` (queued, running, done, failed, cancelled), `pid`, `startedAt`, `updatedAt` (heartbeat every 5 s), `lastActivityAt`, `partialChars`, `error`, `hint`, `warnings`, `tokens` |
  | `result.partial.md` | The text so far, while it runs |
  | `result.md` | The answer. After a failure, a stop or a vanished worker it begins `> INCOMPLETE: <reason>` and keeps the partial text |
  | `log.jsonl` | The CLI's raw output |

- **Agents button.** A task started from a chat (`CLANKER_CHAT_ID`, set by the extension for every engine) also leaves a
  pointer `~/.clanker/jobs/<chat>/<task>.json` (`{ "dir": ... }`). The chat's agents viewer follows its own `_work/clanker`
  plus these pointers, because `--cwd` can name any folder (a Codex chat once used a research folder outside the project,
  and the robot button never appeared). For Copilot tasks it also follows tool activity from `log.jsonl`. Tasks started before the pointers existed are not listed.
- **Rules sent with every task.** One reply, no questions back; findings, then `Sources`, then `Blocked or not found`; every
  source tagged `[READ]` (original page opened), `[SNIPPET]` (search excerpt only) or `[BLOCKED]` (with the reason).
  An answer with URLs and no tags gets a `warning` in `status.json`.
- **Nothing stays "running" by mistake.** `status`/`wait` check the worker's process: if it is gone (PC restart, closed
  session, a sandbox that kills background processes) the task becomes `failed` with the partial text saved.
- **No notification.** Nothing pushes a message into the calling session; the skill tells the agent to call `wait`
  (up to 540 s per call, exit code 2 = still running) until the files say `done`, then read `result.md`.
- **Sign-in.** A 401 or a limit in the CLI's output becomes `error` plus a `hint` ("sign in to codex"). The pre-send check of
  `CliAccounts` (see the auth gate in the [extension README](../ai-chat-panel/README.md)) is not used here yet.

## The skill

The skill recommends **Gemini 4 Hydrogen High** for bulk searching, scraping and reading (papers, e-books, many sites): start several
agents with different topic prompts and one shared output format, wait for all, and let one stronger agent merge the `result.md` files.
Hydrogen is a reader here, not an editor. Reasons and numbers are in the [loop guide](loops.md#who-does-what).

Clanker bundles `ai-chat-panel/skills/clanker-load-agent/SKILL.md` and adds its directory to `COPILOT_SKILLS_DIRS` for Copilot chats in any project.
`copilot skill list` checks discovery without sending a prompt. Other providers can use the personal copy distributed through ClaudeConfig.
The launcher takes the same `--cwd`, `start`, `wait` and `result` arguments from each provider.

## Checks

`node --test ai-chat-panel/test/clanker-agent.test.js` (name matching, provider recipes, partial text, done/failed/cancel,
the detached worker, a vanished worker, the launcher). The vendor CLIs are never started: `test/clanker-agent-fake.js` stands
in, and `CLANKER_AGENT_SPEC_MODULE` is the test seam that lets the detached worker use it.

## Not verified yet

Tracked as AGENT-01 in the [backlog](../TODO.md). Tests replay Copilot JSONL for skill invocation, tool output, patches, MCP results,
usage and native subagents. The project checks use fixtures in place of model prompts.

- Antigravity `--mode plan` may answer with a plan instead of the findings; Codex `-c web_search="live"` may be a different
  key in this CLI version.
- A Codex agent in its workspace sandbox may not be allowed to start background processes or reach the other CLIs' sign-in
  files. `run` (foreground) is the fallback; the failure is then written to `status.json` rather than lost.
- A finished task does not queue a message into the chat that started it.
