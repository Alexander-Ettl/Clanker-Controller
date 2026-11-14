'use strict';

// Dictation pipeline (lib/voice-archive.js): work during the recording, never lose a chunk. And silence trimming.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const archive = require('../lib/voice-archive.js');

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voice-pipeline-'));
const addSegments = (dir, count) => Array.from({ length: count }, (_, i) => {
  const file = path.join(dir, `seg-${String(i).padStart(3, '0')}.wav`);
  if (!fs.existsSync(file)) fs.writeFileSync(file, Buffer.alloc(100));
  return file;
});
const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0;

// Fake chunking at '|': the last chunk may still grow as text arrives, the earlier ones can't (like splitTranscript).
const textOf = { 'seg-000.wav': 'alpha|beta', 'seg-001.wav': 'beta2|gamma', 'seg-002.wav': 'delta' };
const fakePipeline = (dir, overrides = {}) => {
  const calls = { transcribe: [], clean: [] };
  const pipeline = new archive.DictationPipeline(dir, {
    transcribe: async (file) => { calls.transcribe.push(path.basename(file)); return textOf[path.basename(file)] || ''; },
    clean: async (text) => { calls.clean.push(text); return text.toUpperCase(); },
    split: (text) => text.split('|'),
    delays: [],
    cleanDelays: [1, 1],
    ...overrides,
  });
  return { pipeline, calls };
};

test('while recording, finished parts are transcribed and stable text is cleaned; the part being written is left alone', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 2); // seg-001 is the one ffmpeg is still writing
  const { pipeline, calls } = fakePipeline(dir);
  await pipeline.poll();
  assert.deepEqual(calls.transcribe, ['seg-000.wav']);
  assert.deepEqual(calls.clean, ['alpha'], 'the last chunk of the text so far may still grow, so it waits');
  addSegments(dir, 3);
  await pipeline.poll();
  assert.deepEqual(calls.transcribe, ['seg-000.wav', 'seg-001.wav']);
  const done = await pipeline.finish();
  assert.deepEqual(calls.transcribe, ['seg-000.wav', 'seg-001.wav', 'seg-002.wav'], 'finishing sends only the last part');
  assert.deepEqual(calls.clean, ['alpha', 'beta beta2', 'gamma delta'], 'each chunk is cleaned exactly once');
  assert.equal(done.cleaned, 'ALPHA\n\nBETA BETA2\n\nGAMMA DELTA');
  assert.equal(done.cleanFailed, 0);
});

test('polling does nothing while no part has finished', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 1);
  const { pipeline, calls } = fakePipeline(dir);
  await pipeline.poll();
  assert.deepEqual(calls.transcribe, []);
  assert.deepEqual(calls.clean, []);
});

test('a short dictation is one transcription and one cleaning, without chunk numbering', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 1);
  const infos = [];
  const { pipeline, calls } = fakePipeline(dir, { split: (text) => [text], clean: async (text, info) => { infos.push(info); return text; } });
  const done = await pipeline.finish();
  assert.deepEqual(calls.transcribe, ['seg-000.wav']);
  assert.deepEqual(infos, [{ number: 1, multi: false }]);
  assert.equal(done.cleaned, 'alpha|beta');
});

test('a chunk that cannot be cleaned stays as its raw text; the others are still cleaned', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 2);
  let attempts = 0;
  const { pipeline } = fakePipeline(dir, {
    clean: async (text) => { if (text === 'beta beta2') { attempts++; throw new Error('Groq local budget exhausted'); } return text.toUpperCase(); },
  });
  const done = await pipeline.finish();
  assert.equal(done.cleaned, 'ALPHA\n\nbeta beta2\n\nGAMMA');
  assert.equal(done.cleanFailed, 1);
  assert.equal(attempts, 3, 'a spent token allowance is waited out: one try and two retries');
  assert.match(done.lastCleanError, /budget/);
  assert.equal(archive.readMeta(dir).cleanFailedChunks, 1);
});

