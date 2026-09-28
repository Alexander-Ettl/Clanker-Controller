'use strict';

const http = require('node:http');
const https = require('node:https');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const clip = (text, limit = 3500) => String(text).slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');

function makeDockKeyboard({ chatTitle = null, isNewChat = false, model = 'codex' } = {}) {
  const modelIcons = {
    codex: '🤖 Codex ▾',
    claude: '🧠 Claude ▾',
    gemini: '⚡ Gemini ▾',
    opus: '🎭 Opus ▾'
  };
  const modelText = modelIcons[model?.toLowerCase()] || `🤖 ${String(model || 'CODEX').toUpperCase()} ▾`;

  let chatText = '➕ New Chat';
  if (!isNewChat && chatTitle) {
    const cleanTitle = String(chatTitle)
      .replace(/^[#\s]+/, '')
      .trim()
      .slice(0, 14);
    chatText = `💬 ${cleanTitle || 'Chat'} ▾`;
  }

  return {
    keyboard: [
      [
        { text: '📊 Cockpit' },
        { text: chatText },
        { text: modelText }
      ]
    ],
    resize_keyboard: true,
    is_persistent: true
  };
}

const DOCK_KEYBOARD = makeDockKeyboard({ chatTitle: null, isNewChat: true, model: 'codex' });

const COMMANDS = [
  ['cockpit', 'Live workstation cockpit & quotas'],
  ['status', 'Running chats and quotas'],
  ['active', 'Inspect active task / agent'],
  ['chats', 'List and switch chats'],
  ['models', 'Available models and switcher'],
  ['use', 'Select a chat'],
  ['prompt', 'Send a prompt'],
  ['stop', 'Stop the selected chat'],
  ['queue', 'Scheduled tasks'],
  ['new', 'Create a new project topic'],
  ['topics', 'List all project topics'],
  ['help', 'Commands and examples']
];

const HELP = '🖥️ AI Chat Panel — Mobile Remote Cockpit\n\n' +
  'Tap any button in the dock below, or send a message directly to chat with your active agent:\n\n' +
  '• 📊 Cockpit — Live workstation dashboard, quota meters & status\n' +
  '• 💬 Chats — Recent sessions and quick-select buttons\n' +
  '• ⚡ Active Task — Real-time progress and abort control\n' +
  '• ⚙️ Models — Tap to switch between Claude, Codex, Gemini & Opus\n\n' +
  'Commands:\n' +
  '/cockpit or /status — Workstation cockpit\n' +
  '/chats — List recent chats\n' +
  '/use <id> — Choose a chat\n' +
  '/prompt <model> <msg> — Send prompt\n' +
  '/stop — Stop selected chat\n' +
  '/queue — Scheduled tasks\n' +
  '/cancel <task ID> — Remove scheduled task\n\n' +
  'Example: /prompt codex Explain the latest changes\n\n' +
  'Approval buttons work once for the request shown. Reply directly to questions or tap choices.';

const MINI_APP_HTML = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover">
  <title>Astro Visual Editor — Mobile Cockpit</title>
  <script src="https://telegram.org/js/telegram-web-app.js"></script>
  <style>
    :root {
      --bg: #0d1117;
      --card-bg: rgba(22, 27, 34, 0.85);
      --card-border: rgba(255, 255, 255, 0.1);
      --accent: #58a6ff;
      --text: #e6edf3;
      --muted: #8b949e;
      --success: #3fb950;
      --warning: #d29922;
    }
    body {
      margin: 0;
      padding: 16px;
      background: var(--bg);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, 'SF Pro Display', 'Segoe UI', Roboto, sans-serif;
      -webkit-font-smoothing: antialiased;
      box-sizing: border-box;
    }
    .header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 20px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 10px;
      font-weight: 600;
      font-size: 17px;
    }
    .dot {
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: var(--success);
      box-shadow: 0 0 10px var(--success);
      animation: pulse 2s infinite;
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50% { opacity: 0.5; transform: scale(0.9); }
    }
    .card {
      background: var(--card-bg);
      backdrop-filter: blur(24px);
      -webkit-backdrop-filter: blur(24px);
      border: 1px solid var(--card-border);
      border-radius: 16px;
      padding: 16px;
      margin-bottom: 16px;
    }
    .card-title {
      font-size: 13px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: var(--muted);
      margin-bottom: 12px;
    }
    .meter-row {
      margin-bottom: 12px;
    }
    .meter-label {
      display: flex;
      justify-content: space-between;
      font-size: 14px;
      margin-bottom: 6px;
    }
    .bar-bg {
      height: 6px;
      border-radius: 3px;
      background: rgba(255, 255, 255, 0.1);
      overflow: hidden;
    }
    .bar-fill {
      height: 100%;
      border-radius: 3px;
      background: linear-gradient(90deg, #388bfd, #58a6ff);
    }
    .btn {
      display: block;
      width: 100%;
      box-sizing: border-box;
      padding: 12px;
      border-radius: 12px;
      border: 1px solid var(--card-border);
      background: rgba(255, 255, 255, 0.05);
      color: var(--text);
      font-size: 15px;
      font-weight: 500;
      text-align: center;
      cursor: pointer;
      text-decoration: none;
      margin-top: 8px;
    }
    .btn:active { background: rgba(255, 255, 255, 0.15); }
    .btn.danger { color: #f85149; border-color: rgba(248, 81, 73, 0.3); }
  </style>
</head>
<body>
  <div class="header">
    <div class="brand">
      <div class="dot"></div>
      <span>Workstation Online</span>
    </div>
    <span style="font-size: 13px; color: var(--muted);" id="clock">--:--</span>
  </div>

  <div class="card">
    <div class="card-title">Model Quotas</div>
    <div class="meter-row">
      <div class="meter-label"><span>Claude Sonnet 3.5</span><span>82%</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width: 82%;"></div></div>
    </div>
    <div class="meter-row">
      <div class="meter-label"><span>Codex (GPT-5)</span><span>98%</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width: 98%;"></div></div>
    </div>
    <div class="meter-row">
      <div class="meter-label"><span>Gemini 3.8 Flash</span><span>60%</span></div>
      <div class="bar-bg"><div class="bar-fill" style="width: 60%;"></div></div>
    </div>
  </div>

  <div class="card">
    <div class="card-title">Remote Cockpit</div>
    <p style="font-size: 14px; margin: 0 0 12px 0; color: var(--muted);">Return to your Telegram chat to execute prompts or manage runs with tactile buttons.</p>
    <button class="btn" onclick="window.Telegram?.WebApp?.close()">Close Studio</button>
  </div>

  <script>
    if (window.Telegram?.WebApp) {
      window.Telegram.WebApp.ready();
      window.Telegram.WebApp.expand();
    }
    function updateClock() {
      const d = new Date();
      document.getElementById('clock').textContent = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    }
    updateClock();
    setInterval(updateClock, 1000);
  </script>
</body>
</html>`;

class TelegramBridge {
  constructor({ botToken, chatId, ownerId, webhookPort = 57321, webhookPublicUrl = '', apiBaseUrl = 'https://api.telegram.org' } = {}) {
    this.botToken = String(botToken || '');
    this.chatId = String(chatId || '');
    this.ownerId = String(ownerId || (this.chatId && !this.chatId.startsWith('-') ? this.chatId : ''));
    this.onChatIdChange = null;
    this.isForum = String(this.chatId).startsWith('-100');
    this.webhookPort = webhookPort;
    this.webhookPublicUrl = webhookPublicUrl;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.commands = new Map();
    this.callbackHandlers = new Map();
    this.rawHandler = null;
    this.approvalHandler = null;
    this.server = null;
    this.running = false;
    this.offset = 0;
    this.pollTimer = null;
    this.requests = new Set();
    this.actions = new Map();
    this.questionMessages = new Map();
    this.pastQuestionIds = new Set();
    this.webhookSecret = crypto.randomBytes(24).toString('hex');
    this.lastError = '';
    this.generation = 0;
    this.webhookUpdates = new Set();
    this.webhookChain = Promise.resolve();
    this.onCommand('start', (_args, reply) => reply(HELP, { reply_markup: DOCK_KEYBOARD }));
    this.onCommand('help', (_args, reply) => reply(HELP, { reply_markup: DOCK_KEYBOARD }));
  }

  isConfigured() { return Boolean(this.botToken && this.chatId); }
  setWebhookPublicUrl(url) { this.webhookPublicUrl = String(url || ''); }
  onCommand(command, handler) { this.commands.set(String(command).replace(/^\//, '').toLowerCase(), handler); }
  onCallback(prefix, handler) { this.callbackHandlers.set(String(prefix), handler); }
  onRawMessage(handler) { this.rawHandler = handler; }
  onApproval(handler) { this.approvalHandler = handler; }

  async start() {
    if (!this.isConfigured() || this.running) return;
    const generation = ++this.generation;
    try {
      this.bot = await this.api('getMe', {});
      try {
        const chatInfo = await this.api('getChat', { chat_id: this.chatId });
        this.chatInfo = chatInfo;
        if (chatInfo?.is_forum || chatInfo?.type === 'supergroup') this.isForum = true;
      } catch {}
      if (this.webhookPublicUrl) {
        await this.startWebhookServer();
        await this.api('deleteWebhook', { drop_pending_updates: true }).catch(() => {});
        let registered = false;
        let lastErr = null;
        for (let attempt = 0; attempt < 10; attempt++) {
          if (generation !== this.generation) return;
          try {
            await this.api('setWebhook', {
              url: this.webhookPublicUrl,
              secret_token: this.webhookSecret,
              allowed_updates: ['message', 'callback_query'],
              drop_pending_updates: true
            });
            registered = true;
            break;
          } catch (err) {
            lastErr = err;
            if (/Failed to resolve host|bad webhook|getaddrinfo/i.test(err?.message || '') && attempt < 9) {
              await delay(2500, null, { ref: false });
              continue;
            }
            throw err;
          }
        }
        if (!registered && lastErr) throw lastErr;
      } else await this.api('deleteWebhook', { drop_pending_updates: true });
      await this.api('setMyCommands', { commands: COMMANDS.map(([command, description]) => ({ command, description })), scope: { type: 'chat', chat_id: this.chatId } });
      if (generation !== this.generation) return;
      this.running = true;
      this.offset = 0;
      this.webhookUpdates.clear();
      this.lastError = '';
      if (!this.webhookPublicUrl) void this.poll(generation);
    } catch (error) { await this.stop(); throw error; }
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    for (const request of this.requests) request.destroy(new Error('Telegram request cancelled.'));
    this.actions.clear();
    this.questionMessages.clear();
    this.pastQuestionIds.clear();
    if (this.server) await new Promise((resolve) => { this.server.close(resolve); this.server.closeAllConnections?.(); });
    this.server = null;
  }

  async waitForPairing(code, { signal, timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && !signal?.aborted) {
      const updates = await this.api('getUpdates', { offset: this.offset, timeout: 10, allowed_updates: ['message'] }, { signal });
      for (const update of updates || []) {
        this.offset = Math.max(this.offset, update.update_id + 1);
        const m = update.message;
        if (m?.chat?.type === 'private' && !m.from?.is_bot && String(m.from?.id) === String(m.chat.id) && m.text === `/start ${code}`) return m;
      }
    }
    throw new Error(signal?.aborted ? 'Pairing cancelled.' : 'Pairing timed out. Open the pairing link again and tap Start.');
  }

  async sendMessage(text, options = {}) {
    if (!this.isConfigured()) return false;
    const content = String(text || ' ');
    const generation = this.generation;
    try {
      for (let i = 0; i < content.length;) {
        const part = clip(content.slice(i));
        if (!part) throw new Error('The reply contains invalid Unicode.');
        const isLast = i + part.length >= content.length;
        const payload = {
          chat_id: this.chatId,
          text: part,
          ...(options.message_thread_id ? { message_thread_id: options.message_thread_id } : {}),
          ...(isLast && options.reply_markup ? { reply_markup: options.reply_markup } : {}),
          ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
        };
        try {
          const res = await this.api('sendMessage', payload);
          if (res?.message_id) this.lastMessageId = res.message_id;
        } catch (error) {
          if (!(error.retryAfter > 0 && error.retryAfter <= 30)) throw error;
          await delay(error.retryAfter * 1000, null, { ref: false });
          if (generation !== this.generation) return false;
          const res = await this.api('sendMessage', payload);
          if (res?.message_id) this.lastMessageId = res.message_id;
        }
        i += part.length;
        if (generation !== this.generation) return false;
      }
      return true;
    } catch (error) { this.lastError = error.message; return false; }
  }

  async editMessage(messageId, text, options = {}) {
    if (!this.isConfigured() || !messageId) return false;
    try {
      const payload = {
        chat_id: this.chatId,
        message_id: messageId,
        text: clip(text),
        ...(options.reply_markup ? { reply_markup: options.reply_markup } : {}),
        ...(options.parse_mode ? { parse_mode: options.parse_mode } : {}),
      };
      await this.api('editMessageText', payload);
      return true;
    } catch (error) {
      this.lastError = error.message;
      return false;
    }
  }

  async answerCallback(callbackId, text = '', options = {}) {
    if (!callbackId) return false;
    try {
      await this.api('answerCallbackQuery', {
        callback_query_id: callbackId,
        ...(text ? { text: String(text).slice(0, 180) } : {}),
        ...(options.show_alert ? { show_alert: true } : {})
      });
      return true;
    } catch { return false; }
  }

  async createForumTopic(name, options = {}) {
    if (!this.isConfigured()) return null;
    try {
      const payload = {
        chat_id: this.chatId,
        name: clip(name, 128),
        ...(options.icon_color ? { icon_color: options.icon_color } : {}),
        ...(options.icon_custom_emoji_id ? { icon_custom_emoji_id: options.icon_custom_emoji_id } : {})
      };
      return await this.api('createForumTopic', payload);
    } catch (error) {
      this.lastError = error.message;
      return null;
    }
  }

  async editForumTopic(threadId, options = {}) {
    if (!this.isConfigured() || !threadId) return false;
    try {
      const payload = {
        chat_id: this.chatId,
        message_thread_id: threadId,
        ...(options.name ? { name: clip(options.name, 128) } : {}),
        ...(options.icon_custom_emoji_id ? { icon_custom_emoji_id: options.icon_custom_emoji_id } : {})
      };
      await this.api('editForumTopic', payload);
      return true;
    } catch {
      return false;
    }
  }

  async closeForumTopic(threadId) {
    if (!this.isConfigured() || !threadId) return false;
    try {
      await this.api('closeForumTopic', { chat_id: this.chatId, message_thread_id: threadId });
      return true;
    } catch {
      return false;
    }
  }

  async reopenForumTopic(threadId) {
    if (!this.isConfigured() || !threadId) return false;
    try {
      await this.api('reopenForumTopic', { chat_id: this.chatId, message_thread_id: threadId });
      return true;
    } catch {
      return false;
    }
  }

  async deleteForumTopic(threadId) {
    if (!this.isConfigured() || !threadId) return false;
    try {
      await this.api('deleteForumTopic', { chat_id: this.chatId, message_thread_id: threadId });
      return true;
    } catch {
      return false;
    }
  }

  // Arbitrary agent output can contain incomplete Markdown; send it losslessly as plain text.
  async sendMarkdown(text, options = {}) { return this.sendMessage(text, options); }

  async sendApprovalRequest(description, taskId, respond = this.approvalHandler, isPending = () => true, options = {}) {
    this.pruneActions();
    const id = crypto.randomBytes(12).toString('hex');
    this.actions.set(id, { respond: (approved) => respond?.(taskId, approved), isPending, created: Date.now() });
    try {
      const payload = {
        chat_id: this.chatId,
        text: clip(description || 'Approve this action?'),
        reply_markup: { inline_keyboard: [[{ text: 'Approve once', callback_data: `approve:${id}` }, { text: 'Reject', callback_data: `reject:${id}` }]] },
        ...(options.message_thread_id ? { message_thread_id: options.message_thread_id } : {})
      };
      await this.api('sendMessage', payload);
      return true;
    } catch (error) { this.actions.delete(id); this.lastError = error.message; return false; }
  }

  async sendQuestionRequest(event, respond, isPending = () => true, title = '', options = {}) {
    const questions = event.questions || [];
    if (!questions.length) return this.sendMessage(`${title}\nThis request needs input in the editor.`, options);
    const answers = {};
    for (const [index, question] of questions.entries()) {
      if (!isPending()) break;
      const optLines = (question.options || []).map((o) => `${o.label}${o.description ? `: ${o.description}` : ''}`).join('\n');
      const text = `${title}\nQuestion ${index + 1}/${questions.length}: ${question.question}\n${optLines}\n\nReply to this message with your answer.${question.multiSelect ? ' Separate multiple choices with commas.' : ''}`;
      try {
        const payload = {
          chat_id: this.chatId,
          text: clip(text),
          reply_markup: { force_reply: true, selective: true },
          ...(options.message_thread_id ? { message_thread_id: options.message_thread_id } : {})
        };
        const message = await this.api('sendMessage', payload);
        this.pastQuestionIds.add(message.message_id);
        this.questionMessages.set(message.message_id, {
          created: Date.now(), isPending,
          respond: (answer) => {
            answers[question.question || question.id] = question.multiSelect ? answer.split(',').map((v) => v.trim()).filter(Boolean) : answer;
            return Object.keys(answers).length === questions.length ? respond(answers) : 'Answer saved. Please answer the other question messages too.';
          },
        });
      } catch (error) { this.lastError = error.message; return false; }
    }
    this.pruneActions();
    return true;
  }

  pruneActions() {
    for (const map of [this.actions, this.questionMessages]) {
      for (const [key, value] of map) if (Date.now() - value.created > 86400000 || !value.isPending()) map.delete(key);
      while (map.size > 200) map.delete(map.keys().next().value);
    }
    while (this.pastQuestionIds && this.pastQuestionIds.size > 500) {
      this.pastQuestionIds.delete(this.pastQuestionIds.values().next().value);
    }
  }

  async startWebhookServer() {
    if (this.server) return;
    this.server = http.createServer((request, response) => this.handleWebhook(request, response));
    await new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(this.webhookPort, '127.0.0.1', () => { this.server.off('error', reject); resolve(); });
    });
  }

  handleWebhook(request, response) {
    if (request.method === 'GET' && (request.url === '/app' || request.url === '/app/')) {
      response.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'x-content-type-options': 'nosniff',
        'x-frame-options': 'SAMEORIGIN',
        'content-security-policy': "default-src 'self' 'unsafe-inline' https://telegram.org;",
        'cache-control': 'no-store, no-cache, must-revalidate, private'
      });
      response.end(MINI_APP_HTML);
      return;
    }
    if (request.method === 'GET' || request.method === 'HEAD') {
      response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
      response.end('OK');
      return;
    }
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    if (request.headers['x-telegram-bot-api-secret-token'] !== this.webhookSecret) { response.writeHead(403).end(); return; }
    if (!this.running) { response.writeHead(503).end(); return; }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      let update;
      try { update = JSON.parse(body); } catch { response.writeHead(400).end(); return; }
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      if (!Number.isSafeInteger(update.update_id) || this.webhookUpdates.has(update.update_id)) return;
      this.webhookUpdates.add(update.update_id);
      if (this.webhookUpdates.size > 1000) this.webhookUpdates.delete(this.webhookUpdates.values().next().value);
      const generation = this.generation;
      this.webhookChain = this.webhookChain.then(() => this.running && generation === this.generation && this.handleUpdate(update)).catch((error) => { this.lastError = error.message; });
    });
  }

  async poll(generation = this.generation) {
    if (!this.running || this.webhookPublicUrl || generation !== this.generation) return;
    let delay = 1000;
    try {
      const result = await this.api('getUpdates', { offset: this.offset, timeout: 25, allowed_updates: ['message', 'callback_query'] });
      if (!this.running || generation !== this.generation) return;
      this.lastError = '';
      for (const update of result || []) {
        if (!this.running || generation !== this.generation) break;
        this.offset = Math.max(this.offset, Number(update.update_id || 0) + 1);
        await this.handleUpdate(update);
      }
    } catch (error) { this.lastError = error.message; delay = Math.max(5000, (error.retryAfter || 0) * 1000); }
    if (this.running && !this.webhookPublicUrl && generation === this.generation) this.pollTimer = setTimeout(() => void this.poll(generation), delay);
  }

  async handleUpdate(update) {
    const callback = update?.callback_query;
    const message = callback?.message || update?.message;
    const sender = callback?.from || message?.from;
    if (!sender || !message?.chat) return;
    const chatType = message.chat.type || 'private';
    const isSupergroup = chatType === 'supergroup' || chatType === 'group';
    const isPrivate = chatType === 'private';
    const senderId = String(sender.id);
    const incomingChatId = String(message.chat.id);

    if (!this.ownerId) {
      this.ownerId = senderId;
    }

    const isOwner = Boolean(this.ownerId && senderId === this.ownerId);

    if (incomingChatId !== this.chatId) {
      if (callback) return;
      const text = String(message?.text || '').trim();
      const isActivation = /^\/(?:status|cockpit|start|connect)(?:@\w+)?/i.test(text);
      if (!isActivation) return;

      if (isPrivate && isOwner && senderId === incomingChatId) {
        this.chatId = incomingChatId;
        this.isForum = false;
        if (typeof this.onChatIdChange === 'function') {
          try { void this.onChatIdChange(this.chatId); } catch {}
        }
      } else if (isSupergroup && isOwner) {
        this.chatId = incomingChatId;
        this.isForum = Boolean(message.chat.is_forum || incomingChatId.startsWith('-100'));
        if (typeof this.onChatIdChange === 'function') {
          try { void this.onChatIdChange(this.chatId); } catch {}
        }
        try {
          void this.api('getChat', { chat_id: this.chatId }).then((chatInfo) => {
            if (chatInfo?.is_forum) this.isForum = true;
          }).catch(() => {});
        } catch {}
      } else {
        return;
      }
    } else {
      if (!isOwner) return;
    }
    this.pruneActions();
    if (callback) {
      const data = String(callback.data || '');
      const match = /^(approve|reject):([a-f0-9]{24})$/.exec(data);
      if (match) {
        const action = this.actions.get(match[2]);
        this.actions.delete(match[2]);
        let feedback = 'This request has expired or was already answered.';
        try {
          if (action?.isPending()) feedback = await action.respond(match[1] === 'approve') === false ? feedback : (match[1] === 'approve' ? 'Approved once.' : 'Rejected.');
        } catch { feedback = 'Could not answer. Review this request in the editor.'; }
        await this.api('answerCallbackQuery', { callback_query_id: callback.id, text: feedback }).catch(() => {});
        await this.api('editMessageReplyMarkup', { chat_id: this.chatId, message_id: message.message_id, reply_markup: { inline_keyboard: [] } }).catch(() => {});
        return;
      }

      // Check registered callback handlers
      let handled = false;
      const threadId = message?.message_thread_id || null;
      for (const [prefix, handler] of this.callbackHandlers) {
        if (data === prefix || data.startsWith(prefix + ':')) {
          handled = true;
          try {
            await handler(callback, data, {
              answer: (text, opts) => this.answerCallback(callback.id, text, opts),
              edit: (text, opts) => this.editMessage(message.message_id, text, opts),
              reply: (text, opts) => this.sendMarkdown(text, { ...(threadId ? { message_thread_id: threadId } : {}), ...opts }),
              message,
            });
          } catch (err) {
            await this.answerCallback(callback.id, 'Action failed.');
          }
          break;
        }
      }
      if (!handled) {
        await this.answerCallback(callback.id);
      }
      return;
    }
    const threadId = message?.message_thread_id || null;
    const sendReply = (text, opts = {}) => this.sendMarkdown(text, { ...(threadId ? { message_thread_id: threadId } : {}), ...opts });
    const text = String(message.text || '').trim();
    if (message.reply_to_message && !text.startsWith('/')) {
      const id = message.reply_to_message.message_id;
      const question = this.questionMessages.get(id);
      if (question && text) {
        this.questionMessages.delete(id);
        const result = question.isPending() ? await question.respond(text) : false;
        await sendReply(result === false ? 'This question was already answered or cancelled.' : typeof result === 'string' ? result : 'Answer saved.');
        return;
      }
      if (this.pastQuestionIds && this.pastQuestionIds.has(id)) {
        await sendReply('That question is no longer pending. Use /status to check your chats.');
        return;
      }
    }
    const match = text.match(/^\/([\w-]+)(?:@\w+)?(?:\s+([\s\S]+))?$/);
    const handler = match && this.commands.get(match[1].toLowerCase());
    if (handler) {
      try { await handler((match[2] || '').trim().split(/\s+/).filter(Boolean), sendReply, match[2] || ''); }
      catch (error) { await sendReply(`Could not complete that command: ${this.safeError(error.message)}`); }
      return;
    }

    // Check rawHandler for conversational prompts or dock buttons
    if (this.rawHandler) {
      try {
        await this.rawHandler(text, message, sendReply);
        return;
      } catch (error) {
        await sendReply(`Could not complete that message: ${this.safeError(error.message)}`);
        return;
      }
    }

    await sendReply('Use /help for commands. To send work: /prompt codex <your message>');
  }

  safeError(message) { return String(message || 'Telegram request failed.').split(this.botToken || '\0').join('[token]').slice(0, 300); }

  api(method, payload = {}, { signal } = {}) {
    if (!this.botToken) return Promise.reject(new Error('Telegram bot token is missing.'));
    const endpoint = new URL(`${this.apiBaseUrl}/bot${this.botToken}/${method}`);
    const body = JSON.stringify(payload);
    const transport = endpoint.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const request = transport.request(endpoint, { method: 'POST', signal, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; if (text.length > 4 * 1024 * 1024) request.destroy(new Error('Telegram response is too large.')); });
        response.on('error', (error) => reject(new Error(this.safeError(error.message))));
        response.on('end', () => {
          try {
            const parsed = JSON.parse(text || '{}');
            if (response.statusCode >= 200 && response.statusCode < 300 && parsed.ok === true) resolve(parsed.result);
            else {
              const error = new Error(this.safeError(parsed.description || `Telegram HTTP ${response.statusCode}`));
              error.retryAfter = parsed.parameters?.retry_after;
              reject(error);
            }
          } catch { reject(new Error('Telegram returned an invalid response.')); }
        });
      });
      this.requests.add(request);
      request.once('close', () => this.requests.delete(request));
      request.setTimeout(35000, () => request.destroy(new Error('Telegram timed out. Check your internet connection.')));
      request.once('error', (error) => reject(new Error(this.safeError(error.message))));
      request.write(body);
      request.end();
    });
  }
}

module.exports = { TelegramBridge, HELP, DOCK_KEYBOARD, makeDockKeyboard };
