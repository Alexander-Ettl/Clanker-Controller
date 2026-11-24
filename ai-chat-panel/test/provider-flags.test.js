'use strict';

// scripts/verify-cli-flags.mjs against fake CLIs: it must pass when --help lists every flag Clanker passes, fail on a rename,
// and say "skipped" (not "ok") for a CLI that is not installed. No real CLI is run.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const script = path.join(__dirname, '..', '..', 'scripts', 'verify-cli-flags.mjs');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'provider-flags.json'), 'utf8'));
delete manifest['//'];
const posix = process.platform !== 'win32';

function fakeCli(flags) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fake-cli-'));
  const file = path.join(dir, 'fakecli');
  // Shell builtins only: the test runs with an empty PATH so no real CLI can be found.
  fs.writeFileSync(file, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo "fakecli 9.9.9"; exit 0; fi\necho "Usage: fakecli [options]"\n${flags.map((flag) => `echo "  ${flag} <value>   something"`).join('\n')}\n`, { mode: 0o755 });
  return file;
}
const verify = (...argv) => spawnSync(process.execPath, [script, ...argv], { encoding: 'utf8', env: { ...process.env, PATH: '/nonexistent' } });

test('the manifest covers claude, codex and agy and lists only real long flags', () => {
  assert.deepEqual(Object.keys(manifest).sort(), ['agy', 'claude', 'codex']);
  for (const spec of Object.values(manifest)) {
    assert.ok(spec.help.length && spec.flags.length);
    for (const flag of spec.flags) assert.match(flag, /^--[a-z][a-z-]+$/);
  }
});

test('every flag in the manifest is one the code really passes', () => {
  const source = ['../lib/stream-engine.js', '../lib/providers/gemini.js', '../lib/providers/claude.js', '../lib/providers/codex.js'].map((file) => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
  const spoken = new Set(['--config']); // passed as `-c`
  for (const spec of Object.values(manifest)) for (const flag of spec.flags) {
    if (!spoken.has(flag) && flag !== '--model' && flag !== '--print') assert.ok(source.includes(`'${flag}'`) || source.includes(`"${flag}"`), `${flag} is not passed anywhere in the code any more`);
  }
});

test('a CLI that lists every flag passes, one that renamed a flag is reported as drift', { skip: !posix && 'needs a #! shell script' }, () => {
  const all = manifest.claude.flags;
  const ok = verify('claude', '--bin', `claude=${fakeCli(all)}`);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /ok\s+claude fakecli 9\.9\.9: all 11 flags/);
  const drift = verify('claude', '--bin', `claude=${fakeCli(all.map((flag) => (flag === '--output-format' ? '--format' : flag)))}`);
  assert.equal(drift.status, 1);
  assert.match(drift.stdout, /DRIFT\s+claude.*--output-format/);
});

test('a longer flag does not satisfy a shorter one, and a missing CLI is skipped, not passed', { skip: !posix && 'needs a #! shell script' }, () => {
  const near = verify('claude', '--bin', `claude=${fakeCli(manifest.claude.flags.map((flag) => (flag === '--model' ? '--model-name' : flag)))}`);
  assert.equal(near.status, 1);
  assert.match(near.stdout, /--model(\s|$)/);
  const none = verify('codex');
  assert.equal(none.status, 0);
  assert.match(none.stdout, /skipped\s+codex: not installed/);
});
