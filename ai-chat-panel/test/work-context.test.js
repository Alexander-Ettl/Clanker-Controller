'use strict';
// Work-context icons (lib/work-context.js), offline: a fake fetch stands in for Cloudflare, so nothing is sent and nothing is spent.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Router } = require('../lib/routing');
const { ChatStore } = require('../lib/chat-store');
const wc = require('../lib/work-context');

const ACCOUNT = 'a'.repeat(32);
const ids = wc.CATEGORIES.map((category) => category.id);
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'work-context-'));
const odds = (top, p = 0.9, second = 'general', q = 0.05) => Object.fromEntries(ids.map((id) => [id, id === top ? p : id === second ? q : (1 - p - q) / (ids.length - 2)]));
const answer = (top, p, second, q) => ({ ok: true, status: 200, json: async () => ({ success: true, result: { model: 'clef-flash', answers: { context: { choice: top, probabilities: odds(top, p, second, q) } }, usage: { input_tokens: 900 } } }) });

function setup({ reply = () => answer('design'), usage = {}, config = {}, enabled = true, clock = { at: Date.UTC(2026, 9, 29, 12) } } = {}) {
  const calls = [];
  let stored = { day: '2026-10-29', neurons: 0, groq_requests: 0, groq_tokens: 0, minutes: [], accounting_version: 2, ...usage };
  const router = new Router({
    getConfig: () => config,
    secrets: { get: async (key) => ({ routingCloudflareAccount: ACCOUNT, routingCloudflareToken: 'token-123' })[key] || '' },
    store: { get: () => stored, set: (value) => { stored = value; } },
    fetchImpl: async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return reply(calls.length, JSON.parse(init.body)); },
    now: () => clock.at,
  });
  const dir = tmp();
  const changes = [];
  const classifier = new wc.WorkContextClassifier({
    router, ledger: new wc.NeuronLedger(path.join(dir, 'ledger.json'), () => clock.at), enabled: () => enabled, onChange: (run) => changes.push(run.chat.id),
    now: () => clock.at,
  });
  // The requests are sent as soon as a prompt is considered; this lets them run to their end.
  const fire = async () => { for (let i = 0; i < 10; i++) await settle(); };
  return { calls, router, classifier, changes, clock, dir, fire, usage: () => router.usage() };
}
const message = (role, text, extra = {}) => ({ role, text, at: new Date().toISOString(), agent: 'claude', ...extra });
function chatRun(id, texts, workContext) {
  const run = { saved: 0, chat: { id, messages: texts.map((text, i) => message(i % 2 ? 'assistant' : 'user', text)), workContext }, save() { this.saved++; } };
  return run;
}
const settle = () => new Promise((resolve) => setImmediate(resolve));
const REQUEST = 'Redesign the recent chat tiles so they show a small icon in the corner';

test('every category has a bundled, allowlisted icon file', () => {
  assert.equal(ids.length, 24);
  assert.equal(new Set(ids).size, 24);
  const assets = wc.contextAssets(path.join(__dirname, '..', 'media'));
  assert.deepEqual(Object.keys(assets.icons).sort(), [...ids].sort());
  assert.equal(wc.isCategoryId('../evil'), false);
  assert.equal(wc.readStored({ version: 1, categoryId: 'nope' }), null);
  assert.deepEqual(wc.readStored({ version: 1, categoryId: 'auth', updatedAt: 'x', junk: 1 }), { categoryId: 'auth', updatedAt: 'x' });
  assert.equal(wc.readStored({ version: 2, categoryId: 'auth' }), null, 'unknown versions are ignored');
});

test('acknowledgements and "continue" start no new work', () => {
  for (const text of ['continue', 'Continue.', 'yes', 'ok', 'ship it', 'go ahead', 'yes please go ahead', 'do it', 'weiter', 'thanks', '']) assert.equal(wc.isSubstantive(text), false, text);
  for (const text of ['Now let us look at voice search', 'go ahead and build the settings page', REQUEST, 'the settings button still does not work']) assert.equal(wc.isSubstantive(text), true, text);
});

