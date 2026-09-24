'use strict';

// P17-U: pure-logic tests only (parsers, stream normalization, queue and
// quota math, stores on a temp dir). No mocked `vscode` runtime, no browser:
// UI and glue code is verified against the acceptance criteria directly,
// and `node test/check.js` covers syntax for every script.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');
const { writeMicroHandoff, readMicroHandoff, formatMicroHandoffPrompt, MAX_CHARS } = require('../lib/handoff.js');
const { SchedulerQueue, MAX_QUEUE_SIZE, MAX_ATTACHMENT_BYTES } = require('../lib/scheduler-queue.js');
const { TelegramBridge } = require('../lib/telegram-bridge.js');
const { CodexCommandCatalog, parseCommandTable, parseInvocation, supportsComposerCommand } = require('../lib/codex-commands.js');

let failures = 0;

const pendingTests = [];
function test(name, fn) {
  try {
    const result = fn();
    if (result && typeof result.then === 'function') {
      // P17-U: silent on success; only failures print.
      pendingTests.push(result.catch((error) => {
        failures += 1;
        console.error(`FAIL  ${name}`);
        console.error(`      ${error.message}`);
      }));
    }
  } catch (error) {
    failures += 1;
    console.error(`FAIL  ${name}`);
    console.error(`      ${error.message}`);
  }
}

test('P12-D: writeMicroHandoff persists a round-trippable, hard-capped-size summary', () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-handoff-')), 'handoff.json');

  const summary = writeMicroHandoff(filePath, {
    decisions: ['Used a Map for O(1) file-group lookup', 'Capped phases at 10 tasks'],
    modifiedExports: ['sliceIntoAffinityBatches', 'synthesizePackage'],
    invariants: ['Never split a same-file group unless it alone exceeds the cap'],
  });

  assert.ok(fs.statSync(filePath).size <= MAX_CHARS, 'the written artifact must stay within the ~150-token budget');
  const readBack = readMicroHandoff(filePath);
  assert.deepEqual(readBack.decisions, summary.decisions);
  assert.deepEqual(readBack.modifiedExports, summary.modifiedExports);
  assert.deepEqual(readBack.invariants, summary.invariants);
});

test('P12-D: writeMicroHandoff trims oversized input down to budget instead of writing invalid/truncated JSON', () => {
  const filePath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-handoff-')), 'handoff.json');
  const longDecisions = Array.from({ length: 5 }, (_, i) => `Decision ${i}: `.padEnd(200, 'x'));

  writeMicroHandoff(filePath, { decisions: longDecisions, modifiedExports: [], invariants: ['a very long invariant '.padEnd(200, 'y')] });

  const raw = fs.readFileSync(filePath, 'utf8');
  assert.ok(raw.length <= MAX_CHARS, `expected <= ${MAX_CHARS} chars, got ${raw.length}`);
  assert.doesNotThrow(() => JSON.parse(raw), 'trimming must never produce invalid JSON');
});

test('readMicroHandoff returns null instead of throwing when no handoff file exists yet', () => {
  const missingPath = path.join(os.tmpdir(), 'ai-chat-panel-handoff-does-not-exist', 'handoff.json');
  assert.equal(readMicroHandoff(missingPath), null);
});

test('formatMicroHandoffPrompt renders a compact prefix, or an empty string for an empty summary', () => {
  const rendered = formatMicroHandoffPrompt({ decisions: ['Did X'], modifiedExports: ['foo.mjs'], invariants: [] });
  assert.match(rendered, /Did X/);
  assert.match(rendered, /foo\.mjs/);
  assert.equal(formatMicroHandoffPrompt({ decisions: [], modifiedExports: [], invariants: [] }), '');
  assert.equal(formatMicroHandoffPrompt(null), '');
});

test('Codex slash commands are discovered from the installed exec help instead of a static renderer list', async () => {
  const rootHelp = `Run Codex non-interactively\n\nCommands:\n  resume  Resume a previous session\n  review  Run a code review against the current repository\n  help    Print help\n`;
  const reviewHelp = `Run a code review against the current repository\n\nUsage: codex exec review [OPTIONS] [PROMPT]\n\nArguments:\n  [PROMPT]\n          Custom instructions. If - is used, read from stdin\n\nOptions:\n      --json\n          Print JSONL\n      --skip-git-repo-check\n          Allow running outside Git\n  -m, --model <MODEL>\n          Override the model\n  -c, --config <key=value>\n          Override configuration\n`;
  let calls = 0;
  const runImpl = async (_binary, args) => { calls++; return args.length === 2 ? rootHelp : args[1] === 'review' ? reviewHelp : 'Usage: codex exec resume [SESSION_ID]\n'; };
  const catalog = new CodexCommandCatalog({ locateImpl: () => ({ path: 'codex' }), runImpl });
  assert.equal(await catalog.resolve('ordinary prompt'), null);
  assert.equal(calls, 0, 'ordinary turns do not probe the Codex binary');
  assert.deepEqual(parseCommandTable(rootHelp).map((entry) => entry.name), ['resume', 'review', 'help']);
  assert.equal(supportsComposerCommand(reviewHelp, 'review'), true);
  assert.equal(supportsComposerCommand(reviewHelp.replace('      --skip-git-repo-check\n', ''), 'review'), false, 'discovery rejects commands that cannot accept the launch flags');
  assert.deepEqual(await catalog.list(), [{ name: 'review', description: 'Run a code review against the current repository' }]);
  assert.deepEqual(await catalog.resolve('/review focus on races'), { name: 'review', description: 'Run a code review against the current repository', prompt: 'focus on races' });
  assert.equal(parseInvocation('/unknown', await catalog.list()), null);
});

