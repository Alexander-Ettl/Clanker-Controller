'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
require('./model-fixture').seedModels();
const { StreamEngine } = require('../lib/stream-engine.js');
const { prepareCliEnv, findBundledRipgrepDir, configureAppRoot } = require('../lib/cli-env.js');
const { attachmentPrompt } = require('../lib/attachments.js');

const FAKE_AGY_BODY = `
const readline = require('node:readline');
const convId = process.env.FAKE_AGY_CONV || 'conv-warm-1';
let turn = 0;
process.stdout.write(JSON.stringify({ event: 'init', conversation_id: convId }) + '\\n');
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  if (!line.trim()) return;
  turn += 1;
  const msg = JSON.parse(line);
  const content = String(msg?.message?.content || '');
  if (content.includes('TRIGGER_ERROR')) {
    process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'ERROR', error: 'simulated turn failure' } }) + '\\n');
    return;
  }
  process.stdout.write(JSON.stringify({
    event: 'step_update',
    step_update: { conversation_id: convId, step_index: turn, step_type: 'text', state: 'DONE', text_delta: 'pid=' + process.pid + ' turn=' + turn + ' ' + content },
  }) + '\\n');
  process.stdout.write(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } }) + '\\n');
});
rl.on('close', () => process.exit(0));
`;

function createFakeAgy(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-fake-agy-'));
  const script = path.join(dir, 'fake-agy.js');
  fs.writeFileSync(script, FAKE_AGY_BODY, 'utf8');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, script };
}

function createFakeEngine(t, script, extra = {}) {
  const spawns = [];
  const cwd = extra.cwd || fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agy-cwd-'));
  if (!extra.cwd) t.after(() => fs.rmSync(cwd, { recursive: true, force: true }));
  const engine = new StreamEngine({
    cwd,
    locateImpl: () => ({ agent: 'gemini', path: script, checked: [script] }),
    spawnImpl: (_cmd, args, options) => {
      spawns.push({ args: [...args], env: options.env });
      return spawn(process.execPath, [script, ...args], options);
    },
    agyThoughtReader: () => [],
    agyContextReader: () => null,
    ...extra,
  });
  t.after(() => engine.dispose());
  return { engine, spawns, cwd };
}

function runTurn(engine, options) {
  return new Promise((resolve, reject) => {
    const events = [];
    const timer = setTimeout(() => reject(new Error(`turn timed out; saw: ${JSON.stringify(events)}`)), 5000);
    const onEvent = (event) => {
      events.push(event);
      if (event.type === 'turn_complete') {
        clearTimeout(timer);
        engine.off('event', onEvent);
        resolve(events);
      }
    };
    engine.on('event', onEvent);
    engine.start({ agent: 'gemini', ...options });
  });
}

test('agy commandFor maps permission modes, effort, and deduplicated --add-dir flags', (t) => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agy-flags-cwd-'));
  const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agy-flags-att-'));
  const extraDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agy-flags-ext-'));
  t.after(() => {
    fs.rmSync(cwd, { recursive: true, force: true });
    fs.rmSync(attachDir, { recursive: true, force: true });
    fs.rmSync(extraDir, { recursive: true, force: true });
  });
  const fakeLocate = () => ({ agent: 'gemini', path: '/fake/agy', checked: [] });

  const full = new StreamEngine({ cwd, attachmentsDir: attachDir, permissionMode: 'fullAccess', locateImpl: fakeLocate });
  const auto = new StreamEngine({ cwd, attachmentsDir: attachDir, permissionMode: 'auto', locateImpl: fakeLocate });
  const ask = new StreamEngine({ cwd, attachmentsDir: attachDir, permissionMode: 'ask', locateImpl: fakeLocate });

  const fullSpec = full.commandFor('gemini', 'hello', [path.join(cwd, 'inside.txt'), path.join(attachDir, 'shot.png'), path.join(extraDir, 'notes.md')], { model: 'gemini-4-neon', effort: 'high' });
  assert.ok(fullSpec.args.includes('--dangerously-skip-permissions'));
  assert.ok(!fullSpec.args.includes('--mode'));
  assert.equal(fullSpec.args[fullSpec.args.indexOf('--effort') + 1], 'high');
  assert.equal(fullSpec.keepStdinOpen, true);

  const addDirs = [];
  for (let i = 0; i < fullSpec.args.length; i += 1) {
    if (fullSpec.args[i] === '--add-dir') addDirs.push(fullSpec.args[i + 1]);
  }
  assert.deepEqual(addDirs, [cwd, attachDir, extraDir], 'includes cwd, attachmentsDir, and external attachment parent without duplicating cwd');

  const bakedEffort = full.commandFor('gemini', 'hello', [], { model: 'gemini-4-neon-high', effort: 'high' });
  assert.ok(!bakedEffort.args.includes('--effort'), 'omits redundant --effort when model id already ends with -high');

  const autoSpec = auto.commandFor('gemini', 'hello', [], { model: 'gemini-4-neon' });
  assert.equal(autoSpec.args[autoSpec.args.indexOf('--mode') + 1], 'auto');
  assert.ok(!autoSpec.args.includes('--dangerously-skip-permissions'));

  const askSpec = ask.commandFor('gemini', 'hello', [], { model: 'gemini-4-neon' });
  assert.equal(askSpec.args[askSpec.args.indexOf('--mode') + 1], 'accept-edits');
  assert.ok(!askSpec.args.includes('--dangerously-skip-permissions'));

  const compactSpec = full.commandFor('gemini', 'compact', [], { model: 'gemini-4-neon', compact: true });
  assert.equal(compactSpec.keepStdinOpen, false, 'compaction turns do not stay warm');
});

