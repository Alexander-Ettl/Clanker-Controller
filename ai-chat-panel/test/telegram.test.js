'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { TelegramBridge, markdownToTelegramHtml } = require('../lib/telegram-bridge.js');

test('agent Markdown becomes Telegram HTML with everything else escaped', () => {
  assert.equal(
    markdownToTelegramHtml('## Done\n- **fixed** `a<b` in *x* & [docs](https://e.com/?a=1&b=2)\n```js\nif (a < b) {}\n```'),
    '<b>Done</b>\n• <b>fixed</b> <code>a&lt;b</code> in <i>x</i> &amp; <a href="https://e.com/?a=1&amp;b=2">docs</a>\n<pre>if (a &lt; b) {}</pre>',
  );
  assert.equal(markdownToTelegramHtml('<script>'), '&lt;script&gt;');
});
const { forwardRequest, bindTelegramControls } = require('../lib/telegram-control.js');
const { configureTelegram } = require('../lib/telegram-setup.js');
const { ChatStore } = require('../lib/chat-store.js');

function fixture() {
  const bridge = new TelegramBridge({ botToken: '123:fake-secret-token', chatId: '42' });
  const calls = [];
  bridge.api = async (method, payload) => { calls.push({ method, ...payload }); return { message_id: calls.length }; };
  const user = (text, extra = {}) => ({ message: { from: { id: 42 }, chat: { id: 42, type: 'private' }, text, ...extra } });
  const tap = (data, id = 42, chat = 42) => ({ callback_query: { id: 'cb', from: { id }, data, message: { chat: { id: chat, type: chat === 42 ? 'private' : 'group' }, message_id: 1 } } });
  return { bridge, calls, user, tap };
}

test('approval buttons are bounded, scoped, single-use and reject foreign or stale callbacks', async () => {
  const { bridge, calls, tap } = fixture();
  const answered = [];
  const longId = 'chat:turn:' + 'x'.repeat(150);
  await bridge.sendApprovalRequest('Approve?', longId, (id, yes) => { answered.push([id, yes]); return true; });
  const data = calls[0].reply_markup.inline_keyboard[0][0].callback_data;
  assert.ok(Buffer.byteLength(data) <= 64);
  await bridge.handleUpdate(tap(data, 7));
  await bridge.handleUpdate(tap(data, 42, -100));
  assert.equal(answered.length, 0);
  await Promise.all([bridge.handleUpdate(tap(data)), bridge.handleUpdate(tap(data))]);
  assert.deepEqual(answered, [[longId, true]]);
  await bridge.sendApprovalRequest('Already handled', 'same', () => { throw new Error('must not answer'); }, () => false);
  await bridge.handleUpdate(tap(calls.findLast((c) => c.method === 'sendMessage').reply_markup.inline_keyboard[0][0].callback_data));
});

test('identical engine request IDs route to their original chat and cannot approve a later turn', async () => {
  const { bridge, calls, tap } = fixture();
  bridge.running = true;
  const results = [];
  const engine = (name) => ({ approvals: new Map([['1', {}]]), respondToApproval: () => { results.push(name); return true; } });
  const a = engine('a'), b = engine('b');
  const event = { type: 'approval_required', actionId: '1', description: 'Run command?' };
  for (const target of [a, b]) await forwardRequest(bridge, event, { engine: target, title: 'chat', respond: (_id, cb) => cb(target) });
  const buttons = calls.filter((c) => c.method === 'sendMessage').map((c) => c.reply_markup.inline_keyboard[0][0].callback_data);
  a.approvals.set('1', {});
  await bridge.handleUpdate(tap(buttons[0]));
  await bridge.handleUpdate(tap(buttons[1]));
  assert.deepEqual(results, ['b']);
});