test('package.json declares the webview view, the injectPrompt command, and the 3 focus commands', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
  assert.equal(pkg.contributes.views.aiChatPanel[0].id, 'aiChatPanel.mainView');
  const commandIds = pkg.contributes.commands.map((command) => command.command);
  assert.ok(commandIds.includes('aiChatPanel.newChatWindow'));
  assert.ok(commandIds.includes('aiChatPanel.injectPrompt'));
  assert.ok(commandIds.includes('aiChatPanel.runNextBatchInCleanSession'));
  assert.ok(commandIds.includes('aiChatPanel.focusClaude'));
  assert.ok(commandIds.includes('aiChatPanel.focusCodex'));
  assert.ok(commandIds.includes('aiChatPanel.focusGemini'));
  assert.equal(pkg.contributes.configuration.properties['aiChatPanel.models'].default.codex, 'gpt-5.6-terra');
});

test('P16-I: binary-locator finds the newest bundled CLI across IDE extension dirs and reports every path checked', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'locator-'));
  const make = (rel) => { const file = path.join(home, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, ''); return file; };
  make('.antigravity/extensions/anthropic.claude-code-2.1.99-win32-x64/resources/native-binary/claude.exe');
  const newest = make('.antigravity-ide/extensions/anthropic.claude-code-2.1.280-win32-x64/resources/native-binary/claude.exe');
  const codex = make('.vscode/extensions/openai.chatgpt-26.7.1-win32-x64/bin/windows-x86_64/codex.exe');
  const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, LOCALAPPDATA: process.env.LOCALAPPDATA, APPDATA: process.env.APPDATA, PATH: process.env.PATH };
  Object.assign(process.env, { HOME: home, USERPROFILE: home, LOCALAPPDATA: path.join(home, 'Local'), APPDATA: path.join(home, 'Roaming'), PATH: '' });
  const resolved = require.resolve('../lib/binary-locator.js');
  delete require.cache[resolved];
  try {
    const locator = require('../lib/binary-locator.js');
    assert.equal(locator.locate('claude').path, newest);
    assert.equal(locator.locate('codex').path, codex);
    const gemini = locator.locate('gemini');
    assert.equal(gemini.path, null);
    assert.ok(gemini.checked.some((file) => file.endsWith(path.join('agy', 'bin', 'agy.exe'))));
    assert.equal(locator.terminalCommand('claude'), `& "${newest}"`);
  } finally {
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    delete require.cache[resolved];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('P16-I: StreamEngine turns a missing CLI into a binary_missing event, never a raw ENOENT delta', async () => {
  const locator = require('../lib/binary-locator.js');
  const { StreamEngine } = require('../lib/stream-engine.js');
  const real = locator.locate;
  const cached = real('gemini');
  locator.refresh();
  const engine = new StreamEngine({ cwd: os.tmpdir() });
  // Force "not found" for this one call without touching the real machine.
  const origCommandFor = engine.commandFor.bind(engine);
  engine.commandFor = (...args) => ({ ...origCommandFor(...args), command: null });
  const events = [];
  engine.on('event', (event) => events.push(event));
  assert.equal(engine.start({ agent: 'gemini', prompt: 'hi' }), null);
  await new Promise((r) => setTimeout(r, 10));
  assert.deepEqual(events.map((e) => e.type), ['binary_missing', 'turn_complete']);
  assert.equal(events[0].agent, 'gemini');
  assert.ok(Array.isArray(events[0].checked));
  assert.ok(!events.some((e) => e.type === 'delta'));
  void cached;
});

test('readQuotas without the usage extension reports every provider as unknown', async () => {
  const { readQuotas } = require('../lib/quota-bridge.js');
  assert.deepEqual(await readQuotas(), { claude: null, claudeWeekly: null, claudeOpus: null, opus: null, codex: null, gemini: null });
});

test('P13-E: normalizeEvent maps vendor-shaped NDJSON into the locked webview protocol', () => {
  const { normalizeEvent } = require('../lib/stream-engine.js');
  assert.deepEqual(normalizeEvent({ type: 'content_delta', text: 'hello' }, 'codex'), { type: 'delta', text: 'hello', model: 'codex', agent: 'codex' });
  const tool = normalizeEvent({ type: 'tool_start', name: 'bash', command: 'npm test' }, 'claude');
  assert.equal(tool.type, 'tool_start');
  assert.equal(tool.command, 'npm test');
  assert.equal(normalizeEvent({ type: 'turn_complete' }, 'gemini').type, 'turn_complete');
});

test('P13-F: ChatStore persists, lists, reloads, and deletes a session', () => {
  const { ChatStore } = require('../lib/chat-store.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-chat-'));
  const store = new ChatStore(root);
  const chat = store.create();
  chat.messages.push({ role: 'user', text: 'Persist this chat' });
  const saved = store.save(chat);
  assert.equal(store.list().length, 1);
  assert.equal(store.load(saved.id).messages[0].text, 'Persist this chat');
  assert.equal(store.delete(saved.id), true);
  assert.equal(store.list().length, 0);
});

test('Manage Chats: a chat is active while it runs or within five minutes of its last run', () => {
  const { markActive, ACTIVE_WINDOW_MS } = require('../lib/chat-store.js');
  const now = Date.parse('2026-09-23T12:00:00Z');
  const ago = (ms) => new Date(now - ms).toISOString();
  const [running, recent, stale, never] = markActive(
    [{ id: 'a', lastRunAt: ago(ACTIVE_WINDOW_MS * 3) }, { id: 'b', lastRunAt: ago(ACTIVE_WINDOW_MS - 1000) }, { id: 'c', lastRunAt: ago(ACTIVE_WINDOW_MS + 1000) }, { id: 'd' }],
    new Map([['a', 'waiting']]),
    now,
  );
  assert.deepEqual([running.active, running.state], [true, 'waiting']);
  assert.deepEqual([recent.active, recent.state], [true, null]);
  assert.equal(stale.active, false);
  assert.equal(never.active, false);
});

