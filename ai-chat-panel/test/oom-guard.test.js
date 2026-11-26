'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { OomGuard, unitOf } = require('../lib/oom-guard');

const USER = '/user.slice/user-1000.slice/user@1000.service';
const EDITOR = `${USER}/app.slice/app-code-466155.scope`;

// A /proc with the editor's scope, a language server inside it, desktop apps, a terminal, the desktop shell, a user service
// and a root-protected process. Writes below the floor fail with EACCES, like the kernel's oom_score_adj_min check.
function fakeSystem({ floor = 100, memAvailableKb = 8e6, editorUnit = EDITOR } = {}) {
  const files = new Map();
  const procs = [
    [10, editorUnit, '/opt/vscode/code --type=utility --utility-sub-type=node.mojom.NodeService', 200], // extension host (self)
    [11, editorUnit, '/opt/vscode/code', 200],
    [12, editorUnit, '/opt/vscode/code --type=renderer', 300],
    [13, editorUnit, '/opt/vscode/code ms-python.vscode-pylance-2026.4.1/dist/server.bundle.js', 200],
    [14, editorUnit, '/home/user/.local/bin/claude -p --input-format stream-json', 200],
    [15, editorUnit, '/bin/bash -c grep -rn tsserver vscode-pylance src', 200], // a tool call that only mentions one
    [20, `${USER}/app.slice/app-ChatGPT-77.scope`, '/usr/lib/chatgpt/ChatGPT', 300],
    [21, `${USER}/app.slice/app-bitwarden@abc.service`, '/opt/Bitwarden/bitwarden-app', 300],
    [22, `${USER}/app.slice/app-org.kde.konsole@1.service`, '/usr/bin/konsole', 200],
    [23, `${USER}/session.slice/plasma-plasmashell.service`, '/usr/bin/plasmashell', 200],
    [24, `${USER}/app.slice/nextcloud-readonly.service`, '/usr/bin/rclone mount nextcloud:', 200],
    [25, `${USER}/app.slice/app-snapstore-9.scope`, '/snap/snapd', -900],
  ];
  for (const [pid, cgroup, cmdline, adj] of procs) {
    files.set(`/proc/${pid}/cgroup`, `0::${cgroup}\n`);
    files.set(`/proc/${pid}/cmdline`, cmdline.split(' ').join('\0'));
    files.set(`/proc/${pid}/oom_score_adj`, `${adj}\n`);
    files.set(`/proc/${pid}/stat`, `${pid} (x) S ${Array(18).fill(1).join(' ')} 1000${pid} 0`);
  }
  files.set('/proc/meminfo', `MemTotal: 16000000 kB\nMemAvailable: ${memAvailableKb} kB\n`);
  const writes = [];
  const fs = {
    readdirSync: (dir) => { assert.equal(dir, '/proc'); return [...new Set([...files.keys()].map((key) => key.split('/')[2]))]; },
    readFileSync: (file) => { if (!files.has(file)) throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); return files.get(file); },
    writeFileSync: (file, value) => {
      if (/^\/proc\/\d+\/oom_score_adj$/.test(file) && Number(value) < floor) throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      writes.push([file, String(value)]);
      files.set(file, String(value));
    },
    existsSync: (file) => files.has(file),
    mkdirSync: () => {},
  };
  const adj = (pid) => Number(files.get(`/proc/${pid}/oom_score_adj`));
  return { fs, files, writes, adj };
}

function guard(system, extra = {}) {
  const execs = [];
  const g = new OomGuard({ fs: system.fs, platform: 'linux', selfPid: 10, configDir: '/home/user/.config/systemd/user', runtimeDir: '/run/user/1000/systemd/user',
    exec: (file, args, _options, done) => { execs.push([file, ...args]); done?.(null); }, hasWork: () => false, ...extra });
  return { g, execs };
}

test('the editor and its CLIs drop to the lowest allowed value; its language server goes first; nothing else moves', () => {
  const system = fakeSystem();
  const { g } = guard(system);
  g.tick();
  assert.deepEqual([10, 11, 12, 14, 15].map(system.adj), [100, 100, 100, 100, 100], 'extension host, main, renderer, the agent and its tool calls at the floor');
  assert.equal(system.adj(13), 500, 'Pylance is the first thing inside VS Code the kernel may take');
  assert.deepEqual([20, 21, 22, 23, 24, 25].map(system.adj), [300, 300, 200, 200, 200, -900], 'no work: other apps keep their values');
});

