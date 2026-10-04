'use strict';

// P17-U: pure-logic tests only (parsers, stream normalization, queue and
// quota math, stores on a temp dir). No mocked `vscode` runtime, no browser:
// UI and glue code is verified against the acceptance criteria directly,
// and `node test/check.js` covers syntax for every script.

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');

const os = require('node:os');
const TEST_CWD = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-workspace-'));
process.on('exit', () => fs.rmdirSync(TEST_CWD));
const { writeMicroHandoff, readMicroHandoff, formatMicroHandoffPrompt, MAX_CHARS } = require('../lib/handoff.js');
const { SchedulerQueue, MAX_QUEUE_SIZE, MAX_ATTACHMENT_BYTES } = require('../lib/scheduler-queue.js');
const { TelegramBridge } = require('../lib/telegram-bridge.js');
const { CodexCommandCatalog, methodNamesFromSchema, parseInvocation } = require('../lib/codex-commands.js');
const { CodexAppServer, commandsForMethods } = require('../lib/codex-app-server.js');
const { SlashCommandCatalog } = require('../lib/slash-commands.js');
require('./model-fixture').seedModels();

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

test('Codex slash commands are capability-gated by the installed App Server schema', async () => {
  const methods = new Set(['review/start', 'thread/goal/get', 'thread/goal/set', 'thread/goal/clear', 'thread/compact/start']);
  let calls = 0;
  const catalog = new CodexCommandCatalog({
    locateImpl: () => ({ path: 'codex' }),
    discoverMethodsImpl: async () => { calls++; return methods; },
  });
  assert.equal(await catalog.resolve('ordinary prompt'), null);
  assert.equal(calls, 0, 'ordinary turns do not probe the Codex binary');
  assert.deepEqual(methodNamesFromSchema({ oneOf: [{ properties: { method: { enum: ['review/start'] } } }] }), new Set(['review/start']));
  assert.deepEqual((await catalog.list()).map((entry) => entry.name), ['review', 'goal', 'compact']);
  assert.deepEqual(commandsForMethods(methods).map((entry) => entry.name), ['review', 'goal', 'compact']);
  assert.equal((await catalog.resolve('/review focus on races')).prompt, 'focus on races');
  assert.equal((await catalog.resolve('/goal ship the app')).prompt, 'ship the app');
  assert.equal((await catalog.resolve('/review')).prompt, '');
  assert.equal(await catalog.resolve('/mcp'), null, 'unsupported installed methods are not advertised');
  assert.equal(parseInvocation('/unknown', await catalog.list()), null);
  assert.equal(calls, 1, 'the generated schema is cached');
});

test('Codex App Server speaks newline-delimited requests and performs the native initialize handshake', async () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writable = true;
  child.stdin.end = () => { child.stdin.writable = false; };
  child.kill = () => {};
  const written = [];
  child.stdin.write = (line) => {
    const message = JSON.parse(line);
    written.push(message);
    if (message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { userAgent: 'codex-test' } })}\n`)));
    if (message.method === 'model/list') queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: { data: [{ id: 'gpt-test' }] } })}\n`)));
    return true;
  };
  const server = new CodexAppServer({ cwd: os.tmpdir(), locateImpl: () => ({ path: 'codex' }), spawnImpl: () => child });
  const notifications = [];
  server.on('notification', (message) => notifications.push(message));
  await server.connect();
  assert.deepEqual(written.slice(0, 2).map((message) => message.method), ['initialize', 'initialized']);
  assert.equal('jsonrpc' in written[0], false, 'App Server JSONL is not JSON-RPC 2.0');
  assert.deepEqual(await server.request('model/list', {}), { data: [{ id: 'gpt-test' }] });
  child.stdout.emit('data', Buffer.from(`${JSON.stringify({ method: 'skills/changed', params: {} })}\n`));
  assert.equal(notifications[0].method, 'skills/changed');
  server.dispose();
});

test('Codex App Server kills a failed initializer and ignores that stale child after reconnecting', async () => {
  const children = [];
  const makeChild = (answerInitialize) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.stdin = new EventEmitter();
    child.stdin.writable = true;
    child.stdin.end = () => { child.stdin.writable = false; };
    child.kill = () => { child.killed = true; };
    child.stdin.write = (line) => {
      const message = JSON.parse(line);
      if (answerInitialize && message.method === 'initialize') queueMicrotask(() => child.stdout.emit('data', Buffer.from(`${JSON.stringify({ id: message.id, result: {} })}\n`)));
      return true;
    };
    return child;
  };
  const server = new CodexAppServer({
    cwd: os.tmpdir(), timeoutMs: 5, locateImpl: () => ({ path: 'codex' }),
    spawnImpl: () => { const child = makeChild(children.length > 0); children.push(child); return child; },
  });
  await assert.rejects(server.connect(), /no response/);
  assert.equal(children[0].killed, true);
  await server.connect();
  children[0].emit('close', 1);
  assert.equal(server.child, children[1], 'a superseded child cannot close the replacement connection');
  server.dispose();
});

