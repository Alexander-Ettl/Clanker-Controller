'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
require('./model-fixture').seedModels();

let confirm;
let prompt;
const opened = [];
const vscode = {
  workspace: { getConfiguration: () => ({ get: (_key, fallback) => confirm ?? fallback }) },
  Uri: { parse: url => url },
  window: { showInformationMessage: (...args) => prompt(...args) },
  env: { openExternal: async url => { opened.push(url); } },
};
const load = Module._load;
let ChatWindowHost;
try {
  Module._load = function (request, ...args) {
    return request === 'vscode' ? vscode : load.call(this, request, ...args);
  };
  ({ ChatWindowHost } = require('../extension'));
} finally {
  Module._load = load;
}

test('external links open directly by default and wait for Open when confirmation is enabled', async () => {
  const url = 'https://example.com/docs';
  const click = (target = url) => ChatWindowHost.prototype.handleMessage.call({}, { type: 'openUrl', url: target });
  prompt = () => assert.fail('Direct opening should not prompt');
  await click();
  await click('command:workbench.action.closeWindow');
  assert.deepEqual(opened, [url]);

  confirm = true;
  for (const action of [undefined, 'Open']) {
    let finish;
    prompt = (_message, options, button) => {
      assert.deepEqual(options, { modal: true, detail: url });
      assert.equal(button, 'Open');
      return new Promise(resolve => { finish = resolve; });
    };
    const pending = click();
    assert.deepEqual(opened, [url], 'opening must wait for confirmation');
    finish(action);
    await pending;
  }
  assert.deepEqual(opened, [url, url]);
});