test('P13-H: auto-router applies role boundaries, quota fallback, and contract lock', () => {
  const { route } = require('../lib/auto-router.js');
  const ui = route('Improve the CSS layout animation', { claude: { remaining: 80 } }, 'auto');
  assert.equal(ui.agent, 'claude');
  assert.match(ui.prompt, /presentation\/UI/i);
  const backend = route('Fix the AST parser schema', { codex: { remaining: 10 } }, 'auto');
  assert.equal(backend.agent, 'gemini');
  const split = route('Connect the UI CSS with the backend IPC parser', {}, 'auto');
  assert.equal(split.split, true);
  assert.match(split.contract, /CONTRACT LOCK/);
});

test('P15-F: SchedulerQueue stages attachments, preserves FIFO, and validates limits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-scheduler-'));
  const source = path.join(root, 'diagram.txt');
  fs.writeFileSync(source, 'attachment content');
  const queue = new SchedulerQueue({ workspaceDir: root });
  const task = await queue.enqueue({ model: 'codex', prompt: 'Fix the backend', attachments: [], dispatchTrigger: 'quota-reset' }, [source]);
  assert.match(task.id, /^sched_/);
  assert.equal(task.attachments.length, 1);
  assert.match(task.attachments[0].relativePath, /^\.astro\/session\/scheduler\//);
  assert.ok(fs.existsSync(path.join(root, task.attachments[0].relativePath)));
  assert.equal((await queue.getNextPendingForModel('codex')).id, task.id);
  await queue.markDispatched(task.id);
  await queue.markFailed(task.id, 'temporary outage');
  assert.equal((await queue.getQueue())[0].status, 'pending');
  await queue.markFailed(task.id, 'second');
  await queue.markFailed(task.id, 'third');
  assert.equal((await queue.getQueue())[0].status, 'failed');
  const oversized = path.join(root, 'oversized.bin');
  fs.writeFileSync(oversized, '');
  fs.truncateSync(oversized, MAX_ATTACHMENT_BYTES);
  await assert.rejects(queue.enqueue({ model: 'codex', prompt: 'Too large', attachments: [], dispatchTrigger: 'quota-reset' }, [oversized]), /smaller than 20 MB/);
  const fullQueue = new SchedulerQueue({ workspaceDir: root, sessionDir: path.join(root, '.astro', 'full-session') });
  await fullQueue.getQueue();
  fullQueue.tasks = Array.from({ length: MAX_QUEUE_SIZE }, (_, index) => ({ id: `active-${index}`, status: 'pending' }));
  await assert.rejects(fullQueue.enqueue({ model: 'claude', prompt: 'Overflow', attachments: [], dispatchTrigger: 'quota-reset' }), /queue is full/);
  assert.equal(MAX_QUEUE_SIZE, 50);
  assert.equal(MAX_ATTACHMENT_BYTES, 20 * 1024 * 1024);
});

test('P15-I: TelegramBridge accepts only the configured user and routes commands and approvals', async () => {
  const bridge = new TelegramBridge({ botToken: 'test-token', chatId: '42' });
  const replies = [];
  let statusCalls = 0;
  let approval = null;
  bridge.sendMarkdown = async (text) => { replies.push(text); return true; };
  bridge.onCommand('status', async (_args, reply) => { statusCalls += 1; await reply('all clear'); });
  bridge.onApproval(async (taskId, approved) => { approval = { taskId, approved }; });
  await bridge.handleUpdate({ message: { from: { id: 7 }, chat: { id: 7 }, text: '/status' } });
  assert.equal(statusCalls, 0, 'foreign users must be ignored');
  await bridge.handleUpdate({ message: { from: { id: 42 }, chat: { id: 42 }, text: '/status' } });
  assert.equal(statusCalls, 1);
  assert.deepEqual(replies, ['all clear']);
  bridge.api = async () => true;
  await bridge.handleUpdate({ callback_query: { id: 'callback-1', from: { id: 42 }, data: 'approve:sched_123' } });
  assert.deepEqual(approval, { taskId: 'sched_123', approved: true });
  assert.equal(bridge.isConfigured(), true);
});

test('P16-K: SchedulerQueue reorder sets dispatch priority and editPrompt only touches pending tasks', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-reorder-'));
  const queue = new SchedulerQueue({ workspaceDir: root });
  const a = await queue.enqueue({ model: 'claude', prompt: 'A', dispatchTrigger: 'quota-reset' });
  const b = await queue.enqueue({ model: 'claude', prompt: 'B', dispatchTrigger: 'quota-reset' });
  const c = await queue.enqueue({ model: 'claude', prompt: 'C', dispatchTrigger: 'quota-reset' });
  assert.equal((await queue.getNextPendingForModel('claude')).id, a.id);
  assert.equal(await queue.reorder([c.id, a.id, b.id]), true);
  assert.deepEqual((await queue.getQueue()).map((task) => task.prompt), ['C', 'A', 'B']);
  assert.equal((await queue.getNextPendingForModel('claude')).id, c.id);
  // survives a reload from disk
  const reloaded = new SchedulerQueue({ workspaceDir: root });
  assert.deepEqual((await reloaded.getQueue()).map((task) => task.prompt), ['C', 'A', 'B']);
  assert.equal(await queue.editPrompt(a.id, '  A, clarified  '), true);
  assert.equal((await queue.getQueue()).find((task) => task.id === a.id).prompt, 'A, clarified');
  await queue.markDispatched(b.id);
  assert.equal(await queue.editPrompt(b.id, 'too late'), false);
  await assert.rejects(queue.editPrompt(c.id, '   '));
  fs.rmSync(root, { recursive: true, force: true });
});

