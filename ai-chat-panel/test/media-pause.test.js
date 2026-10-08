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
  const unsupported = harness({ platform: 'linux' });
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
