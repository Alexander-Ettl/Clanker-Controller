'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { MediaPause } = require('../../voice-router/lib/media-pause.cjs');

function harness(options = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stdin = new EventEmitter();
  let ended = 0, spawned = 0;
  child.stdin.end = () => { ended++; };
  const media = new MediaPause({ platform: 'win32', spawnImpl: (command, args, settings) => {
    spawned++;
    assert.equal(command, 'powershell.exe');
    assert.equal(settings.windowsHide, true);
    assert.ok(args.some(arg => arg.endsWith('media-pause.ps1')));
    return child;
  }, ...options });
  return { media, child, ended: () => ended, spawned: () => spawned };
}

test('media pause waits for readiness, reuses its helper and restores exactly once', async () => {
  const h = harness();
  const ready = h.media.pause();
  h.child.stdout.emit('data', Buffer.from('rea'));
  h.child.stdout.emit('data', Buffer.from('dy\n'));
  await ready;
  await h.media.pause();
  assert.equal(h.spawned(), 1);
  h.media.resume(); h.media.resume();
  assert.equal(h.ended(), 1);
});

test('media helper timeouts restore playback and do not hold the microphone open', async () => {
  const h = harness({ timeoutMs: 10 });
  await h.media.pause();
  assert.equal(h.ended(), 1);
  assert.equal(h.media.child, null);
});

test('unavailable media control and unsupported platforms leave dictation usable', async () => {
  const h = harness();
  const ready = h.media.pause();
  h.child.emit('error', new Error('unavailable'));
  await ready;
  assert.equal(h.media.child, null);
  const unsupported = harness({ platform: 'darwin' });
  await unsupported.media.pause();
  assert.equal(unsupported.spawned(), 0);
  const missing = harness({ spawnImpl: () => { throw new Error('missing'); } });
  await missing.media.pause();
});

test('stopping during helper startup closes stdin so delayed pauses still restore', async () => {
  const h = harness();
  const ready = h.media.pause();
  h.media.resume();
  h.child.stdout.emit('data', Buffer.from('ready\n'));
  await ready;
  assert.equal(h.ended(), 1);
});

// A fake session bus: three MPRIS players, two playing. `calls` records every Pause/Play.
function fakeBus(statuses) {
  const calls = [];
  const spawnImpl = (command, args) => {
    assert.equal(command, 'busctl');
    const proc = new EventEmitter();
    proc.stdout = new EventEmitter();
    proc.kill = () => {};
    const rest = args.filter(arg => !arg.startsWith('--'));
    let out = '';
    if (rest[0] === 'list') out = ['org.freedesktop.DBus 1 dbus-daemon', ...Object.keys(statuses).map(name => `${name} 99 app`), ':1.5 5 x'].join('\n');
    else if (rest[0] === 'get-property') out = `s "${statuses[rest[1]]}"\n`;
    else if (rest[0] === 'call') calls.push(`${rest[4]} ${rest[1].replace('org.mpris.MediaPlayer2.', '')}`);
    setTimeout(() => { proc.stdout.emit('data', Buffer.from(out)); proc.emit('close', 0); }, 1);
    return proc;
  };
  return { spawnImpl, calls };
}

test('Linux pauses only the MPRIS players that are playing and resumes exactly those', async () => {
  const { spawnImpl, calls } = fakeBus({ 'org.mpris.MediaPlayer2.spotify': 'Playing', 'org.mpris.MediaPlayer2.firefox.instance1': 'Playing', 'org.mpris.MediaPlayer2.vlc': 'Paused' });
  const media = new MediaPause({ platform: 'linux', spawnImpl });
  await media.pause();
  assert.deepEqual(calls.sort(), ['Pause firefox.instance1', 'Pause spotify']);
  await media.pause(); // already holding: no second round
  assert.equal(calls.length, 2);
  media.resume(); media.resume();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls.sort(), ['Pause firefox.instance1', 'Pause spotify', 'Play firefox.instance1', 'Play spotify']);
});

test('Linux media pause does nothing without busctl, and a resume during the pause undoes it', async () => {
  const missing = new MediaPause({ platform: 'linux', spawnImpl: () => { const proc = new EventEmitter(); proc.stdout = new EventEmitter(); setTimeout(() => proc.emit('error', new Error('ENOENT')), 1); return proc; } });
  await missing.pause(); missing.resume();
  const { spawnImpl, calls } = fakeBus({ 'org.mpris.MediaPlayer2.spotify': 'Playing' });
  const media = new MediaPause({ platform: 'linux', spawnImpl });
  const pausing = media.pause();
  media.resume(); // the microphone failed to open while the players were still being asked
  await pausing;
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.deepEqual(calls, ['Pause spotify', 'Play spotify']);
});