// P16-L: fake ffmpeg -- `-list_devices` prints the given devices; a recording
// either exits at once (missing device), keeps running, or dies mid-recording.
function fakeFfmpeg({ devices, recording }) {
  const { EventEmitter } = require('node:events');
  const spawned = [];
  const spawnImpl = (cmd, args) => {
    const proc = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.stdin = { write() {}, end() { if (proc.exitCode === null) setTimeout(() => { proc.exitCode = 0; proc.emit('exit', 0); proc.emit('close', 0); }, 5); }, on() {} };
    proc.exitCode = null; proc.signalCode = null; proc.kill = () => { proc.exitCode = 1; proc.emit('close', 1); };
    spawned.push(args);
    if (args.includes('-list_devices')) {
      setTimeout(() => { proc.stderr.emit('data', Buffer.from(devices.map((d) => `[in#0] "${d}" (audio)\n[in#0] "Cam" (video)\n`).join(''))); proc.emit('close', 1); }, 1);
      return proc;
    }
    const device = args[args.indexOf('-i') + 1].slice('audio='.length);
    const wav = args.find((a) => typeof a === 'string' && a.endsWith('.wav')) || args[args.length - 1];
    if (!devices.includes(device) || recording === 'exit-now') {
      setTimeout(() => { proc.stderr.emit('data', Buffer.from(`Could not find audio only device with name [${device}]\n`)); proc.exitCode = 1; proc.emit('exit', 1); proc.emit('close', 1); }, 20);
    } else {
      fs.writeFileSync(wav, Buffer.alloc(2000));
      if (recording === 'crash') setTimeout(() => { proc.exitCode = 1; proc.emit('exit', 1); proc.emit('close', 1); }, 450);
    }
    return proc;
  };
  return { spawnImpl, spawned };
}

test('P16-L: parseDshowAudioDevices keeps audio devices only', () => {
  const { parseDshowAudioDevices } = require('../lib/voice-capture.js');
  assert.deepEqual(parseDshowAudioDevices('[in#0] "Anker" (video)\n[in#0] "Microphone (Anker PowerConf C200)" (audio)\n[in#0]   Alternative name "@device_cm_x"\n[in#0] "Kopfhörer (CMF)" (audio)\n'), ['Microphone (Anker PowerConf C200)', 'Kopfhörer (CMF)']);
});

test('P16-L: a configured mic missing on this workstation falls back to the first real device', async () => {
  const { VoiceCapture } = require('../lib/voice-capture.js');
  const { spawnImpl, spawned } = fakeFfmpeg({ devices: ['Microphone (Anker PowerConf C200)', 'Headset Microphone (HyperX)'], recording: 'ok' });
  const capture = new VoiceCapture({ config: { micDevice: 'Mikrofonarray (Realtek(R) Audio)', ffmpegPath: 'ffmpeg' }, spawnImpl });
  assert.equal(await capture.start(), 'Microphone (Anker PowerConf C200)');
  assert.ok(spawned.some((args) => args.includes('audio=Microphone (Anker PowerConf C200)')));
  const wav = await capture.stop();
  assert.ok(fs.existsSync(wav));
  fs.rmSync(wav, { force: true });
  assert.equal(capture.isRecording(), false);
});

test('P16-L: ffmpeg dying at startup rejects start() instead of reporting "recording"', async () => {
  const { VoiceCapture } = require('../lib/voice-capture.js');
  const { spawnImpl } = fakeFfmpeg({ devices: ['Mic A'], recording: 'exit-now' });
  const capture = new VoiceCapture({ config: { micDevice: 'Mic A' }, spawnImpl });
  await assert.rejects(capture.start(), (error) => error.code === 'AUDIO_CAPTURE_FAILED' && error.device === 'Mic A' && /Could not open microphone "Mic A"/.test(error.message) && error.devices.includes('Mic A'));
  assert.equal(capture.isRecording(), false);
  await assert.rejects(capture.stop(), /Not currently recording/);
});

test('P16-L: stop() settles immediately when ffmpeg already crashed mid-recording (no dead-close deadlock)', async () => {
  const { VoiceCapture } = require('../lib/voice-capture.js');
  const { spawnImpl } = fakeFfmpeg({ devices: ['Mic A'], recording: 'crash' });
  const capture = new VoiceCapture({ config: { micDevice: 'Mic A' }, spawnImpl });
  await capture.start();
  await new Promise((r) => setTimeout(r, 120)); // crash happens during "recording"
  const settled = await Promise.race([capture.stop().then(() => 'resolved', () => 'rejected'), new Promise((r) => setTimeout(() => r('hung'), 300))]);
  assert.notEqual(settled, 'hung');
});

test('P16-L: no microphone at all is a clear error', async () => {
  const { VoiceCapture } = require('../lib/voice-capture.js');
  const { spawnImpl } = fakeFfmpeg({ devices: [], recording: 'ok' });
  const capture = new VoiceCapture({ config: { micDevice: '' }, spawnImpl });
  await assert.rejects(capture.start(), /No microphone found/);
});

test('CLI command lines use only flags the real CLIs accept, and stdin payloads they parse', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  const e = new StreamEngine({ models: { claude: 'claude', codex: 'gpt-5.6-terra', gemini: 'gemini-3.8-flash-high' } });
  const claude = e.commandFor('claude', 'hi');
  assert.ok(claude.args.includes('-p') && claude.args.includes('auto') && !claude.args.includes('--model'));
  assert.ok(!claude.args.includes('accept-non-destructive') && !claude.args.includes('--input-format'));
  const codex = e.commandFor('codex', 'hi');
  assert.deepEqual(codex.args, ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-m', 'gpt-5.6-terra', '-']);
  const review = e.commandFor('codex', 'focus on races', [], { codexCommand: 'review' });
  assert.deepEqual(review.args, ['exec', 'review', '--json', '--skip-git-repo-check', '-m', 'gpt-5.6-terra', '-']);
  assert.equal(review.input, 'focus on races\n');
  const defaultReview = e.commandFor('codex', '', [], { codexCommand: 'review' });
  assert.deepEqual(defaultReview.args, ['exec', 'review', '--json', '--skip-git-repo-check', '-m', 'gpt-5.6-terra']);
  assert.equal(defaultReview.input, '');
  const gemini = e.commandFor('gemini', 'hi');
  assert.deepEqual(JSON.parse(gemini.input), { event: 'user', message: { content: 'hi' } });
});

