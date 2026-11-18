# Publishing to the Marketplace and Open VSX

Two extensions ship from this repo: **Clanker Controller** (`ai-chat-panel/`) and **Gemini, Claude & Codex Usage** (`antigravity-usage-statusbar/`). The repo keeps `"publisher": "local"` so your installed dev junctions keep their extension ID (`local.ai-chat-panel`) and chat storage. `scripts/package-marketplace.mjs` builds the real packages from a staging copy under `C:\Dev`, with your publisher ID swapped in.

## One-time setup

1. Create an Azure DevOps organisation and a **Personal Access Token** with scope *Marketplace > Manage* and organisation *All accessible organizations*.
2. Create a publisher at <https://marketplace.visualstudio.com/manage>. Its ID is the value for `--publisher` below.
3. For Open VSX (Antigravity installs from there): sign in at <https://open-vsx.org>, create a token, and run `npx.cmd ovsx create-namespace <publisher> -p <token>` once. The namespace should match the publisher ID.
4. The GitHub repo must be **public**. The README images and links point at `raw.githubusercontent.com/Alexander-Ettl/Clanker-Controller/main/...`, and the Marketplace page shows the repository link. On a private repo the images are broken.

## Every release

1. Bump `version` in the manifest of each extension you are shipping.
2. Check that everything is clean: `npm.cmd run check`, `npm.cmd run typecheck`, `npm.cmd test`.
3. Build both packages:

   ```powershell
   node scripts/package-marketplace.mjs --publisher <publisher>
   ```

   The `.vsix` files land in `C:\Dev\clanker-publish\out`. Add `--target win32-x64` to mark them Windows-only. The code relies on PowerShell and `taskkill`, so that is the honest setting, but it hides the extension from Linux and macOS users. `--only chat` or `--only usage` builds one.
4. Look inside before publishing: `cd C:\Dev\clanker-publish\ai-chat-panel; npx.cmd @vscode/vsce ls --tree`. No `test/`, `.env*`, `types/` or dev `.ps1` scripts should be listed.
5. Publish:

   ```powershell
   npx.cmd @vscode/vsce publish --packagePath C:\Dev\clanker-publish\out\ai-chat-panel-<version>.vsix -p <PAT>
   npx.cmd ovsx publish C:\Dev\clanker-publish\out\antigravity-usage-statusbar-<version>.vsix -p <token>
   ```

   Keep tokens out of the repo and out of shell history where you can (`$env:VSCE_PAT`, `$env:OVSX_PAT`).

## What the packager changes in the staging copy

- Sets `publisher` and removes `"private": true` (vsce refuses to publish a private package).
- Bundles `voice-router/lib/` into the chat extension. `lib/voice-capture.js` prefers that copy.
- Uses the root `README.md` as the chat extension's page, with relative image and file links rewritten to absolute GitHub URLs. The Marketplace rejects SVG images in a README, so the README uses `docs/images/hero.png` and `cost.png`, rendered by `scripts/render-store-assets.mjs` together with `ai-chat-panel/media/icon.png`.
- Copies `LICENSE` and honours each extension's `.vscodeignore`.

## Chats after the publisher change

User storage is tied to the extension ID, so the published `<publisher>.ai-chat-panel` starts with an empty storage folder. On first start it copies the chats, attachments and queue from `local.ai-chat-panel` once (`lib/session-dir.js`, `legacyDirs`). Remove the dev junction before installing the published build; both register the same commands and views.

`scripts/router.cjs` and `scripts/handoff-demo.mjs` still read `local.ai-chat-panel`. Set `AI_CHAT_PANEL_SESSION_DIR` if you use them against the published build.

## Still open

- Windows only: see the README. A per-platform build (`--target`) is the switch.
- The extension activates on `*` (startup). The packager passes `--allow-star-activation`; narrowing the activation events is a separate performance task.
- Personal paths were removed from tests and docs, but **git history still contains them**. Rewriting history means force-pushing and breaking everyone's clones, so it needs a deliberate decision before the repo goes public.
