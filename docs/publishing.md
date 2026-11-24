# Publishing to the Marketplace and Open VSX

Two extensions ship from this repo: **Clanker Controller** (`ai-chat-panel/`) and **Gemini, Claude & Codex Usage** (`antigravity-usage-statusbar/`). The repo keeps `"publisher": "local"` so your installed dev junctions keep their extension ID (`local.ai-chat-panel`) and chat storage. `scripts/package-marketplace.mjs` builds the real packages from a staging copy under `C:\Dev`, with your publisher ID swapped in.

## One-time setup

1. Create an Azure DevOps organisation and a **Personal Access Token** with scope *Marketplace > Manage* and organisation *All accessible organizations*.
2. Create a publisher at <https://marketplace.visualstudio.com/manage>. Its ID is the value for `--publisher` below.
3. For Open VSX (Antigravity installs from there): sign in at <https://open-vsx.org>, create a token, and run `npx ovsx create-namespace <publisher> -p <token>` once. The namespace should match the publisher ID.
4. The GitHub repo must be **public**. The README images and links point at `raw.githubusercontent.com/Alexander-Ettl/Clanker-Controller/main/...`, and the Marketplace page shows the repository link. On a private repo the images are broken.

## Every release

1. Bump `version` in the manifest of each extension you are shipping.
2. Check that everything is clean: `npm run check`, `npm run typecheck`, `npm test`.
3. Build both packages:

   ```bash
   node scripts/package-marketplace.mjs --publisher <publisher>
   ```

   The `.vsix` files land in `~/dev/clanker-publish/out` on Linux and `C:\Dev\clanker-publish\out` on Windows (`--stage <dir>` changes it; staging inside Nextcloud or OneDrive is refused). Don't pass `--target win32-x64`: Linux is supported, and a platform target hides the extension from Linux users. Only the system-wide dictation hotkey is Windows-only; on Linux a desktop shortcut runs `scripts/linux/clanker-dictate`. `--only chat`, `--only usage` or `--only theme` builds one (`theme` is the Clanker Paper & Ink colour themes in `clanker-theme/`).
4. Look inside before publishing: `cd ~/dev/clanker-publish/ai-chat-panel && npx @vscode/vsce ls --tree`. No `test/`, `.env*`, `types/` or dev `.ps1`/`.sh` scripts should be listed.
5. Publish:

   ```bash
   npx @vscode/vsce publish --packagePath ~/dev/clanker-publish/out/ai-chat-panel-<version>.vsix -p <PAT>
   npx ovsx publish ~/dev/clanker-publish/out/antigravity-usage-statusbar-<version>.vsix -p <token>
   ```

   Keep tokens out of the repo and out of shell history where you can (`$VSCE_PAT`, `$OVSX_PAT`; PowerShell: `$env:VSCE_PAT`).

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