test('vendor stream shapes (claude, codex exec --json, agy) map to delta/tool/turn_complete', () => {
  const { normalizeEvent } = require('../lib/stream-engine.js');
  assert.deepEqual(normalizeEvent({ type: 'assistant', message: { content: [{ type: 'text', text: 'OK' }] } }, 'claude'), { type: 'delta', text: 'OK', block: true, model: 'claude', agent: 'claude' });
  assert.equal(normalizeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] } }, 'claude').command, 'ls');
  assert.equal(normalizeEvent({ type: 'result', session_id: 's', result: 'OK' }, 'claude').type, 'turn_complete');
  assert.equal(normalizeEvent({ type: 'system', subtype: 'init' }, 'claude'), null);
  assert.equal(normalizeEvent({ type: 'item.completed', item: { type: 'agent_message', text: 'OK' } }, 'codex').text, 'OK');
  assert.deepEqual(normalizeEvent({ type: 'item.completed', item: { type: 'reasoning', text: 'x' } }, 'codex'), { type: 'thought', text: 'x', agent: 'codex' });
  assert.equal(normalizeEvent({ type: 'turn.completed' }, 'codex').type, 'turn_complete');
  assert.equal(normalizeEvent({ event: 'step_update', step_update: { text_delta: 'OK' } }, 'gemini').text, 'OK');
  assert.equal(normalizeEvent({ event: 'result', result: { status: 'SUCCESS' } }, 'gemini').type, 'turn_complete');
  assert.match(normalizeEvent({ event: 'result', result: { status: 'ERROR', error: 'boom' } }, 'gemini').text, /boom/);
});

test('interactive claude: control_request -> approval/question cards, clicks -> control_response on stdin', () => {
  const { StreamEngine, normalizeEvent } = require('../lib/stream-engine.js');
  const cwd = path.resolve(os.tmpdir(), 'ws');
  const e = new StreamEngine({ cwd, interactive: true });
  const spec = e.commandFor('claude', 'hi');
  assert.ok(spec.keepStdinOpen && spec.args.includes('--permission-prompt-tool') && spec.args.includes('stdio'));
  assert.deepEqual(JSON.parse(spec.input), { type: 'user', message: { role: 'user', content: 'hi' } });

  const written = [];
  e.child = { stdin: { writable: true, write: (s) => written.push(JSON.parse(s)), end() {} } };
  const events = [];
  e.on('event', (ev) => events.push(ev));
  const input = { file_path: path.join(cwd, 'probe.txt'), content: 'x' };
  e.consumeLine(JSON.stringify({ type: 'control_request', request_id: 'r1', request: { subtype: 'can_use_tool', tool_name: 'Write', input, permission_suggestions: [{ type: 'setMode', mode: 'acceptEdits' }] } }), 'claude');
  assert.equal(events[0].type, 'approval_required');
  assert.equal(events[0].file, 'probe.txt', 'card paths are workspace-relative');
  assert.equal(events[0].canAlwaysAllow, true);
  assert.equal(events[0].input, undefined, 'raw input stays in the engine');
  e.respondToApproval('r1', true, { always: true });
  assert.deepEqual(written[0].response.response, { behavior: 'allow', updatedInput: input, updatedPermissions: [{ type: 'setMode', mode: 'acceptEdits' }] });
  assert.equal(written[0].response.request_id, 'r1');

  e.consumeLine(JSON.stringify({ type: 'control_request', request_id: 'r2', request: { subtype: 'can_use_tool', tool_name: 'Bash', input: { command: 'rm x' } } }), 'claude');
  e.respondToApproval('r2', false);
  assert.equal(written[1].response.response.behavior, 'deny');

  const questions = [{ question: 'Red or blue?', options: [{ label: 'Red' }, { label: 'Blue' }] }];
  e.consumeLine(JSON.stringify({ type: 'control_request', request_id: 'r3', request: { subtype: 'can_use_tool', tool_name: 'AskUserQuestion', input: { questions } } }), 'claude');
  assert.equal(events.at(-1).type, 'question_required');
  e.respondToQuestion('r3', { 'Red or blue?': 'Blue' });
  assert.deepEqual(written[2].response.response.updatedInput, { questions, answers: { 'Red or blue?': 'Blue' } });
  assert.equal(normalizeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'AskUserQuestion', input: {} }] } }, 'claude'), null, 'no tool card for the question itself');
});

test('codex command unwrap/exit code, agy tool steps and denied_actions notice', () => {
  const { normalizeEvent, StreamEngine } = require('../lib/stream-engine.js');
  const start = normalizeEvent({ type: 'item.started', item: { id: 'i1', type: 'command_execution', command: `"C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'echo hi'` } }, 'codex');
  assert.equal(start.command, 'echo hi');
  assert.equal(normalizeEvent({ type: 'item.completed', item: { id: 'i1', type: 'command_execution', exit_code: 1 } }, 'codex').error, true);
  const step = (state, extra = {}) => normalizeEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: 3, tool_name: 'run_command', state, tool_info: { parameters: { CommandLine: 'echo hi' }, ...extra } } }, 'gemini');
  assert.deepEqual([step('ACTIVE').type, step('ACTIVE').name, step('ACTIVE').command, step('ACTIVE').toolId], ['tool_start', 'bash', 'echo hi', 'step-3']);
  assert.equal(step('ERROR', { error: { message: 'denied\nstack' } }).output, 'denied');
  const e = new StreamEngine({});
  const events = [];
  e.on('event', (ev) => events.push(ev.type));
  e.consumeLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', denied_actions: [{ action: 'write_file' }] } }), 'gemini');
  assert.deepEqual(events, ['notice', 'turn_complete']);
});

