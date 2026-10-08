'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromKeyEvent, parse } = require('../media/voice-hotkey.js');
const { createHotkeyHandlers, MIN_HOLD_MS } = require('../lib/voice-hotkey.js');
const { parseDuration, parseRateHeaders, GroqAccount } = require('../lib/groq-account.js');

test('dictation cleanup requests text processing only and retains dictionary hints', async () => {
  const { cleanDictation } = await import('../../voice-router/lib/groq-client.mjs');
  const previousFetch = global.fetch;
  const previousKey = process.env.GROQ_API_KEY;
  let request;
  try {
    process.env.GROQ_API_KEY = 'test-key-no-network';
    global.fetch = async (url, options) => {
      request = { url, ...JSON.parse(options.body) };
      return { ok: true, json: async () => ({ choices: [{ message: { content: 'Fix the SimTalk method.' } }] }) };
    };
    assert.equal(await cleanDictation('fix the sim talk method', { dictionaryTerms: ['SimTalk'] }), 'Fix the SimTalk method.');
    assert.match(request.messages[0].content, /EXCLUSIVELY a text processor/);
    assert.doesNotMatch(request.messages[0].content, /primaryIntent|ui_aesthetics|backend_ast|targetModel/);
    assert.match(request.messages[1].content, /SimTalk/);
    assert.match(request.messages[1].content, /fix the sim talk method/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});

test('standalone cleanup rejects a provider response cut off by its output limit', async () => {
  const { cleanDictation } = await import('../../voice-router/lib/groq-client.mjs');
  const previousFetch = global.fetch, previousKey = process.env.GROQ_API_KEY;
  try {
    process.env.GROQ_API_KEY = 'test-key-no-network';
    global.fetch = async () => ({ ok: true, json: async () => ({
      choices: [{ finish_reason: 'length', message: { content: 'This sentence is cut' } }],
    }) });
    await assert.rejects(cleanDictation('This sentence is cut off, and here is the final sentence.'), /preserving the full raw transcript/);
  } finally {
    global.fetch = previousFetch;
    if (previousKey === undefined) delete process.env.GROQ_API_KEY;
    else process.env.GROQ_API_KEY = previousKey;
  }
});

test('chat calls share Groq with Cloudflare: spill when nearly spent, back up on 429, and skip whichever has no key', async () => {
  const { cleanDictation, setChatSpill } = await import('../../voice-router/lib/groq-client.mjs');
  const previousFetch = global.fetch;
  const env = ['GROQ_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'CHAT_PROVIDER'];
  const previous = Object.fromEntries(env.map((key) => [key, process.env[key]]));
  const calls = [], tokens = [];
  const answer = (usage) => { const body = { choices: [{ message: { content: 'Cleaned.' } }], usage }; return { ok: true, status: 200, headers: new Headers(), json: async () => body, clone() { return this; } }; };
  try {
    process.env.GROQ_API_KEY = 'groq-test'; process.env.CLOUDFLARE_ACCOUNT_ID = 'a'.repeat(32); process.env.CLOUDFLARE_API_TOKEN = 'cf-test'; delete process.env.CHAT_PROVIDER;
    let spill = true, groqStatus = 200;
    setChatSpill({ shouldSpill: () => spill, onGroqTokens: (n) => tokens.push(n) });
    global.fetch = async (url, options) => {
      const body = JSON.parse(options.body);
      calls.push({ host: new URL(url).hostname, path: new URL(url).pathname, auth: options.headers.Authorization, model: body.model, max: body.max_tokens });
      if (url.includes('cloudflare')) return answer({ prompt_tokens: 3, completion_tokens: 4 });
      return groqStatus === 200 ? answer({ total_tokens: 42 }) : { ok: false, status: groqStatus, headers: new Headers(), text: async () => 'tokens per day' };
    };
    // Nearly spent: Cloudflare answers and Groq is not asked.
    assert.equal(await cleanDictation('um cleaned'), 'Cleaned.');
    assert.deepEqual(calls, [{ host: 'api.cloudflare.com', path: `/client/v4/accounts/${'a'.repeat(32)}/ai/v1/chat/completions`, auth: 'Bearer cf-test', model: '@cf/openai/gpt-oss-120b', max: 2048 }]);
    calls.length = 0;
    await cleanDictation('Keep the whole long recording. '.repeat(250));
    assert.ok(calls[0].max > 2048, 'standalone Cloudflare honors the long transcript budget');
    // Healthy: Groq answers, and what it spent is reported to the host.
    calls.length = 0; spill = false;
    assert.equal(await cleanDictation('um cleaned'), 'Cleaned.');
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(calls.map((c) => [c.host, c.auth, c.model]), [['api.groq.com', 'Bearer groq-test', 'openai/gpt-oss-120b']]);
    assert.deepEqual(tokens, [42]);
    // Groq's daily allowance is gone: Cloudflare is the backup.
    calls.length = 0; groqStatus = 429;
    assert.equal(await cleanDictation('um cleaned'), 'Cleaned.');
    assert.deepEqual(calls.map((c) => c.host), ['api.groq.com', 'api.cloudflare.com']);
    // No Groq key: Cloudflare alone.
    calls.length = 0; delete process.env.GROQ_API_KEY;
    assert.equal(await cleanDictation('um cleaned'), 'Cleaned.');
    assert.deepEqual(calls.map((c) => c.host), ['api.cloudflare.com']);
    // No Cloudflare: Groq's error stands.
    calls.length = 0; process.env.GROQ_API_KEY = 'groq-test'; delete process.env.CLOUDFLARE_API_TOKEN;
    await assert.rejects(cleanDictation('um cleaned'), /Chat API error 429/);
    assert.deepEqual(calls.map((c) => c.host), ['api.groq.com']);
  } finally {
    setChatSpill({ shouldSpill: () => false, onGroqTokens: () => {} });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('hosted dictation and titles share router budgets and saved credentials without duplicate calls', async () => {
  const { cleanDictation, setChatSpill } = await import('../../voice-router/lib/groq-client.mjs');
  const { runtime } = require('../lib/routing-runtime');
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routing-voice-budget-'));
  const env = ['GROQ_API_KEY', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN'];
  const previous = Object.fromEntries(env.map(key => [key, process.env[key]]));
  const previousFetch = global.fetch, calls = [];
  const values = {};
  const keys = { groqApiKey: 'saved-groq', routingCloudflareAccount: 'a'.repeat(32), routingCloudflareToken: 'saved-cf' };
  try {
    for (const key of env) delete process.env[key];
    const rt = runtime({ globalState: {
      get: (key, fallback) => values[key] ?? fallback,
      update: async (key, value) => { values[key] = value; },
    }, secrets: { get: async key => keys[key] } }, () => [], dir);
    rt.attachVoice({ setChatSpill });
    let finishReason = 'stop';
    let cleaned = 'Cleaned.';
    global.fetch = async (url, init) => {
      calls.push({ url, body: JSON.parse(init.body), auth: init.headers.Authorization });
      return { ok: true, status: 200, json: async () => ({
        choices: [{ finish_reason: finishReason, message: { content: cleaned } }],
        usage: { total_tokens: 42, prompt_tokens: 30, completion_tokens: 12 },
      }) };
    };
    assert.equal(await cleanDictation('um cleaned'), 'Cleaned.');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].auth, 'Bearer saved-groq');
    assert.equal(rt.router.usage().groq_requests, 1);
    assert.equal(rt.router.usage().groq_tokens, 42);
    const longTranscript = 'Please check the Astro website build. '.repeat(180) + 'Keep this final sentence intact.';
    cleaned = longTranscript;
    assert.equal(await cleanDictation(longTranscript), longTranscript);
    assert.ok(calls[1].body.max_tokens > 2048);
    assert.ok(calls[1].body.messages[1].content.includes('Keep this final sentence intact.'));
    rt.router.usage().groq_tokens = 160000;
    assert.equal(await cleanDictation(longTranscript), longTranscript);
    assert.equal(calls.length, 3);
    assert.equal(calls[2].auth, 'Bearer saved-cf');
    assert.equal(calls[2].body.model, '@cf/openai/gpt-oss-120b');
    assert.equal(calls[2].body.max_tokens, calls[1].body.max_tokens);
    assert.ok(rt.router.usage().neurons > 0);
    assert.equal(rt.router.usage().groq_requests, 2);
    finishReason = 'length'; cleaned = 'Please check the Astro website';
    await assert.rejects(cleanDictation(longTranscript), /output limit/);
    assert.equal(calls.length, 5, 'both providers reject partial text before the caller falls back to raw');
    finishReason = 'stop';
    rt.router.usage().neurons = 10000;
    rt.router.usage().groq_tokens = 200000;
    await assert.rejects(cleanDictation('um cleaned'), /budget exhausted/);
    assert.equal(calls.length, 5);
  } finally {
    setChatSpill({ callChat: null });
    global.fetch = previousFetch;
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('hotkey: a key event becomes "Ctrl+Alt+Space", and only a usable combination counts', () => {
  assert.equal(fromKeyEvent({ code: 'Space', ctrlKey: true, altKey: true }), 'Ctrl+Alt+Space');
  assert.equal(fromKeyEvent({ code: 'KeyD', ctrlKey: true, shiftKey: true }), 'Ctrl+Shift+D');
  assert.equal(fromKeyEvent({ code: 'F9' }), 'F9');
  assert.equal(fromKeyEvent({ code: 'KeyD' }), null); // a bare letter would fire while typing
  assert.equal(fromKeyEvent({ code: 'KeyD', shiftKey: true }), null);
  assert.equal(fromKeyEvent({ code: 'ControlLeft', ctrlKey: true }), null); // modifiers alone are not a hotkey yet
  assert.equal(fromKeyEvent({ code: 'Escape', ctrlKey: true }), null);
});

test('hotkey: a saved string parses to the virtual-key codes the listener polls', () => {
  assert.deepEqual(parse('Ctrl+Alt+Space'), { mods: ['Ctrl', 'Alt'], modVks: [0x11, 0x12], key: 'Space', vk: 0x20 });
  assert.equal(parse('F9').vk, 0x78);
  assert.equal(parse('Ctrl+A').vk, 0x41);
  for (const bad of ['', 'D', 'Shift+D', 'Ctrl+Ctrl+D', 'Hyper+D', 'Ctrl+Nope']) assert.equal(parse(bad), null, bad);
});

function harness(mode) {
  const calls = [];
  let recording = false;
  let clock = 1000;
  let openMic;
  const handlers = createHotkeyHandlers({
    mode: () => mode,
    isRecording: () => recording,
    begin: () => { calls.push('begin'); return new Promise((resolve) => { openMic = () => { recording = true; resolve(); }; }); },
    finish: () => { calls.push('finish'); recording = false; },
    cancel: () => { calls.push('cancel'); recording = false; },
    now: () => clock,
  });
  return { handlers, calls, openMic: () => openMic(), tick: (ms) => { clock += ms; } };
}

test('hotkey, press once: the first press starts, the second stops and transcribes; releases do nothing', async () => {
  const h = harness('toggle');
  h.handlers.onDown(); h.openMic(); await h.handlers.onUp();
  h.handlers.onDown(); await h.handlers.onUp();
  assert.deepEqual(h.calls, ['begin', 'finish']);
});

test('hotkey, hold to talk: records while held, transcribes on release', async () => {
  const h = harness('hold');
  h.handlers.onDown(); h.openMic(); h.tick(MIN_HOLD_MS + 1000);
  await h.handlers.onUp();
  assert.deepEqual(h.calls, ['begin', 'finish']);
});

test('hotkey, hold to talk: a tap is a slip and the recording is dropped; a release before the mic opened still stops it', async () => {
  const tap = harness('hold');
  tap.handlers.onDown(); tap.openMic(); tap.tick(100);
  await tap.handlers.onUp();
  assert.deepEqual(tap.calls, ['begin', 'cancel']);

  const early = harness('hold');
  early.handlers.onDown(); early.tick(MIN_HOLD_MS + 500);
  const release = early.handlers.onUp(); // the microphone is still opening
  early.openMic();
  await release;
  assert.deepEqual(early.calls, ['begin', 'finish']);
});

test('groq: durations and the daily request limit come out of the response headers', () => {
  assert.equal(parseDuration('2m59.56s'), 179560);
  assert.equal(parseDuration('7.66s'), 7660);
  assert.equal(parseDuration('1d2h3m4s'), 93784000);
  assert.equal(parseDuration('250ms'), 250);
  assert.equal(parseDuration('soon'), null);
  const headers = new Map([['x-ratelimit-limit-requests', '1000'], ['x-ratelimit-remaining-requests', '958'], ['x-ratelimit-reset-requests', '1h2m']]);
  assert.deepEqual(parseRateHeaders(headers), { limit: 1000, remaining: 958, resetMs: 3720000 });
  assert.equal(parseRateHeaders(new Map()), null);
});

function account(extra = {}) {
  const secrets = new Map();
  let saved = null;
  let time = Date.parse('2026-10-02T10:00:00Z');
  const env = {};
  const made = new GroqAccount({
    secrets: { get: async (k) => secrets.get(k), store: async (k, v) => { secrets.set(k, v); }, delete: async (k) => { secrets.delete(k); } },
    store: { get: () => saved, set: (v) => { saved = v; } },
    env, now: () => time, ...extra,
  });
  return { made, env, secrets, advance: (ms) => { time += ms; } };
}
const rate = (remaining, reset = '1h') => new Map([['x-ratelimit-limit-requests', '1000'], ['x-ratelimit-remaining-requests', String(remaining)], ['x-ratelimit-reset-requests', reset]]);

test('groq account: counts today’s requests, remembers the reported limit, and resets with the day', () => {
  const { made, advance } = account();
  made.record({ kind: 'transcription', headers: rate(999) });
  made.record({ kind: 'chat', headers: rate(950) });
  made.record({ kind: 'chat', headers: new Map() }); // no limit headers: counted, limit kept
  let snap = made.snapshot();
  assert.equal(snap.today.calls, 3);
  assert.equal(snap.limits.chat.remaining, 950);
  assert.equal(snap.limits.transcription.limit, 1000);
  advance(2 * 3600000); // past the reset the allowance is whole again
  snap = made.snapshot();
  assert.equal(snap.limits.chat.remaining, 1000);
  advance(24 * 3600000);
  assert.equal(made.snapshot().today.calls, 0);
});

test('groq account: a key is saved only after Groq accepts it, and removing it hands back to the .env key', async () => {
  const rejected = account({ fetchImpl: async () => ({ ok: false, status: 401 }) });
  assert.deepEqual(await rejected.made.save('gsk_bad'), { ok: false, error: 'Groq rejected this key.' });
  assert.equal(rejected.secrets.size, 0);
  assert.equal(rejected.env.GROQ_API_KEY, undefined);

  const accepted = account({ fetchImpl: async () => ({ ok: true, status: 200 }) });
  accepted.made.loadEnv = () => { accepted.env.GROQ_API_KEY ||= 'gsk_from_env_file'; }; // what the voice router's .env would provide
  assert.deepEqual(await accepted.made.save('  gsk_goodkey1234  '), { ok: true });
  assert.equal(accepted.env.GROQ_API_KEY, 'gsk_goodkey1234');
  assert.equal(accepted.made.snapshot().source, 'account');
  assert.equal(accepted.made.snapshot().masked, 'gsk_…1234');
  await accepted.made.clear();
  assert.equal(accepted.made.snapshot().source, 'env');
});
