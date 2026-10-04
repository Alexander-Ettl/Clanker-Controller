# Set up Telegram remote control

Keep Telegram on your phone and the editor on your PC. No server, public URL or Cloudflare tunnel is needed for normal use.

1. Reload the editor window after installing this update. Open **AI Chat Panel → Settings → Telegram Bridge → Configure**, or use the command palette command **AI Chat Panel: Configure Telegram Remote Control**.
2. Choose **Open BotFather**. This opens [Telegram’s official BotFather](https://t.me/BotFather). Tap **Start**, send `/newbot`, and choose a display name and a unique username ending in `bot`, such as `alex_portfolio_remote_bot`. BotFather gives you a bot token.
3. Return to Configure and choose **I have the bot token — continue**. Paste the token into the password field. The editor checks it with Telegram. Paste it only here, never into an AI conversation; the editor saves it in its secret storage.
4. Choose **Open my bot in Telegram**, or copy the pairing link and open it on your phone. Tap **Start** in that bot chat. Return to Configure and choose **Connect — I tapped Start**. The editor finds your chat ID for you.
5. Check that the account shown is yours, then choose **Connect and send test**. You should receive a Telegram message. Send `/status` back to check the connection in both directions.

The bridge accepts commands only from the private account you paired. Connecting enables chat replies, approval requests and questions to be sent to that account. Your PC must remain awake and the editor must stay running; closing the chat panel itself is fine.

## Try it

When connected, the bot docks an ambient, dynamic 3-button context menu at the bottom of your Telegram chat:

```text
┌────────────────────────────────────────────────────────┐
│  📊 Cockpit  │  💬 #Portfolio ▾  │  🤖 Codex ▾         │
└────────────────────────────────────────────────────────┘
```
*(Or in clean-slate mode: `[ 📊 Cockpit ] [ ➕ New Chat ] [ 🤖 Codex ▾ ]`)*

* **Tap `📊 Cockpit`** (or send `/cockpit` / `/status`): Displays your live workstation status, parallelogram quota meters (`▰▰▰▰▰ 91% ⤾ 4h48m`) for Claude, Codex, Gemini, and Opus, active task indicators, and interactive drilldown buttons. Tap `[ 🔄 Refresh ]` on the message to update numbers in-place without generating new messages.
* **Tap `💬 #<Title> ▾` / `➕ New Chat`**: Opens an instant switcher to toggle between **Clean Slate Mode** (`✨ Start Fresh Chat`) or jump to any recent session. Switching target drops a visible **Session Boundary Divider** (`📁 CONNECTED TO: "Portfolio 2026"` or `✨ NEW CHAT SESSION`) and updates the dock button so you always know which project you are messaging.
* **Tap `🤖 Codex ▾`**: Opens an interactive grid to switch your remote default between Codex, Claude Sonnet, Gemini 3.8 Flash, or Claude Opus with one tap, updating the dock button immediately.
* **Just Chat (Zero Slash Commands)**: Send any regular text message from your phone. It auto-routes directly to your active chat session and selected model, queuing cleanly if a turn is already executing.
* **Approvals & Questions**: When an agent running at home needs permission, an approval card arrives with `[ ✅ Approve once ]` and `[ ❌ Reject ]`. When tapped, the card records a timestamped audit trail (`✅ Approved once at 14:32`). When an agent asks questions, options can be answered directly or via reply.
* **Mini App Webview**: If Cloudflare Tunnel is active, the cockpit card includes `[ 📱 Open Liquid Glass Studio ]` for a fullscreen dark frosted mobile cockpit.

## Telegram Supergroup Forum Topics Mode (Physical Thread Isolation)

For power users managing multiple long-running tasks or distinct project branches, the bridge supports Telegram Supergroup Forum Topics. Each workstation chat session lives in its own dedicated Telegram channel topic thread, isolating diffs, tools, and replies.

### Setup Forum Mode

1. In Telegram, create a **New Group** (e.g. `Home Workstation`).
2. Add your bot to the group as an **Administrator** with permissions to:
   - `Manage Topics` (create, rename, close topics)
   - `Send Messages`
   - `Edit Messages`
3. In **Group Info → Edit → Topics**, switch Topics **ON**.
4. In the editor, open **Configure Telegram Remote Control** and set your Chat ID to the group ID (e.g. `-100...`). Alternatively, send `/status` in the group's General topic.

### How Forum Mode Works

* **Topic #1 (General Topic — Master Cockpit)**:
  - Serves as the central command cockpit.
  - Houses the living workstation status, parallelogram quota meters (`▰▰▰▰▰ 91% ⤾ 4h48m`), and active task indicators.
  - Features an inline `[ ➕ New Topic ]` button to provision a fresh project channel instantly.
  - Lists the 5 most recent project topics along with their live execution dots.
* **Topic #N (Project Topics — Dedicated Pair Programming Channels)**:
  - Each topic thread maps 1:1 to a workstation chat session.
  - **Distraction-Free Chatting**: Any message you type inside a project topic auto-routes straight to that specific chat session. No slash commands, no `/use`, no target switching.
  - **Live Dynamic State Badges**: The topic title automatically reflects real-time status:
    - `🟢 <Project Title>`: Workstation turn actively executing.
    - `🟡 <Project Title>`: Waiting for human approval or questionnaire input.
    - `⚪ <Project Title>`: Idle, turn completed and ready for your next prompt.
  - **Thread-Scoped Approvals & Turn Results**: Approval cards (`[ Approve once ]` / `[ Reject ]`) and completion responses are delivered directly inside that project's thread, keeping the master cockpit clean.
* **Slash Commands**:
  - `/new <title>`: Creates a new chat session on your workstation and provisions a linked forum topic thread.
  - `/topics`: Lists all active project topics and their live statuses.

## If nothing arrives

- Make sure you opened the pairing link and tapped **Start** in your new bot, not in BotFather. Pairing waits up to three minutes; Configure offers another attempt if it times out.
- If token verification fails, copy the complete token again from BotFather. A token revoked in BotFather needs replacing through Configure.
- Check the PC’s internet connection and that the editor is running. One bot should connect to one running editor instance. Two instances polling the same bot cause Telegram connection conflicts.
- **Test Ping** sends another message after setup. **Disconnect** stops the local bridge and removes its saved token and chat ID. It does not delete the bot from Telegram.
- Reconnecting clears Telegram’s undelivered updates so an old remote command cannot unexpectedly run later. Approval buttons from a previous connection no longer work; still-pending chat requests are sent again after reconnecting.

## Security & Operational Risks

Before leaving the workstation unattended with remote control enabled, review the full risk assessment in [`telegram-security-and-risks.md`](telegram-security-and-risks.md). Key operational rules:
- **Telegram is not E2EE**: Code diffs, file paths, and terminal outputs are stored unencrypted on Telegram cloud servers. Avoid discussing private keys or secrets.
- **Approval Blindspots**: Approval cards truncate command descriptions longer than 500 characters and display a `[TRUNCATED]` warning. Inspect long commands in the editor before approving.
- **Strict Supergroup Isolation**: Keep your Mission Control Supergroup strictly private with only your personal account and the bot.
- **Zero-Port Mode**: When Cloudflare Tunnel is turned off, the bridge uses outbound HTTPS long-polling with zero open local ports to the internet.

Telegram’s documentation covers [creating bots and pairing links](https://core.telegram.org/bots/features#botfather).