test('initial icons use the last substantive request, while acknowledgements keep established icons', async () => {
  const t = setup();
  const run = chatRun('restored-ack', [REQUEST, 'Done.', 'continue']);
  t.classifier.consider(run);
  assert.equal(t.calls.length, 0, 'ordinary acknowledgements do not trigger calls');
  t.classifier.consider(run, { initial: true });
  await t.fire();
  assert.equal(t.calls.length, 1);
  assert.equal(t.calls[0].body.state.latest_request, REQUEST);
  assert.equal(run.chat.workContext.categoryId, 'design');
  const established = chatRun('existing-ack', [REQUEST, 'Done.', 'continue'], { version: 1, categoryId: 'auth' });
  t.classifier.consider(established, { initial: true });
  const empty = chatRun('only-ack', ['continue']);
  t.classifier.consider(empty, { initial: true });
  await t.fire();
  assert.equal(t.calls.length, 1, 'no backfill for established categories or an acknowledgement-only chat');
  assert.equal(established.chat.workContext.categoryId, 'auth');
});

test('the request is one choice question over all 24 ids, bounded and redacted', () => {
  const secrets = ['sk-supersecretvalue1234'];
  const long = 'x'.repeat(5000);
  const run = chatRun('c', [long, long, long, long, long, long, `use key sk-supersecretvalue1234 and gsk_abcdefghijk now to ${long}`]);
  run.chat.messages.splice(3, 0, { role: 'tool', text: 'TOOL OUTPUT SHOULD NEVER LEAVE', event: { file: 'a.js' } }, { role: 'user', text: '', attachments: ['C:/shot.png'] });
  const payload = wc.buildPayload(run.chat, { secrets });
  const withReplies = wc.buildPayload(chatRun('r', ['First prompt about the layout of the page', 'AI REPLY SHOULD NEVER LEAVE', REQUEST]).chat);
  assert.deepEqual(withReplies.state.recent_conversation, ['First prompt about the layout of the page'], 'only the earlier prompts of the user, as plain strings');
  assert.doesNotMatch(JSON.stringify(withReplies), /AI REPLY/);
  assert.deepEqual(Object.keys(payload.questions), ['context']);
  assert.equal(payload.questions.context.type, 'choice');
  assert.deepEqual(Object.keys(payload.questions.context.criteria), ids);
  const text = JSON.stringify(payload);
  assert.ok(Math.ceil(Buffer.byteLength(text) / 3) <= 2000 - 256, 'inside the token target');
  assert.doesNotMatch(text, /sk-supersecret|gsk_abcdef|TOOL OUTPUT|shot\.png/);
  assert.equal(payload.state.current_category, null);
  assert.equal(payload.images, undefined);
  assert.match(payload.state.latest_request, /^use key \[REDACTED\]/);
});

test('Clef answers are validated before anything is stored', () => {
  const result = (context) => ({ answers: { context } });
  assert.deepEqual(wc.readChoice(result({ choice: 'design', probabilities: odds('design', 0.8, 'frontend', 0.1) })), { id: 'design', probability: 0.8, runnerUp: 0.1 });
  assert.equal(wc.readChoice({ result: result({ value: 'auth', probs: odds('auth') }) }).id, 'auth', 'result-wrapped and alternative field names');
  assert.equal(wc.readChoice(result({ probabilities: odds('voice', 0.7, 'general', 0.1) })).id, 'voice', 'the top probability when no choice is named');
  assert.equal(wc.readChoice(result({ choice: 'not-a-category', probabilities: odds('design') })), null);
  assert.equal(wc.readChoice(result({ choice: 'design', probabilities: { design: 1.4, auth: 0 } })), null, 'probabilities above 1');
  assert.equal(wc.readChoice(result({ choice: 'design', probabilities: { design: NaN } })), null);
  assert.equal(wc.readChoice(result({ choice: 'design', probabilities: { design: 0.9, '../x': 0.1 } })), null, 'unknown ids');
  assert.equal(wc.readChoice(result({ choice: 'design' })), null, 'no probabilities, no thresholds to apply');
  assert.equal(wc.readChoice(null), null);
  assert.equal(wc.readChoice({}), null);
});

