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

const STARTUP_GRACE_MS = 400;

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
  constructor({ config, spawnImpl, onVolume } = {}) {
    this.config = config || loadVoiceRouterConfig();
    this.spawn = spawnImpl || spawn;
    this.onVolume = onVolume || null; // ({ rms, peak }) about every 40ms while recording
    this.process = null;
    this.wavPath = null;
    this.starting = null;
    this.devices = null;
    this.device = null;
    this.exit = null; // { code, stderr } once the current ffmpeg process has exited
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

  /** The configured mic if this machine has it, else the first real capture device (cached). */
  async resolveDevice(refresh = false) {
    if (this.device && !refresh) return this.device;
    this.devices = await this.listAudioDevices();
    const wanted = this.config.micDevice;
    this.device = this.devices.includes(wanted) ? wanted : this.devices[0] || wanted || null;
    return this.device;
  }

  /** Resolves once ffmpeg is really recording; rejects with AudioCaptureError if it can't. */
  start() {
    if (this.isRecording()) return this.starting || Promise.resolve(this.device);
    this.starting = this.doStart().finally(() => { this.starting = null; });
    return this.starting;
  }

  async doStart() {
    const device = await this.resolveDevice();
    if (!device) {
      throw new AudioCaptureError('No microphone found on this workstation.', { devices: this.devices || [] });
    }
    const dir = path.join(os.tmpdir(), 'ai-chat-panel');
    fs.mkdirSync(dir, { recursive: true });
    this.wavPath = path.join(dir, `rec-${Date.now()}.wav`);
    this.exit = null;

    let stderr = '';
    const proc = this.spawn(
      this.ffmpeg(),
      // P17-ZA: a second output taps raw PCM to stdout for the composer's level meter.
      ['-y', '-loglevel', 'error', '-f', 'dshow', '-i', `audio=${device}`, '-ar', '16000', '-ac', '1', this.wavPath, '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1'],
      { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true },
    );
    this.process = proc;
    proc.stderr?.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-2000); });
    // Always drained (a full pipe would stall ffmpeg); levels go out at most every 40ms.
    let pending = Buffer.alloc(0);
    let lastEmit = 0;
    proc.stdout?.on('data', (chunk) => {
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
      const timer = setTimeout(resolve, STARTUP_GRACE_MS);
      proc.once('error', (error) => { clearTimeout(timer); reject(failure(error.message)); });
      proc.once('exit', (code) => {
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

  /** Stops ffmpeg gracefully (writes 'q' to its stdin) and resolves with the wav path. */
  stop() {
    return new Promise((resolve, reject) => {
      const proc = this.process;
      const wavPath = this.wavPath;
      if (!proc) {
        reject(new Error('Not currently recording.'));
        return;
      }
      this.process = null;

      const settle = () => {
        let size = 0;
        try { size = fs.statSync(wavPath).size; } catch {}
        // 44 bytes is a WAV header with no samples.
        if (size > 44) resolve(wavPath);
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
}

module.exports = { VoiceCapture, AudioCaptureError, parseDshowAudioDevices, pcmLevels, perceptualMicLevel };
