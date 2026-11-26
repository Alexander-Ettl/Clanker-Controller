'use strict';

// Every dictation is kept on disk for a week, so a long recording survives a crash, a network failure or a model
// error and can still be transcribed by hand. One folder per recording under <session>/voice/:
//
//   2026-11-08_14-03-22/
//     seg-000.wav ...      the audio, written while you speak (5 minutes each, see SEGMENT_SECONDS in native-capture.cjs)
//     seg-000.txt ...      the raw transcript of each segment, written the moment that segment comes back
//     transcript.raw.txt   all segments so far, rebuilt after every segment (so a half-finished run still has text)
//     transcript.txt       the cleaned text that went to the composer
//     meta.json            status: recording | transcribing | partial | done | empty | failed
//
// Transcription resumes: a segment that already has a .txt is not sent again, so re-running only fetches what is missing.
//
// DictationPipeline does the work WHILE you speak: a finished 5-minute part is transcribed, and the text cleaned, in the
// background, so pressing the hotkey only has the last part left. Pauses longer than ~1 s are cut from the audio that is
// uploaded (the archived WAV is untouched).

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { SEGMENT_SECONDS } = require('./voice-capture.js');

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const DEFAULT_RETRY_DELAYS_MS = [2000, 10000]; // a rate limit or a dropped connection: two more tries, then the segment is marked missing
const README = [
  'Clanker Controller keeps every voice recording here for 7 days, then deletes it.',
  '',
  'One folder per recording (named by start time):',
  '  seg-000.wav, seg-001.wav ...  the audio, 5 minutes per file (16 kHz mono; any player or Whisper tool opens them)',
  '  seg-000.txt ...               raw transcript of each segment',
  '  transcript.raw.txt            all raw segments joined',
  '  transcript.txt                the cleaned text that was put in the chat',
  '  meta.json                     status of the recording',
  '',
  'To join the audio yourself: ffmpeg -f concat -safe 0 -i list.txt -c copy all.wav',
  '(list.txt has one line per file: file \'seg-000.wav\')',
  'Command Palette: "Clanker Controller: Recover Voice Recording" transcribes whatever is missing.',
  '',
].join('\n');

const pad = (n) => String(n).padStart(2, '0');
const stamp = (date) => `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}_${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`;

function writeAtomic(file, text) {
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, text, 'utf8');
  fs.renameSync(temp, file);
}

function readMeta(dir) {
  try { return JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')); } catch { return {}; }
}

function updateMeta(dir, patch) {
  const meta = { ...readMeta(dir), ...patch, updatedAt: new Date().toISOString() };
  try { writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2)); } catch { /* the audio and transcripts matter more than the status file */ }
  return meta;
}

/** Makes the folder for a new recording and returns its path. */
function newRecordingDir(root, now = new Date()) {
  fs.mkdirSync(root, { recursive: true });
  try { if (!fs.existsSync(path.join(root, 'README.txt'))) fs.writeFileSync(path.join(root, 'README.txt'), README, 'utf8'); } catch { /* informational only */ }
  let dir = path.join(root, stamp(now));
  for (let n = 2; fs.existsSync(dir); n++) dir = path.join(root, `${stamp(now)}-${n}`);
  fs.mkdirSync(dir);
  updateMeta(dir, { status: 'recording', startedAt: now.toISOString() });
  return dir;
}