test('only a clear change replaces the category', () => {
  assert.equal(wc.decide(null, { id: 'design', probability: 0.8, runnerUp: 0.1 }), 'design');
  assert.equal(wc.decide('auth', { id: 'design', probability: 0.8, runnerUp: 0.1 }), 'design');
  assert.equal(wc.decide('auth', { id: 'auth', probability: 0.99, runnerUp: 0 }), null, 'unchanged');
  assert.equal(wc.decide('auth', { id: 'design', probability: 0.69, runnerUp: 0.1 }), null, 'below 0.70');
  assert.equal(wc.decide('auth', { id: 'design', probability: 0.75, runnerUp: 0.6 }), null, 'runner-up too close');
  assert.equal(wc.decide('auth', null), null);
  assert.equal(wc.decide(null, { id: 'design', probability: 0.3, runnerUp: 0.25 }), 'design', 'a chat with no category takes the top pick, however unsure');
  assert.equal(wc.decide(null, null), null);
});

test('a long chat moves from authentication to visual design; "continue" keeps it', async () => {
  const t = setup({ reply: (n) => answer(n === 1 ? 'auth' : 'design') });
  const run = chatRun('long', ['Fix the OAuth token refresh so sessions stay signed in', 'Done.', 'Make the login screen look better with softer colors and spacing']);
  t.classifier.consider(run);
  assert.equal(t.calls.length, 0, 'the request is asynchronous: sending a prompt never waits for it');
  await t.fire();
  assert.equal(t.calls.length, 1, 'and it goes out at once, with no wait');
  assert.equal(run.chat.workContext.categoryId, 'auth');
  assert.equal(run.chat.workContext.sourceRevision, 2);
  assert.equal(run.saved, 1);
  run.chat.messages.push(message('assistant', 'ok'), message('user', 'continue'));
  t.classifier.consider(run);
  await t.fire();
  assert.equal(t.calls.length, 1, '"continue" makes no call');
  run.chat.messages.push(message('assistant', 'ok'), message('user', 'Now restyle the whole sign-in page with a new typography and palette'));
  t.classifier.consider(run);
  await t.fire();
  assert.equal(t.calls.length, 2);
  assert.equal(run.chat.workContext.categoryId, 'design');
  assert.equal(t.changes.length, 2);
  assert.match(t.calls[0].url, /\/ai\/run\/@cf\/cloudflare\/clef-flash$/, 'Clef Flash, the run endpoint');
  assert.equal(t.calls[0].body.model, 'clef-flash');
  assert.equal(t.calls[1].body.state.current_category, 'auth', 'the current category goes in');
});

test('five chats classify independently', async () => {
  const picks = ['backend', 'design', 'research', 'testing', 'voice'];
  const t = setup({ reply: (n) => answer(picks[n - 1]) });
  const runs = picks.map((_, i) => chatRun(`chat-${i}`, [`${REQUEST} number ${i}`]));
  for (const run of runs) t.classifier.consider(run);
  await t.fire();
  assert.deepEqual(runs.map((run) => run.chat.workContext?.categoryId), picks);
  assert.equal(t.calls.length, 5);
});

test('classification starts at the prompt, never repeats it, and runs one request per chat and at most two at once', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  let inflight = 0, peak = 0;
  const t = setup({ reply: async () => { inflight++; peak = Math.max(peak, inflight); await gate; inflight--; return answer('design'); } });
  const runs = [1, 2, 3, 4].map((i) => chatRun(`c${i}`, [`${REQUEST} ${i}`]));
  for (const run of runs) t.classifier.consider(run);
  t.classifier.consider(runs[0]); // the same chat again while its read is in flight: still one read
  await t.fire();
  assert.equal(peak, 2, 'two at once, the rest wait');
  assert.equal(t.calls.length, 2);
  release();
  for (let i = 0; i < 10; i++) await settle();
  assert.equal(t.calls.length, 4, 'the waiting chats run once a slot frees');
  t.classifier.consider(runs[0]);
  await t.fire();
  assert.equal(t.calls.length, 4, 'the same prompt is not read twice');
  runs[0].chat.messages.push(message('assistant', 'ok'), message('user', 'Now write the documentation for the whole feature please'));
  t.classifier.consider(runs[0]);
  await t.fire();
  assert.equal(t.calls.length, 5, 'the next prompt is read at once, with no cooldown');
});