test('Codex turns, native commands, approvals, and questions use one persistent App Server thread', async () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  class FakeServer extends EventEmitter {
    constructor() { super(); this.calls = []; this.responses = []; }
    async connect() {}
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-1' } };
      if (method === 'turn/start' || method === 'review/start') return { turn: { id: 'turn-1' } };
      if (method === 'thread/goal/set') return { goal: { objective: params.objective, status: 'active' } };
      return {};
    }
    respond(id, result) { this.responses.push({ id, result }); }
    dispose() {}
  }
  const server = new FakeServer();
  const engine = new StreamEngine({ cwd: TEST_CWD, interactive: true, codexServerFactory: () => server });
  const events = [];
  engine.on('event', (event) => events.push(event));
  engine.start({ agent: 'codex', prompt: 'hello', model: 'gpt-test', effort: 'high' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(server.calls.map((call) => call.method), ['thread/start', 'turn/start']);
  assert.equal(server.calls[1].params.threadId, 'thread-1');
  assert.deepEqual(server.calls[1].params.input, [{ type: 'text', text: 'hello' }]);
  assert.equal(server.calls[0].params.sandbox, 'danger-full-access');
  assert.equal(server.calls[0].params.approvalPolicy, 'never');
  assert.deepEqual(server.calls[1].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(server.calls[1].params.approvalPolicy, 'never');
  assert.equal(events.find((event) => event.type === 'session')?.sessionId, 'thread-1');

  server.emit('request', { id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'npm test', reason: 'Run tests' } });
  const approval = events.findLast((event) => event.type === 'approval_required');
  assert.equal(approval.command, 'npm test');
  assert.equal(engine.respondToApproval(approval.actionId, true, { always: true }), true);
  assert.deepEqual(server.responses.at(-1), { id: 7, result: { decision: 'acceptForSession' } });

  const questions = [{ id: 'scope', header: 'Scope', question: 'Which scope?', options: [{ label: 'All', description: 'Everything' }] }];
  server.emit('request', { id: 8, method: 'item/tool/requestUserInput', params: { questions } });
  const question = events.findLast((event) => event.type === 'question_required');
  assert.equal(engine.respondToQuestion(question.actionId, { 'Which scope?': 'All' }), true);
  assert.deepEqual(server.responses.at(-1), { id: 8, result: { answers: { scope: { answers: ['All'] } } } });

  server.emit('notification', { method: 'item/agentMessage/delta', params: { delta: 'Done' } });
  server.emit('notification', { method: 'turn/completed', params: { turn: { id: 'turn-1', status: 'completed' } } });
  assert.equal(events.findLast((event) => event.type === 'delta').text, 'Done');
  assert.equal(events.at(-1).type, 'turn_complete');

  engine.start({ agent: 'codex', prompt: 'Ship it', model: 'gpt-test', codexCommand: 'goal', resume: 'thread-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.calls.filter((call) => call.method === 'thread/start').length, 1, 'commands reuse the loaded thread');
  assert.equal(server.calls.findLast((call) => call.method === 'thread/goal/set').params.objective, 'Ship it');
  assert.match(events.findLast((event) => event.type === 'delta').text, /Ship it/);

  engine.start({ agent: 'codex', prompt: '', model: 'gpt-test', codexCommand: 'compact', resume: 'thread-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.calls.at(-1).method, 'thread/compact/start');
  assert.equal(engine.codexActive, true, 'compaction stays active until the server confirms it finished');
  server.emit('notification', { method: 'thread/compacted', params: { threadId: 'thread-1', turnId: 'compact-1' } });
  assert.equal(engine.codexActive, false);

  engine.start({ agent: 'codex', prompt: '', model: 'gpt-test', codexCommand: 'review', resume: 'thread-1' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(server.calls.findLast((call) => call.method === 'review/start').params.target, { type: 'uncommittedChanges' });
  engine.dispose();
});

test('late notifications from an interrupted Codex turn cannot complete its replacement', async () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  class RacingServer extends EventEmitter {
    constructor() { super(); this.turns = []; }
    async connect() {}
    async request(method) {
      if (method === 'thread/start') return { thread: { id: 'thread-race' } };
      if (method === 'turn/interrupt') return {};
      if (method === 'turn/start') return new Promise((resolve) => this.turns.push(resolve));
      return {};
    }
    respond() {}
    dispose() {}
  }
  const server = new RacingServer();
  const engine = new StreamEngine({ cwd: TEST_CWD, codexServerFactory: () => server });
  const events = [];
  engine.on('event', (event) => events.push(event));
  engine.start({ agent: 'codex', prompt: 'old', model: 'gpt-test' });
  await new Promise((resolve) => setImmediate(resolve));
  server.emit('notification', { method: 'turn/started', params: { threadId: 'thread-race', turn: { id: 'old-turn' } } });
  assert.equal(engine.interrupt(), true);
  engine.start({ agent: 'codex', prompt: 'new', model: 'gpt-test', resume: 'thread-race' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(server.turns.length, 2);
  server.turns[0]({ turn: { id: 'old-turn' } });
  server.turns[1]({ turn: { id: 'new-turn' } });
  await new Promise((resolve) => setImmediate(resolve));
  const beforeStale = events.filter((event) => event.type === 'turn_complete').length;
  server.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-race', turn: { id: 'old-turn', status: 'completed' } } });
  assert.equal(events.filter((event) => event.type === 'turn_complete').length, beforeStale);
  server.emit('notification', { method: 'item/agentMessage/delta', params: { threadId: 'thread-race', turnId: 'new-turn', delta: 'new answer' } });
  server.emit('notification', { method: 'turn/completed', params: { threadId: 'thread-race', turn: { id: 'new-turn', status: 'completed' } } });
  assert.equal(events.findLast((event) => event.type === 'delta').text, 'new answer');
  assert.equal(events.filter((event) => event.type === 'turn_complete').length, beforeStale + 1);
  engine.dispose();
});

test('slash command ownership stays with the explicitly selected provider', async () => {
  let claudeProbes = 0;
  let geminiProbes = 0;
  const catalog = new SlashCommandCatalog({
    codexCommands: { list: async () => [{ name: 'review', description: 'Review changes' }] },
    workspaceDir: os.tmpdir(),
    cacheFile: path.join(os.tmpdir(), `missing-slash-cache-${process.pid}.json`),
    claudeHome: path.join(os.tmpdir(), `missing-claude-home-${process.pid}`),
    probe: async () => { claudeProbes++; return null; },
    probeGemini: async () => {
      geminiProbes++;
      return [
        { name: 'goal', description: 'Run until the specified goal is completely finished.' },
        { name: 'grill-me', description: 'Interview me to align on a plan.' },
        { name: 'plan', description: 'Plan carefully before executing a task.' },
      ];
    },
  });
  catalog.claudeLive = ['compact', 'review'];
  assert.equal(await catalog.owner('/review', 'codex'), 'codex');
  assert.equal(claudeProbes, 0, 'Codex command lookup does not touch Claude');
  assert.equal(geminiProbes, 0, 'Codex command lookup does not touch Gemini');
  assert.equal(await catalog.owner('/review', 'claude'), 'claude');
  assert.equal(await catalog.owner('/compact', 'codex'), null);
  assert.equal(await catalog.owner('/compact', 'auto'), 'claude');

  // Antigravity (Gemini) exclusivity & aliases
  assert.equal(await catalog.owner('/goal', 'gemini'), 'gemini');
  assert.equal(await catalog.owner('/grill-me', 'gemini'), 'gemini');
  assert.equal(await catalog.owner('/grillme', 'gemini'), 'gemini');
  assert.equal(await catalog.owner('/goal', 'codex'), null);
  assert.equal(await catalog.owner('/goal', 'claude'), null);
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
  assert.deepEqual(pkg.contributes.configuration.properties['aiChatPanel.models'].default, {});
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
  const engine = new StreamEngine({ cwd: TEST_CWD });
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

test('missing quota readings report every provider as unknown', () => {
  process.env.AI_CHAT_PANEL_QUOTA_CACHE = path.join(os.tmpdir(), `ai-chat-panel-test-unknown-${process.pid}.json`); // nothing remembered either
  const { shapeQuotas } = require('../lib/quota-bridge.js');
  assert.deepEqual(shapeQuotas({}), { claude: null, claudeWeekly: null, claudeOpus: null, opus: null, codex: null, gemini: null });
});

test('quota-sources reads Codex rate limits from session logs, with no other extension', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-quota-codex-'));
  const now = new Date();
  const day = path.join(home, 'sessions', String(now.getFullYear()), String(now.getMonth() + 1).padStart(2, '0'), String(now.getDate()).padStart(2, '0'));
  fs.mkdirSync(day, { recursive: true });
  const resetsAt = Math.floor(Date.now() / 1000) + 3600;
  fs.writeFileSync(path.join(day, 'rollout.jsonl'), JSON.stringify({ timestamp: now.toISOString(), payload: { rate_limits: { primary: { used_percent: 29, window_minutes: 300, resets_at: resetsAt } } } }) + '\n');
  const saved = { claude: process.env.CLAUDE_CONFIG_DIR, codex: process.env.CODEX_HOME };
  process.env.CLAUDE_CONFIG_DIR = home;
  process.env.CODEX_HOME = home;
  try {
    const { getQuotas } = require('../lib/quota-sources.js');
    const { codex, gemini, claude } = await getQuotas({ readGemini: async () => null });
    assert.equal(codex.remaining, 71);
    assert.equal(codex.resetsAt, resetsAt);
    assert.equal(gemini, null);
    assert.equal(claude, null);
  } finally {
    for (const [name, key] of [['claude', 'CLAUDE_CONFIG_DIR'], ['codex', 'CODEX_HOME']]) {
      if (saved[name] === undefined) delete process.env[key]; else process.env[key] = saved[name];
    }
  }
});

test('session dir: Clanker keeps its own storage and copies a legacy session folder once', () => {
  const { resolveSessionDir } = require('../lib/session-dir.js');
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-session-'));
  const legacy = path.join(base, 'legacy');
  fs.mkdirSync(path.join(legacy, 'chats'), { recursive: true });
  fs.writeFileSync(path.join(legacy, 'chats', 'a.json'), '{}');
  fs.writeFileSync(path.join(legacy, 'batch-tasks.json'), '[]'); // someone else's file: not Clanker's to take
  const storageDir = path.join(base, 'storage');

  const dir = resolveSessionDir({ storageDir, legacyDirs: [legacy, undefined], override: '' });
  assert.equal(dir, path.join(storageDir, 'session'));
  assert.ok(fs.existsSync(path.join(dir, 'chats', 'a.json')), 'chats are carried over');
  assert.ok(!fs.existsSync(path.join(dir, 'batch-tasks.json')), 'only Clanker\'s own files are copied');

  fs.writeFileSync(path.join(legacy, 'chats', 'b.json'), '{}');
  resolveSessionDir({ storageDir, legacyDirs: [legacy], override: '' });
  assert.ok(!fs.existsSync(path.join(dir, 'chats', 'b.json')), 'the legacy folder is never read a second time');
  assert.equal(resolveSessionDir({ storageDir, override: '/somewhere/else' }), '/somewhere/else');
});

test('voice dictionary: terms are added once, listed when enabled, and merged without repeats', async () => {
  const dictionary = require('../lib/voice-dictionary.js');
  const dictionaryFile = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-dict-')), 'dict.json');
  assert.deepEqual(dictionary.listEnabledTerms({ dictionaryFile }), [], 'a missing file is an empty dictionary');
  dictionary.addTerm({ dictionaryFile }, 'Tecnomatix');
  dictionary.addTerm({ dictionaryFile }, 'tecnomatix ');
  assert.deepEqual(dictionary.listEnabledTerms({ dictionaryFile }), ['Tecnomatix']);
  assert.throws(() => dictionary.addTerm({ dictionaryFile }, ''), /empty/);
  assert.throws(() => dictionary.addTerm({ dictionaryFile }, 'x'.repeat(61)), /60/);
  process.env.OPENWHISPR_DB_PATH = path.join(os.tmpdir(), 'no-such-openwhispr.db');
  assert.deepEqual(await dictionary.vocabulary({ dictionaryFile }), ['Tecnomatix']);
  delete process.env.OPENWHISPR_DB_PATH;
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

test('Manage Chats: ChatStore provides separate title and lastMessage preview, tracking user/assistant', () => {
  const { ChatStore, deriveFallbackTitle, findLastMessage } = require('../lib/chat-store.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-chat-preview-'));
  const store = new ChatStore(root);

  // 1. Fallback title derivation
  assert.equal(deriveFallbackTitle([{ role: 'user', text: 'How do I rework managed chat bubbles cleanly?' }]), 'How do I rework managed');
  assert.equal(deriveFallbackTitle([{ role: 'user', text: '/review check the diff' }]), 'check the diff');
  assert.equal(deriveFallbackTitle([]), 'New chat');

  // 2. Chat with user message and assistant reply
  const chat = store.create();
  chat.messages.push({ role: 'user', text: 'First user prompt that starts the session' });
  chat.messages.push({ role: 'tool', event: { toolId: 't1' } });
  chat.messages.push({ role: 'assistant', text: 'First assistant reply from Codex', agent: 'codex' });
  const saved = store.save(chat);

  let list = store.list();
  assert.equal(list.length, 1);
  assert.equal(list[0].title, 'First user prompt that starts');
  assert.equal(list[0].customTitle, false);
  assert.ok(list[0].lastMessage);
  assert.equal(list[0].lastMessage.role, 'assistant');
  assert.equal(list[0].lastMessage.agent, 'codex');
  assert.equal(list[0].lastMessage.text, 'First assistant reply from Codex');

  // 3. User responds next -> lastMessage becomes user
  chat.messages.push({ role: 'user', text: 'Second user message: sounds good' });
  store.save(chat);
  list = store.list();
  assert.equal(list[0].lastMessage.role, 'user');
  assert.equal(list[0].lastMessage.text, 'Second user message: sounds good');

  // 4. Renaming sets custom title and customTitle flag
  store.rename(saved.id, 'Managed Bubble Redesign');
  list = store.list();
  assert.equal(list[0].title, 'Managed Bubble Redesign');
  assert.equal(list[0].customTitle, true);
  // lastMessage remains untouched
  assert.equal(list[0].lastMessage.text, 'Second user message: sounds good');

  // 5. Clearing title reverts customTitle
  store.rename(saved.id, '');
  list = store.list();
  assert.equal(list[0].title, 'First user prompt that starts');
  assert.equal(list[0].customTitle, false);

  fs.rmSync(root, { recursive: true, force: true });
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

test('Auto selects a live favorite, avoids low quota, and leaves task scope unrestricted', () => {
  const { route } = require('../lib/auto-router.js');
  const ui = route('Improve the CSS layout animation', { claude: { remaining: 80 } }, 'auto');
  assert.ok(require('../lib/model-catalog').MODEL_CATALOG.some(model => model.id === ui.modelId));
  assert.equal(ui.prompt, 'Improve the CSS layout animation');
  assert.equal(ui.directive, '');
  const backend = route('Fix the AST parser schema', { codex: { remaining: 10 } }, 'auto');
  assert.notEqual(backend.agent, 'codex');
  const split = route('Connect the UI CSS with the backend IPC parser', {}, 'auto');
  assert.equal(split.split, false);
  assert.equal(split.contract, '');
  for (const agent of ['claude', 'codex', 'gemini']) {
    const manual = route('Change the UI and backend together', {}, agent);
    assert.equal(manual.agent, agent);
    assert.equal(manual.prompt, 'Change the UI and backend together');
    assert.equal(manual.directive, '');
    assert.equal(manual.contract, '');
    assert.equal(manual.roleName, null);
  }
});

test('P15-F: SchedulerQueue stages attachments, preserves FIFO, and validates limits', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-scheduler-'));
  const source = path.join(root, 'diagram.txt');
  fs.writeFileSync(source, 'attachment content');
  const queue = new SchedulerQueue({ workspaceDir: root });
  const task = await queue.enqueue({ model: 'codex', prompt: 'Fix the backend', attachments: [], dispatchTrigger: 'quota-reset' }, [source]);
  assert.match(task.id, /^sched_/);
  assert.equal(task.attachments.length, 1);
  assert.match(task.attachments[0].relativePath, /^\.clanker\/session\/scheduler\//);
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
  let buttons;
  bridge.api = async (method, payload) => { if (method === 'sendMessage') buttons = payload.reply_markup; return true; };
  await bridge.sendApprovalRequest('Approve this task?', 'sched_123');
  await bridge.handleUpdate({ callback_query: { id: 'callback-1', from: { id: 42 }, message: { chat: { id: 42, type: 'private' }, message_id: 1 }, data: buttons.inline_keyboard[0][0].callback_data } });
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
  const e = new StreamEngine({ models: { claude: 'claude', codex: 'gpt-6.1-sol', gemini: 'gemini-3.8-flash-high' } });
  const claude = e.commandFor('claude', 'hi');
  assert.ok(claude.args.includes('-p') && claude.args.includes('auto') && !claude.args.includes('--model'));
  assert.ok(!claude.args.includes('accept-non-destructive') && !claude.args.includes('--input-format'));
  const codex = e.commandFor('codex', 'hi');
  assert.deepEqual(codex.args, ['exec', '--json', '--sandbox', 'danger-full-access', '-c', 'approval_policy="never"', '-c', 'approvals_reviewer="user"', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', '-']);
  const review = e.commandFor('codex', 'focus on races', [], { codexCommand: 'review' });
  assert.deepEqual(review.args, ['exec', 'review', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol', '-']);
  assert.equal(review.input, 'focus on races\n');
  const defaultReview = e.commandFor('codex', '', [], { codexCommand: 'review', codexCommandArgs: ['--uncommitted'] });
  assert.deepEqual(defaultReview.args, ['exec', 'review', '--uncommitted', '--json', '--skip-git-repo-check', '-m', 'gpt-6.1-sol']);
  assert.equal(defaultReview.input, '');
  const gemini = e.commandFor('gemini', 'hi');
  assert.deepEqual(JSON.parse(gemini.input), { event: 'user', message: { content: 'hi' } });
});

test('vendor stream shapes (claude, codex exec --json, agy) map to delta/tool/turn_complete', () => {
  const { normalizeEvent, contextTokensOf } = require('../lib/stream-engine.js');
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
  assert.equal(contextTokensOf({ type: 'turn.completed', usage: { input_tokens: 4601075, output_tokens: 1000 } }), 0, 'Codex turn consumption is not context occupancy');
  assert.equal(contextTokensOf({ type: 'assistant', message: { usage: { input_tokens: 100, cache_read_input_tokens: 200, output_tokens: 10 } } }), 310);
  assert.equal(contextTokensOf({ event: 'step_update', step_update: { usage: { input_tokens: 142000, output_tokens: 500 } } }), 142500, 'Gemini step_update provides live context tokens');
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

  // Historical stream interruption error on a successful/resumed reply is ignored
  const e2 = new StreamEngine({});
  const deltas2 = [];
  e2.on('event', (ev) => { if (ev.type === 'delta') deltas2.push(ev.text); });
  e2.hadText = true;
  e2.consumeLine(JSON.stringify({ event: 'result', result: { status: 'ERROR', response: 'OK\n', error: 'The stream was interrupted. Please continue the task you were working on.' } }), 'gemini');
  assert.deepEqual(deltas2, [], 'suppresses stream interrupted error when text was already produced');

  // Genuine failure with no text produces the error delta
  const e3 = new StreamEngine({});
  const deltas3 = [];
  e3.on('event', (ev) => { if (ev.type === 'delta') deltas3.push(ev.text); });
  e3.consumeLine(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'quota exceeded' } }), 'gemini');
  assert.equal(deltas3[0], 'Gemini error: quota exceeded', 'reports error when no text was produced');
});

test('edit tool starts carry a diff; Gemini reads are not edits', () => {
  const { normalizeEvent } = require('../lib/stream-engine.js');
  const gem = (tool_name, parameters) => normalizeEvent({ event: 'step_update', step_update: { step_type: 'tool', step_index: 1, tool_name, state: 'ACTIVE', tool_info: { parameters } } }, 'gemini');
  const read = gem('view_file', { AbsolutePath: 'C:\\a.js' });
  assert.deepEqual([read.name, read.command, read.diff], ['view_file', 'C:\\a.js', '']);
  assert.equal(gem('search_web', { query: 'astro visual editor' }).command, 'astro visual editor');
  assert.equal(gem('manage_task', { Action: 'status', TaskId: 'task-1' }).command, 'status task-1');
  assert.equal(gem('read_url_content', { Url: 'https://example.com' }).command, 'https://example.com');
  assert.equal(gem('schedule', { DurationSeconds: 60, Prompt: 'check build' }).command, '60s check build');
  assert.equal(gem('invoke_subagent', { Subagents: [{ Role: 'Codebase Researcher' }] }).command, 'Codebase Researcher');
  assert.equal(gem('send_message', { Recipient: 'agent-1', Message: 'hello' }).command, 'agent-1: hello');
  assert.equal(gem('generate_image', { ImageName: 'hero', Prompt: 'a sunset' }).command, 'hero: a sunset');
  assert.equal(gem('ask_question', { questions: [{ question: 'Which mode?' }] }).command, 'Which mode?');
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

// Quota tests get their own reset cache and resets in the future (the bridge treats past resets as fresh windows).
const quotaCache = (name) => { process.env.AI_CHAT_PANEL_QUOTA_CACHE = path.join(os.tmpdir(), `ai-chat-panel-test-${name}-${process.pid}.json`); };
const SOON = Math.floor(Date.now() / 1000) + 3600;

test('quota bridge passes full 5h/7d windows per provider, Antigravity included', () => {
  quotaCache('windows');
  const { shapeQuotas } = require('../lib/quota-bridge.js');
  assert.equal(shapeQuotas({ gemini: null }).gemini, null, 'no model-name placeholder when there is no quota, live or remembered');
  const shaped = shapeQuotas({
    claude: { used: 38, remaining: 62, resetsAt: SOON, windowMinutes: 300 },
    claudeWeekly: { used: 19, remaining: 81, resetsAt: SOON + 9000, windowMinutes: 10080 },
    codex: { used: 86, remaining: 14, resetsAt: SOON, windowMinutes: 300, secondary: { used: 45, remaining: 55, resetsAt: SOON + 7000, windowMinutes: 10080 } },
    gemini: { used: 20, remaining: 80, resetsAt: SOON, windowMinutes: 300, secondary: { used: 73, remaining: 27, resetsAt: SOON + 8000, windowMinutes: 10080 } },
  });
  assert.deepEqual(shaped.claude, { remaining: 62, used: 38, resetsAt: SOON, windowMinutes: 300, windowLabel: '5h', secondary: { remaining: 81, used: 19, resetsAt: SOON + 9000, windowMinutes: 10080, windowLabel: '7d' } });
  assert.equal(shaped.codex.secondary.remaining, 55);
  assert.equal(shaped.gemini.secondary.remaining, 27);
});

test('quota bridge: a window whose reset time has passed counts as fresh, even with no new reading', () => {
  quotaCache('reset');
  const { shapeQuotas } = require('../lib/quota-bridge.js');
  const past = Math.floor(Date.now() / 1000) - 60;
  assert.equal(shapeQuotas({ claude: { used: 100, remaining: 0, resetsAt: past, windowMinutes: 300 } }).claude.remaining, 100, 'stale reading after its reset');
  shapeQuotas({ claude: { used: 100, remaining: 0, resetsAt: SOON, windowMinutes: 300 } });
  assert.equal(shapeQuotas({ claude: null }).claude.remaining, 0, 'no reading: the remembered one until its reset');
});

test('quota bridge: a fresh "0% used" reading with no reset time beats the status bar\'s stale "0% left"', () => {
  quotaCache('undated');
  const { shapeQuotas, recordClaudeUsage } = require('../lib/quota-bridge.js');
  const stale = { claude: { used: 100, remaining: 0, resetsAt: null, windowMinutes: 300 } };
  assert.equal(shapeQuotas(stale).claude.remaining, 0, 'nothing newer: still 0% left');
  recordClaudeUsage({ fiveHour: { used: 0, resetsAt: null }, sevenDay: null }); // /usage right after a reset: no "resets ..." yet
  assert.equal(shapeQuotas(stale).claude.remaining, 100, 'after the probe: the new window, so a waiting task may fire');
});

test('P17-B: Opus shares Claude\'s 5h window and prefers the Opus-only weekly cap for its 7d gauge', () => {
  quotaCache('opus');
  const { shapeQuotas } = require('../lib/quota-bridge.js');
  const claude = { used: 42, remaining: 58, resetsAt: SOON, windowMinutes: 300 };
  const claudeWeekly = { used: 19, remaining: 81, resetsAt: SOON + 9000, windowMinutes: 10080 };
  const withCap = shapeQuotas({ claude, claudeWeekly, claudeOpus: { used: 70, remaining: 30, resetsAt: SOON + 9500, windowMinutes: 10080 } });
  assert.equal(withCap.opus.remaining, 58);
  assert.equal(withCap.opus.secondary.remaining, 30);
  assert.equal(shapeQuotas({ claude, claudeWeekly }).opus.secondary.remaining, 81, 'no Opus cap on this plan: the all-models week');
  quotaCache('opus-never-seen');
  assert.equal(shapeQuotas({}).opus, null, 'nothing read and nothing remembered');
});

test('composer model picker: each catalog entry reaches its CLI as model + effort flags', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  const { MODEL_CATALOG, modelOption } = require('../lib/model-catalog.js');
  const e = new StreamEngine({ interactive: true });
  const claude = e.commandFor('claude', 'hi', [], modelOption('claude-opus-5-5-medium')).args;
  assert.deepEqual(claude.slice(claude.indexOf('--model')), ['--model', 'claude-opus-5-5', '--effort', 'medium']);
  const codex = e.commandFor('codex', 'hi', [], modelOption('gpt-6.1-sol-high')).args;
  assert.deepEqual(codex.slice(-5), ['-m', 'gpt-6.1-sol', '-c', 'model_reasoning_effort="high"', '-']);
  const gemini = e.commandFor('gemini', 'hi', [], modelOption('gemini-3.8-flash-high')).args;
  assert.equal(gemini[gemini.indexOf('--model') + 1], 'gemini-3.8-flash-high');
  assert.ok(!e.commandFor('codex', 'hi').args.some((arg) => arg.startsWith('model_reasoning_effort=')), 'no picker choice: no effort override');
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
  assert.equal(resolveModel('SONNET').id, 'claude-sonnet-5-5-high');
  assert.equal(resolveModel('sol').agent, 'codex');
  assert.equal(resolveModel('Astra').id, 'gpt-6-astra-high');
  assert.equal(resolveModel('gpt-6-luna').id, 'gpt-6-luna-high');
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
  assert.deepEqual(starts, [{ agent: 'claude', prompt: 'refactor', attachments: [], model: 'claude-sonnet-5-5', effort: 'high' }]);
  assert.equal(events[0].type, 'notice');
  assert.match(events[0].text, /selected Opus model/);

  e.consumeLine(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Working on it.' }] } }), 'claude');
  e.consumeLine('the model was not found in that file', 'claude');
  assert.equal(starts.length, 1, 'text after real output is the answer, not a CLI failure');

  const sonnet = new StreamEngine({});
  sonnet.commandFor = () => ({ command: null }); // no spawn: only the fallback bookkeeping matters
  sonnet.start({ agent: 'claude', prompt: 'x', model: 'claude-sonnet-5-5' });
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
  const onDisk = JSON.parse(fs.readFileSync(path.join(root, '.clanker', 'session', 'scheduler-queue.json'), 'utf8'));
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
  const engine = new StreamEngine({ cwd: process.cwd(), models: { claude: 'claude', codex: 'gpt-6.1-sol', gemini: 'gemini-3.8-flash-high' } });
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
  const { buildHandoff, buildCompactionHandoff, checkpointStart, estimateTokens, COMPACT_DIRECTIVE, COMPACT_TARGET_TOKENS } = require('../lib/chat-handoff.js');
  const before = [{ role: 'user', text: 'old secret question', agent: 'gemini' }, { role: 'assistant', text: 'old answer', agent: 'gemini' }];
  assert.equal(checkpointStart(before), 0, 'no checkpoint: brief from the start');
  const failed = [...before, { role: 'user', text: 'Compact session', compact: true }, { role: 'assistant', text: 'Gemini error: quota', compact: true, agent: 'gemini' }];
  assert.equal(checkpointStart(failed), 0, 'a failed compaction is not a checkpoint');
  const summary = `# CONTEXT CHECKPOINT SUMMARY\n- **Primary Goal:** ship P17-R ${'z'.repeat(3000)}`;
  const long = Array.from({ length: 20 }, (_, i) => [{ role: 'user', text: `after ${i} ${'x'.repeat(500)}`, agent: 'gemini' }, { role: 'assistant', text: 'y'.repeat(2000), agent: 'gemini' }]).flat();
  const retained = `detailed chronology ${'d'.repeat(60000)}`;
  const messages = [...before, { role: 'user', text: 'Compact session', compact: true }, { role: 'assistant', text: summary, compactContext: retained, compact: true, checkpoint: true, agent: 'gemini' }, ...long];
  const from = checkpointStart(messages);
  assert.equal(from, 2, 'briefing starts at the Compact session message');
  const handoff = buildHandoff(messages.slice(from), 'gemini');
  assert.doesNotMatch(handoff, /old secret question/, 'nothing from before the checkpoint');
  assert.match(handoff, /CHECKPOINT: everything in this chat before this point, retained/);
  assert.ok(handoff.includes('z'.repeat(3000)), 'the summary goes in whole, not clipped to an answer');
  assert.match(handoff, /detailed chronology/, 'the hidden detailed context survives alongside the generated summary');
  assert.match(handoff, /after 19/, 'recent turns still follow it');
  const rich = buildCompactionHandoff(long, 'codex');
  assert.ok(rich.length > 40000 && rich.length <= COMPACT_TARGET_TOKENS * 4 + 1000, `rich handoff uses the larger bounded budget (${rich.length} chars)`);
  assert.ok(estimateTokens(rich) > estimateTokens(buildHandoff(long, 'codex')), 'compaction retains more detail than an ordinary cross-agent briefing');
  const repeated = buildCompactionHandoff(messages, 'codex');
  assert.ok(repeated.length <= COMPACT_TARGET_TOKENS * 4 + 1000, 'repeated compaction shares one budget between the checkpoint and newer turns');
  assert.match(repeated, /after 19/, 'repeated compaction prioritizes the newest work');
  assert.match(COMPACT_DIRECTIVE, /100,000 tokens/);
});

test('Claude usage: rate-limit events and /usage text both yield the 5h and weekly windows', () => {
  const { fromRateLimitEvent, parseUsageText } = require('../lib/claude-usage.js');
  const event = { type: 'rate_limit_event', rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.79, resetsAt: 1790307600 }, seven_day: { utilization: 0.64, resetsAt: 1790341200 } } } };
  assert.deepEqual(fromRateLimitEvent(event), { fiveHour: { used: 79, resetsAt: 1790307600 }, sevenDay: { used: 64, resetsAt: 1790341200 } });
  assert.equal(fromRateLimitEvent({ type: 'rate_limit_event' }), null);

  const now = new Date(2026, 8, 25, 1, 0);
  const text = 'Current session: 77% used · resets Sep 25, 5:39am (Europe/Berlin)\nCurrent week (all models): 65% used · resets Sep 25, 2:59pm (Europe/Berlin)';
  const parsed = parseUsageText(text, now);
  assert.equal(parsed.fiveHour.used, 77);
  assert.equal(parsed.fiveHour.resetsAt, new Date(2026, 8, 25, 5, 39).getTime() / 1000);
  assert.equal(parsed.sevenDay.used, 65);
  assert.equal(parsed.sevenDay.resetsAt, new Date(2026, 8, 25, 14, 59).getTime() / 1000);
  assert.equal(parseUsageText('Unknown command', now), null);

  const text24h = 'Current session: 80% used · resets Sep 25, 17:45 (Europe/Berlin)\nCurrent week (all models): 50% used · resets Sep 25, 22:00';
  const parsed24h = parseUsageText(text24h, now);
  assert.equal(parsed24h.fiveHour.used, 80);
  assert.equal(parsed24h.fiveHour.resetsAt, new Date(2026, 8, 25, 17, 45).getTime() / 1000);
  assert.equal(parsed24h.sevenDay.used, 50);
  assert.equal(parsed24h.sevenDay.resetsAt, new Date(2026, 8, 25, 22, 0).getTime() / 1000);
});

test('quota bridge: Claude\'s own recorded numbers beat a stale status-bar reading until their window ends', () => {
  quotaCache('claude-live');
  const { shapeQuotas, recordClaudeUsage } = require('../lib/quota-bridge.js');
  recordClaudeUsage({ fiveHour: { used: 77, resetsAt: SOON }, sevenDay: { used: 65, resetsAt: SOON + 9000 } });
  const shaped = shapeQuotas({ claude: { used: 0, remaining: 100, resetsAt: SOON, windowMinutes: 300 } });
  assert.equal(shaped.claude.remaining, 23);
  assert.equal(shaped.claude.secondary.remaining, 35);
});

test('Claude subagent lines become subagent events, never part of the main reply', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  const e = new StreamEngine({ cwd: TEST_CWD, interactive: true });
  const events = [];
  e.on('event', (ev) => events.push(ev));
  const line = (raw) => e.consumeLine(JSON.stringify(raw), 'claude');
  line({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'tool_use', id: 'call1', name: 'Agent', input: { description: 'Audit the site', subagent_type: 'Explore', prompt: 'Find X' } }] } });
  line({ type: 'user', parent_tool_use_id: 'call1', message: { content: 'Find X' } });
  line({ type: 'assistant', parent_tool_use_id: 'call1', message: { content: [{ type: 'text', text: 'Looking.' }] } });
  line({ type: 'assistant', parent_tool_use_id: 'call1', message: { content: [{ type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'a.md' } }] } });
  line({ type: 'user', parent_tool_use_id: null, message: { content: [{ type: 'tool_result', tool_use_id: 'call1', content: 'Found X.' }] } });

  const start = events.find((ev) => ev.type === 'subagent_start');
  assert.deepEqual([start.id, start.description, start.subagentType, start.prompt], ['call1', 'Audit the site', 'Explore', 'Find X']);
  // The Agent call itself still shows as a step in the main chat.
  assert.ok(events.some((ev) => ev.type === 'tool_start' && ev.toolId === 'call1'));
  const inner = events.filter((ev) => ev.type === 'subagent_event').map((ev) => ev.event.type);
  assert.deepEqual(inner, ['task', 'delta', 'tool_start']);
  assert.ok(!events.some((ev) => ev.type === 'delta'), 'subagent text stays out of the main reply');
  assert.deepEqual(events.find((ev) => ev.type === 'subagent_end'), { type: 'subagent_end', id: 'call1', output: 'Found X.', error: false, launched: false, agent: 'claude' });
  assert.equal(e.subagentIds.size, 0);

  // A background launch keeps it working until the CLI says otherwise.
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'call2', name: 'Task', input: { description: 'Long job', run_in_background: true } }] } });
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'call2', content: 'Async agent launched successfully.' }] } });
  assert.equal(events.find((ev) => ev.type === 'subagent_end' && ev.id === 'call2').launched, true);
  assert.ok(e.subagentIds.has('call2'));
  line({ type: 'system', subtype: 'task_notification', tool_use_id: 'call2', status: 'completed', summary: 'Done' });
  assert.deepEqual([events.at(-1).type, events.at(-1).status], ['subagent_status', 'completed']);
});

