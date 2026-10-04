# Clanker Controller

This folder is its own Git repository, branch `main`. It owns `ai-chat-panel/`, `voice-router/`, `antigravity-usage-statusbar/`, its scripts, and Clanker documentation. Visor lives in `../Visor`; the website lives in `../Portfolio/2026`. Work and commit in the repository that owns the changed files. Never push unless the user asks, and never commit `.env`, user storage, recordings, dependencies or migration backups.

Use native Windows PowerShell with an explicit working directory, quoted paths, `-LiteralPath`, and `npm.cmd`/`npx.cmd`. Don't introduce WSL or project Codex configuration. Prefer `rg`, focused reads, the existing helpers, and short working diffs. Preserve Liquid Glass styling, responsive motion, and the Dynamic Island rules in `docs/dynamic-island-composer-spec.md`.

Start with `README.md`. Project registration and chat histories belong to the extension's user storage; see `ai-chat-panel/PROJECTS.md` and `ai-chat-panel/lib/projects.js`. A chat currently has one primary project. Its project root must remain explicit across queued turns and scheduling.

Checks from this root: `npm.cmd run check`, `npm.cmd test`, `npm.cmd run verify:models`. `npm.cmd run verify:bridge` also needs the compiled Visor extension; set `VISOR_DIR` if it isn't at `../Visor`. Scope verification to the change and don't send test prompts to real CLIs.

Keep extension IDs, command IDs and settings IDs stable across folder moves. The installed Antigravity extensions are junctions to `ai-chat-panel/` and `antigravity-usage-statusbar/`; reload the IDE after changes to extension-host code.
