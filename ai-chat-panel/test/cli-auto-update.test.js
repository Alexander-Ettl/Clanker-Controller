'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { CliHub, providerBusy } = require('../lib/cli-tools.js');

function fixture(overrides = {}) {
  let enabled = true, now = 100000;
  const calls = [];
  const hub = new CliHub({ store: { get: () => [] }, promptStore: { get: () => ({}) }, broadcast() {},
    autoUpdateEnabled: () => enabled, isBusy: () => false, now: () => now,
    updateCliImpl: async agent => { calls.push(agent); return { ok: true, message: 'Updated' }; },
    installedVersionImpl: async () => '2.0.0', releaseStatusImpl: async () => ({ latest: '2.0.0', error: null }), ...overrides });
  hub.versions = Object.fromEntries(['claude', 'codex', 'gemini'].map(agent => [agent, { version: '1.0.0', latest: '2.0.0', outdated: true }]));
  return { hub, calls, enable: value => { enabled = value; }, advance: ms => { now += ms; } };
}

test('provider activity protects only the busy provider, across chat windows and background runs', () => {
  for (const agent of ['claude', 'codex', 'gemini']) {
    const runs = [{ turn: {}, turnAgent: agent }];
    for (const target of ['claude', 'codex', 'gemini']) assert.equal(providerBusy(target, { runs }), agent === target);
  }
  assert.equal(providerBusy('claude', { runs: [{ remote: {} }] }), true);
  assert.equal(providerBusy('claude', { runs: [{ streamEngine: { hasBackgroundAgents: true }, activeAssistantMessage: { agent: 'codex' } }] }), true);
  assert.equal(providerBusy('codex', { runs: [{ starting: true }] }), true);
  assert.equal(providerBusy('codex', { runs: [{ turn: {} }] }), true, 'unknown dispatch protects every provider');
  assert.equal(providerBusy('codex', { runs: [{ queue: [{ modelId: 'auto' }] }] }), true);
  assert.equal(providerBusy('claude', { runs: [{ queue: [{ agentId: 'codex' }] }] }), false);
  assert.equal(providerBusy('codex', { runs: [{ queue: [{ agentId: 'codex' }] }] }), true);
});

test('recent typing protects its selected provider; Auto protects all, and idle typing expires', () => {
  const hosts = [{ activeAgent: 'codex', typingAt: 100 }];
  assert.equal(providerBusy('codex', { hosts, now: 30099 }), true);
  assert.equal(providerBusy('claude', { hosts, now: 30099 }), false);
  assert.equal(providerBusy('codex', { hosts, now: 30100 }), false);
  hosts.push({ activeAgent: 'auto', typingAt: 100 });
  assert.equal(providerBusy('claude', { hosts, now: 200 }), true);
  assert.equal(providerBusy('gemini', { hosts, now: 200 }), true);
  assert.equal(providerBusy('codex'), false);
});

test('auto update skips busy, disconnected, current and unknown providers; reconsideration updates a newly idle provider', async () => {
  let busy = 'codex';
  const f = fixture({ isBusy: agent => agent === busy, accounts: { isEnabled: agent => agent !== 'gemini', enabledAgents: () => ['claude', 'codex'] } });
  await f.hub.autoUpdate();
  assert.deepEqual(f.calls, ['claude']);
  busy = null;
  await f.hub.autoUpdate();
  assert.deepEqual(f.calls, ['claude', 'codex']);
  assert.equal(f.hub.snapshot().versions.codex.outdated, false);
  f.hub.versions = { claude: { version: null, latest: '3.0.0', outdated: false } };
  await f.hub.autoUpdate();
  assert.equal(f.calls.length, 2);
});

test('toggle prevents automatic updates while manual update remains available', async () => {
  const f = fixture();
  f.enable(false);
  await f.hub.autoUpdate();
  assert.deepEqual(f.calls, []);
  await f.hub.update('codex');
  assert.deepEqual(f.calls, ['codex']);
  f.enable(true);
  await f.hub.autoUpdate();
  assert.deepEqual(f.calls, ['codex', 'claude', 'gemini']);
});

test('in-flight updates deduplicate manual and automatic requests and release the start-turn wait', async () => {
  let finish;
  const f = fixture({ updateCliImpl: () => new Promise(resolve => { finish = resolve; }) });
  f.hub.versions = { codex: f.hub.versions.codex };
  const pending = f.hub.autoUpdate();
  const wait = f.hub.updatePromises.get('codex');
  assert.equal(f.hub.update('codex'), wait);
  assert.equal(f.hub.snapshot().updating.codex.background, true);
  await f.hub.autoUpdate();
  await Promise.resolve();
  finish({ ok: true, message: 'Updated' });
  await pending;
  await wait;
  assert.equal(f.hub.updatePromises.size, 0);
  assert.deepEqual(f.hub.snapshot().updating, {});
});

