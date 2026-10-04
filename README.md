# Clanker Controller

Independent repository for the chat controller, native voice routing, and CLI usage display.

| Folder | Owns |
|---|---|
| `ai-chat-panel/` | IDE extension, chat UI, project manager, scheduler and CLI runners |
| `voice-router/` | Native capture, transcription, vocabulary and prompt routing |
| `antigravity-usage-statusbar/` | Usage and quota status extension |
| `scripts/` | Browser checks for the chat controller and the Visor bridge |
| `docs/` | Clanker specifications and architecture |

Run `npm.cmd install`, `npm.cmd run check`, and `npm.cmd test` from this folder. Browser checks use Playwright and the installed Edge browser. To install the unpacked extension, run `ai-chat-panel/install-into-antigravity.ps1 -Link`; an existing junction must point to this checkout.

Use the [project guide](ai-chat-panel/PROJECTS.md) to choose the website, Visor, or Clanker as a chat's destination. They have independent Git roots. The current chat model supports one primary project per conversation; several open chats can target different repositories. Project registration doesn't itself grant or restrict filesystem access.

Visor is optional. The bridge smoke check discovers `../Visor` or `VISOR_DIR`. Clanker stores chats, schedules and attachments in per-user extension storage, so moving this source repository doesn't move that history.

Migration recovery files live in `.migration-backup/`, which Git ignores. Visor holds the original Git bundle and working-tree snapshot. No GitHub remote or push is implied by the split.