test('question replies collect all answers and do not reroute unrelated messages', async () => {
  const { bridge, calls, user } = fixture();
  let result;
  await bridge.sendQuestionRequest({ questions: [{ question: 'Where?', options: [{ label: 'Here' }] }, { question: 'Which?', multiSelect: true }] }, (answers) => { result = answers; return true; });
  await bridge.handleUpdate(user('Here', { reply_to_message: { message_id: 1 } }));
  assert.equal(result, undefined);
  await bridge.handleUpdate(user('A, B', { reply_to_message: { message_id: 2 } }));
  assert.deepEqual(result, { 'Where?': 'Here', 'Which?': ['A', 'B'] });
  await bridge.handleUpdate(user('Changed', { reply_to_message: { message_id: 1, from: { is_bot: true } } }));
  assert.match(calls.at(-1).text, /no longer pending/);
});

test('long replies preserve emoji, code and incomplete Markdown without exceeding Telegram limits', async () => {
  const { bridge, calls } = fixture();
  const text = '```code_with_underscore\n' + '😀'.repeat(5000);
  assert.equal(await bridge.sendMarkdown(text), true);
  assert.equal(calls.map((c) => c.text).join(''), text);
  assert.ok(calls.every((c) => c.text.length <= 3500 && !c.parse_mode && !/[\uD800-\uDBFF]$/.test(c.text)));
});

test('pairing ignores old starts, foreign nonces and group chats', async () => {
  const { bridge } = fixture();
  const msg = (text, type = 'private') => ({ from: { id: 42 }, chat: { id: 42, type }, text });
  bridge.api = async () => [
    { update_id: 1, message: msg('/start') }, { update_id: 2, message: msg('/start wrong') },
    { update_id: 3, message: msg('/start nonce', 'group') }, { update_id: 4, message: msg('/start nonce') },
  ];
  assert.equal((await bridge.waitForPairing('nonce')).chat.id, 42);
  assert.equal(bridge.offset, 5);
  await assert.rejects(bridge.waitForPairing('nonce', { signal: AbortSignal.abort() }), /cancelled/);
  await assert.rejects(bridge.waitForPairing('nonce', { timeoutMs: 0 }), /timed out/);
});

test('polling ignores a response that arrives after stop', async () => {
  const { bridge } = fixture();
  let finish, handled = 0;
  bridge.running = true;
  bridge.api = () => new Promise((resolve) => { finish = resolve; });
  bridge.handleUpdate = async () => { handled += 1; };
  const poll = bridge.poll();
  await bridge.stop();
  finish([{ update_id: 1 }]);
  await poll;
  assert.equal(handled, 0);
  assert.equal(bridge.pollTimer, null);
});

test('startup validates credentials, replaces webhooks, registers commands and reports failures', async () => {
  const { bridge, calls } = fixture();
  bridge.poll = async () => {};
  await bridge.start();
  assert.deepEqual(calls.map((c) => c.method), ['getMe', 'getChat', 'deleteWebhook', 'setMyCommands']);
  assert.equal(bridge.running, true);
  await bridge.stop();
  bridge.api = async () => { throw new Error('Unauthorized'); };
  await assert.rejects(bridge.start(), /Unauthorized/);
  assert.equal(bridge.running, false);
});

test('HTTP API validates tokens without a chat ID, redacts secrets and handles aborts', async (t) => {
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('/getMe')) res.end(JSON.stringify({ ok: true, result: { is_bot: true, username: 'test_bot' } }));
    else if (req.url.endsWith('/bad')) { res.statusCode = 401; res.end(JSON.stringify({ ok: false, description: 'bad 123:secret' })); }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const bridge = new TelegramBridge({ botToken: '123:secret', apiBaseUrl: `http://127.0.0.1:${server.address().port}` });
  assert.equal((await bridge.api('getMe')).username, 'test_bot');
  await assert.rejects(bridge.api('bad'), (error) => error.message === 'bad [token]');
  const controller = new AbortController();
  const pending = bridge.api('wait', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(pending);
});