test('warm agy process is reused across follow-up turns and attachments in attachmentsDir', async (t) => {
  const { script } = createFakeAgy(t);
  const attachDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agy-attach-'));
  t.after(() => fs.rmSync(attachDir, { recursive: true, force: true }));
  const { engine, spawns } = createFakeEngine(t, script, { attachmentsDir: attachDir, agyIdleMs: 60000 });

  const turn1 = await runTurn(engine, { prompt: 'first', model: 'gemini-4-neon' });
  const delta1 = turn1.find((e) => e.type === 'delta')?.text || '';
  const session = turn1.find((e) => e.type === 'session')?.sessionId;
  assert.equal(session, 'conv-warm-1');
  assert.equal(spawns.length, 1);
  assert.match(delta1, /turn=1 first/);

  const turn2 = await runTurn(engine, { prompt: 'second', model: 'gemini-4-neon', resume: 'conv-warm-1' });
  const delta2 = turn2.find((e) => e.type === 'delta')?.text || '';
  assert.equal(spawns.length, 1, 'reuses the same warm agy process on follow-up turn');
  assert.match(delta2, /turn=2 second/);
  assert.equal(delta1.split(' ')[0], delta2.split(' ')[0], 'same OS process PID answered both turns');

  const shot = path.join(attachDir, 'shot.png');
  fs.writeFileSync(shot, 'png');
  const turn3 = await runTurn(engine, { prompt: 'check image', model: 'gemini-4-neon', resume: 'conv-warm-1', attachments: [shot] });
  const delta3 = turn3.find((e) => e.type === 'delta')?.text || '';
  assert.equal(spawns.length, 1, 'attachment inside pre-authorized attachmentsDir keeps warm agy alive');
  assert.match(delta3, /turn=3 check image/);
});

test('warm agy recycles when model, permissionMode, conversation id, or external dir changes', async (t) => {
  const { script } = createFakeAgy(t);
  const externalDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-agy-ext-'));
  t.after(() => fs.rmSync(externalDir, { recursive: true, force: true }));
  const { engine, spawns } = createFakeEngine(t, script, { agyIdleMs: 60000 });

  await runTurn(engine, { prompt: 'one', model: 'gemini-4-neon', permissionMode: 'fullAccess' });
  assert.equal(spawns.length, 1);

  await runTurn(engine, { prompt: 'two', model: 'gemini-3.8-flash', permissionMode: 'fullAccess' });
  assert.equal(spawns.length, 2, 'model switch spawns a fresh process');

  await runTurn(engine, { prompt: 'three', model: 'gemini-3.8-flash', permissionMode: 'auto' });
  assert.equal(spawns.length, 3, 'permissionMode change spawns a fresh process');

  await runTurn(engine, { prompt: 'four', model: 'gemini-3.8-flash', permissionMode: 'auto', resume: 'conv-other-99' });
  assert.equal(spawns.length, 4, 'switching to another conversation id spawns a fresh process');

  const extFile = path.join(externalDir, 'spec.md');
  fs.writeFileSync(extFile, '# spec');
  await runTurn(engine, { prompt: 'five', model: 'gemini-3.8-flash', permissionMode: 'auto', attachments: [extFile] });
  assert.equal(spawns.length, 5, 'new external attachment dir restarts with --add-dir');
  assert.ok(spawns[4].args.includes(externalDir));
});

