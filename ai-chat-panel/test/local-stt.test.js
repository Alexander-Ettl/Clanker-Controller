'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const {
  DEFAULT_LOCAL_MODEL,
  LOCAL_STT_MODELS,
  LocalSttManager,
  cleanWhisperTranscript,
  modelById,
  modelDownloadUrl,
  pickWindowsReleaseAsset,
  resolveLocalSttDir,
} = require('../lib/local-stt.js');
const { DictationPipeline, newRecordingDir, trimSilence, withSilenceTrim } = require('../lib/voice-archive.js');

const mkTempDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-local-stt-'));

function fakeSpawn({ stdout = '', stderr = '', code = 0, calls = [] } = {}) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    process.nextTick(() => {
      if (stdout) child.stdout.emit('data', Buffer.from(stdout, 'utf8'));
      if (stderr) child.stderr.emit('data', Buffer.from(stderr, 'utf8'));
      child.emit('close', code);
    });
    return child;
  };
}

test('model catalog offers distinct English-only and Multilingual models with Hugging Face URLs', () => {
  const english = LOCAL_STT_MODELS.filter((m) => m.group === 'english');
  const multilingual = LOCAL_STT_MODELS.filter((m) => m.group === 'multilingual');
  assert.ok(english.length >= 2, 'at least two English-only models');
  assert.ok(multilingual.length >= 2, 'at least two Multilingual models');
  assert.ok(english.every((m) => m.language === 'en'));
  assert.ok(multilingual.every((m) => m.language === 'auto'));
  assert.equal(modelById('unknown-model').id, DEFAULT_LOCAL_MODEL);
  for (const model of LOCAL_STT_MODELS) {
    assert.match(modelDownloadUrl(model), /^https:\/\/huggingface\.co\/ggerganov\/whisper\.cpp\/resolve\/main\/ggml-.*\.bin$/);
  }
});

test('resolveLocalSttDir uses non-synced local user cache paths per platform and supports override', () => {
  const linuxDir = resolveLocalSttDir({ env: { XDG_CACHE_HOME: '/home/user/.cache' }, platform: 'linux', homedir: '/home/user' });
  assert.equal(linuxDir, path.join('/home/user/.cache', 'clanker-controller', 'local-stt'));

  const winDir = resolveLocalSttDir({ env: { LOCALAPPDATA: 'C:\\Users\\user\\AppData\\Local' }, platform: 'win32', homedir: 'C:\\Users\\user' });
  assert.ok(winDir.includes('clanker-controller') && winDir.endsWith('local-stt'));

  const override = resolveLocalSttDir({ env: { CLANKER_LOCAL_STT_DIR: '/tmp/custom-stt' }, platform: 'linux', homedir: '/home/user' });
  assert.equal(override, path.resolve('/tmp/custom-stt'));
});

test('pickWindowsReleaseAsset selects matching architecture zip', () => {
  const assets = [
    { name: 'whisper-bin-Win32.zip', browser_download_url: 'https://example.test/win32.zip' },
    { name: 'whisper-bin-x64.zip', browser_download_url: 'https://example.test/x64.zip' },
    { name: 'whisper-bin-arm64.zip', browser_download_url: 'https://example.test/arm64.zip' },
  ];
  assert.equal(pickWindowsReleaseAsset(assets, 'x64')?.name, 'whisper-bin-x64.zip');
  assert.equal(pickWindowsReleaseAsset(assets, 'arm64')?.name, 'whisper-bin-arm64.zip');
});

test('cleanWhisperTranscript strips non-speech markers and normalizes spacing', () => {
  assert.equal(cleanWhisperTranscript('  [BLANK_AUDIO] Hello   world. (silence)\n\n\nSecond line.  '), 'Hello world.\n\nSecond line.');
  assert.equal(cleanWhisperTranscript('[BLANK_AUDIO]'), '');
});