test('webhooks authenticate, deduplicate retries and retain out-of-order updates', async (t) => {
  const { bridge } = fixture();
  bridge.webhookPort = 0;
  bridge.running = true;
  const ids = [];
  bridge.handleUpdate = async (update) => { ids.push(update.update_id); };
  await bridge.startWebhookServer();
  t.after(() => bridge.stop());
  const send = (id, secret) => fetch(`http://127.0.0.1:${bridge.server.address().port}`, { method: 'POST', headers: { 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify({ update_id: id }) });
  assert.equal((await send(1, 'wrong')).status, 403);
  for (const id of [3, 2, 3]) assert.equal((await send(id, bridge.webhookSecret)).status, 200);
  await bridge.webhookChain;
  assert.deepEqual(ids, [3, 2]);
});

test('remote prompts preserve newlines, pick current models and queue in the selected chat', async () => {
  const { bridge, user, calls } = fixture();
  const queued = [], stopped = [];
  const run = { chat: { id: 'chat-123456' }, turn: {}, enqueue: (m) => queued.push(m), streamEngine: { interrupt: () => stopped.push(true) } };
  const manager = { listChats: () => [{ id: run.chat.id, preview: 'My chat' }], runs: new Map([[run.chat.id, run]]), runFor: () => run };
  bindTelegramControls(bridge, { manager, watchdog: {}, queue: {}, readQuotas: async () => ({}), models: [{ id: 'gpt-current', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {} });
  await bridge.handleUpdate(user('/use chat-123456'));
  await bridge.handleUpdate(user('/prompt codex first line\n  second line'));
  assert.deepEqual(queued, [{ text: 'first line\n  second line', modelId: 'gpt-current' }]);
  assert.match(calls.at(-1).text, /Queued/);
  await bridge.handleUpdate(user('/stop'));
  assert.equal(stopped.length, 1);
});

function wizard({ token, confirm = true, failTest = false } = {}) {
  const picks = [{ id: 'open' }, { id: 'next' }, { id: 'open' }, { id: 'connect' }];
  const opened = [], connected = [], notices = [];
  let stopped = 0, restored = 0;
  const previous = { stop: async () => { stopped++; }, start: async () => { restored++; } };
  const candidate = {
    api: async (method) => method === 'getMe' ? { is_bot: true, username: 'demo_bot' } : {},
    waitForPairing: async (code) => { assert.match(code, /^[a-f0-9]{48}$/); return { from: { id: 42, first_name: 'Owner' }, chat: { id: 42 } }; },
    sendMessage: async () => !failTest, stop: async () => {},
  };
  const vscode = {
    Uri: { parse: (x) => x }, ProgressLocation: { Notification: 1 },
    env: { openExternal: async (url) => { opened.push(url); return true; }, clipboard: { writeText: async () => {} } },
    window: {
      showQuickPick: async () => picks.shift(), showInputBox: async () => token,
      withProgress: async (_options, fn) => fn({}, { onCancellationRequested: () => ({ dispose() {} }) }),
      showInformationMessage: async (_message, options) => options?.modal ? (confirm ? 'Connect and send test' : undefined) : undefined,
      showWarningMessage: async (message) => { notices.push(message); }, showErrorMessage: async (message) => { notices.push(message); },
    },
  };
  return { opened, connected, notices, run: () => configureTelegram({ vscode, secrets: { get: async () => undefined }, getCurrent: () => previous, createBridge: () => candidate, connect: async (...args) => connected.push(args) }), counts: () => ({ stopped, restored }) };
}

test('setup pairs through BotFather and a nonce link before saving a confirmed, tested account', async () => {
  const w = wizard({ token: '123:valid-token' });
  assert.equal(await w.run(), true);
  assert.equal(w.opened[0], 'https://t.me/BotFather');
  assert.match(w.opened[1], /^https:\/\/t.me\/demo_bot\?start=[a-f0-9]{48}$/);
  assert.deepEqual(w.connected, [['123:valid-token', '42']]);
});

test('cancelling token entry does not reconnect or alter the previous account', async () => {
  const w = wizard();
  assert.equal(await w.run(), false);
  assert.deepEqual(w.connected, []);
  assert.deepEqual(w.counts(), { stopped: 0, restored: 0 });
});

test('cancelled identity confirmation and failed delivery restore the previous bridge without saving', async () => {
  for (const options of [{ confirm: false }, { failTest: true }]) {
    const w = wizard({ token: '123:valid-token', ...options });
    assert.equal(await w.run(), false);
    assert.deepEqual(w.connected, []);
    assert.deepEqual(w.counts(), { stopped: 1, restored: 1 });
  }
});

test('conversational text input auto-routes to active chat and selected model without slash command', async () => {
  const { bridge, user, calls } = fixture();
  const queued = [];
  const run = { chat: { id: 'chat-active', title: 'My Work' }, turn: null, enqueue: (m) => queued.push(m) };
  const manager = { listChats: () => [{ id: run.chat.id, preview: 'My Work' }], runs: new Map([[run.chat.id, run]]), runFor: () => run };
  bindTelegramControls(bridge, { manager, watchdog: {}, queue: { getQueue: async () => [] }, readQuotas: async () => ({}), models: [{ id: 'gpt-current', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex', modelId: 'gpt-current' }), notifyQueue() {} });
  
  // Send plain conversational message without slash
  await bridge.handleUpdate(user('Hello from my phone, fix the styling'));
  assert.equal(queued.length, 1);
  assert.equal(queued[0].text, 'Hello from my phone, fix the styling');
  assert.equal(queued[0].modelId, 'gpt-current');
  assert.match(calls.at(-1).text, /Dispatched to workstation/);
});

test('dock buttons render graphical cockpit with unicode quota meters and interactive keyboard', async () => {
  const { bridge, user, calls } = fixture();
  const manager = { listChats: () => [{ id: 'chat-1', preview: 'Header Design' }], runs: new Map() };
  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({ claude: { remaining: 80 }, codex: { remaining: 100 }, gemini: { remaining: 60 } }),
    models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  // Tap Cockpit dock button
  await bridge.handleUpdate(user('📊 Cockpit'));
  const lastCall = calls.at(-1);
  assert.match(lastCall.text, /HOME WORKSTATION COCKPIT/);
  assert.match(lastCall.text, /Claude/);
  assert.match(lastCall.text, /80%/);
  assert.match(lastCall.text, /Codex/);
  assert.match(lastCall.text, /100%/);
  // Verify inline buttons attached
  assert.ok(lastCall.reply_markup?.inline_keyboard?.length >= 3);
});

test('inline callback navigation updates message in-place and switches models', async () => {
  const { bridge, tap, calls } = fixture();
  const manager = { listChats: () => [{ id: 'chat-1', preview: 'Header Design' }], runs: new Map() };
  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  // Tap models nav
  await bridge.handleUpdate(tap('nav:models'));
  const editCall = calls.findLast((c) => c.method === 'editMessageText');
  assert.ok(editCall);
  assert.match(editCall.text, /MODEL SELECTOR/);

  // Switch model to claude
  await bridge.handleUpdate(tap('model:set:claude'));
  const lastEdit = calls.findLast((c) => c.method === 'editMessageText');
  assert.match(lastEdit.text, /CLAUDE/);
});

test('setWebhook retries upon temporary DNS host resolution failure before trycloudflare propagates', async () => {
  const { bridge, calls } = fixture();
  bridge.webhookPublicUrl = 'https://delayed-dns-tunnel.trycloudflare.com';
  bridge.webhookPort = 0;
  let attempts = 0;
  bridge.api = async (method, payload) => {
    calls.push({ method, payload });
    if (method === 'getMe') return { id: 1, is_bot: true, username: 'test_bot' };
    if (method === 'setWebhook') {
      attempts++;
      if (attempts < 2) throw new Error('Bad Request: bad webhook: Failed to resolve host: Name or service not known');
      return true;
    }
    return true;
  };
  await bridge.start();
  assert.equal(attempts, 2);
  assert.equal(bridge.running, true);
  await bridge.stop();
});

test('dynamic dock updates button label with active chat title and model', async () => {
  const { bridge, user, calls } = fixture();
  const run = { chat: { id: 'chat-portfolio', title: 'Portfolio 2026' }, turn: null, enqueue: () => {} };
  const manager = { listChats: () => [{ id: run.chat.id, preview: 'Portfolio 2026' }], runs: new Map([[run.chat.id, run]]), runFor: () => run };
  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  // Tap dynamic chat switcher button
  await bridge.handleUpdate(user('💬 Portfolio ▾'));
  const switcherCall = calls.at(-1);
  assert.match(switcherCall.text, /SELECT CHAT TARGET/);
  assert.ok(switcherCall.reply_markup?.inline_keyboard?.length >= 2);
});

test('switching chat via inline button emits session divider and updates reply keyboard', async () => {
  const { bridge, tap, calls } = fixture();
  const chat1 = { id: 'c-1', preview: 'Astro Studio' };
  const manager = { listChats: () => [chat1], runs: new Map() };
  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  await bridge.handleUpdate(tap('chat:use:c-1'));
  const dividerCall = calls.findLast((c) => c.text && c.text.includes('CONNECTED TO: "Astro Studio"'));
  assert.ok(dividerCall);
  const kb = dividerCall.reply_markup?.keyboard?.[0];
  assert.equal(kb[0].text, '📊 Cockpit');
  assert.match(kb[1].text, /Astro Studio/);
  assert.match(kb[2].text, /Codex/);
});

test('clean-slate new chat mode spawns fresh session on next conversational prompt', async () => {
  const { bridge, tap, user, calls } = fixture();
  let created = 0;
  const newRun = { chat: { id: 'c-fresh', title: 'Brand New' }, turn: null, enqueue: () => {} };
  const manager = {
    listChats: () => [],
    runs: new Map(),
    runFor: (id) => {
      if (id === null) { created++; return newRun; }
      return null;
    }
  };
  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  // Tap start fresh chat
  await bridge.handleUpdate(tap('chat:new'));
  const dividerCall = calls.findLast((c) => c.text && c.text.includes('NEW CHAT SESSION (Clean Slate)'));
  assert.ok(dividerCall);
  const kb = dividerCall.reply_markup?.keyboard?.[0];
  assert.equal(kb[1].text, '➕ New Chat');

  // Send prompt
  await bridge.handleUpdate(user('Build a contact form'));
  assert.equal(created, 1);
  assert.match(calls.at(-1).text, /Dispatched to workstation/);
});

test('supergroup topic messages auto-route to mapped chat session and update topic title to 🟢', async () => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '-1009999999' });
  bridge.isForum = true;
  const calls = [];
  bridge.api = async (method, payload) => {
    calls.push({ method, ...payload });
    return { ok: true, message_id: calls.length };
  };

  const enqueued = [];
  const run1 = {
    chat: { id: 'c-topic-1', title: 'Header Redesign', telegramTopicId: 101 },
    turn: null,
    enqueue: (msg) => enqueued.push(msg)
  };
  const manager = {
    listChats: () => [run1.chat],
    runs: new Map([['c-topic-1', run1]]),
    runFor: (id) => (id === 'c-topic-1' ? run1 : null),
    deps: { chatStore: { save: (c) => c } }
  };

  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex', modelId: 'codex' }), notifyQueue() {}
  });

  const topicMsg = {
    message: {
      message_id: 1,
      from: { id: 42 },
      chat: { id: -1009999999, type: 'supergroup' },
      message_thread_id: 101,
      text: 'Make the logo clickable'
    }
  };

  await bridge.handleUpdate(topicMsg);

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].text, 'Make the logo clickable');

  const editCall = calls.find((c) => c.method === 'editForumTopic');
  assert.ok(editCall);
  assert.equal(editCall.message_thread_id, 101);
  assert.match(editCall.name, /🟢 Header Redesign/);

  const replyCall = calls.findLast((c) => c.method === 'sendMessage');
  assert.equal(replyCall.message_thread_id, 101);
  assert.match(replyCall.text, /Executing turn/);
});

