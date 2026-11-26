'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const apps = require('../lib/desktop-apps.js');
const { CliHub } = require('../lib/cli-tools.js');

const POLICY = `chatgpt:
  Installed: 26.1120.41243
  Candidate: 26.1120.50957
  Version table:
     26.1120.50957 500
        500 https://persistent.oaistatic.com/codex-app-prod/linux/deb stable/main amd64 Packages
 *** 26.1120.41243 100
        100 /var/lib/dpkg/status
`;
const INDEX = `Package: chatgpt
Version: 26.1120.50957
Size: 501426562

Package: chatgpt-extras
Version: 99.0.0
`;
const SOURCE = `Types: deb
URIs: https://persistent.oaistatic.com/codex-app-prod/linux/deb
Suites: stable
Components: main
`;

function sourceDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-apt-'));
  fs.writeFileSync(path.join(dir, 'other.list'), 'deb http://archive.ubuntu.com/ubuntu noble main\n');
  fs.writeFileSync(path.join(dir, 'chatgpt.sources'), SOURCE);
  return dir;
}

function fakeExec({ installed = true, calls = [], pkexec = { ok: true, code: 0, stdout: '', stderr: '' } } = {}) {
  let upgraded = false;
  return Object.assign(async (file, args) => {
    calls.push([file, ...args]);
    if (file === 'dpkg-query') return installed && args.at(-1) === 'chatgpt'
      ? { ok: true, code: 0, stdout: `ii \t${upgraded ? '26.1120.50957' : '26.1120.41243'}`, stderr: '' }
      : { ok: false, code: 1, stdout: '', stderr: 'no packages found' };
    if (file === 'apt-cache') return { ok: true, code: 0, stdout: POLICY, stderr: '' };
    if (file === 'pkexec') { if (pkexec.ok) upgraded = true; return pkexec; }
    throw new Error(`unexpected ${file}`);
  }, { calls });
}

test('apt output is parsed: policy, the Packages index, and the source file that serves a repository', () => {
  const policy = apps.parsePolicy(POLICY);
  assert.equal(policy.installed, '26.1120.41243');
  assert.equal(policy.candidate, '26.1120.50957');
  assert.deepEqual(policy.repo, { uri: 'https://persistent.oaistatic.com/codex-app-prod/linux/deb', suite: 'stable', component: 'main', arch: 'amd64' });
  assert.deepEqual(apps.parsePackagesIndex(INDEX, 'chatgpt'), { version: '26.1120.50957', size: 501426562 });
  assert.equal(apps.parsePackagesIndex(INDEX, 'missing'), null);
  const dir = sourceDir();
  assert.equal(apps.findSourceFile('https://persistent.oaistatic.com/codex-app-prod/linux/deb/', dir), path.join(dir, 'chatgpt.sources'));
  assert.equal(apps.findSourceFile('https://example.com/none', dir), null);
});

test('an installed apt app is detected and compared with the repository index', async () => {
  const dir = sourceDir();
  const exec = fakeExec();
  const found = await apps.checkApps({ exec, platform: 'linux', sourceDir: dir, fetchText: async (url) => {
    assert.equal(url, 'https://persistent.oaistatic.com/codex-app-prod/linux/deb/dists/stable/main/binary-amd64/Packages');
    return INDEX;
  } });
  assert.deepEqual(Object.keys(found), ['codex'], 'Claude Desktop is not installed');
  assert.equal(found.codex.version, '26.1120.41243');
  assert.equal(found.codex.latest, '26.1120.50957');
  assert.equal(found.codex.outdated, true);
});

test('an unreachable index falls back to apt\'s own candidate, and other platforms report nothing', async () => {
  const exec = fakeExec();
  const found = await apps.checkApps({ exec, platform: 'linux', sourceDir: sourceDir(), fetchText: async () => { throw new Error('offline'); } });
  assert.equal(found.codex.latest, '26.1120.50957');
  assert.deepEqual(await apps.checkApps({ exec, platform: 'win32', fetchText: async () => INDEX }), {});
  assert.deepEqual(await apps.checkApps({ exec: fakeExec({ installed: false }), platform: 'linux', fetchText: async () => INDEX }), {});
});

