'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseAntigravityQuota } = require('../lib/quota-sources');
const { shapeQuotas } = require('../lib/quota-bridge');
const { pickLanguageServer } = require('../lib/antigravity-quota');
const { normalizeModels } = require('../lib/model-catalog');
const { capped } = require('../lib/routing');

test('Gemini 4 Argon is a weekly-only pool of its own, found by name', () => {
  const resetTime = new Date(Date.now() + 3600000).toISOString();
  const data = { groups: [
    { displayName: 'Gemini Models', buckets: [{ bucketId: 'gemini-5h', remainingFraction: .9, resetTime }, { bucketId: 'gemini-weekly', remainingFraction: .8, resetTime }] },
    { displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: .3, resetTime }] },
  ] };
  const argon = parseAntigravityQuota(data, 'Gemini 4 Argon');
  assert.equal(argon.remaining, 30);
  assert.equal(argon.windowMinutes, 10080);
  assert.equal(parseAntigravityQuota(data).remaining, 90, 'the Gemini pool is not mistaken for Argon');
  assert.equal(shapeQuotas({ antigravityArgon: argon }).antigravityArgon.windowLabel, '7d');
  assert.equal(parseAntigravityQuota({ groups: [data.groups[0]] }, 'Gemini 4 Argon'), null);
  const idle = parseAntigravityQuota({ groups: [{ displayName: 'Gemini 4 Argon', buckets: [{ bucketId: 'gemini-argon-wtu-weekly', window: 'weekly', remainingFraction: 1, resetTime }] }] }, 'Gemini 4 Argon');
  assert.equal(idle.resetsAt, null, 'an untouched Antigravity bucket has no running window yet');
});

test('routing judges Argon models by the Argon pool, not by the Flash windows', () => {
  const models = normalizeModels([
    { id: 'gemini-4-argon-high', model: 'gemini-4-argon-high', label: 'Gemini 4 Argon (High)', agent: 'gemini' },
    { id: 'gemini-3.8-flash-high', model: 'gemini-3.8-flash-high', label: 'Gemini 3.8 Flash (High)', agent: 'gemini' },
  ]);
  const argon = models.find(m => /argon/.test(m.id)), flash = models.find(m => /flash/.test(m.id));
  assert.equal(argon.brand, 'antigravityArgon');
  assert.equal(flash.brand, undefined);
  const spentFlash = { gemini: { remaining: 0 }, antigravityArgon: { remaining: 55 } };
  assert.equal(capped(argon, spentFlash), false);
  assert.equal(capped(flash, spentFlash), true);
  assert.equal(capped(argon, { gemini: { remaining: 100 }, antigravityArgon: { remaining: 0 } }), true);
  // No Argon pool listed (Ultra shares the Gemini one): the agent's windows apply.
  assert.equal(capped(argon, { gemini: { remaining: 0 } }), true);
});

test('language server discovery accepts the agy hub and the classic process', () => {
  const hub = { ProcessId: 9312, CommandLine: 'C:\\Users\\x\\.gemini\\bin\\agy.exe --hub --hub-port=58386 --app_data_dir=antigravity --csrf_token=0a1b2c3d-1111-2222-3333-444455556666 "--add-dir=c:\\p"' };
  assert.deepEqual(pickLanguageServer([hub]), { pid: '9312', csrfToken: '0a1b2c3d-1111-2222-3333-444455556666', hubPort: 58386 });
  const classic = { ProcessId: 4, CommandLine: 'language_server_windows_x64.exe --enable_lsp --csrf_token abcdef-12' };
  assert.deepEqual(pickLanguageServer([{ ProcessId: 7, CommandLine: 'agy.exe chat' }, classic]), { pid: '4', csrfToken: 'abcdef-12', hubPort: null });
  assert.equal(pickLanguageServer([{ ProcessId: 7, CommandLine: 'agy.exe chat' }]), null);
});

test('Antigravity Claude/GPT pool keeps its own 5h and weekly quota through the bridge', () => {
  const resetTime = new Date(Date.now() + 3600000).toISOString();
  const group = (displayName, five, week) => ({ displayName, buckets: [
    { bucketId: '5h', remainingFraction: five, resetTime },
    { bucketId: 'weekly', remainingFraction: week, resetTime },
  ] });
  const data = { response: { groups: [group('Gemini Models', .8, .65), group('Claude and GPT models', .18, .42)] } };
  const raw = { gemini: parseAntigravityQuota(data), antigravityClaudeGpt: parseAntigravityQuota(data, 'Claude and GPT models') };
  const shaped = shapeQuotas(raw);
  assert.equal(shaped.gemini.remaining, 80);
  assert.equal(shaped.antigravityClaudeGpt.remaining, 18);
  assert.equal(shaped.antigravityClaudeGpt.secondary.remaining, 42);
  assert.equal(shaped.antigravityClaudeGpt.secondary.windowLabel, '7d');
  assert.equal(parseAntigravityQuota({ groups: [] }, 'Claude and GPT models'), null);
  const weeklyOnly = parseAntigravityQuota({ groups: [{ ...data.response.groups[1], buckets: [data.response.groups[1].buckets[1]] }] }, 'Claude and GPT models');
  assert.equal(shapeQuotas({ antigravityClaudeGpt: weeklyOnly }).antigravityClaudeGpt.windowLabel, '7d');
});
