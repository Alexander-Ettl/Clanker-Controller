'use strict';

// In-panel mic recording, mirroring tools/voice-router/daemon.ps1's ffmpeg
// invocation but in plain Node (the extension host is Node, not PowerShell).
// Reads the SAME daemon.config.json so there's one place to set micDevice.
//
// P16-L: that micDevice is one workstation's DirectShow name. On any other
// machine ffmpeg exits within ~50ms, and the old start() never noticed, so
// stop() waited forever on a 'close' that had already fired and the mic
// button stayed locked in "processing". Now the device is checked against
// what this machine actually has, a startup exit rejects start(), and stop()
// settles immediately for a process that is already gone.

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MediaPause } = require('./media-pause.cjs');

// "Recording" is declared when ffmpeg delivers its first audio, which is when the device is really open and the start
// cue is honest. A device that opens but never delivers is let through after this long rather than hanging the button.
const STARTUP_TIMEOUT_MS = 2500;
// DirectShow's default device buffer is ~500 ms and delays the first sample by that much; 50 ms lets it through at once.
const DSHOW_BUFFER_MS = 50;
// The media pause may trail the device opening, but the start cue should not play over music for long.
const MEDIA_PAUSE_GRACE_MS = 250;
// A recording is written as consecutive WAV files of this length, so there is no length limit. 16 kHz mono 16-bit is
// 32 KB/s, so 5 minutes is ~9.6 MB: well under Groq's 25 MB upload cap, and a hard crash costs at most the
// segment being written (every finished segment is a complete file).
const SEGMENT_SECONDS = 300;

function loadVoiceRouterConfig() {
  const candidates = [
    process.env.VOICE_ROUTER_DIR ? path.join(process.env.VOICE_ROUTER_DIR, 'daemon.config.json') : null,
    path.join(__dirname, '..', 'daemon.config.json'),
    path.join(os.homedir(), 'Projects', 'Portfolio', '2026', 'tools', 'voice-router', 'daemon.config.json'),
  ].filter(Boolean);
  for (const configPath of candidates) {
    try {
      if (fs.existsSync(configPath)) {
        return JSON.parse(fs.readFileSync(configPath, 'utf8'));
      }
    } catch {}
  }
  return { micDevice: '', ffmpegPath: 'ffmpeg' };
}

/** `"Name" (audio)` lines from `ffmpeg -list_devices true -f dshow -i dummy`. */
function parseDshowAudioDevices(output) {
  const devices = [];
  for (const match of String(output).matchAll(/"([^"]+)"\s+\(audio\)/g)) devices.push(match[1]);
  return devices;
}

/** The name Windows gives its default input (Sound settings), or '' when it can't be read. */
function readWindowsDefaultMic() {
  if (process.platform !== 'win32') return Promise.resolve('');
  return new Promise((resolve) => {
    let output = '';
    let child;
    try {
      child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'default-mic.ps1')], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    } catch { resolve(''); return; }
    const timer = setTimeout(() => { child.kill(); resolve(''); }, 6000);
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.once('error', () => { clearTimeout(timer); resolve(''); });
    child.once('close', () => { clearTimeout(timer); resolve(output.trim()); });
  });
}

/** P17-ZA: RMS and peak (0..1) of little-endian 16-bit mono PCM. */
function pcmLevels(buffer) {
  const samples = Math.floor(buffer.length / 2);
  if (!samples) return { rms: 0, peak: 0 };
  let sum = 0;
  let peak = 0;
  for (let i = 0; i < samples; i++) {
    const v = buffer.readInt16LE(i * 2) / 32768;
    sum += v * v;
    if (Math.abs(v) > peak) peak = Math.abs(v);
  }
  return { rms: Math.sqrt(sum / samples), peak };
}

/**
 * Perceptually normalized speech level [0..1] with noise floor cutoff and power scaling.
 * Speech sits in 0.25..0.80; quiet room noise (< 0.0035) returns 0.
 */
function perceptualMicLevel({ rms = 0, peak = 0 } = {}) {
  const safeRms = Math.max(0, Math.min(1, Number(rms) || 0));
  const safePeak = Math.max(0, Math.min(1, Number(peak) || 0));
  const crest = Math.min(safePeak, safeRms * 4);
  const energy = safeRms * 0.78 + crest * 0.22;
  const noiseFloor = 0.0035;
  const speechCeiling = 0.095;
  if (energy <= noiseFloor) return 0;
  return Math.min(1, ((energy - noiseFloor) / (speechCeiling - noiseFloor)) ** 0.58);
}