test('A turn that ends with background agents running keeps its Claude process until they finish', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  const e = new StreamEngine({ cwd: TEST_CWD, interactive: true });
  const written = [];
  let ended = 0;
  e.child = { stdin: { writable: true, write: (s) => written.push(JSON.parse(s)), end() { ended += 1; } } };
  const events = [];
  e.on('event', (ev) => events.push(ev));
  const line = (raw) => e.consumeLine(JSON.stringify(raw), 'claude');
  line({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'bg1', name: 'Agent', input: { description: 'Research', run_in_background: true } }] } });
  line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'bg1', content: 'Async agent launched successfully.' }] } });
  line({ type: 'result', session_id: 's1' });
  assert.equal(ended, 0, 'closing stdin would kill the background agent');
  assert.equal(e.lingering, e.child);

  // The next message goes into the same process instead of spawning (and killing) anew.
  const child = e.child;
  assert.equal(e.start({ agent: 'claude', prompt: 'next' }), child);
  assert.equal(written.at(-1).message.content, 'next');
  line({ type: 'result', session_id: 's1' });
  assert.equal(ended, 0);

  // The agent finishing lets the process go.
  line({ type: 'system', subtype: 'task_notification', tool_use_id: 'bg1', status: 'completed' });
  assert.equal(ended, 1, 'no agents left and the turn is over: the process may close');
  assert.equal(e.lingering, null);
});

