'use strict';

const { makeDockKeyboard } = require('./telegram-bridge.js');
const clip = (text, limit = 3500) => String(text).slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');

function makeBar(percent, length = 5) {
  if (typeof percent !== 'number' || Number.isNaN(percent)) return '▱'.repeat(length);
  const clamped = Math.max(0, Math.min(100, Math.round(percent)));
  const filled = Math.round((clamped / 100) * length);
  return '▰'.repeat(filled) + '▱'.repeat(length - filled);
}

function formatCompactReset(resetsAtSeconds, nowMs = Date.now()) {
  const resetsAt = Number(resetsAtSeconds);
  if (!Number.isFinite(resetsAt) || resetsAt <= 0) return '';
  const remainingMinutes = Math.max(0, Math.ceil((resetsAt * 1000 - nowMs) / 60000));
  if (remainingMinutes === 0) return 'now';
  const days = Math.floor(remainingMinutes / 1440);
  const hours = Math.floor((remainingMinutes % 1440) / 60);
  const minutes = remainingMinutes % 60;
  if (days > 0) return `${days}d${hours > 0 ? `${hours}h` : ''}`;
  if (hours > 0) return `${hours}h${minutes > 0 ? `${minutes}m` : ''}`;
  return `${minutes}m`;
}

function timeAgo(isoString) {
  if (!isoString) return '';
  const diffMs = Date.now() - Date.parse(isoString);
  if (Number.isNaN(diffMs)) return '';
  const mins = Math.floor(diffMs / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

/** Capture the engine's exact request, so reused IDs across chats/turns cannot approve other work. */
async function forwardRequest(bridge, event, { engine, title, respond }) {
  if (!bridge?.running || !['approval_required', 'question_required'].includes(event.type)) return;
  const pending = engine.approvals.get(event.actionId);
  if (!pending) return;
  const isPending = () => engine.approvals.get(event.actionId) === pending;
  const answer = (callback) => isPending() ? respond(event.actionId, callback) : false;
  if (event.type === 'approval_required') {
    const desc = event.description || event.command || event.tool || 'Review the pending action.';
    const text = `⚠️ ACTION APPROVAL REQUIRED\n\n📁 ${title}\n🤖 ${event.agent || 'Agent'} needs approval:\n\n${desc}`;
    return bridge.sendApprovalRequest(text, event.actionId,
      (_id, approved) => answer((target) => target.respondToApproval(event.actionId, approved)), isPending);
  }
  return bridge.sendQuestionRequest(event, (answers) => answer((target) => target.respondToQuestion(event.actionId, answers)), isPending, title);
}

function bindTelegramControls(bridge, { manager, watchdog, queue, readQuotas, models, resolveTarget, notifyQueue }) {
  let selected = null;
  let selectedModel = 'codex';
  let isNewChat = false;
  const chats = () => manager.listChats();
  const findChat = (id) => {
    const all = chats();
    const exact = all.find((chat) => chat.id === id);
    if (exact) return exact;
    const matches = String(id || '').length >= 6 ? all.filter((chat) => chat.id.startsWith(id)) : [];
    return matches.length === 1 ? matches[0] : null;
  };

  function getActiveChat() {
    return selected ? findChat(selected) : null;
  }

  function currentDock() {
    const cur = getActiveChat();
    return makeDockKeyboard({
      chatTitle: cur ? (cur.preview || cur.id) : null,
      isNewChat: isNewChat || !cur,
      model: selectedModel
    });
  }

  function formatDivider(title, subtitle = '', icon = '📁') {
    return `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n` +
      `${icon} <b>${title}</b>\n` +
      (subtitle ? `${subtitle}\n` : '') +
      `━━━━━━━━━━━━━━━━━━━━━━━━━━━━`;
  }

  async function buildCockpitCard() {
    let quotas = {};
    try { quotas = await readQuotas() || {}; } catch {}
    const agents = ['claude', 'codex', 'gemini'];
    if (quotas.claudeOpus && typeof quotas.claudeOpus.remaining === 'number') agents.push('opus');
    const quotaLines = agents.map((agent) => {
      const q = quotas[agent];
      const pct = typeof q?.remaining === 'number' ? q.remaining : null;
      const bar = makeBar(pct, 5);
      const val = pct !== null ? `${pct}%` : q?.label || 'ready';
      const reset = formatCompactReset(q?.resetsAt);
      const resetStr = reset ? ` ⤾ ${reset}` : '';
      const name = agent === 'claude' ? 'Claude' : agent === 'codex' ? 'Codex ' : agent === 'opus' ? 'Opus  ' : 'Gemini';
      return `• ${name} : ${bar} ${val}${resetStr}`;
    }).join('\n');

    const runs = [...manager.runs.values()];
    const activeRun = runs.find((r) => r.turn || r.starting || r.state === 'running');
    const runningTaskId = watchdog.activeTaskId;

    let statusLine = '🟢 <b>Workstation:</b> Ready (All agents idle)';
    if (activeRun) {
      statusLine = `⚡ <b>Workstation:</b> Active turn in "${clip(activeRun.chat.title || activeRun.chat.id.slice(0, 8), 24)}"`;
    } else if (runningTaskId) {
      statusLine = `⚡ <b>Workstation:</b> Running scheduled task ${runningTaskId}`;
    }

    const currentChat = selected ? findChat(selected) : null;
    const chatTitle = currentChat ? (currentChat.preview || currentChat.id) : (chats()[0]?.preview || 'None (ready to prompt)');

    let queuedCount = 0;
    try {
      const allTasks = await queue.getQueue();
      queuedCount = allTasks.filter((t) => t.status === 'pending').length;
    } catch {}

    const text = `🖥️ <b>HOME WORKSTATION COCKPIT</b>\n${statusLine}\n\n` +
      `<b>📊 Quotas & Limits</b>\n<code>${quotaLines}</code>\n\n` +
      `<b>🎯 Remote Session</b>\n` +
      `• Active Chat: <i>${clip(chatTitle, 35)}</i>\n` +
      `• Default Model: <b>${selectedModel.toUpperCase()}</b>\n` +
      `• Pending Tasks: ${queuedCount}`;

    const inline_keyboard = [
      [
        { text: '🔄 Refresh', callback_data: 'nav:cockpit' },
        { text: '⚡ Active Task', callback_data: 'nav:active' }
      ],
      [
        { text: '💬 Chats', callback_data: 'nav:chats' },
        { text: `⚙️ Model: ${selectedModel.toUpperCase()}`, callback_data: 'nav:models' }
      ],
      [
        { text: '⏳ Task Queue', callback_data: 'nav:queue' },
        { text: '⏹ Stop Turn', callback_data: 'act:stop' }
      ]
    ];

    if (bridge.webhookPublicUrl) {
      inline_keyboard.push([
        { text: '📱 Open Liquid Glass Studio', web_app: { url: `${bridge.webhookPublicUrl}/app` } }
      ]);
    }

    return { text, reply_markup: { inline_keyboard }, parse_mode: 'HTML' };
  }

  async function buildActiveTaskCard() {
    const runs = [...manager.runs.values()];
    const activeRun = runs.find((r) => r.turn || r.starting || r.state === 'running');
    const taskId = watchdog.activeTaskId;

    if (!activeRun && !taskId) {
      const lastChat = selected ? findChat(selected) : chats()[0];
      const text = `⚪ <b>NO ACTIVE TASKS RUNNING</b>\n\n` +
        `All agents are idle. Your workstation is standing by.\n\n` +
        `• Active chat: <i>${clip(lastChat?.preview || 'None', 40)}</i>\n` +
        `• Default model: <b>${selectedModel.toUpperCase()}</b>\n\n` +
        `<i>Send any text message directly to start a turn.</i>`;
      return {
        text,
        reply_markup: {
          inline_keyboard: [
            [
              { text: '🔄 Refresh', callback_data: 'nav:active' },
              { text: '💬 Recent Chats', callback_data: 'nav:chats' }
            ],
            [
              { text: '⚙️ Switch Model', callback_data: 'nav:models' },
              { text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }
            ]
          ]
        },
        parse_mode: 'HTML'
      };
    }

    const title = activeRun ? (activeRun.chat.title || activeRun.chat.id) : `Scheduled task ${taskId}`;
    const agent = activeRun?.turn?.agent || 'Agent';
    const recentOutput = activeRun?.activeAssistantMessage?.text
      ? clip(activeRun.activeAssistantMessage.text.slice(-300))
      : watchdog.output ? clip(watchdog.output.slice(-300)) : 'Agent is executing...';

    const text = `⚡ <b>ACTIVE TASK IN PROGRESS</b>\n\n` +
      `📁 <b>Chat:</b> <i>${clip(title, 40)}</i>\n` +
      `🤖 <b>Agent:</b> ${agent}\n` +
      `🔄 <b>State:</b> Running turn\n\n` +
      `<b>Latest Output / Step:</b>\n<code>${recentOutput}</code>`;

    const stopTarget = activeRun ? activeRun.chat.id : 'watchdog';
    return {
      text,
      reply_markup: {
        inline_keyboard: [
          [
            { text: '🔄 Refresh Output', callback_data: 'nav:active' },
            { text: '⏹ Stop Task', callback_data: `act:stop:${stopTarget}` }
          ],
          [
            { text: '💬 View Chat', callback_data: `chat:select:${activeRun ? activeRun.chat.id : ''}` },
            { text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }
          ]
        ]
      },
      parse_mode: 'HTML'
    };
  }

  function buildChatsCard() {
    const all = chats().slice(0, 6);
    if (!all.length) {
      return {
        text: `💬 <b>NO CHATS FOUND</b>\n\nSend any text message to start your first chat session!`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }]
          ]
        },
        parse_mode: 'HTML'
      };
    }

    const lines = all.map((c, i) => {
      const isCur = c.id === selected;
      const statusIcon = c.state === 'running' ? '🟢' : c.state === 'waiting' ? '🟡' : '⚪';
      const curBadge = isCur ? ' <i>(selected)</i>' : '';
      const time = c.updatedAt ? ` • ${timeAgo(c.updatedAt)}` : '';
      return `${statusIcon} <b>${i + 1}. ${clip(c.preview || 'Chat', 28)}</b>${curBadge}\n   ID: <code>${c.id.slice(0, 8)}</code>${time}`;
    }).join('\n\n');

    const text = `💬 <b>RECENT CHATS</b>\nSelect a chat to inspect or resume:\n\n${lines}`;
    const buttons = all.map((c, i) => [{
      text: `${c.id === selected ? '• ' : ''}${i + 1}. ${clip(c.preview || 'Chat', 22)}`,
      callback_data: `chat:select:${c.id}`
    }]);

    buttons.push([
      { text: '➕ New Chat', callback_data: 'act:newchat' },
      { text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }
    ]);

    return { text, reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' };
  }

  function buildFastChatSwitcherCard() {
    const cur = getActiveChat();
    const curTitle = cur ? (cur.preview || cur.id) : 'None (Fresh Chat)';
    const text = `💬 <b>SELECT CHAT TARGET</b>\n\n` +
      `Currently active: <i>${clip(curTitle, 35)}</i>\n` +
      `Default model: <b>${selectedModel.toUpperCase()}</b>\n\n` +
      `Tap an action below to switch targets:`;

    const all = chats().slice(0, 5);
    const inline_keyboard = [
      [
        { text: isNewChat ? '✨ Active: Fresh New Chat' : '✨ Start Fresh Chat (Clean Slate)', callback_data: 'chat:new' }
      ]
    ];

    for (const c of all) {
      const isCur = !isNewChat && selected === c.id;
      const statusIcon = c.state === 'running' ? '🟢' : c.state === 'waiting' ? '🟡' : '⚪';
      inline_keyboard.push([
        {
          text: `${isCur ? '• ' : ''}${statusIcon} ${clip(c.preview || c.id, 24)}${isCur ? ' •' : ''}`,
          callback_data: `chat:use:${c.id}`
        }
      ]);
    }

    inline_keyboard.push([
      { text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }
    ]);

    return { text, reply_markup: { inline_keyboard }, parse_mode: 'HTML' };
  }

  function buildChatDetailsCard(chatId) {
    const chat = findChat(chatId);
    if (!chat) return buildChatsCard();
    const isCur = chat.id === selected;
    const run = manager.runs.get(chat.id);
    const state = run?.state || chat.state || 'idle';
    const statusIcon = state === 'running' ? '🟢 Running' : state === 'waiting' ? '🟡 Waiting approval' : '⚪ Idle';

    const text = `📁 <b>CHAT DETAILS</b>\n\n` +
      `<b>Title:</b> ${clip(chat.preview || 'Untitled', 40)}\n` +
      `<b>ID:</b> <code>${chat.id}</code>\n` +
      `<b>Status:</b> ${statusIcon}\n` +
      `<b>Selected for prompts:</b> ${isCur ? '✅ Yes' : 'No'}\n\n` +
      `<i>Type any message to prompt here, or tap 'Select for Prompts' below.</i>`;

    const buttons = [
      [
        { text: isCur ? '✅ Selected' : '⚡ Select for Prompts', callback_data: `chat:use:${chat.id}` },
        { text: '⏹ Stop Turn', callback_data: `act:stop:${chat.id}` }
      ],
      [
        { text: '‹ Back to Chats', callback_data: 'nav:chats' },
        { text: '‹ Cockpit', callback_data: 'nav:cockpit' }
      ]
    ];

    return { text, reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' };
  }

  function buildModelsCard() {
    const text = `⚙️ <b>MODEL SELECTOR</b>\n\n` +
      `Current active default: <b>${selectedModel.toUpperCase()}</b>\n\n` +
      `Tap any model below to change your default for direct prompts:`;

    const available = [
      { id: 'codex', label: 'Codex' },
      { id: 'claude', label: 'Claude Sonnet' },
      { id: 'gemini', label: 'Gemini 3.8 Flash' },
      { id: 'opus', label: 'Claude Opus 5.5' },
    ];

    const rows = [];
    for (let i = 0; i < available.length; i += 2) {
      const row = [];
      const m1 = available[i];
      const m2 = available[i + 1];
      row.push({
        text: selectedModel === m1.id ? `• ${m1.label} •` : m1.label,
        callback_data: `model:set:${m1.id}`
      });
      if (m2) {
        row.push({
          text: selectedModel === m2.id ? `• ${m2.label} •` : m2.label,
          callback_data: `model:set:${m2.id}`
        });
      }
      rows.push(row);
    }
    rows.push([{ text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }]);

    return { text, reply_markup: { inline_keyboard: rows }, parse_mode: 'HTML' };
  }

  async function buildQueueCard() {
    let tasks = [];
    try {
      tasks = (await queue.getQueue()).filter((t) => ['pending', 'dispatched', 'interrupted'].includes(t.status));
    } catch {}

    if (!tasks.length) {
      return {
        text: `⏳ <b>SCHEDULED TASKS</b>\n\nThe scheduler queue is currently empty.\n\nWorkstation watchdog is active.`,
        reply_markup: {
          inline_keyboard: [
            [{ text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }]
          ]
        },
        parse_mode: 'HTML'
      };
    }

    const lines = tasks.map((t, i) => {
      return `<b>${i + 1}. ${t.id}</b>\n• Model: ${t.model} • Status: ${t.status}\n• Trigger: ${t.dispatchTrigger || 'auto'}`;
    }).join('\n\n');

    const text = `⏳ <b>SCHEDULED TASKS (${tasks.length})</b>\n\n${lines}`;
    const buttons = tasks.slice(0, 4).map((t) => [{
      text: `❌ Cancel ${t.id.slice(0, 14)}`,
      callback_data: `queue:cancel:${t.id}`
    }]);
    buttons.push([{ text: '‹ Back to Cockpit', callback_data: 'nav:cockpit' }]);

    return { text, reply_markup: { inline_keyboard: buttons }, parse_mode: 'HTML' };
  }

  // Register interactive callback routes
  bridge.onCallback('nav', async (_cb, data, { edit }) => {
    const view = data.split(':')[1];
    if (view === 'cockpit') {
      const card = await buildCockpitCard();
      await edit(card.text, card);
    } else if (view === 'active') {
      const card = await buildActiveTaskCard();
      await edit(card.text, card);
    } else if (view === 'chats') {
      const card = buildChatsCard();
      await edit(card.text, card);
    } else if (view === 'models') {
      const card = buildModelsCard();
      await edit(card.text, card);
    } else if (view === 'queue') {
      const card = await buildQueueCard();
      await edit(card.text, card);
    }
  });

  bridge.onCallback('chat', async (_cb, data, { edit, answer, reply }) => {
    const parts = data.split(':');
    const action = parts[1];
    const id = parts[2];
    if (action === 'new') {
      isNewChat = true;
      selected = null;
      await answer('Switched to Fresh Chat mode');
      const divider = formatDivider(
        'NEW CHAT SESSION (Clean Slate)',
        `🤖 Model: ${selectedModel.toUpperCase()}\n💡 Type any message below to start a fresh workstation chat.`,
        '✨'
      );
      await reply(divider, { parse_mode: 'HTML', reply_markup: currentDock() });
      const card = buildFastChatSwitcherCard();
      await edit(card.text, card).catch(() => {});
      return;
    }
    if (action === 'use') {
      selected = id;
      isNewChat = false;
      const cur = findChat(id);
      const title = cur ? (cur.preview || cur.id) : id;
      await answer(`Selected ${clip(title, 20)}`);
      const divider = formatDivider(
        `CONNECTED TO: "${clip(title, 30)}"`,
        `🤖 Model: ${selectedModel.toUpperCase()}\n💡 Prompts you type now will continue this session.`,
        '📁'
      );
      await reply(divider, { parse_mode: 'HTML', reply_markup: currentDock() });
      const card = buildFastChatSwitcherCard();
      await edit(card.text, card).catch(() => {});
      return;
    }
    if (action === 'select') {
      const card = buildChatDetailsCard(id);
      await edit(card.text, card);
    }
  });

  bridge.onCallback('model', async (_cb, data, { edit, answer, reply }) => {
    const model = data.split(':')[2];
    if (model) {
      selectedModel = model;
      await answer(`Default switched to ${model.toUpperCase()}`);
      const cur = getActiveChat();
      const title = cur ? (cur.preview || cur.id) : 'Fresh Chat';
      const toast = `⚙️ <b>Default Model Changed</b>\nNow using <b>${model.toUpperCase()}</b> for <i>${clip(title, 25)}</i>.`;
      await reply(toast, { parse_mode: 'HTML', reply_markup: currentDock() });
      const card = buildModelsCard();
      await edit(card.text, card).catch(() => {});
    }
  });

  bridge.onCallback('act', async (_cb, data, { answer, edit }) => {
    const parts = data.split(':');
    const action = parts[1];
    const targetId = parts[2];
    if (action === 'stop') {
      const run = (targetId && manager.runs.get(targetId)) || (selected && manager.runs.get(selected)) || [...manager.runs.values()].find((r) => r.turn);
      if (run?.streamEngine) {
        run.streamEngine.interrupt();
        await answer('Stopped turn.');
      } else {
        await answer('No active turn running.');
      }
      const card = await buildCockpitCard();
      await edit(card.text, card);
    } else if (action === 'newchat') {
      const run = manager.runFor(null);
      if (run) {
        selected = run.chat.id;
        await answer('Created new chat!');
        const card = buildChatDetailsCard(selected);
        await edit(card.text, card);
      }
    }
  });

  bridge.onCallback('queue', async (_cb, data, { answer, edit }) => {
    const taskId = data.split(':')[2];
    if (taskId) {
      const removed = await queue.dequeue(taskId);
      notifyQueue();
      await answer(removed ? `Cancelled ${taskId}` : 'Task not found');
      const card = await buildQueueCard();
      await edit(card.text, card);
    }
  });

  // Direct conversational input & bottom dock dispatch
  bridge.onRawMessage(async (text, _msg, reply) => {
    const trimmed = text.trim();

    // 1. Cockpit Anchor
    if (/^(?:📊\s*)?cockpit$/i.test(trimmed)) {
      const card = await buildCockpitCard();
      await reply(card.text, card);
      return;
    }

    // 2. Chat Switcher Button (Dynamic match: 💬 ... or ➕ New Chat)
    if (/^(?:💬|➕|📁)/i.test(trimmed) || /^(?:chats?|new\s*chat)$/i.test(trimmed)) {
      const card = buildFastChatSwitcherCard();
      await reply(card.text, card);
      return;
    }

    // 3. Model Switcher Button (Dynamic match: 🤖 ... or 🧠 ... or ⚡ ... or 🎭 ...)
    if (/^(?:🤖|🧠|⚡|🎭|⚙️)/i.test(trimmed) || /^models?$/i.test(trimmed)) {
      const card = buildModelsCard();
      await reply(card.text, card);
      return;
    }

    // 4. Active Task Button (Backward compatibility)
    if (/^(?:⚡\s*)?active(?:\s*task)?$/i.test(trimmed)) {
      const card = await buildActiveTaskCard();
      await reply(card.text, card);
      return;
    }

    // 5. Direct Conversational Prompt
    let run = null;
    if (isNewChat) {
      run = manager.runFor(null);
      if (run) {
        selected = run.chat.id;
        isNewChat = false;
      }
    } else {
      run = selected ? manager.runFor(selected) : null;
      if (!run) {
        const all = chats();
        if (all.length > 0) run = manager.runFor(all[0].id);
        if (!run) run = manager.runFor(null);
      }
    }

    if (!run) {
      await reply('Could not open a chat session. Tap ➕ New Chat to create one.', { reply_markup: currentDock() });
      return;
    }

    selected = run.chat.id;
    const target = resolveTarget(selectedModel) || resolveTarget('codex');
    const modelId = target?.modelId || models.find((m) => m.agent === target?.agentId)?.id || 'auto';
    const queued = Boolean(run.turn || run.starting);
    run.enqueue({ text: trimmed, modelId });

    const statusBadge = queued ? '⏳ Queued behind current turn' : '⚡ Dispatched to workstation';
    const confirmText = `${statusBadge}\n\n` +
      `📁 <b>Chat:</b> <i>${clip(run.chat.title || run.chat.id, 35)}</i>\n` +
      `🤖 <b>Model:</b> ${selectedModel.toUpperCase()}\n\n` +
      `<code>${clip(trimmed, 120)}</code>`;

    await reply(confirmText, {
      parse_mode: 'HTML',
      reply_markup: {
        inline_keyboard: [
          [
            { text: '⏹ Stop', callback_data: `act:stop:${run.chat.id}` },
            { text: '⚡ Active Task', callback_data: 'nav:active' },
            { text: '📊 Cockpit', callback_data: 'nav:cockpit' }
          ]
        ]
      }
    });
  });

  // Standard slash commands
  bridge.onCommand('models', (_args, reply) => {
    const card = buildModelsCard();
    reply(card.text, card);
  });
  bridge.onCommand('chats', (_args, reply) => {
    const card = buildChatsCard();
    reply(card.text, card);
  });
  bridge.onCommand('use', async ([id], reply) => {
    const chat = findChat(id);
    if (!chat) return reply('Chat not found or ID is ambiguous. Use /chats, then /use <chat ID>.');
    selected = chat.id;
    isNewChat = false;
    const divider = formatDivider(
      `CONNECTED TO: "${clip(chat.preview || chat.id, 30)}"`,
      `🤖 Model: ${selectedModel.toUpperCase()}\n💡 Prompts you type now will continue this session.`,
      '📁'
    );
    await reply(divider, { parse_mode: 'HTML', reply_markup: currentDock() });
  });
  bridge.onCommand('prompt', async (_args, reply, raw) => {
    const match = /^(\S+)\s+([\s\S]+)$/.exec(raw.trim());
    const target = match && resolveTarget(match[1]);
    if (!target) return reply('Usage: /prompt <model> <message>. Use /models to see the available models.');
    const run = manager.runFor(selected);
    if (!run) { selected = null; return reply('That chat was deleted. Send your prompt again to start a new chat.'); }
    selected = run.chat.id;
    const queued = Boolean(run.turn || run.starting);
    run.enqueue({ text: match[2], modelId: target.modelId || models.find((m) => m.agent === target.agentId)?.id || 'auto' });
    await reply(`${queued ? 'Queued behind the current turn' : 'Sent'} to ${match[1]}.\nChat: ${selected}`);
  });
  bridge.onCommand('stop', async (_args, reply) => {
    const run = selected && manager.runs.get(selected);
    if (!run?.turn) return reply('No running turn is selected. Use /chats and /use <chat ID>.');
    run.streamEngine.interrupt();
    await reply('Stopped the selected chat.');
  });
  bridge.onCommand('status', async (_args, reply) => {
    const card = await buildCockpitCard();
    await reply(card.text, card);
  });
  bridge.onCommand('cockpit', async (_args, reply) => {
    const card = await buildCockpitCard();
    await reply(card.text, card);
  });
  bridge.onCommand('active', async (_args, reply) => {
    const card = await buildActiveTaskCard();
    await reply(card.text, card);
  });
  bridge.onCommand('queue', async (_args, reply) => {
    const card = await buildQueueCard();
    await reply(card.text, card);
  });
  bridge.onCommand('cancel', async ([id], reply) => {
    if (!id) return reply('Usage: /cancel <task ID>. Use /queue to see IDs.');
    if (id === watchdog.activeTaskId) return reply('That scheduled task is already running. Stop it in the editor.');
    const removed = await queue.dequeue(id);
    notifyQueue();
    await reply(removed ? `Cancelled ${id}.` : 'Task not found.');
  });
}

module.exports = { forwardRequest, bindTelegramControls };
