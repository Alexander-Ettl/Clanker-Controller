# Chat storage and recovery

Clanker keeps the live store outside the directory Antigravity uses for a particular extension ID. On Windows the independent recovery copy defaults to `%LOCALAPPDATA%\Clanker Controller\recovery`. Each live store gets its own subfolder. Clanker copies existing chats in the background on first launch and backs up normal chat saves as they occur.

Clanker validates signed chat snapshots before opening them. If a snapshot disappears or fails verification, Clanker tries its most recent recovery copy, then the previous copy. The separate store also preserves project registrations and icon paths, saved chat attachments, and stored tool output. Clanker restores missing attachment and tool-output files when opening the recovered chat. Deliberate chat deletion in Manage Chats removes its live and recovery snapshots. Shared asset copies can be retained because other chats or saved versions may reference them.

During streaming, additional backup writes are limited to once per minute per chat. A normal completed save requests a backup immediately. Clanker writes the backup in the background, so recovery can lose changes made since the last successful copy. View backup or restore errors under **Chat Settings → General → Logs**.

Set `AI_CHAT_PANEL_RECOVERY_DIR` before starting the editor to place the recovery store on a different writable local disk. When relocating an existing store, copy its recovery subfolder including `snapshot.key` before launching the editor with the new setting. The setting takes the parent directory, and Clanker uses the same subfolder for the same live store path.

For protection from an agent with Full Access, keep a versioned copy of the recovery directory under a different security principal or on offline media. An agent running under the IDE's Windows account can reach any writable local copies and their signing keys. If both live and recovery copies are lost, restore the recovery directory, including `snapshot.key`, from that external backup before opening the editor. An independent copy on the same disk also shares the risk of disk failure. Keep the recovery directory private because it contains chat content.