test('edit tool starts carry a diff; Gemini reads are not edits', () => {
  const { normalizeEvent } = require('../lib/stream-engine.js');
  const gem = (tool_name, parameters) => normalizeEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: 1, tool_name, state: 'ACTIVE', tool_info: { parameters } } }, 'gemini');
  const read = gem('view_file', { AbsolutePath: 'C:\\a.js' });
  assert.deepEqual([read.name, read.command, read.diff], ['view_file', 'C:\\a.js', '']);
  const edit = gem('replace_file_content', { TargetFile: 'C:\\a.js', TargetContent: 'keep\nold\nend', ReplacementContent: 'keep\nnew\nend' });
  assert.deepEqual([edit.name, edit.file, edit.diff], ['edit', 'C:\\a.js', ' keep\n-old\n+new\n end']);
  assert.equal(gem('write_to_file', { TargetFile: 'b.txt', CodeContent: 'hi' }).diff, '+hi');
  const claude = normalizeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 't', name: 'MultiEdit', input: { file_path: 'x', edits: [{ old_string: 'a', new_string: 'b' }] } }] } }, 'claude');
  assert.equal(claude.diff, '-a\n+b');
  // Codex: a new file's lines come from the file itself.
  const { StreamEngine } = require('../lib/stream-engine.js');
  const dir = require('node:fs').mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'codex-diff-'));
  require('node:fs').writeFileSync(require('node:path').join(dir, 'n.txt'), 'hi\n');
  const engine = new StreamEngine({ cwd: dir });
  let codex;
  engine.on('event', (ev) => { codex = ev; });
  engine.consumeLine(JSON.stringify({ type: 'item.completed', item: { id: 'i', type: 'file_change', changes: [{ path: 'n.txt', kind: 'add' }] } }), 'codex');
  assert.deepEqual([codex.name, codex.diff, 'changes' in codex], ['edit', '+hi', false]);
  // An edited file shows only Codex's change, not the user's earlier unstaged one.
  const run = (...args) => require('node:child_process').execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { cwd: dir, stdio: 'ignore' });
  const write = (text) => require('node:fs').writeFileSync(require('node:path').join(dir, 'n.txt'), text);
  run('init', '-q'); run('add', '.'); run('commit', '-qm', 'base');
  write('mine\n');
  engine.consumeLine(JSON.stringify({ type: 'turn.started' }), 'codex');
  write('codex\n');
  engine.consumeLine(JSON.stringify({ type: 'item.completed', item: { id: 'j', type: 'file_change', changes: [{ path: 'n.txt', kind: 'update' }] } }), 'codex');
  assert.equal(codex.diff, '-mine\n+codex');
});

// Summarize only after every test in this file has registered (setImmediate
// runs after the module body), so async tests defined further down are
// awaited too.
setImmediate(() => Promise.all(pendingTests).then(() => {
  if (failures > 0) {
    console.error(`\n${failures} test(s) failed.`);
    process.exitCode = 1;
  }
}));

test('quota bridge passes full 5h/7d windows per provider, Antigravity included', () => {
  const { shapeQuotas } = require('../lib/quota-bridge.js');
  const shaped = shapeQuotas({
    claude: { used: 38, remaining: 62, resetsAt: 1000, windowMinutes: 300 },
    claudeWeekly: { used: 19, remaining: 81, resetsAt: 9000, windowMinutes: 10080 },
    codex: { used: 86, remaining: 14, resetsAt: 500, windowMinutes: 300, secondary: { used: 45, remaining: 55, resetsAt: 7000, windowMinutes: 10080 } },
    gemini: { used: 20, remaining: 80, resetsAt: 600, windowMinutes: 300, secondary: { used: 73, remaining: 27, resetsAt: 8000, windowMinutes: 10080 } },
  });
  assert.deepEqual(shaped.claude, { remaining: 62, used: 38, resetsAt: 1000, windowMinutes: 300, windowLabel: '5h', secondary: { remaining: 81, used: 19, resetsAt: 9000, windowMinutes: 10080, windowLabel: '7d' } });
  assert.equal(shaped.codex.secondary.remaining, 55);
  assert.equal(shaped.gemini.secondary.remaining, 27);
  assert.equal(shapeQuotas({ gemini: null }).gemini, null, 'no model-name placeholder when there is no live quota');
});

test('P17-B: Opus shares Claude\'s 5h window and prefers the Opus-only weekly cap for its 7d gauge', () => {
  const { shapeQuotas } = require('../lib/quota-bridge.js');
  const claude = { used: 42, remaining: 58, resetsAt: 1000, windowMinutes: 300 };
  const claudeWeekly = { used: 19, remaining: 81, resetsAt: 9000, windowMinutes: 10080 };
  const withCap = shapeQuotas({ claude, claudeWeekly, claudeOpus: { used: 70, remaining: 30, resetsAt: 9500, windowMinutes: 10080 } });
  assert.equal(withCap.opus.remaining, 58);
  assert.equal(withCap.opus.secondary.remaining, 30);
  assert.equal(shapeQuotas({ claude, claudeWeekly }).opus.secondary.remaining, 81, 'no Opus cap on this plan: the all-models week');
  assert.equal(shapeQuotas({}).opus, null);
});

