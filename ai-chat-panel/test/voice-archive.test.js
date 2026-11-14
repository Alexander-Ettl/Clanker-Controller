'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const archive = require('../lib/voice-archive.js');

const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'voice-archive-'));
const addSegments = (dir, count) => Array.from({ length: count }, (_, i) => {
  const file = path.join(dir, `seg-${String(i).padStart(3, '0')}.wav`);
  fs.writeFileSync(file, Buffer.alloc(100));
  return file;
});

test('a recording folder is named by time, never collides and starts as "recording"', () => {
  const root = tempRoot();
  const now = new Date(2026, 10, 8, 14, 3, 22);
  const first = archive.newRecordingDir(root, now);
  const second = archive.newRecordingDir(root, now);
  assert.equal(path.basename(first), '2026-11-08_14-03-22');
  assert.equal(path.basename(second), '2026-11-08_14-03-22-2');
  assert.equal(archive.readMeta(first).status, 'recording');
  assert.ok(fs.existsSync(path.join(root, 'README.txt')), 'the archive explains itself');
});

test('every segment is transcribed in order and saved the moment it returns', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  const wavs = addSegments(dir, 3);
  const seen = [];
  const result = await archive.transcribeRecording(dir, async (wav) => {
    seen.push(path.basename(wav));
    // by the time segment 2 is asked for, segment 1's text is already on disk and the joined text is current
    if (wav === wavs[1]) assert.match(fs.readFileSync(path.join(dir, 'transcript.raw.txt'), 'utf8'), /^one \[Part 2 /);
    return ` text of ${path.basename(wav, '.wav')} `.replace('text of seg-000', 'one').replace('text of seg-001', 'two').replace('text of seg-002', 'three');
  });
  assert.deepEqual(seen, ['seg-000.wav', 'seg-001.wav', 'seg-002.wav']);
  assert.equal(result.text, 'one two three');
  assert.deepEqual(result.failed, []);
  assert.equal(fs.readFileSync(path.join(dir, 'seg-001.txt'), 'utf8'), 'two');
  assert.equal(archive.readMeta(dir).status, 'transcribed');
});

test('a short dictation is one segment and one request', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 1);
  let calls = 0;
  const result = await archive.transcribeRecording(dir, async () => { calls++; return 'hello there'; });
  assert.equal(calls, 1);
  assert.equal(result.text, 'hello there');
});

test('a failing segment is retried, then marked in the text while the others still arrive', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 3);
  const calls = [];
  const result = await archive.transcribeRecording(dir, async (wav) => {
    const name = path.basename(wav);
    calls.push(name);
    if (name === 'seg-001.wav') throw new Error('Groq transcription error 429');
    return name === 'seg-000.wav' ? 'first' : 'third';
  }, { delays: [1, 1] });
  assert.equal(calls.filter((name) => name === 'seg-001.wav').length, 3, 'one try and two retries');
  assert.deepEqual(result.failed, [2]);
  assert.match(result.text, /^first \[Part 2 \(from 5:00\) was not transcribed. Audio: .*seg-001\.wav\] third$/);
  assert.equal(result.lastError, 'Groq transcription error 429');
  assert.equal(archive.readMeta(dir).status, 'partial');
  assert.ok(!fs.existsSync(path.join(dir, 'seg-001.txt')), 'a failed segment leaves no text file, so it is asked again');
});

test('a retry that works needs no marker', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 1);
  let tries = 0;
  const result = await archive.transcribeRecording(dir, async () => { if (++tries < 2) throw new Error('network'); return 'ok'; }, { delays: [1] });
  assert.equal(result.text, 'ok');
  assert.deepEqual(result.failed, []);
});

test('transcribing again only sends the segments that are missing', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 3);
  await archive.transcribeRecording(dir, async (wav) => { if (wav.endsWith('seg-002.wav')) throw new Error('down'); return path.basename(wav, '.wav'); }, { delays: [] });
  const asked = [];
  const result = await archive.transcribeRecording(dir, async (wav) => { asked.push(path.basename(wav)); return 'late'; });
  assert.deepEqual(asked, ['seg-002.wav']);
  assert.equal(result.text, 'seg-000 seg-001 late');
  assert.deepEqual(result.failed, []);
});

test('a silent segment is remembered as silence and is not asked again', async () => {
  const dir = archive.newRecordingDir(tempRoot());
  addSegments(dir, 2);
  await archive.transcribeRecording(dir, async (wav) => (wav.endsWith('000.wav') ? '' : 'speech'));
  let asked = 0;
  const result = await archive.transcribeRecording(dir, async () => { asked++; return 'x'; });
  assert.equal(asked, 0);
  assert.equal(result.text, 'speech');
});

test('finishing keeps the cleaned text and the status; partial and unfinished recordings are flagged', async () => {
  const root = tempRoot();
  const done = archive.newRecordingDir(root, new Date(2026, 10, 8, 10, 0, 0));
  addSegments(done, 1);
  archive.finishRecording(done, { cleaned: 'Clean text.', raw: 'raw text' });
  const crashed = archive.newRecordingDir(root, new Date(2026, 10, 8, 11, 0, 0)); // still "recording": the IDE died
  addSegments(crashed, 2);
  const empty = archive.newRecordingDir(root, new Date(2026, 10, 8, 12, 0, 0)); // no audio at all
  assert.equal(fs.readFileSync(path.join(done, 'transcript.txt'), 'utf8'), 'Clean text.');
  const list = archive.listRecordings(root);
  assert.deepEqual(list.map((entry) => path.basename(entry.dir)), [path.basename(empty), path.basename(crashed), path.basename(done)], 'newest first');
  assert.deepEqual(list.map((entry) => entry.needsAttention), [false, true, false]);
  assert.equal(list[1].segments, 2);
});

test('recordings older than seven days are deleted, younger ones and ones still being written are kept', () => {
  const root = tempRoot();
  const day = 24 * 60 * 60 * 1000;
  const make = (name, ageDays) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    const file = path.join(dir, 'seg-000.wav');
    fs.writeFileSync(file, Buffer.alloc(100));
    const when = new Date(Date.now() - ageDays * day);
    fs.utimesSync(file, when, when);
    fs.utimesSync(dir, when, when);
    return dir;
  };
  const old = make('old', 8);
  const recent = make('recent', 6);
  const writing = make('writing', 8);
  fs.writeFileSync(path.join(writing, 'seg-001.wav'), Buffer.alloc(100)); // changed just now: a long recording in progress
  fs.writeFileSync(path.join(root, 'README.txt'), 'x');
  const removed = archive.sweepVoiceArchive(root);
  assert.equal(removed.recordings, 1);
  assert.ok(!fs.existsSync(old));
  assert.ok(fs.existsSync(recent) && fs.existsSync(writing) && fs.existsSync(path.join(root, 'README.txt')));
});

test('sweeping a folder that does not exist yet is harmless', () => {
  assert.deepEqual(archive.sweepVoiceArchive(path.join(os.tmpdir(), 'no-such-voice-archive')), { recordings: 0, bytes: 0 });
});
