# Linux helpers

| Script | What it does |
|---|---|
| (moved: `ai-chat-panel/lib/clanker-dictate`, published to `~/.clanker/clanker-dictate`) | Starts/stops dictation in the editor window used last. Bind it to a global shortcut (KDE: System Settings > Keyboard > Shortcuts > Add New > Command). |
| `system-check.cjs` | Runs the Linux code paths against your real desktop: notification, image clipboard (Wayland or X11), keep-awake, media pause over MPRIS, tree kill. Pops one toast and leaves a red 8x8 image on the clipboard. |
| `fake-mpris.py` | A fake media player on the session bus, used by `system-check.cjs`. |
| `vscode-run.sh`, `vscode-dictate.sh` | Run VS Code under Xvfb with this checkout loaded and dictate a test tone; screenshots go to `/tmp/shots`. Need `xvfb xdotool imagemagick`. |

The Windows-to-Linux VM harness from the old machine is not needed any more; the VM files are kept in the Nextcloud pre-wipe backup only.