test('composer model picker: each catalog entry reaches its CLI as model + effort flags', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  const { MODEL_CATALOG, modelOption } = require('../lib/model-catalog.js');
  const e = new StreamEngine({ interactive: true });
  const claude = e.commandFor('claude', 'hi', [], modelOption('claude-opus-5-5-medium')).args;
  assert.deepEqual(claude.slice(claude.indexOf('--model')), ['--model', 'claude-opus-5-5', '--effort', 'medium']);
  const codex = e.commandFor('codex', 'hi', [], modelOption('gpt-5.6-terra-high')).args;
  assert.deepEqual(codex.slice(-5), ['-m', 'gpt-5.6-terra', '-c', 'model_reasoning_effort="high"', '-']);
  const gemini = e.commandFor('gemini', 'hi', [], modelOption('gemini-3.8-flash-high')).args;
  assert.equal(gemini[gemini.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.ok(!e.commandFor('codex', 'hi').args.includes('-c'), 'no picker choice: the configured default, no effort override');
  assert.equal(new Set(MODEL_CATALOG.map((option) => option.id)).size, MODEL_CATALOG.length, 'ids are unique');
  assert.ok(MODEL_CATALOG.every((option) => ['claude', 'codex', 'gemini'].includes(option.agent) && option.label));
});

test('P17-A: Opus 5.5 is a branded Claude model, and family names resolve to catalog entries', () => {
  const { modelOption, resolveModel } = require('../lib/model-catalog.js');
  const opus = modelOption('claude-opus-5-5-medium');
  assert.deepEqual([opus.agent, opus.brand, opus.model, opus.effort, opus.shortLabel], ['claude', 'opus', 'claude-opus-5-5', 'medium', 'Opus']);
  assert.equal(opus.hint, undefined, 'no benchmark line under Opus in the picker');
  assert.equal(resolveModel('opus').id, 'claude-opus-5-5-medium');
  assert.equal(resolveModel('Claude Opus 5.5').id, 'claude-opus-5-5-medium');
  assert.equal(resolveModel('SONNET').id, 'claude-sonnet-5-high');
  assert.equal(resolveModel('terra').agent, 'codex');
  assert.equal(resolveModel('gemini-3.8-flash-high').agent, 'gemini');
  assert.equal(resolveModel('haiku'), null);
});

test('P17-D: a claude CLI that rejects Opus 5.5 reruns the turn once on Sonnet, but never after output started', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  const e = new StreamEngine({ interactive: true });
  const starts = [];
  e.start = (turn) => { starts.push(turn); };
  const events = [];
  e.on('event', (event) => events.push(event));

  e.fallback = { agent: 'claude', prompt: 'refactor', attachments: [] };
  e.sawOutput = false;
  e.consumeLine("error: unknown option '--effort'", 'claude');
  assert.deepEqual(starts, [{ agent: 'claude', prompt: 'refactor', attachments: [], model: 'claude-sonnet-5', effort: 'high' }]);
  assert.equal(events[0].type, 'notice');
  assert.match(events[0].text, /Opus 5\.5/);

  e.consumeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }), 'claude');
  e.consumeLine('the model was not found in that file', 'claude');
  assert.equal(starts.length, 1, 'text after real output is the answer, not a CLI failure');

  const sonnet = new StreamEngine({});
  sonnet.commandFor = () => ({ command: null }); // no spawn: only the fallback bookkeeping matters
  sonnet.start({ agent: 'claude', prompt: 'x', model: 'claude-sonnet-5' });
  assert.equal(sonnet.fallback, null, 'only an Opus turn has a fallback');
});

test('P17-F: interrupt() ends the turn visibly, kills the whole process tree, and ignores the dying process', () => {
  const { StreamEngine, killTree } = require('../lib/stream-engine.js');
  const calls = [];
  const child = { pid: 4242, exitCode: null, signalCode: null, kill: () => calls.push(['kill']) };
  killTree(child, (file, args) => calls.push([file, ...args]));
  if (process.platform === 'win32') assert.deepEqual(calls, [['taskkill', '/PID', '4242', '/T', '/F']]);
  else assert.deepEqual(calls, [['kill']]);
  calls.length = 0;
  killTree({ ...child, exitCode: 0 }, (file, args) => calls.push([file, ...args]));
  assert.equal(calls.length, 0, 'an exited process is left alone');

  const e = new StreamEngine({});
  const events = [];
  e.on('event', (event) => events.push(event));
  assert.equal(e.interrupt(), false, 'nothing running: nothing to report');
  e.child = { exitCode: 0, signalCode: null, stdin: { writable: false } };
  assert.equal(e.interrupt(), true);
  assert.deepEqual(events, [{ type: 'turn_complete', interrupted: true }]);
  assert.equal(e.child, null);
});

test('P17-H: a task left "dispatched" by a restart loads as "interrupted", persisted, and Reschedule returns it to pending', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-orphan-'));
  const queue = new SchedulerQueue({ workspaceDir: root });
  const orphan = await queue.enqueue({ model: 'claude', prompt: 'overnight refactor', dispatchTrigger: 'quota-reset' });
  const waiting = await queue.enqueue({ model: 'codex', prompt: 'later', dispatchTrigger: 'quota-reset' });
  await queue.markDispatched(orphan.id);

  const afterRestart = new SchedulerQueue({ workspaceDir: root });
  const task = (await afterRestart.getQueue()).find((item) => item.id === orphan.id);
  assert.equal(task.status, 'interrupted');
  assert.ok(!Number.isNaN(Date.parse(task.interruptedAt)));
  assert.match(task.interruptedReason, /restart, shutdown, or window reload/);
  assert.equal((await afterRestart.getQueue()).find((item) => item.id === waiting.id).status, 'pending', 'pending tasks are untouched');
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.astro', 'session', 'scheduler-queue.json'), 'utf8'));
  assert.equal(onDisk.find((item) => item.id === orphan.id).status, 'interrupted', 'reconciled state is written back at once');

  assert.equal(await afterRestart.reschedule(waiting.id), false, 'a pending task is not rescheduled');
  assert.equal(await afterRestart.reschedule(orphan.id), true);
  const rescheduled = (await afterRestart.getQueue()).find((item) => item.id === orphan.id);
  assert.equal(rescheduled.status, 'pending');
  assert.equal(rescheduled.interruptedAt, undefined);
  assert.equal(rescheduled.interruptedReason, undefined);
  assert.equal((await afterRestart.getNextPendingForModel('claude')).id, orphan.id, 'the watchdog picks it up again');
  fs.rmSync(root, { recursive: true, force: true });
});

