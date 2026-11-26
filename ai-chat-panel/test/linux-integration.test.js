'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { notifyReply } = require('../lib/notify.js');
const { copyImageToClipboard, clipboardImageCommand } = require('../lib/clipboard-image.js');

function fakeSpawn({ missing = [], failing = [] } = {}) {
  const calls = [];
  const spawnImpl = (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.unref = () => {};
    child.stdin = Object.assign(new EventEmitter(), { write() {}, end() {} });
    setTimeout(() => {
      if (missing.includes(command)) child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
      else child.emit('exit', failing.includes(command) ? 1 : 0);
    }, 1);
    return child;
  };
  return { spawnImpl, calls };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test('Linux: a reply shows a desktop notification and plays the chime through the first player that works', async () => {
  const { spawnImpl, calls } = fakeSpawn({ missing: ['paplay'] });
  notifyReply({ platform: 'linux', spawnImpl, existsImpl: () => true, appName: 'Visual Studio Code', toast: { agent: 'claude', text: 'The build is fixed. More detail follows.', chatTitle: 'Linux' } });
  await settle();
  const toast = calls.find((call) => call[0] === 'notify-send');
  assert.ok(toast, 'notify-send ran');
  assert.deepEqual(toast.slice(-2), ['Claude replied · Linux', 'The build is fixed.']);
  assert.ok(toast.includes('Visual Studio Code'), 'the app name is the host editor');
  assert.deepEqual(calls.filter((call) => call[0] !== 'notify-send').map((call) => call[0]), ['paplay', 'pw-play'], 'a missing paplay falls through to pw-play');
});

test('Linux: a chime that cannot be decoded falls through, a missing sound file uses the freedesktop one, and silence plays nothing', async () => {
  const failing = fakeSpawn({ failing: ['paplay'] });
  notifyReply({ platform: 'linux', spawnImpl: failing.spawnImpl, existsImpl: (file) => file.includes('freedesktop') });
  await settle();
  assert.deepEqual(failing.calls.map((call) => call[0]), ['paplay', 'pw-play']);
  assert.ok(failing.calls[0].at(-1).endsWith('complete.oga'));
  const silent = fakeSpawn();
  notifyReply({ platform: 'linux', spawnImpl: silent.spawnImpl, existsImpl: () => true, chime: false });
  notifyReply({ platform: 'freebsd', spawnImpl: silent.spawnImpl, existsImpl: () => true });
  await settle();
  assert.equal(silent.calls.length, 0);
});

test('Linux: images reach the clipboard through wl-copy on Wayland and xclip on X11, and a missing tool says what to install', async () => {
  const wayland = clipboardImageCommand('/tmp/a.png', { platform: 'linux', env: { WAYLAND_DISPLAY: 'wayland-0' } });
  assert.deepEqual([wayland.command, wayland.args, wayland.stdinFile], ['wl-copy', ['--type', 'image/png'], '/tmp/a.png']);
  const x11 = clipboardImageCommand('/tmp/a.JPG', { platform: 'linux', env: {} });
  assert.deepEqual([x11.command, x11.args], ['xclip', ['-selection', 'clipboard', '-t', 'image/jpeg', '-i', '/tmp/a.JPG']]);
  assert.equal(clipboardImageCommand('/tmp/a.txt', { platform: 'linux', env: {} }), null);
  assert.equal(clipboardImageCommand('C:\\a.png', { platform: 'win32', env: {} }).command, 'powershell.exe');

  const ok = fakeSpawn();
  await copyImageToClipboard('/tmp/a.png', { platform: 'linux', env: {}, spawnImpl: ok.spawnImpl });
  assert.equal(ok.calls[0][0], 'xclip');
  const missing = fakeSpawn({ missing: ['xclip'] });
  await assert.rejects(copyImageToClipboard('/tmp/a.png', { platform: 'linux', env: {}, spawnImpl: missing.spawnImpl }), /Install xclip/);
  const failed = fakeSpawn({ failing: ['xclip'] });
  await assert.rejects(copyImageToClipboard('/tmp/a.png', { platform: 'linux', env: {}, spawnImpl: failed.spawnImpl }), /exited with code 1/);
  await assert.rejects(copyImageToClipboard('/tmp/a.bmp', { platform: 'linux', env: {} }), /not supported/);
});

test('Linux: the setup terminal installs through sh for the CLIs that have an official script, and stays open', () => {
  const { terminalSpec } = require('../lib/cli-accounts');
  const claude = terminalSpec('claude', null, 'linux');
  assert.equal(claude.shellArgs[0], '-c');
  assert.match(claude.shellArgs[1], /(^|; )curl -fsSL https:\/\/claude\.ai\/install\.sh \| bash && .*auth login; exec "/);
  assert.match(terminalSpec('codex', null, 'linux').shellArgs[1], /(^|; )npm install -g @openai\/codex@latest && codex login/);
  assert.match(terminalSpec('copilot', null, 'linux').shellArgs[1], /(^|; )npm install -g @github\/copilot@latest/);
  assert.match(terminalSpec('gemini', null, 'linux').shellArgs[1], /(^|; )curl -fsSL https:\/\/antigravity\.google\/cli\/install\.sh \| bash/, "Antigravity's official script");
  // A non-interactive `bash -c` skips ~/.bashrc, so the line carries the folders nvm and friends keep npm in.
  const line = terminalSpec('copilot', null, 'linux').shellArgs[1];
  const nodeDir = require('node:path').dirname(process.execPath);
  if (/\.nvm\//.test(nodeDir)) assert.ok(line.startsWith('export PATH="') && line.includes(nodeDir), 'the nvm bin folder is on the setup line\'s PATH');
  assert.deepEqual(terminalSpec('claude', '/home/a/.local/bin/claude', 'linux'), { shellPath: '/home/a/.local/bin/claude', shellArgs: ['auth', 'login'] });
});

test('Linux: CLIs are also looked for where install scripts and npm put them, not only on a PATH the desktop launcher may have trimmed', () => {
  const { unixBinDirs } = require('../lib/binary-locator');
  const dirs = unixBinDirs('/home/a', { NPM_CONFIG_PREFIX: '/opt/npm' });
  for (const dir of [path.join('/home/a', '.local', 'bin'), path.join('/home/a', '.npm-global', 'bin'), path.join('/opt/npm', 'bin'), '/usr/local/bin']) assert.ok(dirs.includes(dir), dir);
});

test('Linux: an nvm install is searched, and a copy the user owns wins over a root-owned app-bundled one that cannot update itself', { skip: process.platform === 'win32' }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'nvm-'));
  const saved = { HOME: process.env.HOME, NVM_DIR: process.env.NVM_DIR, PATH: process.env.PATH };
  for (const version of ['v22.1.0', 'v24.22.3']) fs.mkdirSync(path.join(home, '.nvm', 'versions', 'node', version, 'bin'), { recursive: true });
  const mine = path.join(home, '.nvm', 'versions', 'node', 'v24.22.3', 'bin', 'codex');
  fs.writeFileSync(mine, '', { mode: 0o755 });
  // A folder that is not writable stands in for /usr/lib/chatgpt/resources.
  const bundledDir = path.join(home, 'app'); fs.mkdirSync(bundledDir);
  fs.writeFileSync(path.join(bundledDir, 'codex'), '', { mode: 0o755 }); fs.chmodSync(bundledDir, 0o555);
  Object.assign(process.env, { HOME: home, PATH: bundledDir });
  delete process.env.NVM_DIR;
  const resolved = require.resolve('../lib/binary-locator.js');
  delete require.cache[resolved];
  try {
    const locator = require('../lib/binary-locator.js');
    const dirs = locator.unixBinDirs(home, {});
    assert.ok(dirs.indexOf(path.join(home, '.nvm', 'versions', 'node', 'v24.22.3', 'bin')) < dirs.indexOf(path.join(home, '.nvm', 'versions', 'node', 'v22.1.0', 'bin')), 'newest Node first');
    const writable = process.getuid?.() !== 0;
    assert.equal(locator.locate('codex').path, writable ? mine : path.join(bundledDir, 'codex'));
  } finally {
    fs.chmodSync(bundledDir, 0o755);
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    delete require.cache[resolved];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('Linux: the Antigravity language server is found by its token in /proc and its port by ss', async () => {
  const { discoverLinux, parseSsListeners } = require('../lib/process-scan');
  const ss = [
    'LISTEN 0 4096 127.0.0.1:43211 0.0.0.0:* users:(("language_server_l",pid=1234,fd=9))',
    'LISTEN 0 4096 [::1]:43212 [::]:* users:(("language_server_l",pid=1234,fd=10))',
    'LISTEN 0 128 0.0.0.0:22 0.0.0.0:* users:(("sshd",pid=900,fd=3))',
  ].join('\n');
  assert.deepEqual([...parseSsListeners(ss)], [[1234, [43211, 43212]], [900, [22]]]);
  const files = {
    '/proc/1234/cmdline': ['/opt/antigravity/language_server_linux_x64', '--enable_lsp', '--csrf_token', 'abc-123'].join('\0') + '\0',
    '/proc/55/cmdline': ['/usr/bin/agy', 'chat'].join('\0') + '\0', // a CLI session: no token, skipped
    '/proc/900/cmdline': ['/usr/sbin/sshd', '--csrf_token', 'nope'].join('\0'), // wrong program
  };
  const found = await discoverLinux({
    readdir: () => ['1', '55', '900', '1234', 'self'], readFile: (file) => { if (!(file in files)) throw new Error('ENOENT'); return files[file]; },
    exec: async (command, args) => { assert.deepEqual([command, args], ['ss', ['-ltnpH']]); return ss; },
  });
  assert.deepEqual(found.procs.map((p) => p.ProcessId), [1234]);
  assert.match(found.procs[0].CommandLine, /--csrf_token abc-123/);
  assert.deepEqual(found.ports, [43211, 43212]);
  assert.deepEqual(await discoverLinux({ readdir: () => { throw new Error('no /proc'); } }), { procs: [], ports: [] });
});

test('Linux: a file is copied as a URI list, or in GNOME\'s own flavour, through wl-copy or xclip', () => {
  const { clipboardFileCommand } = require('../lib/clipboard-image');
  const kde = clipboardFileCommand('/home/a/my file.txt', { platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'KDE' } });
  assert.deepEqual([kde.command, kde.args], ['xclip', ['-selection', 'clipboard', '-t', 'text/uri-list']]);
  assert.equal(kde.stdinText, 'file:///home/a/my%20file.txt\r\n');
  const gnome = clipboardFileCommand('/home/a/b.txt', { platform: 'linux', env: { XDG_CURRENT_DESKTOP: 'ubuntu:GNOME', WAYLAND_DISPLAY: 'wayland-0' } });
  assert.deepEqual([gnome.command, gnome.args], ['wl-copy', ['--type', 'x-special/gnome-copied-files']]);
  assert.equal(gnome.stdinText, 'copy\nfile:///home/a/b.txt');
  assert.equal(clipboardFileCommand('/a', { platform: 'darwin', env: {} }), null);
  assert.equal(clipboardFileCommand('C:\\a.txt', { platform: 'win32', env: {} }).command, 'powershell.exe');
});

test('Linux: a screenshot is shrunk with ffmpeg until it fits, and a missing ffmpeg gives up quietly', async () => {
  const { shrinkImage } = require('../lib/image-shrink');
  const sizes = [], seen = [];
  const execImpl = (command, args, options, done) => { seen.push(args.find((a) => a.startsWith('scale='))); sizes.push(args[args.indexOf('-q:v') + 1]); done(null, Buffer.alloc(sizes.length < 3 ? 500 : 50, 1)); };
  const out = await shrinkImage('/tmp/a.png', { width: 800, maxBytes: 100, execImpl });
  assert.equal(Buffer.from(out, 'base64').length, 50);
  assert.deepEqual(sizes, ['4', '8', '12'], 'quality steps down first');
  assert.match(seen[0], /min\(800,min\(iw,iw\*1536\/ih\)\)/);
  assert.equal(await shrinkImage('/tmp/a.png', { execImpl: (c, a, o, done) => done(Object.assign(new Error('ENOENT'), { code: 'ENOENT' })) }), null);
});

test('Linux: the held-send popup is a notification whose action button answers "act"', async () => {
  const { showAuthPrompt } = require('../lib/auth-prompt');
  const calls = [];
  const run = (stdout) => (command, args) => {
    calls.push([command, ...args]);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    setTimeout(() => { child.stdout.emit('data', stdout); child.emit('close', 0); }, 1);
    return child;
  };
  const block = { title: 'Not signed in', message: 'Claude needs you.', steps: ['Open a terminal'], button: 'Sign in' };
  assert.equal(await showAuthPrompt(block, { platform: 'linux', spawnImpl: run('act\n') }).result, 'act');
  assert.equal(await showAuthPrompt(block, { platform: 'linux', spawnImpl: run('') }).result, 'later');
  assert.ok(calls[0].includes('--wait') && calls[0].includes('act=Sign in'));
  assert.match(calls[0].at(-1), /Claude needs you\.\n• Open a terminal/);
  assert.equal(showAuthPrompt(block, { platform: 'freebsd' }), null);
});

test('Linux: gcloud is found in the SDK folders a desktop-launched IDE has no PATH entry for', { skip: process.platform === 'win32' && 'POSIX paths: not applicable on Windows' }, () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const { findGcloud } = require('../lib/cloud-warmup.js');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'gcloud-home-'));
  const saved = process.env.HOME;
  try {
    process.env.HOME = home;
    assert.notEqual(findGcloud({ PATH: '' }), path.join(home, 'google-cloud-sdk', 'bin', 'gcloud'));
    fs.mkdirSync(path.join(home, 'google-cloud-sdk', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'google-cloud-sdk', 'bin', 'gcloud'), '');
    assert.equal(findGcloud({ PATH: '' }), path.join(home, 'google-cloud-sdk', 'bin', 'gcloud'));
  } finally { process.env.HOME = saved; fs.rmSync(home, { recursive: true, force: true }); }
});
