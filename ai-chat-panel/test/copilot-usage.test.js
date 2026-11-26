'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCopilotUsage, readCopilotUsage, copilotLogin, resetCopilotUsageCache } = require('../lib/copilot-usage.js');
const { shapeQuotas } = require('../lib/quota-bridge.js');
const { getQuotas } = require('../lib/quota-sources.js');

const NOW = Date.parse('2026-11-25T12:00:00Z');
// The reply's shape for a Copilot Free account, as GitHub returned it (identifiers removed).
const FREE = {
  access_type_sku: 'free_limited_copilot', copilot_plan: 'individual', quota_reset_date_utc: '2026-12-01T00:00:00.000Z',
  quota_snapshots: {
    chat: { entitlement: 200, remaining: 200, percent_remaining: 100, unlimited: false, has_quota: true },
    completions: { entitlement: 2000, remaining: 2000, percent_remaining: 100, unlimited: false, has_quota: true },
    premium_interactions: { entitlement: 0, remaining: 0, percent_remaining: 0, unlimited: false, has_quota: false },
  },
};

test('a free plan shows its chat messages: nothing used, resets on the first of the month', () => {
  const window = parseCopilotUsage(FREE, NOW);
  assert.equal(window.remaining, 100);
  assert.equal(window.used, 0);
  assert.equal(window.windowMinutes, 30 * 1440, 'November has 30 days');
  assert.equal(window.resetsAt, Date.parse('2026-12-01T00:00:00Z') / 1000);
  assert.deepEqual(window.detail, { what: 'chat messages', plan: 'Copilot Free', entitlement: 200, used: 0 });
});

test('a plan with premium requests shows those, and what has been spent', () => {
  const paid = { ...FREE, access_type_sku: 'copilot_for_individual', copilot_plan: 'individual', quota_snapshots: { ...FREE.quota_snapshots,
    premium_interactions: { entitlement: 300, remaining: 75, percent_remaining: 25, unlimited: false, has_quota: true } } };
  const window = parseCopilotUsage(paid, NOW);
  assert.equal(window.remaining, 25);
  assert.equal(window.used, 75);
  assert.equal(window.detail.what, 'premium requests');
  assert.equal(window.detail.used, 225);
});

test('credit-based plans label the allowance and preserve fractional credit usage', () => {
  const chat = { ...FREE.quota_snapshots.chat, credits_used: 0.125 };
  const credits = { ...FREE, token_based_billing: true, quota_snapshots: { chat } };
  assert.deepEqual(parseCopilotUsage(credits, NOW).detail, { what: 'AI credits', plan: 'Copilot Free', entitlement: 200, used: 0.125 });
  const premium = { ...chat, token_based_billing: true, entitlement: 1000, credits_used: 11.25 };
  assert.deepEqual(parseCopilotUsage({ quota_snapshots: { premium_interactions: premium } }, NOW).detail,
    { what: 'AI credits', plan: 'Copilot', entitlement: 1000, used: 11.25 });
});

test('unlimited, missing or unreadable quotas give no reading rather than a made-up one', () => {
  assert.equal(parseCopilotUsage({ quota_snapshots: { chat: { entitlement: 0, unlimited: true } } }, NOW), null);
  assert.equal(parseCopilotUsage({}, NOW), null);
  assert.equal(parseCopilotUsage(null, NOW), null);
  assert.equal(parseCopilotUsage({ quota_snapshots: { chat: { entitlement: 200, has_quota: true } } }, NOW), null);
});

test('the ring gets the reading shaped like every other window, with the counts kept', () => {
  const shaped = shapeQuotas({ copilot: parseCopilotUsage({ ...FREE, quota_snapshots: { ...FREE.quota_snapshots, chat: { entitlement: 200, remaining: 150, percent_remaining: 75, has_quota: true } } }, NOW) });
  assert.equal(shaped.copilot.remaining, 75);
  assert.equal(shaped.copilot.windowLabel, 'month');
  assert.equal(shaped.copilot.detail.used, 50);
});

test('the request carries the token only to api.github.com, is cached, and stays quiet when it fails', async () => {
  resetCopilotUsageCache();
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, auth: init.headers.Authorization }); return { ok: true, json: async () => FREE }; };
  const first = await readCopilotUsage({ fetchImpl, token: 'gho_test', login: 'someone', now: NOW });
  await readCopilotUsage({ fetchImpl, token: 'gho_test', login: 'someone', now: NOW + 60_000 });
  assert.equal(first.remaining, 100);
  assert.equal(calls.length, 1, 'read once, then served from the cache');
  assert.equal(calls[0].url, 'https://api.github.com/copilot_internal/user');
  assert.equal(calls[0].auth, 'Bearer gho_test');
  await readCopilotUsage({ fetchImpl, token: 'gho_test', login: 'someone', now: NOW + 11 * 60_000 });
  assert.equal(calls.length, 2, 'and again after ten minutes');

  resetCopilotUsageCache();
  assert.equal(await readCopilotUsage({ fetchImpl: async () => { throw new Error('offline'); }, token: 't', login: 'someone', now: NOW }), null);
  resetCopilotUsageCache();
  assert.equal(await readCopilotUsage({ fetchImpl: async () => ({ ok: false, status: 401 }), token: 't', login: 'someone', now: NOW }), null);
  resetCopilotUsageCache();
  assert.equal(await readCopilotUsage({ fetchImpl, token: 't', login: null, now: NOW }), null, 'no Copilot sign-in on this machine: nothing is asked');
});

test('the Copilot CLI sign-in is read from its config, comment lines and all; other hosts do not count', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'copilot-home-'));
  const saved = process.env.COPILOT_HOME;
  delete process.env.COPILOT_HOME; // this test is about the default folder
  try {
    fs.mkdirSync(path.join(home, '.copilot'));
    const write = (config) => fs.writeFileSync(path.join(home, '.copilot', 'config.json'), `// User settings belong in settings.json.\n// This file is managed automatically.\n${JSON.stringify(config)}`);
    assert.equal(copilotLogin(home), null, 'no config yet');
    write({ lastLoggedInUser: { host: 'https://github.com', login: 'someone' }, loggedInUsers: [] });
    assert.equal(copilotLogin(home), 'someone');
    write({ lastLoggedInUser: { host: 'https://ghe.example.com', login: 'someone' } });
    assert.equal(copilotLogin(home), null);
  } finally { fs.rmSync(home, { recursive: true, force: true }); if (saved !== undefined) process.env.COPILOT_HOME = saved; }
});

test('getQuotas never reaches for the network while a test swaps the sources', async () => {
  const quotas = await getQuotas({ readGemini: async () => null });
  assert.equal(quotas.copilot, null);
});
