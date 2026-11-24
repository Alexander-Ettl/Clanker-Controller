'use strict';

// Replays recorded CLI output (test/fixtures/providers/<provider>/<version>/<case>.jsonl) through the stream engine and compares the
// events with the golden file next to it. UPDATE_FIXTURES=1 rewrites the golden files. With no recordings it skips, loudly.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { StreamEngine } = require('../lib/stream-engine.js');

const root = path.join(__dirname, 'fixtures', 'providers');
const cases = [];
for (const provider of fs.existsSync(root) ? fs.readdirSync(root, { withFileTypes: true }).filter((e) => e.isDirectory()) : []) {
  for (const version of fs.readdirSync(path.join(root, provider.name), { withFileTypes: true }).filter((e) => e.isDirectory())) {
    for (const file of fs.readdirSync(path.join(root, provider.name, version.name)).filter((name) => name.endsWith('.jsonl'))) {
      cases.push({ provider: provider.name, version: version.name, name: file.replace(/\.jsonl$/, ''), file: path.join(root, provider.name, version.name, file) });
    }
  }
}

// Shapes that must never reach the repository: a real home directory, an email address, something key-like.
const LEAKS = [
  [/\/home\/(?!user\b)[a-z][\w.-]*/i, 'a home directory'],
  [/[A-Z]:\\Users\\(?!user\b)[^\\"\s]+/i, 'a Windows user folder'],
  [/\/Users\/(?!user\b)[a-z][\w.-]*/i, 'a macOS user folder'],
  [/[\w.+-]+@(?!example\.(com|org)\b)[\w-]+\.[\w.-]+/i, 'an email address'],
  [/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|AIza[0-9A-Za-z_-]{20,}|ya29\.[\w.-]{20,}|eyJ[\w-]{20,}\.[\w-]{10,})/, 'a token'],
];

function replay(provider, lines) {
  const engine = new StreamEngine();
  const events = [];
  engine.on('event', (event) => events.push(JSON.parse(JSON.stringify(event))));
  engine.agyTurnAt = Date.now();
  for (const line of lines) engine.consumeLine(line, provider);
  return events;
}

if (!cases.length) {
  test('recorded provider output replays to the same events', { skip: 'no recordings yet: see test/fixtures/providers/README.md (they need your own CLI sign-ins)' }, () => {});
}

for (const c of cases) {
  const label = `${c.provider} ${c.version} / ${c.name}`;
  test(`${label}: the recording holds no personal data`, () => {
    const text = fs.readFileSync(c.file, 'utf8');
    for (const [pattern, what] of LEAKS) assert.doesNotMatch(text, pattern, `${c.file} still contains ${what}`);
  });
  test(`${label}: replays to the recorded events`, () => {
    const lines = fs.readFileSync(c.file, 'utf8').split(/\r?\n/).filter(Boolean);
    const actual = replay(c.provider, lines);
    const golden = c.file.replace(/\.jsonl$/, '.expected.json');
    if (process.env.UPDATE_FIXTURES === '1') { fs.writeFileSync(golden, `${JSON.stringify(actual, null, 2)}\n`); return; }
    assert.ok(fs.existsSync(golden), `${golden} is missing: run UPDATE_FIXTURES=1 node --test ai-chat-panel/test/provider-fixtures.test.js and read it`);
    assert.deepEqual(actual, JSON.parse(fs.readFileSync(golden, 'utf8')));
    assert.ok(actual.length > 0, 'a recording that produces no events guards nothing');
  });
}

test('the leak scan itself catches what it should', () => {
  const sample = ['/home/alice/dev', 'C:\\Users\\alice\\x', 'me@gmail.com', 'sk-ant-abcdefghijklmnopqrstu'];
  for (const text of sample) assert.ok(LEAKS.some(([pattern]) => pattern.test(text)), `${text} is not caught`);
  for (const ok of ['/home/user/project', 'user@example.com', 'session-0001']) assert.ok(!LEAKS.some(([pattern]) => pattern.test(ok)), `${ok} is wrongly flagged`);
});