const segmentFiles = (dir) => {
  try { return fs.readdirSync(dir).filter((name) => /^seg-\d{3,}\.wav$/.test(name)).sort().map((name) => path.join(dir, name)); } catch { return []; }
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const clock = (seconds) => `${Math.floor(seconds / 60)}:${pad(seconds % 60)}`;

/**
 * Transcribes every segment of a recording that has no .txt yet, in order, saving each as it returns.
 * @param {string} dir recording folder
 * @param {(wavPath: string) => Promise<string>} transcribe
 * @returns {{ text: string, total: number, failed: number[], lastError: string }} `failed` are segment numbers (1-based)
 *   that stayed untranscribed; the text has a visible marker in their place.
 */
async function transcribeRecording(dir, transcribe, { delays = DEFAULT_RETRY_DELAYS_MS, segmentSeconds = SEGMENT_SECONDS, onSegment, skipLast = false } = {}) {
  const files = segmentFiles(dir).slice(0, skipLast ? -1 : undefined); // skipLast: the newest part is still being written
  const failed = [];
  let lastError = '';
  if (!skipLast) updateMeta(dir, { status: 'transcribing', segments: files.length });
  for (const [index, wav] of files.entries()) {
    const txt = wav.replace(/\.wav$/, '.txt');
    if (!fs.existsSync(txt)) {
      let text = null;
      for (let attempt = 0; text === null; attempt++) {
        try { text = String(await transcribe(wav)).trim(); } catch (error) {
          lastError = error?.message || String(error);
          if (attempt >= delays.length) break;
          await sleep(delays[attempt]);
        }
      }
      if (text === null) failed.push(index + 1);
      else writeAtomic(txt, text); // an empty file is a real answer: that segment is silence, and is not asked again
    }
    onSegment?.({ number: index + 1, total: files.length });
    writeAtomic(path.join(dir, 'transcript.raw.txt'), joinSegments(files, segmentSeconds, dir));
  }
  const text = joinSegments(files, segmentSeconds, dir);
  if (!skipLast) updateMeta(dir, { status: failed.length ? 'partial' : 'transcribed', failedSegments: failed, lastError });
  return { text, total: files.length, failed, lastError };
}

/** The segments' texts in order; one that was never transcribed leaves a marker so the gap is visible, not silent. */
function joinSegments(files, segmentSeconds, dir) {
  return files.map((wav, index) => {
    try { return fs.readFileSync(wav.replace(/\.wav$/, '.txt'), 'utf8').trim(); } catch {
      return `[Part ${index + 1} (from ${clock(index * segmentSeconds)}) was not transcribed. Audio: ${path.join(dir, path.basename(wav))}]`;
    }
  }).filter(Boolean).join(' ');
}

// Silence is cut from the upload, not from the archive: pauses of 1.2 s or more shrink to 0.4 s. -45 dB sits far below
// speech and above a quiet room (on a real 30-minute recording -45 and -38 dB cut the same pauses).
const SILENCE_FILTER = 'silenceremove=start_periods=1:start_threshold=-45dB:start_silence=0.3:stop_periods=-1:stop_duration=1.2:stop_threshold=-45dB:stop_silence=0.4';
const TRIM_MIN_BYTES = 45 * 32000; // a short prompt is sent as it is: nothing to gain, and no risk of clipping a quiet word
const SILENT_SECONDS = 0.4; // less than this is left of a part that was only silence (a FLAC header alone is 8 KB, so the length is read from ffmpeg's own report)

/**
 * Re-encodes a WAV part as FLAC (or 16 kHz mono WAV when `format: 'wav'`) without its pauses.
 * Resolves `{ file, temp }` (send `file`, then delete it if `temp`), `{ silent: true }` when nothing
 * but silence is left, or the original WAV if ffmpeg can't do it: sending more is safe.
 */
function trimSilence(wav, { ffmpeg = 'ffmpeg', spawnImpl = spawn, minBytes = TRIM_MIN_BYTES, format = 'flac' } = {}) {
  const original = { file: wav, temp: false };
  try { if (fs.statSync(wav).size < minBytes) return Promise.resolve(original); } catch { return Promise.resolve(original); }
  const isWav = format === 'wav';
  const ext = isWav ? '.wav' : '.flac';
  const codecArgs = isWav ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'flac'];
  return new Promise((resolve) => {
    const out = path.join(os.tmpdir(), `clanker-${process.pid}-${Date.now()}-${path.basename(wav, '.wav')}${ext}`);
    const fail = () => { fs.rm(out, { force: true }, () => {}); resolve(original); };
    let child;
    try {
      child = spawnImpl(ffmpeg, ['-y', '-loglevel', 'error', '-stats', '-i', wav, '-af', SILENCE_FILTER, '-ar', '16000', '-ac', '1', ...codecArgs, out], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    } catch { return fail(); }
    let report = '';
    child.stderr?.on('data', (chunk) => { report = (report + chunk.toString('utf8')).slice(-1000); });
    const timer = setTimeout(() => { child.kill(); }, 60000);
    child.once('error', () => { clearTimeout(timer); fail(); });
    child.once('close', (code) => {
      clearTimeout(timer);
      let size = 0;
      try { size = fs.statSync(out).size; } catch { /* no output */ }
      if (code !== 0 || !size) return fail();
      const times = [...report.matchAll(/time=(\d+):(\d+):(\d+(?:\.\d+)?)/g)];
      const last = times[times.length - 1]; // the report's last line is the length that came out; no report means "unknown", which is sent as audio
      if (last && Number(last[1]) * 3600 + Number(last[2]) * 60 + Number(last[3]) < SILENT_SECONDS) { fs.rm(out, { force: true }, () => {}); resolve({ silent: true }); return; }
      resolve({ file: out, temp: true });
    });
  });
}

/** Wraps a `transcribe(file)` so each part is silence-trimmed first; a part that is only silence costs no request. */
function withSilenceTrim(transcribe, options = {}) {
  return async (wav) => {
    const trimmed = await trimSilence(wav, options);
    if (trimmed.silent) return '';
    try { return await transcribe(trimmed.file); } finally { if (trimmed.temp) fs.rm(trimmed.file, { force: true }, () => {}); }
  };
}

const budgetError = (message) => /budget|rate.?limit|\b429\b|quota|tokens per minute/i.test(message || '');
const CLEAN_DELAYS_MS = [6000, 20000, 45000]; // Groq's token allowance is per minute: waiting a minute in total usually clears it
const CLEAN_CONCURRENCY = 2;

/**
 * Transcribes and cleans a dictation while it is still being recorded.
 *  start()  polls the folder; every part that ffmpeg has finished is transcribed, and every stable chunk of text cleaned.
 *  finish() transcribes whatever is left, cleans the rest and resolves with everything. Without start() (Recover), it is
 *           simply the whole job at once.
 * Nothing is thrown away: a part that can't be transcribed leaves a visible marker, and a chunk that can't be cleaned is
 * kept as its raw text. The audio and each part's raw text are on disk the whole time.
 * @param {object} options
 * @param {(file: string) => Promise<string>} options.transcribe speech to text for one audio file
 * @param {(text: string, info: { number: number, multi: boolean }) => Promise<string>} options.clean cleans one chunk of text (`multi`: it is one of several)
 * @param {(text: string) => string[]} options.split cuts text into chunks; all but the last never change as text is added
 */
class DictationPipeline {
  constructor(dir, { transcribe, clean, split, delays = DEFAULT_RETRY_DELAYS_MS, cleanDelays = CLEAN_DELAYS_MS, segmentSeconds = SEGMENT_SECONDS, pollMs = 3000, now = Date.now } = {}) {
    Object.assign(this, { dir, transcribe, clean, split, delays, cleanDelays, segmentSeconds, pollMs, now });
    this.cleaned = new Map(); // chunk text -> cleaned text; only successes, so a failure is tried again at the end
    this.queue = Promise.resolve();
    this.timer = null;
    this.retryAt = 0;
    this.stopped = false;
    this.lastCleanError = '';
    this.gaveUp = false; // one chunk that could not be cleaned even after waiting: the rest get a single try
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.poll(); }, this.pollMs);
    this.timer.unref?.();
  }

  /** Live pass, only when a part has finished since last time. Runs one at a time. */
  poll() {
    if (this.stopped || this.polling) return this.queue;
    const files = segmentFiles(this.dir).slice(0, -1);
    if (!files.some((wav) => !fs.existsSync(wav.replace(/\.wav$/, '.txt'))) && !this.hasUncleanedStable) return this.queue;
    if (this.now() < this.retryAt) return this.queue;
    this.polling = true;
    this.queue = this.queue.then(async () => {
      try {
        const result = await transcribeRecording(this.dir, this.transcribe, { delays: this.delays, segmentSeconds: this.segmentSeconds, skipLast: true });
        if (result.failed.length) this.retryAt = this.now() + 60000; // asked again at the end, and in a minute if still recording
        await this.cleanChunks(result.text, false);
        if (this.hasUncleanedStable) this.retryAt = this.now() + 60000;
      } catch { /* the final pass reports whatever is still missing */ } finally { this.polling = false; }
    });
    return this.queue;
  }

  /** Cleans the chunks of `text` that can no longer change (all but the last, unless `final`) and returns the chunks. */
  async cleanChunks(text, final) {
    const chunks = this.split(text);
    const stable = final ? chunks : chunks.slice(0, -1);
    this.hasUncleanedStable = false;
    const todo = stable.map((chunk, index) => ({ chunk, number: index + 1, multi: chunks.length > 1 })).filter(({ chunk }) => !this.cleaned.has(chunk));
    let next = 0;
    const worker = async () => {
      while (next < todo.length) {
        const { chunk, number, multi } = todo[next++];
        const cleaned = await this.cleanOne(chunk, { number, multi }, final);
        if (cleaned !== null) this.cleaned.set(chunk, cleaned);
        else this.hasUncleanedStable = true; // retried by the next poll's end-of-recording pass
      }
    };
    await Promise.all(Array.from({ length: Math.min(final ? CLEAN_CONCURRENCY : 1, todo.length) }, worker));
    return chunks;
  }

  /** The cleaned chunk, or null when it could not be cleaned. Waits out a full Groq minute before giving up. */
  async cleanOne(chunk, info, final) {
    const delays = this.gaveUp ? [] : this.cleanDelays;
    for (let attempt = 0; ; attempt++) {
      try { return String(await this.clean(chunk, info)).trim() || chunk; } catch (error) {
        this.lastCleanError = error?.message || String(error);
        if (attempt >= delays.length || (!budgetError(this.lastCleanError) && attempt >= 1)) break; // a real outage is not waited out minute after minute
        await sleep(delays[attempt]);
      }
    }
    if (final) this.gaveUp = true;
    return null;
  }

  /** Stops polling, finishes the transcription and the cleaning. */
  async finish() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.queue;
    const startedAt = this.now();
    const result = await transcribeRecording(this.dir, this.transcribe, { delays: this.delays, segmentSeconds: this.segmentSeconds });
    const chunks = result.text.trim() ? await this.cleanChunks(result.text, true) : [];
    const failedChunks = chunks.filter((chunk) => !this.cleaned.has(chunk)).length;
    const cleaned = chunks.map((chunk) => this.cleaned.get(chunk) ?? chunk).join('\n\n');
    updateMeta(this.dir, { finishMs: this.now() - startedAt, chunks: chunks.length, cleanFailedChunks: failedChunks, lastCleanError: failedChunks ? this.lastCleanError : '' });
    return { ...result, cleaned, chunks: chunks.length, cleanFailed: failedChunks, lastCleanError: this.lastCleanError };
  }

  /** Esc: the recording is thrown away, so stop working on it. */
  cancel() {
    this.stopped = true;
    clearInterval(this.timer);
  }
}