test('a prompt is read while its answer is still being written', async () => {
  const t = setup();
  const run = chatRun('running', [REQUEST]);
  run.chat.messages.push(message('assistant', '', { inProgress: true }));
  t.classifier.consider(run);
  await t.fire();
  assert.equal(t.calls.length, 1, 'no idle check, no wait');
  assert.equal(run.chat.workContext.categoryId, 'design');
});

test('a chat with no category takes an unsure answer; one with a category needs a clear change', async () => {
  const t = setup({ reply: () => answer('design', 0.4, 'frontend', 0.3) });
  const fresh = chatRun('fresh', [REQUEST]);
  const known = chatRun('known', [REQUEST], { version: 1, categoryId: 'testing', sourceRevision: 1, updatedAt: 'then' });
  t.classifier.consider(fresh); t.classifier.consider(known);
  await t.fire();
  assert.equal(fresh.chat.workContext.categoryId, 'design');
  assert.equal(known.chat.workContext.categoryId, 'testing');
});

test('a late answer about an older request cannot overwrite a newer task', async () => {
  let release; const gate = new Promise((resolve) => { release = resolve; });
  const t = setup({ reply: async (n) => { if (n === 1) await gate; return answer(n === 1 ? 'auth' : 'voice'); } });
  const run = chatRun('stale', [REQUEST]);
  t.classifier.consider(run);
  await t.fire();
  run.chat.messages.push(message('assistant', 'ok'), message('user', 'Switch to the dictation microphone selection and speech recognition work'));
  t.classifier.consider(run);
  release();
  await t.fire();
  assert.equal(t.calls.length, 2, 'the newer prompt is read right after the stale one returns');
  assert.equal(run.saved, 1, 'the stale answer was dropped, never stored');
  assert.equal(run.chat.workContext.categoryId, 'voice');
  assert.equal(run.chat.workContext.sourceRevision, 2);
});

test('low confidence, bad answers, errors and missing credentials keep the icon', async () => {
  const cases = [
    [() => answer('design', 0.5, 'frontend', 0.3), 'low confidence'],
    [() => answer('design', 0.8, 'frontend', 0.19), 'clear change'],
    [() => ({ ok: true, status: 200, json: async () => ({ success: true, result: { answers: { context: { choice: 'bogus', probabilities: { bogus: 1 } } } } }) }), 'invalid id'],
    [() => ({ ok: false, status: 500, json: async () => ({ errors: [{ code: 1, message: 'boom' }] }) }), 'provider error'],
    [() => { throw new Error('network down'); }, 'network'],
  ];
  for (const [reply, name] of cases) {
    const t = setup({ reply });
    const run = chatRun('k', [REQUEST], { version: 1, categoryId: 'testing', sourceRevision: 1, updatedAt: 'then' });
    t.classifier.consider(run);
    await t.fire();
    if (name === 'clear change') { assert.equal(run.chat.workContext.categoryId, 'design'); continue; }
    assert.equal(run.chat.workContext.categoryId, 'testing', name);
    assert.equal(run.saved, 0, name);
  }
  const t = setup();
  t.router.secrets = { get: async () => '' };
  const run = chatRun('nocred', [REQUEST]);
  t.classifier.consider(run);
  await t.fire();
  assert.equal(t.calls.length, 0, 'no credentials, no request');
  assert.equal(run.chat.workContext, undefined);
});

test('nothing is sent when the setting is off, the project is private or the chat was deleted', async () => {
  const off = setup({ enabled: false });
  off.classifier.consider(chatRun('a', [REQUEST]));
  const priv = setup({ config: { never_send: ['C:/Secret'] } });
  priv.classifier.consider(chatRun('b', [REQUEST]), { project: 'C:\\Secret' });
  const gone = setup();
  gone.classifier.isLive = () => false;
  gone.classifier.consider(chatRun('c', [REQUEST]));
  await Promise.all([off, priv, gone].map((t) => t.fire()));
  assert.equal(off.calls.length + priv.calls.length + gone.calls.length, 0);
});