test('forum topic resumes its saved chat after restart and ignores the same topic ID in another group', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'telegram-topic-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new ChatStore(dir);
  for (const [id, group] of [['wrong-group', '-100111'], ['right-group', '-100222']]) {
    store.save({ id, title: id, telegramTopicId: 36, telegramChatId: group, messages: [] });
  }
  store.save({ id: 'legacy-chat', title: 'Legacy', telegramTopicId: 37, messages: [] });

  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '-100222', ownerId: '42' });
  bridge.isForum = true;
  bridge.api = async () => ({ message_id: 1 });
  const enqueued = [];
  let created = 0;
  const manager = {
    listChats: () => store.list(),
    runs: new Map(),
    runFor: (id) => {
      if (!id) { created++; return null; }
      const chat = store.load(id);
      return chat && { chat, enqueue: (message) => enqueued.push([id, message]) };
    },
    deps: { chatStore: store }
  };
  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }],
    resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  await bridge.handleUpdate({ message: {
    message_id: 7, message_thread_id: 36, from: { id: 42 },
    chat: { id: -100222, type: 'supergroup' }, text: 'Continue this work'
  } });
  assert.equal(created, 0);
  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0][0], 'right-group');
  assert.equal(enqueued[0][1].text, 'Continue this work');

  await bridge.handleUpdate({ message: {
    message_id: 8, message_thread_id: 37, from: { id: 42 },
    chat: { id: -100222, type: 'supergroup' }, text: 'Continue old topic'
  } });
  assert.equal(created, 0);
  assert.equal(enqueued[1][0], 'legacy-chat');
});