test('a failure that is not about the allowance is retried once, not waited out', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 1);
  let attempts = 0;
  const { pipeline } = fakePipeline(dir, { split: (text) => [text], clean: async () => { attempts++; throw new Error('fetch failed'); } });
  const done = await pipeline.finish();
  assert.equal(attempts, 2);
  assert.equal(done.cleaned, 'alpha|beta', 'the raw text comes through');
  assert.equal(done.cleanFailed, 1);
});

test('a part that failed while recording is asked again at the end and leaves no marker', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 2);
  let down = true;
  const { pipeline, calls } = fakePipeline(dir, { transcribe: async (file) => { if (down) throw new Error('offline'); return textOf[path.basename(file)] || 'x'; } });
  await pipeline.poll();
  assert.equal(fs.existsSync(path.join(dir, 'seg-000.txt')), false);
  down = false;
  const done = await pipeline.finish();
  assert.deepEqual(done.failed, []);
  assert.doesNotMatch(done.cleaned, /not transcribed/i);
  assert.equal(calls.clean.length, 3);
});

test('without polling (Recover) the whole recording is done at once, two chunks at a time, in order', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 3);
  let running = 0;
  let peak = 0;
  const { pipeline } = fakePipeline(dir, { clean: async (text) => { peak = Math.max(peak, ++running); await new Promise((resolve) => setTimeout(resolve, 15)); running--; return text.toUpperCase(); } });
  const done = await pipeline.finish();
  assert.equal(done.cleaned, 'ALPHA\n\nBETA BETA2\n\nGAMMA DELTA');
  assert.equal(peak, 2);
});

test('a cancelled recording is not worked on any more', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 2);
  const { pipeline, calls } = fakePipeline(dir);
  pipeline.cancel();
  await pipeline.poll();
  assert.deepEqual(calls.transcribe, []);
});

test('short parts and a missing ffmpeg send the original audio', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  const [wav] = addSegments(dir, 1);
  assert.deepEqual(await archive.trimSilence(wav), { file: wav, temp: false }, 'under 45 s is sent as it is');
  assert.deepEqual(await archive.trimSilence(wav, { minBytes: 0, ffmpeg: path.join(os.tmpdir(), 'no-such-ffmpeg') }), { file: wav, temp: false });
});

test('ffmpeg cuts long pauses from the upload, leaves the archived audio alone and skips pure silence', { skip: !hasFfmpeg }, async () => {
  const dir = archive.newRecordingDir(tempRoot());
  const wav = path.join(dir, 'seg-000.wav');
  // 3 s tone, 40 s silence, 3 s tone
  const made = spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=3', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-filter_complex', '[1]atrim=0:40[s];[0][s][0]concat=n=3:v=0:a=1,aformat=sample_rates=16000:channel_layouts=mono', '-ar', '16000', '-ac', '1', wav]);
  assert.equal(made.status, 0, String(made.stderr));
  const before = fs.statSync(wav).size;
  const trimmed = await archive.trimSilence(wav, { minBytes: 0 });
  assert.equal(trimmed.temp, true);
  const seconds = Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', trimmed.file]).stdout.toString());
  assert.ok(seconds > 6 && seconds < 10, `two 3 s tones and short pauses, got ${seconds} s`);
  assert.equal(fs.statSync(wav).size, before, 'the archived WAV is untouched');
  fs.rmSync(trimmed.file);

  const quiet = path.join(dir, 'seg-001.wav');
  assert.equal(spawnSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=16000:cl=mono', '-t', '30', '-ar', '16000', '-ac', '1', quiet]).status, 0);
  assert.deepEqual(await archive.trimSilence(quiet, { minBytes: 0 }), { silent: true });
  let asked = 0;
  assert.equal(await archive.withSilenceTrim(async () => { asked++; return 'x'; }, { minBytes: 0 })(quiet), '');
  assert.equal(asked, 0, 'a silent part costs no request');
});
