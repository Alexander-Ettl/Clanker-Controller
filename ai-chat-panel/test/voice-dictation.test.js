'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { fromKeyEvent, parse } = require('../media/voice-hotkey.js');
const { createHotkeyHandlers, MIN_HOLD_MS } = require('../lib/voice-hotkey.js');
const { parseDuration, parseRateHeaders, GroqAccount } = require('../lib/groq-account.js');

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