test('/new creates workstation chat and provisions forum topic via createForumTopic', async () => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '-1009999999' });
  bridge.isForum = true;
  const calls = [];
  bridge.api = async (method, payload) => {
    calls.push({ method, ...payload });
    if (method === 'createForumTopic') return { message_thread_id: 202, name: payload.name };
    return { ok: true, message_id: calls.length };
  };

  let createdRun = null;
  const manager = {
    listChats: () => [],
    runs: new Map(),
    runFor: (id) => {
      if (id === null) {
        createdRun = { chat: { id: 'c-new', title: '' }, turn: null, enqueue: () => {} };
        return createdRun;
      }
      return null;
    },
    deps: { chatStore: { save: (c) => c } }
  };

  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  const cmdMsg = {
    message: {
      message_id: 2,
      from: { id: 42 },
      chat: { id: -1009999999, type: 'supergroup' },
      text: '/new Portfolio V2'
    }
  };

  await bridge.handleUpdate(cmdMsg);

  assert.ok(createdRun);
  assert.equal(createdRun.chat.title, 'Portfolio V2');
  assert.equal(createdRun.chat.telegramTopicId, 202);

  const topicCall = calls.find((c) => c.method === 'createForumTopic');
  assert.ok(topicCall);
  assert.match(topicCall.name, /Portfolio V2/);

  const introCall = calls.find((c) => c.method === 'sendMessage' && c.message_thread_id === 202);
  assert.ok(introCall);
  assert.match(introCall.text, /PORTFOLIO V2/);
});