test('while prompts run or wait, launched apps become the first choice, and get their own values back afterwards', () => {
  const system = fakeSystem();
  let work = true;
  const { g } = guard(system, { hasWork: () => work });
  g.tick();
  assert.equal(system.adj(20), 1000, 'ChatGPT');
  assert.equal(system.adj(21), 1000, 'Bitwarden');
  assert.equal(system.adj(22), 200, 'a terminal may run your work');
  assert.equal(system.adj(23), 200, 'the desktop shell would take the editor down with it');
  assert.equal(system.adj(24), 200, 'a user service, not a launched app');
  assert.equal(system.adj(25), -900, 'a value root lowered stays');
  work = false;
  g.tick();
  assert.deepEqual([system.adj(20), system.adj(21)], [300, 300], 'restored to what they had');
});

test('a pid reused by another process is not "restored"', () => {
  const system = fakeSystem();
  let work = true;
  const { g } = guard(system, { hasWork: () => work });
  g.tick();
  system.files.set('/proc/20/stat', `20 (y) S ${Array(18).fill(1).join(' ')} 999999 0`); // ChatGPT ended; something else got pid 20
  work = false;
  g.tick();
  assert.equal(system.adj(20), 1000, 'left alone: it is not the process that was raised');
});

test('drop-ins: written once with OOMPolicy=continue, the user manager reloaded only when something changed', () => {
  const system = fakeSystem();
  const { g, execs } = guard(system);
  assert.equal(g.ensureDropIns(), true);
  const scope = system.files.get('/home/user/.config/systemd/user/app-code-.scope.d/50-clanker-keep-running.conf');
  const service = system.files.get('/home/user/.config/systemd/user/app-code@.service.d/50-clanker-keep-running.conf');
  assert.match(scope, /\[Scope\]\nOOMPolicy=continue\n$/);
  assert.match(service, /\[Service\]\nOOMPolicy=continue\n$/);
  assert.deepEqual(execs, [['systemctl', '--user', 'daemon-reload']]);
  assert.equal(g.ensureDropIns(), false, 'unchanged files');
  assert.equal(execs.length, 1);
});

test('an editor started outside the launcher gets a drop-in for its own unit, in the runtime directory', () => {
  const system = fakeSystem({ editorUnit: `${USER}/app.slice/app-org.kde.konsole@1.service/tab.scope` });
  const { g } = guard(system);
  g.ensureDropIns();
  assert.match(system.files.get('/run/user/1000/systemd/user/tab.scope.d/50-clanker-keep-running.conf'), /\[Scope\]\nOOMPolicy=continue/);
});

test('queued work waits for memory: idle sessions close first, then it waits, and it never waits past the limit', async () => {
  const system = fakeSystem({ memAvailableKb: 300 * 1024 });
  let clock = 0, released = 0, recovers = true;
  const { g } = guard(system, { releaseIdle: () => { released++; return 2; }, now: () => clock,
    sleep: async (ms) => { clock += ms; if (recovers && clock >= 30000) system.files.set('/proc/meminfo', 'MemAvailable: 4000000 kB\n'); } });
  const result = await g.waitForMemory({ pollMs: 15000 });
  assert.equal(released, 1);
  assert.equal(result.waitedMs, 30000);
  assert.ok(result.availableMb > 3000);
  clock = 0; recovers = false;
  system.files.set('/proc/meminfo', 'MemAvailable: 100000 kB\n');
  const capped = await g.waitForMemory({ maxWaitMs: 60000, pollMs: 15000 });
  assert.equal(capped.waitedMs, 60000, 'gives up and lets the prompt start rather than hold the queue forever');
});

test('enough memory, another platform or the setting off: nothing waits and nothing is written', async () => {
  const system = fakeSystem();
  const { g } = guard(system);
  assert.deepEqual(await g.waitForMemory(), { waitedMs: 0, availableMb: 8e6 / 1024 });
  const mac = new OomGuard({ fs: system.fs, platform: 'darwin', hasWork: () => true });
  mac.tick();
  assert.equal((await mac.waitForMemory()).waitedMs, 0);
  const off = new OomGuard({ fs: system.fs, platform: 'linux', selfPid: 10, enabled: () => false, hasWork: () => true });
  off.tick();
  assert.equal(system.writes.length, 0);
});

test('unitOf names the systemd unit of a cgroup', () => {
  assert.equal(unitOf(EDITOR), 'app-code-466155.scope');
  assert.equal(unitOf(`${USER}/app.slice/app-org.kde.konsole@1.service/tab.scope`), 'tab.scope');
  assert.equal(unitOf('/'), '');
});
