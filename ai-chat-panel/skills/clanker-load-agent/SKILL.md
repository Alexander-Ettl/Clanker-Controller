---
name: clanker-load-agent
description: Delegate a task to another model through Clanker Controller. Use when the user asks for a second opinion, cross-vendor research or a task delegated to Claude, Codex, Antigravity or GitHub Copilot.
---

Use Clanker's `clanker-agent.js` launcher in `~/.clanker/` (`$HOME/.clanker/` in PowerShell). The editor writes it on activation. Pass the chat's project root explicitly as `--cwd`.

1. Run `node ~/.clanker/clanker-agent.js models` to find the installed providers' available models. For Copilot, use `--to copilot` for the selected default or `--to 'copilot:<model-id>'` for a specific model.
2. Start the job with `node ~/.clanker/clanker-agent.js start --to '<target>' --cwd '<project-root>' --task '<short-name>' --prompt-file '<task-file>'`. Use the default read mode for research and reviews. Add `--mode edit` only if the user asked for changes.
3. Call `node ~/.clanker/clanker-agent.js wait '<short-name>' --cwd '<project-root>' --timeout 45`. If the job is still running, check it again. Read the reported `result.md` when the job finishes, and carry any reported failures or incomplete work into your answer.

Use the permissions granted by the calling session. If it cannot run the launcher, report the blocker and keep any work already completed.