test('forwardRequest dispatches approval directly into project topic thread and renames topic to 🟡', async () => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '-1009999999' });
  bridge.isForum = true;
  bridge.running = true;
  const calls = [];
  bridge.api = async (method, payload) => {
    calls.push({ method, ...payload });
    return { ok: true, message_id: calls.length };
  };

  const engine = {
    approvals: new Map([['act-1', {}]]),
    respondToApproval: () => true
  };
  const event = {
    type: 'approval_required',
    actionId: 'act-1',
    agent: 'codex',
    description: 'npm install lodash'
  };

  await forwardRequest(bridge, event, {
    engine,
    title: 'Landing Page',
    threadId: 303,
    respond: (_id, cb) => cb(engine)
  });

  const editCall = calls.find((c) => c.method === 'editForumTopic');
  assert.ok(editCall);
  assert.equal(editCall.message_thread_id, 303);
  assert.match(editCall.name, /🟡 Landing Page/);

  const sendCall = calls.find((c) => c.method === 'sendMessage');
  assert.ok(sendCall);
  assert.equal(sendCall.message_thread_id, 303);
  assert.match(sendCall.text, /needs approval/);
  assert.equal(sendCall.parse_mode, 'HTML');
});

test('/status from owner in supergroup dynamically adopts supergroup and updates target chat', async () => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '42', ownerId: '42' });
  bridge.running = true;
  const calls = [];
  let adoptedChatId = null;
  bridge.onChatIdChange = (id) => { adoptedChatId = id; };
  bridge.api = async (method, payload) => {
    calls.push({ method, ...payload });
    if (method === 'getChat') return { id: payload.chat_id, type: 'supergroup', is_forum: true };
    return { ok: true, message_id: calls.length };
  };

  bindTelegramControls(bridge, {
    manager: { listChats: () => [], runs: new Map(), deps: {} },
    watchdog: {},
    queue: { getQueue: async () => [] },
    readQuotas: async () => ({}),
    models: [{ id: 'codex', agent: 'codex' }],
    resolveTarget: () => ({ agentId: 'codex' }),
    notifyQueue() {}
  });

  // 1. Stranger in supergroup sends /status -> ignored
  await bridge.handleUpdate({
    message: {
      message_id: 1,
      from: { id: 999 },
      chat: { id: -1008888888, type: 'supergroup' },
      text: '/status'
    }
  });
  assert.equal(bridge.chatId, '42');
  assert.equal(calls.length, 0);

  // 2. Verified owner sends /status in supergroup -> auto-adopts
  await bridge.handleUpdate({
    message: {
      message_id: 2,
      from: { id: 42 },
      chat: { id: -1008888888, type: 'supergroup' },
      text: '/status'
    }
  });

  assert.equal(bridge.chatId, '-1008888888');
  assert.equal(bridge.isForum, true);
  assert.equal(adoptedChatId, '-1008888888');

  // Verify cockpit reply was sent to the new supergroup
  const cockpitCall = calls.find((c) => c.method === 'sendMessage' && c.chat_id === '-1008888888');
  assert.ok(cockpitCall);
  assert.match(cockpitCall.text, /HOME WORKSTATION COCKPIT/);
});

