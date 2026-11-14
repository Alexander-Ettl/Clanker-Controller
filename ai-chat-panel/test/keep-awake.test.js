'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { keepAwake } = require('../lib/keep-awake');

function helper() {
  const child = new EventEmitter();
  Object.assign(child, { pid: 1, exitCode: null, stdout: new EventEmitter(), kill() { this.killed = true; } });
  return child;
}

test('sleep protection confirms Windows acknowledgement and releases the helper', () => {
  const child = helper(); let command, changes = 0;
  const hold = keepAwake({ platform: 'win32', spawnImpl: (cmd, args, options) => { command = { cmd, args, options }; return child; }, onChange: () => changes++ });
  assert.equal(hold.active, false);
  child.stdout.emit('data', 'awa'); child.stdout.emit('data', 'ke\r\n');
  assert.equal(hold.active, true); assert.equal(changes, 1);
  assert.equal(command.options.windowsHide, true);
  const script = Buffer.from(command.args.at(-1), 'base64').toString('utf16le');
  assert.match(script, /-eq 0/); assert.match(script, /\$parent.Refresh\(\)/);
  hold.release(); hold.release();
  assert.equal(hold.active, false); assert.equal(child.killed, true);
});

test('a failed helper clears its status and reacquires protection', async () => {
  const children = [], errors = [];
  const hold = keepAwake({ platform: 'win32', retryMs: 5, spawnImpl: () => { const child = helper(); children.push(child); return child; }, onError: error => errors.push(error) });
  try {
    children[0].stdout.emit('data', 'awake\n');
    children[0].emit('error', new Error('helper failed')); children[0].emit('exit', 1);
    assert.equal(hold.active, false); assert.equal(errors.length, 1);
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(children.length, 2);
    children[1].stdout.emit('data', 'awake\n'); assert.equal(hold.active, true);
  } finally { hold.release(); }
});

test('missing acknowledgement retries, and release cancels retries', async () => {
  const children = [], errors = [];
  const hold = keepAwake({ platform: 'win32', readyMs: 5, retryMs: 50, spawnImpl: () => { const child = helper(); children.push(child); return child; }, onError: error => errors.push(error) });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(errors.length, 1); assert.equal(children[0].killed, true);
  hold.release(); await new Promise(resolve => setTimeout(resolve, 65));
  assert.equal(children.length, 1);
  assert.equal(keepAwake({ platform: 'linux' }), null);
});