test('failures stay manual, isolate providers, clear progress and back off for six hours', async () => {
  const calls = [];
  const f = fixture({ updateCliImpl: async agent => { calls.push(agent); throw new Error('Locked binary'); } });
  await f.hub.autoUpdate();
  assert.equal(calls.length, 3);
  assert.deepEqual(f.hub.snapshot().updating, {});
  assert.equal(f.hub.snapshot().notes.codex.ok, false);
  assert.equal(f.hub.snapshot().versions.codex.outdated, true);
  await f.hub.autoUpdate();
  assert.equal(calls.length, 3);
  await f.hub.update('codex');
  assert.equal(calls.length, 4, 'manual retry bypasses backoff');
  f.advance(6 * 60 * 60 * 1000);
  await f.hub.autoUpdate();
  assert.equal(calls.length, 7);
});

test('idle server cleanup completes before update and cleanup failure leaves the update manual', async () => {
  let release;
  const f = fixture({ beforeUpdate: () => new Promise(resolve => { release = resolve; }) });
  const pending = f.hub.update('codex');
  assert.deepEqual(f.calls, []);
  release();
  await pending;
  assert.deepEqual(f.calls, ['codex']);
  const failed = fixture({ beforeUpdate: async () => { throw new Error('Server still running'); } });
  await failed.hub.autoUpdate();
  assert.deepEqual(failed.calls, []);
  assert.equal(failed.hub.snapshot().versions.codex.outdated, true);
});

test('an external agy update clears stale version, update badge and already-in-progress error without auto-installing', async () => {
  let installed = '1.4.2';
  const snapshots = [];
  const f = fixture({ installedVersionImpl: async () => installed, broadcast: message => { if (message.type === 'cliStatus') snapshots.push(message); } });
  f.enable(false);
  f.hub.versions = { gemini: { version: installed, latest: '1.4.3', outdated: true } };
  f.hub.notes.gemini = { ok: false, text: 'Error: update already in progress' };
  await f.hub.refreshInstalled();
  assert.deepEqual(f.hub.snapshot().updates, ['gemini']);
  assert.equal(f.hub.snapshot().notes.gemini.ok, false, 'retain the failure while the binary is still old');
  installed = '1.4.3';
  await f.hub.refreshInstalled();
  assert.equal(f.hub.snapshot().versions.gemini.version, installed);
  assert.deepEqual(f.hub.snapshot().updates, []);
  assert.equal(f.hub.snapshot().notes.gemini, undefined);
  assert.deepEqual(snapshots.at(-1).updates, [], 'publish the refreshed state to webviews');
  assert.deepEqual(f.calls, [], 'status reconciliation never launches an updater');
});

test('local version refresh deduplicates reads and retains status on a failed read', async () => {
  let finish, calls = 0;
  const f = fixture({ installedVersionImpl: () => { calls++; return new Promise(resolve => { finish = resolve; }); } });
  f.hub.versions = { gemini: { version: '1.4.2', latest: '1.4.3', outdated: true } };
  const pending = f.hub.refreshInstalled();
  assert.equal(f.hub.refreshInstalled(), pending);
  assert.equal(calls, 1);
  finish(null);
  await pending;
  assert.equal(f.hub.snapshot().versions.gemini.version, '1.4.2');
  assert.equal(f.hub.snapshot().versions.gemini.outdated, true);
});

test('a delayed full version check cannot restore the old version after an update finishes', async () => {
  let finish;
  const f = fixture({ checkVersionsImpl: () => new Promise(resolve => { finish = resolve; }) });
  const pending = f.hub.check();
  await f.hub.update('gemini');
  finish({ gemini: { version: '1.0.0', latest: '2.0.0', outdated: true } });
  await pending;
  assert.equal(f.hub.snapshot().versions.gemini.version, '2.0.0');
  assert.equal(f.hub.snapshot().versions.gemini.outdated, false);
});

test('a delayed local version read cannot restore stale status after another check finishes', async () => {
  let finish;
  const f = fixture({ installedVersionImpl: () => new Promise(resolve => { finish = resolve; }),
    checkVersionsImpl: async () => ({ gemini: { version: '2.0.0', latest: '2.0.0', outdated: false } }) });
  f.hub.versions = { gemini: f.hub.versions.gemini };
  const pending = f.hub.refreshInstalled();
  await f.hub.check();
  finish('1.0.0');
  await pending;
  assert.equal(f.hub.snapshot().versions.gemini.version, '2.0.0');
  assert.equal(f.hub.snapshot().versions.gemini.outdated, false);
});

test('verified current version clears an updater error even if the follow-up release lookup fails', async () => {
  const f = fixture({ updateCliImpl: async () => ({ ok: false, message: 'Error: update already in progress' }),
    releaseStatusImpl: async () => ({ latest: null, error: 'Offline' }) });
  await f.hub.update('gemini');
  assert.equal(f.hub.snapshot().versions.gemini.latest, '2.0.0');
  assert.equal(f.hub.snapshot().versions.gemini.outdated, false);
  assert.equal(f.hub.snapshot().notes.gemini, undefined);
});