test('replies to bot topic welcome messages or slash commands are not rejected as expired questions', async () => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '-1008888888', ownerId: '42' });
  bridge.isForum = true;
  bridge.running = true;
  const calls = [];
  bridge.api = async (method, payload) => {
    calls.push({ method, ...payload });
    return { ok: true, message_id: calls.length };
  };

  let enqueued = null;
  const manager = {
    listChats: () => [],
    runs: new Map(),
    runFor: () => ({
      chat: { id: 'c-36', title: 'Project 36', telegramTopicId: 36 },
      turn: null,
      enqueue: (msg) => { enqueued = msg; }
    }),
    deps: { chatStore: { save: (c) => c } }
  };

  bindTelegramControls(bridge, {
    manager,
    watchdog: {},
    queue: { getQueue: async () => [] },
    readQuotas: async () => ({}),
    models: [{ id: 'codex', agent: 'codex' }],
    resolveTarget: () => ({ agentId: 'codex' }),
    notifyQueue() {}
  });

  // Message in topic 36 that replies to the bot's topic intro message (message_id: 100, is_bot: true)
  await bridge.handleUpdate({
    message: {
      message_id: 101,
      message_thread_id: 36,
      from: { id: 42 },
      chat: { id: -1008888888, type: 'supergroup' },
      reply_to_message: { message_id: 100, from: { is_bot: true } },
      text: '/antigravity-code-review'
    }
  });

  // Must not have sent "That question is no longer pending"
  assert.ok(!calls.some((c) => /no longer pending/i.test(c.text)));
  // Must have enqueued prompt in the topic chat
  assert.ok(enqueued);
  assert.equal(enqueued.text, '/antigravity-code-review');

  // Also sending /status as a reply to bot must render cockpit
  await bridge.handleUpdate({
    message: {
      message_id: 102,
      message_thread_id: 36,
      from: { id: 42 },
      chat: { id: -1008888888, type: 'supergroup' },
      reply_to_message: { message_id: 100, from: { is_bot: true } },
      text: '/status'
    }
  });
  const cockpitCall = calls.find((c) => /HOME WORKSTATION COCKPIT/i.test(c.text));
  assert.ok(cockpitCall);
});