test('chat memory: each CLI resumes its own session by id, and a missing session reruns fresh', () => {
  const { StreamEngine, normalizeEvent } = require('../lib/stream-engine.js');
  const engine = new StreamEngine({ cwd: process.cwd(), models: { claude: 'claude', codex: 'gpt-5.6-terra', gemini: 'gemini-3.8-flash-high' } });
  assert.deepEqual(engine.commandFor('claude', 'hi', [], { resume: 'c-1' }).args.slice(-2), ['--resume', 'c-1']);
  assert.deepEqual(engine.commandFor('codex', 'hi', [], { resume: 'x-1' }).args.slice(0, 3), ['exec', 'resume', 'x-1']);
  assert.ok(!engine.commandFor('codex', 'hi', [], { resume: 'x-1' }).args.includes('--sandbox'), 'exec resume takes no --sandbox');
  assert.deepEqual(engine.commandFor('gemini', 'hi', [], { resume: 'g-1' }).args.slice(-2), ['--conversation', 'g-1']);
  assert.ok(!engine.commandFor('claude', 'hi', []).args.includes('--resume'), 'no id, no resume');

  assert.deepEqual(normalizeEvent({ type: 'system', subtype: 'init', session_id: 'c-1' }, 'claude'), { type: 'session', sessionId: 'c-1', agent: 'claude' });
  assert.deepEqual(normalizeEvent({ type: 'thread.started', thread_id: 'x-1' }, 'codex'), { type: 'session', sessionId: 'x-1', agent: 'codex' });
  assert.deepEqual(normalizeEvent({ event: 'init', conversation_id: 'g-1' }, 'gemini'), { type: 'session', sessionId: 'g-1', agent: 'gemini' });

  const restarts = [];
  engine.start = function (options) { restarts.push(options); };
  for (const line of ['No conversation found with session ID: c-1', 'Error: thread/resume: thread/resume failed: no rollout found for thread id x-1', 'warning: conversation "g-1" not found']) {
    engine.resumeRetry = { agent: 'claude', prompt: 'FULL HANDOFF + request' };
    engine.sawOutput = false;
    engine.consumeLine(line, 'claude');
  }
  assert.equal(restarts.length, 3);
  assert.ok(restarts.every((options) => options.prompt === 'FULL HANDOFF + request' && !options.resume));
});

test('chat memory: the handoff briefs only missed turns, without tool output, within budget', () => {
  const { buildHandoff } = require('../lib/chat-handoff.js');
  assert.equal(buildHandoff([], 'claude'), '');
  const handoff = buildHandoff([
    { role: 'user', text: 'Pick a codename', agent: 'codex' },
    { role: 'assistant', text: 'NIGHT-HERON, written to docs/codename.md', agent: 'codex' },
    { role: 'tool', event: { name: 'edit', command: 'added codename.md', output: 'SECRET RAW OUTPUT' } },
  ], 'gemini');
  assert.match(handoff, /User: Pick a codename/);
  assert.match(handoff, /Codex answered: NIGHT-HERON/);
  assert.match(handoff, /Codex used: edit added codename\.md/);
  assert.doesNotMatch(handoff, /SECRET RAW OUTPUT/);
  const long = Array.from({ length: 60 }, (_, i) => [{ role: 'user', text: `question ${i} ${'x'.repeat(500)}`, agent: 'claude' }, { role: 'assistant', text: `answer ${i} ${'y'.repeat(2000)}`, agent: 'claude' }]).flat();
  const clipped = buildHandoff(long, 'codex');
  assert.ok(clipped.length < 12000, `handoff stays small (${clipped.length} chars)`);
  assert.match(clipped, /earlier turns omitted/);
  assert.match(clipped, /question 59/, 'the newest turns are the ones kept');
});

test('compaction: a checkpoint bounds the briefing and always survives the budget', () => {
  const { buildHandoff, checkpointStart } = require('../lib/chat-handoff.js');
  const before = [{ role: 'user', text: 'old secret question', agent: 'gemini' }, { role: 'assistant', text: 'old answer', agent: 'gemini' }];
  assert.equal(checkpointStart(before), 0, 'no checkpoint: brief from the start');
  const failed = [...before, { role: 'user', text: 'Compact session', compact: true }, { role: 'assistant', text: 'Gemini error: quota', compact: true, agent: 'gemini' }];
  assert.equal(checkpointStart(failed), 0, 'a failed compaction is not a checkpoint');
  const summary = `# CONTEXT CHECKPOINT SUMMARY\n- **Primary Goal:** ship P17-R ${'z'.repeat(3000)}`;
  const long = Array.from({ length: 20 }, (_, i) => [{ role: 'user', text: `after ${i} ${'x'.repeat(500)}`, agent: 'gemini' }, { role: 'assistant', text: 'y'.repeat(2000), agent: 'gemini' }]).flat();
  const messages = [...before, { role: 'user', text: 'Compact session', compact: true }, { role: 'assistant', text: summary, compact: true, checkpoint: true, agent: 'gemini' }, ...long];
  const from = checkpointStart(messages);
  assert.equal(from, 2, 'briefing starts at the Compact session message');
  const handoff = buildHandoff(messages.slice(from), 'gemini');
  assert.doesNotMatch(handoff, /old secret question/, 'nothing from before the checkpoint');
  assert.match(handoff, /CHECKPOINT: everything in this chat before this point/);
  assert.ok(handoff.includes('z'.repeat(3000)), 'the summary goes in whole, not clipped to an answer');
  assert.match(handoff, /after 19/, 'recent turns still follow it');
});
