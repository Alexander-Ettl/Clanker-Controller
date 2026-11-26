'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { DictateSocket, socketPath } = require('../lib/dictate-socket.js');

const send = (file, text) => new Promise((resolve, reject) => {
  const client = net.createConnection(file, () => client.write(text));
  let out = '';
  client.setEncoding('utf8');
  client.on('data', (chunk) => { out += chunk; });
  client.on('end', () => resolve(out));
  client.on('error', reject);
});
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'dictate-'));
const linux = process.platform === 'linux';

test('socketPath is per user and per window, and can be overridden', () => {
  assert.equal(socketPath({ CLANKER_DICTATE_SOCKET: '/x/y.sock' }), '/x/y.sock');
  assert.match(path.basename(socketPath({ XDG_RUNTIME_DIR: os.tmpdir() })), new RegExp(`^clanker-dictate-.+-${process.pid}\\.sock$`));
});

test('a toggle line runs the command and an unknown line does not', { skip: !linux && 'Linux only (Unix socket and bash script)' }, async () => {
  const dir = tmp();
  const file = path.join(dir, 'clanker-dictate-1-1.sock');
  let toggles = 0;
  const socket = new DictateSocket({ file, commands: { toggle: () => { toggles++; } } });
  assert.equal(socket.start(), true);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await send(file, 'toggle\n'), 'ok\n');
  assert.equal(await send(file, 'delete everything\n'), 'unknown\n');
  assert.equal(toggles, 1);
  socket.stop();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(fs.existsSync(file), false, 'closing the window removes its socket');
});

test('a failing command is reported, not thrown', { skip: !linux && 'Linux only (Unix socket and bash script)' }, async () => {
  const file = path.join(tmp(), 'clanker-dictate-1-2.sock');
  const errors = [];
  const socket = new DictateSocket({ file, commands: { toggle: () => Promise.reject(new Error('mic busy')) }, onError: (reason) => errors.push(reason) });
  socket.start();
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await send(file, 'toggle\n'), 'ok\n');
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.deepEqual(errors, ['mic busy']);
  socket.stop();
});

test('sockets of dead windows are swept, live ones are kept', { skip: !linux && 'Linux only (Unix socket and bash script)' }, () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'clanker-dictate-1-999999999.sock'), '');
  fs.writeFileSync(path.join(dir, `clanker-dictate-1-${process.ppid}.sock`), '');
  fs.writeFileSync(path.join(dir, 'clanker-dictate-2-999999998.sock'), ''); // another user's: left alone
  const socket = new DictateSocket({ file: path.join(dir, 'clanker-dictate-1-5.sock'), commands: {} });
  socket.start();
  assert.deepEqual(fs.readdirSync(dir).filter((name) => !name.endsWith('-5.sock')).sort(), [`clanker-dictate-1-${process.ppid}.sock`, 'clanker-dictate-2-999999998.sock'].sort());
  socket.stop();
});

test('it does nothing off Linux', () => {
  const socket = new DictateSocket({ file: path.join(tmp(), 'x.sock'), commands: {}, platform: 'win32' });
  assert.equal(socket.start(), false);
});

test('the shortcut script reaches the window used last and skips dead sockets', { skip: !linux && 'Linux only (Unix socket and bash script)' }, async () => {
  const dir = tmp();
  const script = path.join(__dirname, '..', 'lib', 'clanker-dictate');
  const uid = process.getuid();
  const hits = [];
  // Real pids, because a socket whose pid is gone is swept when another window starts.
  const older = new DictateSocket({ file: path.join(dir, `clanker-dictate-${uid}-${process.ppid}.sock`), commands: { toggle: () => hits.push('older') } });
  const newer = new DictateSocket({ file: path.join(dir, `clanker-dictate-${uid}-${process.pid}.sock`), commands: { toggle: () => hits.push('newer') } });
  const run = () => new Promise((resolve) => execFile('bash', [script], { env: { ...process.env, XDG_RUNTIME_DIR: dir, CLANKER_DICTATE_SOCKET: '' } }, (error) => resolve(error ? error.code : 0)));
  try {
    older.start(); newer.start();
    await new Promise((resolve) => setTimeout(resolve, 80));
    fs.writeFileSync(path.join(dir, `clanker-dictate-${uid}-1.sock`), ''); // not a socket
    await new Promise((resolve) => setTimeout(resolve, 20));
    older.touch(); // the older window was focused last
    assert.equal(await run(), 0);
    assert.deepEqual(hits, ['older']);
  } finally { older.stop(); newer.stop(); }
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(await run(), 1, 'with no window listening the script fails');
  assert.doesNotMatch(fs.readFileSync(script, 'utf8'), /notify-send/, 'never shows a desktop popup when no window is listening');
});

test('the shortcut script is published to a fixed path, executable, and left alone when unchanged', { skip: !linux && 'Linux only' }, () => {
  const home = tmp();
  const file = require('../lib/dictate-socket').publishScript({ home });
  assert.equal(file, path.join(home, 'clanker-dictate'));
  assert.ok(fs.statSync(file).mode & 0o100, 'executable');
  const before = fs.statSync(file).mtimeMs;
  require('../lib/dictate-socket').publishScript({ home });
  assert.equal(fs.statSync(file).mtimeMs, before);
  assert.equal(require('../lib/dictate-socket').publishScript({ home, platform: 'win32' }), null);
});
