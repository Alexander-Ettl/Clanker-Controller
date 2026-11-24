'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-service-'));

test('the systemd timer calls the launcher every five minutes and quotes what has spaces', () => {
  const { systemdUnits } = require('../lib/runner-service');
  const { service, timer } = systemdUnits({ command: '/opt/My Editor/code', args: ['/home/a b/.clanker/clanker-run-due.js', '--quiet'], env: { ELECTRON_RUN_AS_NODE: '1' } });
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^Environment=ELECTRON_RUN_AS_NODE=1$/m);
  assert.match(service, /^ExecStart="\/opt\/My Editor\/code" "\/home\/a b\/\.clanker\/clanker-run-due\.js" "--quiet"$/m);
  assert.match(timer, /^OnUnitActiveSec=5min$/m);
  assert.match(timer, /^WantedBy=timers\.target$/m);
});

test('node on PATH is used; an editor-only machine runs the editor as node', () => {
  const { nodeCommand } = require('../lib/runner-service');
  assert.deepEqual(nodeCommand({ env: { PATH: '/a:/b' }, exists: (file) => file === '/b/node', platform: 'linux' }), { command: '/b/node', env: {} });
  assert.deepEqual(nodeCommand({ env: { PATH: '/a' }, exists: () => false, execPath: '/usr/share/code/code', platform: 'linux' }), { command: '/usr/share/code/code', env: { ELECTRON_RUN_AS_NODE: '1' } });
});

test('setting up writes the units and enables the timer; removing takes both away', () => {
  const { install, remove, installed } = require('../lib/runner-service');
  const home = tmp();
  const ran = [];
  const run = (file, args) => { ran.push([file, ...args].join(' ')); };
  const result = install({ launcher: '/h/.clanker/clanker-run-due.js', platform: 'linux', home, run, node: { command: '/usr/bin/node', env: {} } });
  assert.equal(result.ok, true);
  assert.deepEqual(ran, ['systemctl --user daemon-reload', 'systemctl --user enable --now clanker-run-due.timer']);
  assert.equal(installed({ platform: 'linux', home }), true);
  assert.match(fs.readFileSync(path.join(home, '.config/systemd/user/clanker-run-due.service'), 'utf8'), /ExecStart="\/usr\/bin\/node" "\/h\/\.clanker\/clanker-run-due\.js" "--quiet"/);
  assert.equal(remove({ platform: 'linux', home, run }).ok, true);
  assert.equal(installed({ platform: 'linux', home }), false);
  assert.equal(fs.existsSync(path.join(home, '.config/systemd/user/clanker-run-due.service')), false);
});

test('a failing systemctl is reported, not thrown', () => {
  const { install } = require('../lib/runner-service');
  const result = install({ launcher: '/x.js', platform: 'linux', home: tmp(), run: () => { throw Object.assign(new Error('boom'), { stderr: Buffer.from('Failed to connect to bus') }); }, node: { command: 'node', env: {} } });
  assert.equal(result.ok, false);
  assert.match(result.message, /Failed to connect to bus/);
});

test('Windows gets a Task Scheduler task that runs every five minutes', () => {
  const { install } = require('../lib/runner-service');
  const ran = [];
  install({ launcher: 'C:\\h\\.clanker\\clanker-run-due.js', platform: 'win32', run: (file, args) => ran.push([file, ...args]), node: { command: 'C:\\node\\node.exe', env: {} } });
  assert.equal(ran[0][0], 'schtasks.exe');
  assert.deepEqual(ran[0].slice(1, 7), ['/Create', '/F', '/SC', 'MINUTE', '/MO', '5']);
  assert.match(ran[0].at(-1), /"C:\\node\\node\.exe" "C:\\h\\\.clanker\\clanker-run-due\.js" "--quiet"/);
});

test('the launcher is written once, runs, and says how to set up when the editor never published', () => {
  const { publishLauncher } = require('../lib/run-due-cli');
  const home = tmp();
  const file = publishLauncher({ home });
  const first = fs.statSync(file).mtimeMs;
  assert.equal(publishLauncher({ home }), file);
  assert.equal(fs.statSync(file).mtimeMs, first, 'unchanged: not rewritten');
  const result = spawnSync(process.execPath, [file, '--quiet'], { env: { ...process.env, CLANKER_HOME: home }, encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Open the editor once/);
  assert.equal(spawnSync(process.execPath, [file, '--help'], { env: { ...process.env, CLANKER_HOME: home }, encoding: 'utf8' }).status, 0);
});