const VOLUME_INTERVAL_MS = 40;

/** The finished-or-playable segments of a recording folder, in order. 44 bytes is a WAV header with no samples. */
function listSegments(dir) {
  try {
    return fs.readdirSync(dir).filter((name) => /^seg-\d{3,}\.wav$/.test(name)).sort()
      .map((name) => path.join(dir, name)).filter((file) => fs.statSync(file).size > 44);
  } catch { return []; }
}

class AudioCaptureError extends Error {
  constructor(message, { device, devices = [], stderr = '' } = {}) {
    super(message);
    this.code = 'AUDIO_CAPTURE_FAILED';
    this.device = device;
    this.devices = devices;
    this.stderr = stderr;
  }
}

class VoiceCapture {
  constructor({ config, spawnImpl, onVolume, mediaControl, defaultMicImpl } = {}) {
    this.config = config || loadVoiceRouterConfig();
    this.spawn = spawnImpl || spawn;
    this.onVolume = onVolume || null; // ({ rms, peak }) about every 40ms while recording
    this.process = null;
    this.dir = null; // folder of the current recording
    this.ownsDir = false; // true when start() made a temp folder itself, so dispose() may delete it
    this.starting = null;
    this.devices = null;
    this.device = null;
    this.resolving = null; // the device probe in flight, if any
    this.preferred = ''; // the microphone chosen in Settings > Voice; empty falls back to daemon.config.json, then the first device
    this.exit = null; // { code, stderr } once the current ffmpeg process has exited
    this.media = mediaControl || new MediaPause();
    this.readDefaultMic = defaultMicImpl || (spawnImpl ? async () => '' : readWindowsDefaultMic); // a faked ffmpeg means no real Windows to ask
  }

  isRecording() {
    return this.process !== null || this.starting !== null;
  }

  ffmpeg() { return this.config.ffmpegPath || 'ffmpeg'; }