test('the update goes through pkexec with the package and source as parameters, never in the script', async () => {
  const dir = sourceDir();
  const exec = fakeExec();
  const result = await apps.updateApp('codex', { exec, platform: 'linux', sourceDir: dir });
  assert.equal(result.ok, true);
  assert.equal(result.version, '26.1120.50957');
  assert.match(result.message, /Restart ChatGPT/);
  const call = exec.calls.find((entry) => entry[0] === 'pkexec');
  assert.deepEqual(call.slice(1, 3), ['/bin/sh', '-c']);
  assert.equal(call.at(-3), 'sh');
  assert.equal(call.at(-2), path.join(dir, 'chatgpt.sources'));
  assert.equal(call.at(-1), 'chatgpt');
  assert.match(call[3], /apt-get update .*Dir::Etc::sourceparts=- .*List-Cleanup=0 && .*apt-get install --only-upgrade -y/);
  assert.doesNotMatch(call[3], /chatgpt|persistent\.oaistatic/, 'nothing from the system is spliced into the script');
});

test('a dismissed password dialog and a failed upgrade are reported plainly', async () => {
  const dismissed = await apps.updateApp('codex', { exec: fakeExec({ pkexec: { ok: false, code: 126, stdout: '', stderr: '' } }), platform: 'linux', sourceDir: sourceDir() });
  assert.deepEqual([dismissed.ok, dismissed.message], [false, 'Cancelled: the system password was not given']);
  const failed = await apps.updateApp('codex', { exec: fakeExec({ pkexec: { ok: false, code: 100, stdout: '', stderr: 'E: Could not get lock\nE: Unable to lock the administration directory' } }), platform: 'linux', sourceDir: sourceDir() });
  assert.deepEqual([failed.ok, failed.message], [false, 'E: Unable to lock the administration directory']);
  assert.equal((await apps.updateApp('claude', { exec: fakeExec(), platform: 'linux', sourceDir: sourceDir() })).ok, false);
});

test('the bundled CLI inside an app is recognised by its folder', () => {
  assert.equal(apps.isBundledBinary('codex', '/usr/lib/chatgpt/resources/codex'), true);
  assert.equal(apps.isBundledBinary('codex', '/home/me/.nvm/versions/node/v24/bin/codex'), false);
  assert.equal(apps.isBundledBinary('gemini', '/usr/lib/chatgpt/resources/codex'), false);
});

function hubFixture(overrides = {}) {
  const calls = { app: [], cli: [] };
  let apps = { codex: { name: 'ChatGPT', version: '1', latest: '2', outdated: true } };
  const hub = new CliHub({ store: { get: () => [] }, promptStore: { get: () => ({}) }, broadcast() {}, isBusy: () => false,
    checkAppsImpl: async () => apps,
    updateAppImpl: async (agent) => { calls.app.push(agent); apps = { codex: { ...apps.codex, version: '2', outdated: false } }; return { ok: true, message: 'Updated to 2. Restart ChatGPT to finish.' }; },
    updateCliImpl: async (agent) => { calls.cli.push(agent); return { ok: true, message: 'Updated' }; },
    installedVersionImpl: async () => '2.0.0', releaseStatusImpl: async () => ({ latest: '2.0.0', error: null }),
    checkVersionsImpl: async () => ({}), ...overrides });
  hub.apps = apps;
  return { hub, calls };
}

test('CliHub: the app update button upgrades the app, re-checks it, and keeps the outcome for the row', async () => {
  const { hub, calls } = hubFixture();
  assert.deepEqual(hub.snapshot().updates, ['codex'], 'an outdated app counts toward the update badge');
  await hub.updateApp('codex');
  assert.deepEqual(calls.app, ['codex']);
  assert.equal(hub.apps.codex.outdated, false);
  assert.equal(hub.appNotes.codex.ok, true);
  assert.match(hub.appNotes.codex.text, /Restart ChatGPT/);
  assert.deepEqual(hub.appUpdating, {});
});

test('CliHub: a CLI update for a copy bundled in the app upgrades the app instead', async () => {
  const { hub, calls } = hubFixture();
  hub.usesBundledBinary = (agent) => agent === 'codex';
  await hub.update('codex');
  assert.deepEqual([calls.app, calls.cli], [['codex'], []]);
  const other = hubFixture();
  other.hub.usesBundledBinary = () => false;
  await other.hub.update('codex');
  assert.deepEqual([other.calls.app, other.calls.cli], [[], ['codex']]);
});