test('unified permission selector: effectivePermissionMode, CLI flags, fallback, and resumed chats', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');

  // 1. effectivePermissionMode logic & defaults
  const defaultEngine = new StreamEngine();
  assert.equal(defaultEngine.effectivePermissionMode('claude'), 'auto', 'claude defaults to auto when unset');
  assert.equal(defaultEngine.effectivePermissionMode('codex'), 'fullAccess', 'codex defaults to fullAccess when unset');
  assert.equal(defaultEngine.effectivePermissionMode('gemini'), 'fullAccess', 'gemini defaults to fullAccess when unset');
  assert.equal(defaultEngine.effectivePermissionMode('claude', 'ask'), 'ask', 'explicit override takes precedence');

  const askEngine = new StreamEngine({ permissionMode: 'ask' });
  assert.equal(askEngine.effectivePermissionMode('claude'), 'ask');
  assert.equal(askEngine.effectivePermissionMode('codex'), 'ask');
  assert.equal(askEngine.effectivePermissionMode('gemini'), 'ask');

  const autoEngine = new StreamEngine({ permissionMode: 'auto' });
  assert.equal(autoEngine.effectivePermissionMode('claude'), 'auto');
  assert.equal(autoEngine.effectivePermissionMode('codex'), 'auto');
  assert.equal(autoEngine.effectivePermissionMode('gemini'), 'auto');

  const fullEngine = new StreamEngine({ permissionMode: 'fullAccess' });
  assert.equal(fullEngine.effectivePermissionMode('claude'), 'fullAccess');
  assert.equal(fullEngine.effectivePermissionMode('codex'), 'fullAccess');
  assert.equal(fullEngine.effectivePermissionMode('gemini'), 'fullAccess');

  // 2. Claude command line across modes (interactive and non-interactive)
  const interactiveAsk = new StreamEngine({ interactive: true, permissionMode: 'ask' });
  const claudeInteractiveAsk = interactiveAsk.commandFor('claude', 'test prompt');
  assert.ok(claudeInteractiveAsk.args.includes('--permission-mode'));
  assert.equal(claudeInteractiveAsk.args[claudeInteractiveAsk.args.indexOf('--permission-mode') + 1], 'manual');
  assert.ok(claudeInteractiveAsk.args.includes('--permission-prompt-tool'));
  assert.equal(claudeInteractiveAsk.args[claudeInteractiveAsk.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.ok(!claudeInteractiveAsk.args.includes('--dangerously-skip-permissions'));
  assert.equal(claudeInteractiveAsk.keepStdinOpen, true);

  const interactiveAuto = new StreamEngine({ interactive: true, permissionMode: 'auto' });
  const claudeInteractiveAuto = interactiveAuto.commandFor('claude', 'test prompt');
  assert.ok(claudeInteractiveAuto.args.includes('--permission-mode'));
  assert.equal(claudeInteractiveAuto.args[claudeInteractiveAuto.args.indexOf('--permission-mode') + 1], 'auto');
  assert.ok(claudeInteractiveAuto.args.includes('--permission-prompt-tool'));
  assert.equal(claudeInteractiveAuto.args[claudeInteractiveAuto.args.indexOf('--permission-prompt-tool') + 1], 'stdio');
  assert.ok(!claudeInteractiveAuto.args.includes('--dangerously-skip-permissions'));
  assert.equal(claudeInteractiveAuto.keepStdinOpen, true);

  const interactiveFull = new StreamEngine({ interactive: true, permissionMode: 'fullAccess' });
  const claudeInteractiveFull = interactiveFull.commandFor('claude', 'test prompt');
  assert.ok(claudeInteractiveFull.args.includes('--dangerously-skip-permissions'));
  assert.ok(!claudeInteractiveFull.args.includes('--permission-mode'));
  assert.ok(!claudeInteractiveFull.args.includes('--permission-prompt-tool'));
  assert.equal(claudeInteractiveFull.keepStdinOpen, false);

  // Claude non-interactive
  const nonInteractiveAsk = new StreamEngine({ interactive: false, permissionMode: 'ask' });
  const claudeNonInteractiveAsk = nonInteractiveAsk.commandFor('claude', 'test prompt');
  assert.ok(claudeNonInteractiveAsk.args.includes('--permission-mode'));
  assert.equal(claudeNonInteractiveAsk.args[claudeNonInteractiveAsk.args.indexOf('--permission-mode') + 1], 'manual');
  assert.ok(!claudeNonInteractiveAsk.args.includes('--permission-prompt-tool'));
  assert.ok(!claudeNonInteractiveAsk.args.includes('--dangerously-skip-permissions'));

  const nonInteractiveFull = new StreamEngine({ interactive: false, permissionMode: 'fullAccess' });
  const claudeNonInteractiveFull = nonInteractiveFull.commandFor('claude', 'test prompt');
  assert.ok(claudeNonInteractiveFull.args.includes('--dangerously-skip-permissions'));

  // Claude resume across modes
  const claudeResume = interactiveAsk.commandFor('claude', 'test prompt', [], { resume: 'session-xyz' });
  assert.ok(claudeResume.args.includes('--resume'));
  assert.equal(claudeResume.args[claudeResume.args.indexOf('--resume') + 1], 'session-xyz');
  assert.ok(claudeResume.args.includes('--permission-mode'));

  // 3. Codex command line across modes
  const codexFull = fullEngine.commandFor('codex', 'test prompt');
  assert.deepEqual(codexFull.args.slice(1, 4), ['--json', '--sandbox', 'danger-full-access']);
  assert.ok(!codexFull.args.includes('--approve-for-me'));
  assert.ok(codexFull.args.includes('approval_policy="never"'));

  const codexAuto = autoEngine.commandFor('codex', 'test prompt');
  assert.deepEqual(codexAuto.args.slice(1, 5), ['--json', '--sandbox', 'workspace-write', '--approve-for-me']);
  assert.ok(codexAuto.args.includes('approvals_reviewer="auto_review"'));

  const codexAsk = askEngine.commandFor('codex', 'test prompt');
  assert.deepEqual(codexAsk.args.slice(1, 4), ['--json', '--sandbox', 'workspace-write']);
  assert.ok(!codexAsk.args.includes('--approve-for-me'));
  assert.ok(codexAsk.args.includes('approval_policy="on-request"'));
  assert.ok(codexAsk.args.includes('approvals_reviewer="user"'));

  // Codex resume
  const codexResume = askEngine.commandFor('codex', 'test prompt', [], { resume: 'thread-xyz' });
  assert.equal(codexResume.args[0], 'exec');
  assert.equal(codexResume.args[1], 'resume');
  assert.equal(codexResume.args[2], 'thread-xyz');
  assert.ok(codexResume.args.includes('sandbox_mode="workspace-write"'));
  assert.ok(codexResume.args.includes('approval_policy="on-request"'));
  assert.ok(codexResume.args.includes('approvals_reviewer="user"'));
  const codexAutoResume = autoEngine.commandFor('codex', 'test prompt', [], { resume: 'thread-xyz' });
  assert.ok(codexAutoResume.args.includes('approvals_reviewer="auto_review"'));
  const codexFullResume = fullEngine.commandFor('codex', 'test prompt', [], { resume: 'thread-xyz' });
  assert.ok(codexFullResume.args.includes('sandbox_mode="danger-full-access"'));
  assert.ok(codexFullResume.args.includes('approval_policy="never"'));

  // 4. Gemini (Antigravity) command line across modes
  const geminiFull = fullEngine.commandFor('gemini', 'test prompt');
  assert.ok(geminiFull.args.includes('--dangerously-skip-permissions'), 'fullAccess grants --dangerously-skip-permissions to Gemini');

  const geminiAsk = askEngine.commandFor('gemini', 'test prompt');
  assert.ok(!geminiAsk.args.includes('--dangerously-skip-permissions'), 'ask mode does not include --dangerously-skip-permissions for Gemini');

  const geminiAuto = autoEngine.commandFor('gemini', 'test prompt');
  assert.ok(!geminiAuto.args.includes('--dangerously-skip-permissions'), 'auto mode leaves Gemini restricted; headless denied actions are skipped');

  // Gemini resume across modes
  const geminiResume = autoEngine.commandFor('gemini', 'test prompt', [], { resume: 'conv-123' });
  assert.ok(geminiResume.args.includes('--conversation'));
  assert.equal(geminiResume.args[geminiResume.args.indexOf('--conversation') + 1], 'conv-123');
  assert.ok(!geminiResume.args.includes('--dangerously-skip-permissions'));
});

test('Codex App Server thread/start, thread/resume, and turn/start follow permissionMode', async () => {
  const { StreamEngine } = require('../lib/stream-engine.js');

  class MockCodexServer extends EventEmitter {
    constructor() { super(); this.calls = []; }
    async connect() {}
    async request(method, params) {
      this.calls.push({ method, params });
      if (method === 'thread/start') return { thread: { id: 'thread-perm-1' } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') return { turn: { id: 'turn-perm-1' } };
      return {};
    }
    respond() {}
    dispose() {}
  }

  // Test Auto mode on Codex App Server
  const autoServer = new MockCodexServer();
  const autoEngine = new StreamEngine({ cwd: TEST_CWD, interactive: true, permissionMode: 'auto', codexServerFactory: () => autoServer });
  autoEngine.start({ agent: 'codex', prompt: 'check code' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(autoServer.calls[0].method, 'thread/start');
  assert.equal(autoServer.calls[0].params.sandbox, 'workspace-write');
  assert.equal(autoServer.calls[0].params.approvalPolicy, 'on-request');
  assert.equal(autoServer.calls[0].params.approvalsReviewer, 'auto_review');

  assert.equal(autoServer.calls[1].method, 'turn/start');
  assert.equal(autoServer.calls[1].params.sandboxPolicy.type, 'workspaceWrite');
  assert.deepEqual(autoServer.calls[1].params.sandboxPolicy, {
    type: 'workspaceWrite', writableRoots: [TEST_CWD], networkAccess: false,
    excludeTmpdirEnvVar: false, excludeSlashTmp: false,
  });
  assert.equal(autoServer.calls[1].params.approvalPolicy, 'on-request');
  assert.equal(autoServer.calls[1].params.approvalsReviewer, 'auto_review');

  // Test Ask mode on Codex App Server (with resume)
  const askServer = new MockCodexServer();
  const askEngine = new StreamEngine({ cwd: TEST_CWD, interactive: true, permissionMode: 'ask', codexServerFactory: () => askServer });
  askEngine.start({ agent: 'codex', prompt: 'edit file', resume: 'existing-thread-99' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(askServer.calls[0].method, 'thread/resume');
  assert.equal(askServer.calls[0].params.threadId, 'existing-thread-99');
  assert.equal(askServer.calls[0].params.sandbox, 'workspace-write');
  assert.equal(askServer.calls[0].params.approvalPolicy, 'on-request');
  assert.equal(askServer.calls[0].params.approvalsReviewer, 'user');

  assert.equal(askServer.calls[1].method, 'turn/start');
  assert.equal(askServer.calls[1].params.sandboxPolicy.type, 'workspaceWrite');
  assert.equal(askServer.calls[1].params.approvalPolicy, 'on-request');
  assert.equal(askServer.calls[1].params.approvalsReviewer, 'user');

  const fullServer = new MockCodexServer();
  const fullEngine = new StreamEngine({ cwd: TEST_CWD, interactive: true, permissionMode: 'fullAccess', codexServerFactory: () => fullServer });
  fullEngine.start({ agent: 'codex', prompt: 'inspect code' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(fullServer.calls[0].params.sandbox, 'danger-full-access');
  assert.equal(fullServer.calls[0].params.approvalPolicy, 'never');
  assert.deepEqual(fullServer.calls[1].params.sandboxPolicy, { type: 'dangerFullAccess' });
  assert.equal(fullServer.calls[1].params.approvalPolicy, 'never');
});

test('storage sweep removes only old, unreferenced attachments and finished tasks\' staging', () => {
  const { sweepStorage, GRACE_MS } = require('../lib/storage-gc.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-gc-'));
  const now = Date.now();
  const old = new Date(now - GRACE_MS - 1000);
  const put = (rel, text, when) => { const file = path.join(root, rel); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); fs.utimesSync(file, when, when); };
  put('attachments/1_inchat.png', 'x', old);
  put('attachments/2_inqueue.png', 'x', old);
  put('attachments/3_orphan.png', 'x', old);
  put('attachments/4_young.png', 'x', new Date(now));
  put('chats/1_a.json', JSON.stringify({ messages: [{ attachments: [path.join('C:', 's', 'attachments', '1_inchat.png')] }] }), old);
  const day = 864e5;
  const tasks = [
    { id: 'sched_done', status: 'done', completedAt: new Date(now - GRACE_MS - day).toISOString(), attachments: ['2_inqueue.png'] },
    { id: 'sched_fresh_done', status: 'done', completedAt: new Date(now - day).toISOString() },
    { id: 'sched_pending', status: 'pending' },
    { id: 'sched_failed', status: 'failed', completedAt: new Date(now - GRACE_MS - day).toISOString() },
  ];
  put('scheduler-queue.json', JSON.stringify(tasks), old);
  for (const id of ['sched_done', 'sched_fresh_done', 'sched_pending', 'sched_failed']) put(`scheduler/${id}/attachments/f.txt`, 'x', old);
  put('scheduler/sched_gone/attachments/f.txt', 'x', old);
  fs.utimesSync(path.join(root, 'scheduler/sched_gone'), old, old);
  fs.utimesSync(path.join(root, 'scheduler/sched_fresh_done'), old, old);

  const removed = sweepStorage(root, { now });
  const left = (dir) => fs.readdirSync(path.join(root, dir)).sort();
  assert.deepEqual(left('attachments'), ['1_inchat.png', '2_inqueue.png', '4_young.png'], 'only the old orphan goes: used by a chat, named in the queue, or too young stay');
  assert.deepEqual(left('scheduler'), ['sched_failed', 'sched_fresh_done', 'sched_pending'], 'finished-long-ago and vanished tasks lose their staging; pending, failed and recent ones keep it');
  assert.equal(removed.attachments, 1);
  assert.equal(removed.staging, 2);
  assert.doesNotThrow(() => sweepStorage(path.join(root, 'does-not-exist')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('a quota-reset task waits for the reset moment it was scheduled against, even while quota is left', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-notbefore-'));
  const queue = new SchedulerQueue({ workspaceDir: root, sessionDir: root });
  const { isDue } = require('../lib/scheduler-queue.js');
  const later = new Date(Date.now() + 3 * 3600e3).toISOString();
  const waiting = await queue.enqueue({ model: 'claude', prompt: 'later', dispatchTrigger: 'quota-reset', notBefore: later });
  const plain = await queue.enqueue({ model: 'codex', prompt: 'no reset known', dispatchTrigger: 'quota-reset' });
  const fixed = await queue.enqueue({ model: 'gemini', prompt: 'not before either', dispatchTrigger: 'fixed-time', dispatchTime: new Date(Date.now() - 1000).toISOString(), notBefore: later });
  assert.equal(waiting.notBefore, later);
  assert.equal(plain.notBefore, undefined, 'no reset known: quota alone decides, as before');
  assert.equal(fixed.notBefore, undefined, 'a fixed-time task has its own time');
  assert.equal(await queue.getNextPendingForModel('claude'), null, 'three hours to go: not due');
  assert.ok(await queue.getNextPendingForModel('codex'));
  assert.equal(isDue(waiting, Date.parse(later) + 1), true, 'due once the reset has passed');
  fs.rmSync(root, { recursive: true, force: true });
});

test('tool cards in main.js map Antigravity, Claude, and Codex tools to clean labels and icons', () => {
  const vm = require('node:vm');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'media', 'main.js'), 'utf8');
  const match = mainSrc.match(/(const SHELL_TOOLS[\s\S]*?function toolDisplayName\([\s\S]*?\n  \})/);
  assert.ok(match, 'found toolKind and toolDisplayName in main.js');
  const context = vm.createContext({});
  vm.runInContext(`${match[1]}; this.toolKind = toolKind; this.toolDisplayName = toolDisplayName;`, context);
  const { toolKind, toolDisplayName } = context;

  assert.equal(toolDisplayName('view_file', toolKind('view_file')), 'View');
  assert.equal(toolKind('view_file'), 'read');
  assert.equal(toolDisplayName('search_web', toolKind('search_web')), 'Web Search');
  assert.equal(toolKind('search_web'), 'web');
  assert.equal(toolDisplayName('manage_task', toolKind('manage_task')), 'ManageTask');
  assert.equal(toolKind('manage_task'), 'task');

  assert.equal(toolDisplayName('run_command', toolKind('run_command')), 'Run');
  assert.equal(toolKind('run_command'), 'shell');
  assert.equal(toolDisplayName('replace_file_content', toolKind('replace_file_content')), 'Edit');
  assert.equal(toolKind('replace_file_content'), 'edit');
  assert.equal(toolDisplayName('write_to_file', toolKind('write_to_file')), 'Edit');
  assert.equal(toolDisplayName('read_url_content', toolKind('read_url_content')), 'Web Fetch');
  assert.equal(toolKind('read_url_content'), 'web');
  assert.equal(toolDisplayName('invoke_subagent', toolKind('invoke_subagent')), 'Subagent');
  assert.equal(toolKind('invoke_subagent'), 'agent');
  assert.equal(toolDisplayName('schedule', toolKind('schedule')), 'Schedule');
  assert.equal(toolKind('schedule'), 'schedule');
  assert.equal(toolDisplayName('generate_image', toolKind('generate_image')), 'Image');
  assert.equal(toolKind('generate_image'), 'image');
  assert.equal(toolDisplayName('ask_question', toolKind('ask_question')), 'Question');
  assert.equal(toolKind('ask_question'), 'question');
});

test('compaction: StreamEngine flags compact turn and notifyReply suppresses chime under NO_CHIME', () => {
  const { StreamEngine } = require('../lib/stream-engine.js');
  const { notifyReply } = require('../lib/notify.js');

  const engine = new StreamEngine({ cwd: TEST_CWD, codexServerFactory: () => ({ connect: async () => {}, request: async () => ({}) }) });
  engine.turn = null;
  engine.resetCodexTurn({ agent: 'codex', prompt: 'test', compact: true });
  assert.equal(engine.turn?.compact, true);

  const origNoChime = process.env.NO_CHIME;
  try {
    process.env.NO_CHIME = '1';
    assert.doesNotThrow(() => notifyReply({ toast: null, chime: true }));
  } finally {
    if (origNoChime === undefined) delete process.env.NO_CHIME;
    else process.env.NO_CHIME = origNoChime;
  }
});