test('warm agy releases itself after the idle TTL expires', async (t) => {
  const { script } = createFakeAgy(t);
  const { engine } = createFakeEngine(t, script, { agyIdleMs: 60 });

  await runTurn(engine, { prompt: 'ping', model: 'gemini-4-neon' });
  assert.ok(engine.warmAgy, 'warm process stays alive right after turn_complete');
  const child = engine.warmAgy;
  const exited = new Promise((resolve) => child.once('close', resolve));
  await exited;
  assert.equal(engine.warmAgy, null, 'idle TTL closed stdin and cleared warmAgy');
});

test('under memory pressure an idle warm agy closes at once; a busy or absent one is left alone', async (t) => {
  const { script } = createFakeAgy(t);
  const { engine } = createFakeEngine(t, script, { agyIdleMs: 60000 });
  assert.equal(engine.releaseIdleWarm(), false, 'nothing warm yet');
  await runTurn(engine, { prompt: 'ping', model: 'gemini-4-neon' });
  const child = engine.warmAgy;
  assert.ok(child, 'warm between turns');
  child.turnCompleted = false;
  assert.equal(engine.releaseIdleWarm(), false, 'a turn in progress keeps its process');
  child.turnCompleted = true;
  const exited = new Promise((resolve) => child.once('close', resolve));
  assert.equal(engine.releaseIdleWarm(), true);
  assert.equal(engine.warmAgy, null);
  await exited; // closed now, not after the 60 s idle TTL
});

test('warm agy does not hang on ERROR result and retires the errored process', async (t) => {
  const { script } = createFakeAgy(t);
  const { engine, spawns } = createFakeEngine(t, script, { agyIdleMs: 60000 });

  const child = engine.start({ agent: 'gemini', prompt: 'TRIGGER_ERROR', model: 'gemini-4-neon' });
  const events = [];
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('ERROR result hung')), 5000);
    engine.on('event', (event) => {
      events.push(event);
      if (event.type === 'turn_complete') { clearTimeout(timer); resolve(); }
    });
  });
  assert.ok(events.some((e) => e.type === 'delta' && /simulated turn failure/.test(e.text)));
  assert.equal(engine.warmAgy, null, 'errored warm process is retired instead of reused');
  await new Promise((resolve) => (child.exitCode !== null ? resolve() : child.once('close', resolve)));
  assert.equal(spawns.length, 1);
});

test('prepareCliEnv repairs broken GIT_CONFIG_* and appends bundled rg only when missing on PATH', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-cli-env-'));
  t.after(() => {
    configureAppRoot('');
    fs.rmSync(root, { recursive: true, force: true });
  });
  const binName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const universalDir = path.join(root, 'node_modules.asar.unpacked', '@vscode', 'ripgrep-universal', 'bin', `${process.platform}-${process.arch}`);
  fs.mkdirSync(universalDir, { recursive: true });
  fs.writeFileSync(path.join(universalDir, binName), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  configureAppRoot(root);
  assert.equal(findBundledRipgrepDir({ skipCache: true }), universalDir);

  const raw = { PATH: '/nonexistent-bin', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'credential.helper' };
  const cleaned = prepareCliEnv(raw, { appRoot: root });
  assert.equal(raw.GIT_CONFIG_VALUE_0, undefined, 'does not mutate input env object');
  assert.equal(cleaned.GIT_CONFIG_VALUE_0, '', 'repairs missing GIT_CONFIG_VALUE_0');
  assert.ok(cleaned.PATH.endsWith(`${path.delimiter}${universalDir}`), 'appends bundled rg dir to the end of PATH');

  // Existing rg on PATH is never overridden or duplicated.
  const userBin = path.join(root, 'user-bin');
  fs.mkdirSync(userBin, { recursive: true });
  fs.writeFileSync(path.join(userBin, binName), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const alreadyHasRg = prepareCliEnv({ PATH: userBin }, { appRoot: root });
  assert.equal(alreadyHasRg.PATH, userBin);
});

test('image-only attachmentPrompt omits redundant document-reading boilerplate', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-img-prompt-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const img = path.join(dir, 'before.png');
  const doc = path.join(dir, 'notes.md');
  fs.writeFileSync(img, 'png');
  fs.writeFileSync(doc, '# hello');

  const imageOnly = attachmentPrompt('Check this screenshot', [img]);
  assert.match(imageOnly, /Open and inspect the attached original image files/);
  assert.ok(imageOnly.includes(`Attachment available locally: ${img}`));
  assert.ok(!imageOnly.includes('Read the attached documents'), 'omits document boilerplate on image-only turns');

  const withDoc = attachmentPrompt('Check both', [img, doc]);
  assert.match(withDoc, /Open and inspect the attached original image files/);
  assert.match(withDoc, /Read the attached documents/);
});