  listAudioDevices() {
    return new Promise((resolve) => {
      let output = '';
      let child;
      try {
        child = this.spawn(this.ffmpeg(), ['-hide_banner', '-list_devices', 'true', '-f', 'dshow', '-i', 'dummy'], { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
      } catch { resolve([]); return; }
      child.stderr?.on('data', (chunk) => { output += chunk.toString('utf8'); });
      child.once('error', () => resolve([]));
      child.once('close', () => resolve(parseDshowAudioDevices(output)));
    });
  }

  /** Choose the microphone for the next recording (empty: automatic). */
  setPreferred(name) {
    this.preferred = String(name || '');
    this.device = null;
  }

  /** The chosen mic if this machine has it. Automatic: the Windows default input, else the configured one, else the first capture device (cached). */
  async resolveDevice(refresh = false) {
    if (this.device && !refresh) return this.device;
    this.resolving ||= this.probe().finally(() => { this.resolving = null; }); // a warm-up and a start share one probe
    const { devices, automatic } = await this.resolving;
    this.devices = devices;
    this.device = this.preferred && devices.includes(this.preferred) ? this.preferred : automatic;
    return this.device;
  }

  /** The capture devices, and which one Automatic means: the Windows default, else daemon.config.json's, else the first. */
  async probe() {
    const [devices, windowsDefault] = await Promise.all([this.listAudioDevices(), Promise.resolve(this.readDefaultMic()).catch(() => '')]);
    const name = String(windowsDefault || '').trim(); // DirectShow cuts long names, so one starting the other counts
    const system = devices.find((device) => device === name) || (name && devices.find((device) => name.startsWith(device) || device.startsWith(name)));
    return { devices, automatic: system || (devices.includes(this.config.micDevice) ? this.config.micDevice : devices[0] || this.config.micDevice || null) };
  }

  /** Looks the microphone up ahead of the first click, so starting does not pay for the device probe. */
  warm() {
    return this.resolveDevice().catch(() => null);
  }

  /** Resolves once ffmpeg is really recording; rejects with AudioCaptureError if it can't. */
  start({ pauseMedia = false, dir = null } = {}) {
    if (this.isRecording()) return this.starting || Promise.resolve(this.device);
    this.starting = (async () => {
      // Booting the pause helper takes as long as opening the device, so the two run side by side.
      const paused = pauseMedia ? this.media.pause() : null;
      const device = await this.doStart(dir);
      if (paused) await Promise.race([paused, new Promise(resolve => setTimeout(resolve, MEDIA_PAUSE_GRACE_MS))]);
      return device;
    })().catch(error => { this.media.resume(); throw error; }).finally(() => { this.starting = null; });
    return this.starting;
  }

  async doStart(dir) {
    const device = await this.resolveDevice();
    if (!device) {
      throw new AudioCaptureError('No microphone found on this workstation.', { devices: this.devices || [] });
    }
    this.ownsDir = !dir;
    this.dir = dir || path.join(os.tmpdir(), 'ai-chat-panel', `rec-${Date.now()}`);
    fs.mkdirSync(this.dir, { recursive: true });
    this.exit = null;

    let stderr = '';
    const proc = this.spawn(
      this.ffmpeg(),
      // P17-ZA: a second output taps raw PCM to stdout for the composer's level meter.
      ['-y', '-loglevel', 'error', '-f', 'dshow', '-audio_buffer_size', String(DSHOW_BUFFER_MS), '-i', `audio=${device}`, '-ar', '16000', '-ac', '1', '-f', 'segment', '-segment_time', String(SEGMENT_SECONDS), '-segment_format', 'wav', path.join(this.dir, 'seg-%03d.wav'), '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.process = proc;
    proc.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    // Always drained (a full pipe would stall ffmpeg); levels go out at most every 40ms.
    let pending = Buffer.alloc(0);
    let lastEmit = 0;
    let onFirstAudio = null;
    proc.stdout?.on('data', (chunk) => {
      onFirstAudio?.();
      if (!this.onVolume) return;
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      const now = Date.now();
      if (now - lastEmit < VOLUME_INTERVAL_MS) return;
      lastEmit = now;
      const even = pending.length - (pending.length % 2);
      const levels = pcmLevels(pending.subarray(0, even));
      this.onVolume({ ...levels, level: perceptualMicLevel(levels) });
      pending = pending.subarray(even);
    });
    proc.stdin?.on('error', () => {});

    const failure = (reason) => new AudioCaptureError(`Could not open microphone "${device}": ${reason}`, { device, devices: this.devices || [], stderr: stderr.trim() });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, STARTUP_TIMEOUT_MS);
      onFirstAudio = () => { onFirstAudio = null; clearTimeout(timer); resolve(); };
      proc.once('error', (error) => { this.media.resume(); clearTimeout(timer); reject(failure(error.message)); });
      proc.once('exit', (code) => {
        this.media.resume();
        this.exit = { code, stderr: stderr.trim() };
        clearTimeout(timer);
        reject(failure(stderr.trim().split(/\r?\n/).pop() || `ffmpeg exited with code ${code}`));
      });
    }).catch((error) => {
      this.process = null;
      this.device = null; // re-probe next time: the device may have been unplugged
      throw error;
    });
    return device;
  }

  /** Stops ffmpeg gracefully (writes 'q' to its stdin) and resolves with the segment files, in order. */
  stop() {
    this.media.resume();
    return new Promise((resolve, reject) => {
      const proc = this.process;
      const dir = this.dir;
      if (!proc) {
        reject(new Error('Not currently recording.'));
        return;
      }
      this.process = null;

      const settle = () => {
        const files = listSegments(dir);
        if (files.length) resolve(files);
        else reject(new AudioCaptureError(`Recording from "${this.device}" produced no audio.`, { device: this.device, devices: this.devices || [], stderr: this.exit?.stderr || '' }));
      };

      // Already dead (crashed mid-recording): its 'close' has fired and will not fire again.
      if (proc.exitCode !== null || proc.signalCode !== null || this.exit) { settle(); return; }

      const killTimer = setTimeout(() => { if (proc.exitCode === null) proc.kill(); }, 5000);
      proc.once('close', () => { clearTimeout(killTimer); settle(); });
      proc.once('error', (error) => { clearTimeout(killTimer); reject(error); });
      try {
        proc.stdin.write('q');
        proc.stdin.end();
      } catch {
        proc.kill();
      }
    });
  }

  async dispose() {
    try {
      await this.starting;
      if (this.process) {
        const dir = this.dir;
        await this.stop().catch(() => {});
        if (this.ownsDir) fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); // a folder the caller gave us keeps its audio
      }
    } catch { /* failed startup has already restored playback */ }
    finally { this.media.resume(); }
  }
}

module.exports = { VoiceCapture, AudioCaptureError, SEGMENT_SECONDS, listSegments, parseDshowAudioDevices, pcmLevels, perceptualMicLevel };
