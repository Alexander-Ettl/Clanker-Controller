'use strict';

const http = require('node:http');
const https = require('node:https');

class TelegramBridge {
  constructor({ botToken, chatId, webhookPort = 57321, webhookPublicUrl = '', apiBaseUrl = 'https://api.telegram.org' } = {}) {
    this.botToken = String(botToken || '');
    this.chatId = String(chatId || '');
    this.webhookPort = webhookPort;
    this.webhookPublicUrl = webhookPublicUrl;
    this.apiBaseUrl = apiBaseUrl.replace(/\/$/, '');
    this.commands = new Map();
    this.approvalHandler = null;
    this.server = null;
    this.running = false;
    this.offset = 0;
    this.pollTimer = null;
  }

  isConfigured() { return Boolean(this.botToken && this.chatId); }
  setWebhookPublicUrl(url) { this.webhookPublicUrl = String(url || ''); }
  onCommand(command, handler) { this.commands.set(String(command).replace(/^\//, '').toLowerCase(), handler); }
  onApproval(handler) { this.approvalHandler = handler; }

  async start() {
    if (!this.isConfigured() || this.running) return;
    this.running = true;
    if (this.webhookPublicUrl) {
      await this.startWebhookServer();
      await this.api('setWebhook', { url: this.webhookPublicUrl });
    } else {
      void this.poll();
    }
  }

  async stop() {
    this.running = false;
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.pollTimer = null;
    if (this.server) await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  async sendMessage(text) { return this.api('sendMessage', { chat_id: this.chatId, text: String(text) }).then(() => true).catch(() => false); }
  async sendMarkdown(text) { return this.api('sendMessage', { chat_id: this.chatId, text: String(text), parse_mode: 'Markdown' }).then(() => true).catch(() => false); }
  async sendApprovalRequest(description, taskId) {
    return this.api('sendMessage', {
      chat_id: this.chatId,
      text: String(description),
      reply_markup: { inline_keyboard: [[{ text: 'Approve', callback_data: `approve:${taskId}` }, { text: 'Reject', callback_data: `reject:${taskId}` }]] },
    }).then(() => true).catch(() => false);
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
    if (request.method !== 'POST') { response.writeHead(405).end(); return; }
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; if (body.length > 1024 * 1024) request.destroy(); });
    request.on('end', () => {
      response.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}');
      try { void this.handleUpdate(JSON.parse(body)); } catch { /* Telegram retries malformed updates; acknowledge safely. */ }
    });
  }

  async poll() {
    if (!this.running || this.webhookPublicUrl) return;
    try {
      const result = await this.api('getUpdates', { offset: this.offset, timeout: 25 });
      for (const update of result || []) {
        this.offset = Math.max(this.offset, Number(update.update_id || 0) + 1);
        await this.handleUpdate(update);
      }
    } catch { /* transient offline/auth errors are retried without crashing the extension host */ }
    if (this.running && !this.webhookPublicUrl) this.pollTimer = setTimeout(() => void this.poll(), 1000);
  }

  async handleUpdate(update) {
    const message = update?.message;
    const callback = update?.callback_query;
    const sender = message?.from || callback?.from;
    const chat = message?.chat;
    if (!sender || String(sender.id) !== this.chatId || (chat && String(chat.id) !== this.chatId)) return;
    if (callback) {
      const [decision, taskId] = String(callback.data || '').split(':', 2);
      if ((decision === 'approve' || decision === 'reject') && taskId && this.approvalHandler) await this.approvalHandler(taskId, decision === 'approve');
      if (callback.id) void this.api('answerCallbackQuery', { callback_query_id: callback.id }).catch(() => {});
      return;
    }
    const match = String(message.text || '').trim().match(/^\/([\w-]+)(?:@\w+)?(?:\s+(.+))?$/);
    if (!match) return;
    const handler = this.commands.get(match[1].toLowerCase());
    if (handler) await handler((match[2] || '').trim().split(/\s+/).filter(Boolean), (reply) => this.sendMarkdown(reply));
  }

  api(method, payload) {
    if (!this.isConfigured()) return Promise.reject(new Error('Telegram bridge is not configured.'));
    const endpoint = new URL(`${this.apiBaseUrl}/bot${this.botToken}/${method}`);
    const body = JSON.stringify(payload);
    const transport = endpoint.protocol === 'http:' ? http : https;
    return new Promise((resolve, reject) => {
      const request = transport.request(endpoint, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (response) => {
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => {
          try {
            const parsed = JSON.parse(text || '{}');
            if (response.statusCode >= 200 && response.statusCode < 300 && parsed.ok !== false) resolve(parsed.result);
            else reject(new Error(parsed.description || `Telegram HTTP ${response.statusCode}`));
          } catch (error) { reject(error); }
        });
      });
      request.once('error', reject);
      request.write(body);
      request.end();
    });
  }
}

module.exports = { TelegramBridge };
