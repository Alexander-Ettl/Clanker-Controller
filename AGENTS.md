# Clanker Controller

This folder is its own Git repository, branch `main`. It owns `ai-chat-panel/`, `voice-router/`, `antigravity-usage-statusbar/`, its scripts, and Clanker documentation. Visor lives in `../Visor`; the website lives in `../Portfolio/2026`. Work and commit in the repository that owns the changed files. Never push unless the user asks, and never commit `.env`, user storage, recordings, dependencies or migration backups.

The main machine runs Kubuntu with VS Code (since 2026-11-24). Use bash with an explicit working directory and quoted paths, plus `npm`/`npx`. Windows is still supported and tested: on Windows use PowerShell with `-LiteralPath` and `npm.cmd`/`npx.cmd`. Don't introduce WSL or project Codex configuration. Prefer `rg`, focused reads, the existing helpers, and short working diffs. Preserve Liquid Glass styling, responsive motion, and the Dynamic Island rules in `docs/dynamic-island-composer-spec.md`. New `.sh` files need `chmod +x`; git keeps the bit.

Before merging or enabling auto-merge, check the PR's current draft status, labels, and title. Leave draft PRs and PRs marked **Work in Progress** or **WIP** open until the author marks them ready, even if they have approvals and passing checks.

Start with `README.md`. For remaining work, read the root `TODO.md`; it is the single backlog. Use `docs/README.md` to distinguish current guides, linked proposals and historical material. Don't treat archived checklists as open tasks. Update the backlog when completing or deferring work. Project registration and chat histories belong to the extension's user storage; see `ai-chat-panel/PROJECTS.md` and `ai-chat-panel/lib/projects.js`. A chat currently has one primary project. Its project root must remain explicit across queued turns and scheduling.

Checks from this root: `npm run check`, `npm test`, `npm run verify:models`. `npm run verify:bridge` also needs the compiled Visor extension; set `VISOR_DIR` if it isn't at `../Visor`. Scope verification to the change and don't send test prompts to real CLIs.

Keep extension IDs, command IDs and settings IDs stable across folder moves. The VS Code and Antigravity installs are links to `ai-chat-panel/` and `antigravity-usage-statusbar/` (`node scripts/install-extension.mjs vscode --link`); reload the editor window after changes to extension-host code. A linked install runs from a symlinked path, so locate sibling folders (`voice-router/`, `Visor/`) from `fs.realpathSync(__dirname)`.

Shells launched from another app may inherit a broken `GIT_CONFIG_COUNT` without its `GIT_CONFIG_VALUE_n` entries, which makes every `git` call fail; unset `GIT_CONFIG_COUNT` and the `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` variables, and start VS Code from the desktop launcher.

Never put SDKs, caches, dependencies or build output (`node_modules`, `dist`, `.gradle`, `.tools`, venvs) inside this repo or any other synced Nextcloud/OneDrive folder; use `~/dev` (`C:\Dev` on Windows) and point env vars there. Full rule: `ClaudeConfig/CLAUDE.md`.