/** Saves the text that went to the composer and closes the recording. `partial` keeps it listed as needing attention. */
function finishRecording(dir, { cleaned, raw, partial = false, cleanupFailed = false }) {
  try { writeAtomic(path.join(dir, 'transcript.txt'), cleaned || raw || ''); } catch { /* see updateMeta */ }
  updateMeta(dir, { status: partial ? 'partial' : 'done', cleanupFailed });
}

const NEEDS_ATTENTION = new Set(['recording', 'transcribing', 'partial', 'failed', 'transcribed']);

/** Recordings, newest first. `needsAttention`: never finished (crash, offline) or some segment is missing. */
function listRecordings(root) {
  let names = [];
  try { names = fs.readdirSync(root, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name); } catch { return []; }
  return names.sort().reverse().map((name) => {
    const dir = path.join(root, name);
    const meta = readMeta(dir);
    const files = segmentFiles(dir);
    const bytes = files.reduce((sum, file) => { try { return sum + fs.statSync(file).size; } catch { return sum; } }, 0);
    return { dir, name, meta, segments: files.length, seconds: Math.round(bytes / 32000), status: meta.status || 'unknown', needsAttention: files.length > 0 && NEEDS_ATTENTION.has(meta.status || 'recording') };
  });
}

/** Newest file change inside a folder: a recording being written (or transcribed) right now is never "old". */
function lastActivity(dir) {
  let newest = 0;
  try {
    for (const entry of fs.readdirSync(dir)) newest = Math.max(newest, fs.statSync(path.join(dir, entry)).mtimeMs);
    newest = Math.max(newest, fs.statSync(dir).mtimeMs);
  } catch { /* gone already */ }
  return newest;
}

/** Deletes recordings untouched for a week. Never throws. */
function sweepVoiceArchive(root, { now = Date.now(), retentionMs = RETENTION_MS } = {}) {
  const removed = { recordings: 0, bytes: 0 };
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(root, entry.name);
      if (now - lastActivity(dir) < retentionMs) continue;
      let bytes = 0;
      try { for (const name of fs.readdirSync(dir)) bytes += fs.statSync(path.join(dir, name)).size; } catch { /* size is only for the log */ }
      try { fs.rmSync(dir, { recursive: true, force: true }); removed.recordings++; removed.bytes += bytes; } catch { /* next sweep */ }
    }
  } catch { /* no archive yet */ }
  return removed;
}

module.exports = { RETENTION_MS, DictationPipeline, trimSilence, withSilenceTrim, newRecordingDir, readMeta, updateMeta, segmentFiles, transcribeRecording, finishRecording, listRecordings, sweepVoiceArchive };
