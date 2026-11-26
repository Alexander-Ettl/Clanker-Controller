# Publishing to the Marketplace and Open VSX

This repo ships **Clanker Controller** (`ai-chat-panel/`), **Gemini, Claude & Codex Usage** (`antigravity-usage-statusbar/`) and **Clanker Paper & Ink** (`clanker-theme/`). The repo keeps `"publisher": "local"` so your installed dev junctions keep their extension ID (`local.ai-chat-panel`) and chat storage. `scripts/package-marketplace.mjs` sets the publisher ID in a staging copy.

## One-time setup

1. The `clanker-controller` publisher already has an active policy named **Release workflow** under **Trusted Publishing**. It authorizes `Alexander-Ettl/Clanker-Controller` and `release.yml`, with the environment blank. [Marketplace publisher management](https://marketplace.visualstudio.com/manage) · [Microsoft's Trusted Publishing instructions](https://code.visualstudio.com/api/working-with-extensions/publishing-extension#publish-with-github-actions-and-trusted-publishing)
2. Open VSX uses the `clanker-controller` namespace and the `OVSX_PAT` repository secret under **Settings → Secrets and variables → Actions**. [Open VSX publishing](https://github.com/eclipse/openvsx/wiki/Publishing-Extensions)
3. Keep the GitHub repo public so the Marketplace can display README images hosted on `raw.githubusercontent.com/Alexander-Ettl/Clanker-Controller/main/`.

## Releasing from GitHub

Pushing a tag `v<version>` that matches `ai-chat-panel/package.json` runs `.github/workflows/release.yml`. It checks the code, builds all three packages, publishes them to Open VSX and the VS Code Marketplace, and attaches the `.vsix` files to a GitHub release. GitHub Actions uses the Trusted Publishing policy to authenticate to the Marketplace.

A tag build checks `OVSX_PAT` before packaging. A retry uses the workflow from the original tagged commit, skips already published packages and updates the existing GitHub release assets. Use a new version tag to pick up workflow changes. A manual run on a branch builds and uploads packages for inspection.

## Every release

1. Bump `version` in the manifest of each extension you are shipping.
2. Check that everything is clean: `npm run check`, `npm run typecheck`, `npm test`.
3. To package locally, run this command:

   ```bash
   node scripts/package-marketplace.mjs --publisher <publisher>
   ```

   The `.vsix` files land in `~/dev/clanker-publish/out` on Linux and `C:\Dev\clanker-publish\out` on Windows (`--stage <dir>` changes it; staging inside Nextcloud or OneDrive is refused). Don't pass `--target win32-x64`: Linux is supported, and a platform target hides the extension from Linux users. Only the system-wide dictation hotkey is Windows-only; on Linux a desktop shortcut runs `scripts/linux/clanker-dictate`. `--only chat`, `--only usage` or `--only theme` builds one (`theme` is the Clanker Paper & Ink colour themes in `clanker-theme/`).
4. Look inside before publishing: `cd ~/dev/clanker-publish/ai-chat-panel && npx @vscode/vsce ls --tree`. No `test/`, `.env*`, `types/` or dev `.ps1`/`.sh` scripts should be listed.
5. Push the version tag to publish through GitHub Actions. **Always wait for CI and the `Release` workflow to finish and confirm the release is live before proceeding:**
   - **`CI` (`ci.yml`)** on `main` typically reports in **~1m 10s – 1m 55s** (`ubuntu-latest` ~35–45s, `windows-latest` ~1m 20s – 1m 50s). Wait for it to go green before tagging a new release.
   - **`Release` (`release.yml`)** on tag `v*` typically reports in **~1m 45s – 2m 45s** (allow up to **4m** with runner queue: `check` ~1m 35s + `publish` ~40s). Watch it with `gh run watch` and verify Open VSX, the VS Code Marketplace, and the GitHub Release assets all succeeded before moving on.
   - Note on naming: `antigravity-usage-statusbar` is published under its original ID on Open VSX (`clanker-controller.antigravity-usage-statusbar`), while the VS Code Marketplace build uses `--store marketplace` (`clanker-controller.clanker-usage-statusbar`) because `antigravity-usage-statusbar` is already claimed on the Marketplace.
   - To upload an existing `.vsix` by hand, use the publisher management page. [Visual Studio Marketplace publisher management](https://marketplace.visualstudio.com/manage)

## What the packager changes in the staging copy

- Sets `publisher` and removes `"private": true` (vsce refuses to publish a private package).
- Bundles `voice-router/lib/` into the chat extension. `lib/voice-capture.js` prefers that copy.
- Uses the root `README.md` as the chat extension's page, with relative image and file links rewritten to absolute GitHub URLs. The Marketplace rejects SVG images in a README, so the README uses `docs/images/hero.png` and `cost.png`, rendered by `scripts/render-store-assets.mjs` together with `ai-chat-panel/media/icon.png`.
- Copies `LICENSE` and honours each extension's `.vscodeignore`.

## Chats after the publisher change

Clanker stores session data in `User/globalStorage/clanker-controller-data/session` within the editor's user data. On first start it copies the previous extension's session once, including chats, project icons, attachments and the queue. Start the updated development build once before replacing it to migrate its data before the editor can remove the old extension directory. Remove the dev junction before using the published build because both builds register the same commands and views.

`scripts/router.cjs` and `scripts/handoff-demo.mjs` look for the shared session folder. Set `AI_CHAT_PANEL_SESSION_DIR` to use a custom location.

## Still open

- Windows only: see the README. A per-platform build (`--target`) is the switch.
- The extension activates on `*` (startup). The packager passes `--allow-star-activation`; narrowing the activation events is a separate performance task.
- Personal paths were removed from tests and docs, but **git history still contains them**. Rewriting history means force-pushing and breaking everyone's clones, so it needs a deliberate decision before the repo goes public.