test('free-only: exhausted budgets make zero HTTP requests, retries included', async () => {
  const featureSpent = setup();
  fs.writeFileSync(path.join(featureSpent.dir, 'ledger.json'), JSON.stringify({ day: '2026-10-29', neurons: 999 }));
  featureSpent.classifier.consider(chatRun('f', [REQUEST]));
  const sharedSpent = setup({ usage: { neurons: 7999 } });
  sharedSpent.classifier.consider(chatRun('s', [REQUEST]));
  const blocked = setup({ usage: { cf_blocked: true } });
  blocked.classifier.consider(chatRun('b', [REQUEST]));
  await Promise.all([featureSpent, sharedSpent, blocked].map((t) => t.fire()));
  assert.equal(featureSpent.calls.length, 0, 'the feature\'s own 1,000');
  assert.equal(sharedSpent.calls.length, 0, 'shared usage plus the reservation past 8,000');
  assert.equal(blocked.calls.length, 0, 'Cloudflare said the free allowance is spent');
  // The router's own 10,000 still binds underneath the feature's 8,000.
  const router = setup({ usage: { neurons: 10000 } }).router;
  await assert.rejects(router.callTier('cloudflare', { state: 'x', questions: { q: { type: 'noul', instructions: 'x' } } }), /budget exhausted/);
});

test('the feature never spends more than 1,000 Neurons a day, however many chats ask', async () => {
  const t = setup({ reply: () => answer('design') });
  const runs = Array.from({ length: 400 }, (_, i) => chatRun(`m${i}`, [`${REQUEST} ${i}`]));
  for (const run of runs) t.classifier.consider(run);
  await t.fire();
  for (let i = 0; i < 3000; i++) await settle();
  const spent = new wc.NeuronLedger(path.join(t.dir, 'ledger.json'), () => t.clock.at).spent();
  assert.ok(t.calls.length > 100 && t.calls.length < 400, `${t.calls.length} calls fit in the day`);
  assert.ok(spent <= 1000, `ledger ${spent}`);
  assert.ok(t.usage().neurons <= 1000, 'and the shared counter agrees');
});

test('the ledger is atomic across hosts and resets at 00:00 UTC, categories stay', () => {
  const dir = tmp(); const file = path.join(dir, 'ledger.json');
  let now = Date.UTC(2026, 9, 29, 23, 59);
  const a = new wc.NeuronLedger(file, () => now), b = new wc.NeuronLedger(file, () => now);
  let granted = 0;
  for (let i = 0; i < 400; i++) { try { (i % 2 ? a : b).lease(7, 1000); granted++; } catch (error) { assert.match(error.message, /exhausted/); } }
  assert.equal(granted, 142);
  assert.ok(a.spent() <= 1000);
  const lease = a.lease(0, 1000); lease.settle(0);
  now += 2 * 60000;
  assert.equal(b.spent(), 0, 'a new UTC day starts empty');
  assert.ok(!fs.existsSync(`${file}.lock`), 'no lock left behind');
});

test('Clef Flash is metered at its published rate, and measured use replaces the reservation', async () => {
  const t = setup({ reply: () => answer('design') });
  const before = t.usage().neurons;
  const run = chatRun('rate', [REQUEST]);
  t.classifier.consider(run);
  await t.fire();
  const spent = t.usage().neurons - before;
  assert.ok(Math.abs(spent - 900 * 0.003455) < 0.01, `900 reported input tokens at 3,455 Neurons/MTok, got ${spent}`);
  const ledger = new wc.NeuronLedger(path.join(t.dir, 'ledger.json'), () => t.clock.at).spent();
  assert.ok(Math.abs(ledger - spent) < 0.01, 'the ledger holds the same measured figure');
});

test('the history summary names the agent that actually worked last, and drops unknown categories', () => {
  const store = new ChatStore(tmp());
  const chat = store.create();
  chat.messages = [message('user', 'a b c d e f g'), message('assistant', 'one', { agent: 'claude' }), message('user', 'next one please'), message('assistant', 'two', { agent: 'codex' }), message('user', 'more please do it'), message('assistant', 'three', { agent: 'claude' })];
  chat.workContext = { version: 1, categoryId: 'frontend', sourceRevision: 3, updatedAt: 'now' };
  store.save(chat);
  const [summary] = store.list();
  assert.deepEqual(summary.models, ['claude', 'codex'], 'models keeps its first-appearance order for other callers');
  assert.equal(summary.latestAgent, 'claude');
  assert.equal(summary.workContext.categoryId, 'frontend');
  chat.workContext = { version: 1, categoryId: '../../x' };
  store.save(chat);
  assert.equal(store.list()[0].workContext, null);
});
