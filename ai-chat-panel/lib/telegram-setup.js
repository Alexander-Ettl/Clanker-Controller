'use strict';

const crypto = require('node:crypto');
const { TelegramBridge } = require('./telegram-bridge.js');

const BOT_FATHER = 'https://t.me/BotFather';
const TOKEN_KEY = 'aiChatPanel.telegramBotToken';
const CHAT_KEY = 'aiChatPanel.telegramChatId';
const OWNER_KEY = 'aiChatPanel.telegramOwnerId';

/** Native editor steps keep credentials out of the webview and retain Configure's existing IPC. */
async function configureTelegram({ vscode, secrets, getCurrent, connect, onRestored = () => {}, createBridge = (options) => new TelegramBridge(options) }) {
  let candidate;
  let previous;
  let connected = false;
  const pick = (step, placeHolder, items) => vscode.window.showQuickPick(items, { title: `Telegram setup (${step}/4)`, placeHolder, ignoreFocusOut: true });
  const open = async (url) => {
    if (!await vscode.env.openExternal(vscode.Uri.parse(url))) await vscode.window.showWarningMessage(`Could not open Telegram. Open this link on your phone or in a browser: ${url}`);
  };
  try {
    while (true) {
      const action = await pick(1, 'Create your own bot with Telegram’s official BotFather. You need a Telegram account.', [
        { label: 'Open BotFather', detail: 'In Telegram, tap Start, send /newbot, then choose a name and a username ending in bot.', id: 'open' },
        { label: 'Copy /newbot', detail: 'Paste this command into your chat with @BotFather.', id: 'copy' },
        { label: 'I have the bot token — continue', detail: 'BotFather sends a token like 123456789:ABC… after creating the bot.', id: 'next' },
      ]);
      if (!action) return false;
      if (action.id === 'next') break;
      if (action.id === 'open') await open(BOT_FATHER);
      if (action.id === 'copy') await vscode.env.clipboard.writeText('/newbot');
    }

    let token = await secrets.get(TOKEN_KEY) || '';
    let bot;
    while (true) {
      token = await vscode.window.showInputBox({ title: 'Telegram setup (2/4): bot token',
        prompt: 'Paste the token from BotFather. It stays in the editor’s encrypted secret storage; never paste it into an AI chat.',
        value: token, password: true, ignoreFocusOut: true,
        validateInput: (value) => /^\d+:[A-Za-z0-9_-]{20,}$/.test(value.trim()) ? null : 'Paste the complete token from BotFather, including the number and colon.',
      });
      if (token === undefined) return false;
      token = token.trim();
      candidate = createBridge({ botToken: token });
      try {
        bot = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Checking the bot token…' }, () => candidate.api('getMe', {}));
        if (!bot?.is_bot || !/^[A-Za-z0-9_]+$/.test(bot.username || '')) throw new Error('This token did not identify a Telegram bot.');
        break;
      } catch (error) {
        await candidate.stop();
        const retry = await vscode.window.showErrorMessage(`Could not verify the bot. ${error.message}`, 'Try again');
        if (!retry) return false;
      }
    }

    const hook = await candidate.api('getWebhookInfo', {});
    if (hook.url && await vscode.window.showWarningMessage('This bot already has a webhook connection. Switching it to this editor stops delivery to that other connection.', { modal: true }, 'Use this editor') !== 'Use this editor') return false;
    previous = getCurrent();
    if (previous) await previous.stop();
    await candidate.api('deleteWebhook', { drop_pending_updates: true });
    const code = crypto.randomBytes(24).toString('hex');
    const link = `https://t.me/${bot.username}?start=${code}`;
    let account;
    while (!account) {
      const action = await pick(3, `Pair @${bot.username}: open the link, tap Start in Telegram, then choose Connect below.`, [
        { label: 'Open my bot in Telegram', detail: link, id: 'open' },
        { label: 'Copy pairing link for my phone', detail: 'Open this link in Telegram on the phone you want to use.', id: 'copy' },
        { label: 'Connect — I tapped Start', detail: 'The editor finds your account automatically. No chat ID is needed.', id: 'connect' },
      ]);
      if (!action) return false;
      if (action.id === 'open') await open(link);
      if (action.id === 'copy') await vscode.env.clipboard.writeText(link);
      if (action.id !== 'connect') continue;
      try {
        account = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Waiting for Start in your Telegram bot…', cancellable: true }, async (_progress, cancellation) => {
          const controller = new AbortController();
          const subscription = cancellation.onCancellationRequested(() => controller.abort());
          if (cancellation.isCancellationRequested) controller.abort();
          try { return await candidate.waitForPairing(code, { signal: controller.signal }); }
          finally { subscription.dispose(); }
        });
      } catch (error) {
        if (await vscode.window.showWarningMessage(error.message, 'Try pairing again') !== 'Try pairing again') return false;
      }
    }
    const identity = [account.from.first_name, account.from.username && `@${account.from.username}`].filter(Boolean).join(' ');
    const confirm = await vscode.window.showInformationMessage(`Telegram setup (4/4): connect ${identity || account.from.id}?`, {
      modal: true,
      detail: 'Only this private Telegram account can control the bridge. It will receive chat replies, approvals and questions, and can send work to your agents. Your PC and editor must stay running. The next step sends you a test message.',
    }, 'Connect and send test');
    if (confirm !== 'Connect and send test') return false;
    candidate.chatId = String(account.chat.id);
    if (!await candidate.sendMessage(`Connected to AI Chat Panel as @${bot.username}.\nThis is your test message. Next, send /help or /status.\nKeep your PC and editor running to use remote control.`)) throw new Error(`The test message could not be delivered. ${candidate.lastError}`);
    await connect(token, candidate.chatId);
    connected = true;
    await vscode.window.showInformationMessage('Telegram is connected. Check your phone for the test message, then send /status.', 'Open my bot').then((choice) => choice && open(`https://t.me/${bot.username}`));
    return true;
  } catch (error) {
    await vscode.window.showErrorMessage(`Telegram setup did not finish: ${error.message}`);
    return false;
  } finally {
    await candidate?.stop();
    if (previous && !connected) {
      try { await previous.start(); onRestored(); }
      catch (error) { await vscode.window.showWarningMessage(`Could not restore the previous Telegram connection: ${error.message}`); }
    }
  }
}

module.exports = { configureTelegram, TOKEN_KEY, CHAT_KEY, OWNER_KEY, BOT_FATHER };