test('LocalSttManager downloads model atomically, reports progress, transcribes with prompt/language, and removes model', async () => {
  const root = mkTempDir();
  const fakeRuntime = path.join(root, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
  fs.mkdirSync(path.dirname(fakeRuntime), { recursive: true });
  fs.writeFileSync(fakeRuntime, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

  const progressEvents = [];
  const spawnCalls = [];
  const fakeModelBytes = Buffer.from('GGML-FAKE-WEIGHTS-DATA');
  const fetchImpl = async (url) => {
    assert.equal(url, modelDownloadUrl(modelById('small.en')));
    return {
      ok: true,
      status: 200,
      headers: { get: (k) => (k.toLowerCase() === 'content-length' ? String(fakeModelBytes.length) : null) },
      async arrayBuffer() { return fakeModelBytes; },
    };
  };

  const manager = new LocalSttManager({
    rootDir: root,
    fetchImpl,
    spawnImpl: fakeSpawn({ stdout: '  Fix Clanker Controller cursor insertion. [BLANK_AUDIO]\n', calls: spawnCalls }),
    onChange: () => {
      if (manager.progress) progressEvents.push(manager.progress);
    },
  });

  try {
    assert.equal(manager.snapshot('small.en').ready, false);
    assert.equal(manager.snapshot('small.en').runtime.installed, true);

    const installed = await manager.install('small.en');
    assert.deepEqual(installed, { ok: true, model: 'small.en' });
    assert.equal(manager.snapshot('small.en').ready, true);
    assert.ok(progressEvents.length >= 1, 'emitted install progress');
    assert.equal(fs.existsSync(`${manager.modelPath('small.en')}.tmp`), false, 'no leftover .tmp file');

    const wav = path.join(root, 'sample.wav');
    fs.writeFileSync(wav, Buffer.alloc(64));
    const text = await manager.transcribe(wav, { modelId: 'small.en', vocabularyPrompt: 'Clanker, Visor' });
    assert.equal(text, 'Fix Clanker Controller cursor insertion.');
    assert.equal(spawnCalls.length, 1);
    assert.equal(spawnCalls[0].command, fakeRuntime);
    assert.ok(spawnCalls[0].args.includes('-l'));
    assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf('-l') + 1], 'en');
    assert.equal(spawnCalls[0].args[spawnCalls[0].args.indexOf('--prompt') + 1], 'Clanker, Visor');

    manager.removeModel('small.en');
    assert.equal(manager.snapshot('small.en').ready, false);
    await assert.rejects(() => manager.transcribe(wav, { modelId: 'small.en' }), /not downloaded yet/i);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('LocalSttManager uses language=auto for multilingual models and reports actionable error when Unix build tools are missing', async () => {
  const root = mkTempDir();
  const calls = [];
  try {
    const unixMissingTools = new LocalSttManager({
      rootDir: root,
      platform: 'linux',
      env: { PATH: '' },
      fetchImpl: async () => ({ ok: true, status: 200, arrayBuffer: async () => Buffer.from('x') }),
    });
    const res = await unixMissingTools.install('small');
    assert.equal(res.ok, false);
    assert.match(res.error, /Missing build tools to compile whisper-cli/i);

    const fakeRuntime = path.join(root, 'bin', 'whisper-cli');
    fs.mkdirSync(path.dirname(fakeRuntime), { recursive: true });
    fs.writeFileSync(fakeRuntime, 'stub');
    const manager = new LocalSttManager({
      rootDir: root,
      platform: 'linux',
      env: { PATH: '' },
      spawnImpl: fakeSpawn({ stdout: 'Hallo Welt\n', calls }),
    });
    fs.mkdirSync(path.dirname(manager.modelPath('small')), { recursive: true });
    fs.writeFileSync(manager.modelPath('small'), Buffer.from('weights'));
    const wav = path.join(root, 'de.wav');
    fs.writeFileSync(wav, Buffer.alloc(64));

    const out = await manager.transcribe(wav, { modelId: 'small' });
    assert.equal(out, 'Hallo Welt');
    assert.equal(calls[0].args[calls[0].args.indexOf('-l') + 1], 'auto');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('local dictation pipeline runs completely offline without GROQ_API_KEY and supports WAV silence trimming', async () => {
  const root = mkTempDir();
  const prevGroq = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const fakeRuntime = path.join(root, 'bin', process.platform === 'win32' ? 'whisper-cli.exe' : 'whisper-cli');
    fs.mkdirSync(path.dirname(fakeRuntime), { recursive: true });
    fs.writeFileSync(fakeRuntime, 'stub');
    const manager = new LocalSttManager({
      rootDir: root,
      spawnImpl: fakeSpawn({ stdout: 'Fully local dictation works without Groq.' }),
    });
    fs.mkdirSync(path.dirname(manager.modelPath('base.en')), { recursive: true });
    fs.writeFileSync(manager.modelPath('base.en'), Buffer.from('weights'));

    const recDir = newRecordingDir(path.join(root, 'voice'));
    fs.writeFileSync(path.join(recDir, 'seg-000.wav'), Buffer.alloc(128));

    const pipeline = new DictationPipeline(recDir, {
      transcribe: withSilenceTrim((file) => manager.transcribe(file, { modelId: 'base.en' }), { format: 'wav' }),
      clean: async (text) => text,
      split: (text) => [text],
    });
    const result = await pipeline.finish();
    assert.equal(result.failed.length, 0);
    assert.equal(result.cleaned, 'Fully local dictation works without Groq.');

    // Verify trimSilence(..., { format: 'wav' }) requests PCM WAV output rather than FLAC when triggered.
    const bigWav = path.join(root, 'big.wav');
    fs.writeFileSync(bigWav, Buffer.alloc(256));
    const trimCalls = [];
    const trimmed = await trimSilence(bigWav, {
      minBytes: 100,
      format: 'wav',
      spawnImpl: (cmd, args) => {
        trimCalls.push({ cmd, args });
        const outFile = args[args.length - 1];
        fs.writeFileSync(outFile, Buffer.alloc(128));
        const child = new EventEmitter();
        child.stderr = new EventEmitter();
        child.kill = () => {};
        process.nextTick(() => {
          child.stderr.emit('data', Buffer.from('size=1kB time=00:00:02.00 bitrate=256kbits/s'));
          child.emit('close', 0);
        });
        return child;
      },
    });
    assert.equal(trimmed.temp, true);
    assert.ok(trimmed.file.endsWith('.wav'));
    assert.ok(trimCalls[0].args.includes('pcm_s16le'));
    fs.rmSync(trimmed.file, { force: true });
  } finally {
    if (prevGroq !== undefined) process.env.GROQ_API_KEY = prevGroq;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