test('unauthenticated or non-owner sender in group or private is strictly dropped when ownerId is configured', async () => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '-1008888888', ownerId: '42' });
  bridge.isForum = true;
  bridge.running = true;
  const enqueued = [];
  const run = { chat: { id: 'chat-1', telegramTopicId: 10 }, turn: null, enqueue: (msg) => enqueued.push(msg) };
  const manager = { listChats: () => [run.chat], runs: new Map([[run.chat.id, run]]), runFor: () => run };
  bindTelegramControls(bridge, {
    manager, watchdog: {}, queue: { getQueue: async () => [] },
    readQuotas: async () => ({}), models: [{ id: 'codex', agent: 'codex' }], resolveTarget: () => ({ agentId: 'codex' }), notifyQueue() {}
  });

  // Message from non-owner (user ID 999 instead of 42)
  await bridge.handleUpdate({
    message: {
      message_id: 201,
      message_thread_id: 10,
      from: { id: 999 },
      chat: { id: -1008888888, type: 'supergroup' },
      text: 'rm -rf /'
    }
  });

  // Non-owner message must not be enqueued
  assert.equal(enqueued.length, 0);

  // Message from verified owner (user ID 42)
  await bridge.handleUpdate({
    message: {
      message_id: 202,
      message_thread_id: 10,
      from: { id: 42 },
      chat: { id: -1008888888, type: 'supergroup' },
      text: 'Check project status'
    }
  });

  assert.equal(enqueued.length, 1);
  assert.equal(enqueued[0].text, 'Check project status');
});

test('forwardRequest appends explicit truncation warning when command exceeds 500 characters', async () => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '42', ownerId: '42' });
  bridge.running = true;
  const calls = [];
  bridge.api = async (method, payload) => {
    calls.push({ method, ...payload });
    return { ok: true, message_id: 1 };
  };

  const longCommand = 'npm test -- --filter ' + 'x'.repeat(600);
  const engine = { approvals: new Map([['act-1', {}]]) };
  await forwardRequest(bridge, {
    type: 'approval_required',
    actionId: 'act-1',
    command: longCommand,
    agent: 'codex'
  }, {
    engine,
    title: 'Security Task',
    respond: () => true
  });

  const sendCall = calls.find((c) => c.method === 'sendMessage');
  assert.ok(sendCall);
  assert.match(sendCall.text, /⚠️ <i>\[TRUNCATED: \d+ chars total\. Review full command in editor before approving\.\]<\/i>/);
});

test('GET /app returns security headers preventing clickjacking, sniffing and insecure caching', async (t) => {
  const bridge = new TelegramBridge({ botToken: '123:token', chatId: '42', ownerId: '42' });
  bridge.webhookPort = 0;
  bridge.running = true;
  await bridge.startWebhookServer();
  t.after(() => bridge.stop());

  const port = bridge.server.address().port;
  const res = await fetch(`http://127.0.0.1:${port}/app`);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'/);
  assert.match(res.headers.get('cache-control'), /no-store/);
});


