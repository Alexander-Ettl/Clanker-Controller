'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { repairGitConfigEnv } = require('../lib/git-env.js');

test('missing values become empty strings and git works again', () => {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_CONFIG_/.test(k)));
  Object.assign(env, { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'credential.https://x.test/.helper', GIT_CONFIG_KEY_1: 'credential.https://x.test/.helper', GIT_CONFIG_VALUE_1: '!true' });
  assert.throws(() => execFileSync('git', ['config', '--get', 'user.name'], { env, stdio: 'pipe' }));
  assert.deepEqual(repairGitConfigEnv(env), { repaired: true, dropped: false, filled: 1 });
  assert.equal(env.GIT_CONFIG_VALUE_0, '');
  assert.equal(env.GIT_CONFIG_VALUE_1, '!true');
  assert.doesNotThrow(() => { try { execFileSync('git', ['config', '--get', 'user.name'], { env, stdio: 'pipe' }); } catch (e) { if (e.status !== 1) throw e; } });
});

test('a missing key or a bad count drops the whole set; a healthy set is untouched', () => {
  const noKey = { GIT_CONFIG_COUNT: '2', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1', PATH: 'x' };
  assert.equal(repairGitConfigEnv(noKey).dropped, true);
  assert.deepEqual(Object.keys(noKey), ['PATH']);
  const bad = { GIT_CONFIG_COUNT: 'abc', GIT_CONFIG_KEY_0: 'a.b' };
  assert.equal(repairGitConfigEnv(bad).dropped, true);
  assert.deepEqual(Object.keys(bad), []);
  const ok = { GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'a.b', GIT_CONFIG_VALUE_0: '1' };
  assert.deepEqual(repairGitConfigEnv(ok), { repaired: false, dropped: false });
  assert.deepEqual(repairGitConfigEnv({ PATH: 'x' }), { repaired: false, dropped: false });
});