test('CliHub: auto-update of apps is opt-in, skips busy providers, and does not retry a dismissed dialog for hours', async () => {
  let enabled = false, busy = true, now = 1000;
  const { hub, calls } = hubFixture({ autoUpdateAppsEnabled: () => enabled, isBusy: () => busy, now: () => now,
    updateAppImpl: async (agent) => { calls.app.push(agent); return { ok: false, message: 'Cancelled: the system password was not given' }; } });
  await hub.autoUpdateApps();
  enabled = true;
  await hub.autoUpdateApps();
  assert.deepEqual(calls.app, [], 'off, then busy');
  busy = false;
  await hub.autoUpdateApps();
  now += 60 * 1000;
  await hub.autoUpdateApps();
  assert.deepEqual(calls.app, ['codex'], 'tried once, not again within the retry window');
  now += 7 * 60 * 60 * 1000;
  await hub.autoUpdateApps();
  assert.deepEqual(calls.app, ['codex', 'codex']);
});

test('Claude Desktop: Anthropic\'s one-line .list with bracket options is found and its newest version read', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-apt-'));
  fs.writeFileSync(path.join(dir, 'claude-desktop.list'), 'deb [arch=amd64,arm64 signed-by=/usr/share/keyrings/claude-desktop-archive-keyring.asc] https://downloads.claude.ai/claude-desktop/apt/stable stable main\n');
  assert.equal(apps.findSourceFile('https://downloads.claude.ai/claude-desktop/apt/stable', dir), path.join(dir, 'claude-desktop.list'));
  const policy = apps.parsePolicy(`claude-desktop:\n  Installed: 1.17180.0\n  Candidate: 1.17282.0\n  Version table:\n     1.17282.0 500\n        500 https://downloads.claude.ai/claude-desktop/apt/stable stable/main amd64 Packages\n *** 1.17180.0 100\n        100 /var/lib/dpkg/status\n`);
  assert.deepEqual(policy.repo, { uri: 'https://downloads.claude.ai/claude-desktop/apt/stable', suite: 'stable', component: 'main', arch: 'amd64' });
  // Anthropic's index lists every release, oldest first; the newest must win whatever the order, and 1.x < 6.x numerically.
  const index = 'Package: claude-desktop\nVersion: 1.17282.0\nSize: 144238024\n\nPackage: claude-desktop\nVersion: 6.28899.6\nSize: 191718584\n\nPackage: claude-desktop\nVersion: 1.9.0\nSize: 1\n';
  assert.deepEqual(apps.parsePackagesIndex(index, 'claude-desktop'), { version: '6.28899.6', size: 191718584 });
});

test('Antigravity from apt: every installed package is upgraded together and the update runs through a real sh', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-apt-'));
  fs.writeFileSync(path.join(dir, 'antigravity.sources'), 'Types: deb\nURIs: https://apt.example.test/deb\nSuites: stable\nComponents: main\n');
  const policy = 'antigravity-ide:\n  Installed: 2.8.0\n  Candidate: 2.9.0\n  Version table:\n     2.9.0 500\n        500 https://apt.example.test/deb stable/main amd64 Packages\n';
  const log = path.join(dir, 'apt.log');
  const bin = path.join(dir, 'bin');
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, 'apt-get'), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${log}'\n`, { mode: 0o755 });
  const { run } = apps;
  let upgraded = false;
  const exec = async (file, args, options) => {
    if (file === 'dpkg-query') return ['antigravity-ide', 'antigravity'].includes(args.at(-1))
      ? { ok: true, code: 0, stdout: `ii \t${upgraded ? '2.9.0' : '2.8.0'}`, stderr: '' } : { ok: false, code: 1, stdout: '', stderr: '' };
    if (file === 'apt-cache') return { ok: true, code: 0, stdout: policy, stderr: '' };
    if (file === 'pkexec') { upgraded = true; return run('/bin/sh', args.slice(1), options); }
    throw new Error(`unexpected ${file}`);
  };
  const previous = process.env.PATH;
  process.env.PATH = `${bin}:${previous}`;
  try {
    const result = await apps.updateApp('gemini', { exec, platform: 'linux', sourceDir: dir });
    assert.equal(result.ok, true, result.message);
    assert.match(result.message, /Updated to 2\.9\.0\. Restart Antigravity/);
  } finally { process.env.PATH = previous; }
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], new RegExp(`^update -o Dir::Etc::sourcelist=${path.join(dir, 'antigravity.sources').replace(/[.+]/g, '\\$&')} -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0$`));
  assert.match(lines[1], /^install --only-upgrade -y -o Dpkg::Options::=--force-confold -- antigravity-ide antigravity$/);
});
