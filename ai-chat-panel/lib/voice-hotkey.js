'use strict';

// The dictation hotkey: a PowerShell helper (hotkey-listener.ps1) reports when the combination goes down and up, anywhere
// in Windows; the handlers turn that into recording. Two behaviours: "toggle" (press to start, press again to stop and
// transcribe) and "hold" (record while the keys are held, transcribe on release).

const { spawn } = require('node:child_process');
const path = require('node:path');
const { parse } = require('../media/voice-hotkey.js');

const MIN_HOLD_MS = 350; // a shorter hold is a slip of the finger: the recording is thrown away

/**
 * What a key going down or up does. begin/finish/cancel are the chat window's start, stop-and-transcribe and discard;
 * begin() resolves once the microphone is really recording.
 */
function createHotkeyHandlers({ mode, isRecording, begin, finish, cancel, now = Date.now }) {
  let downAt = 0;
  let starting = Promise.resolve();
  return {
    onDown() {
      if (mode() === 'hold') {
        if (isRecording()) return;
        downAt = now();
        starting = Promise.resolve(begin());
      } else if (isRecording()) void finish();
      else void begin();
    },
    async onUp() {
      if (mode() !== 'hold') return;
      await starting; // released while the microphone was still opening: wait for it, then stop
      if (!isRecording()) return;
      if (now() - downAt < MIN_HOLD_MS) void cancel();
      else void finish();
    },
  };
}

/** One PowerShell helper per hotkey; start() replaces the previous one, stop() ends it. */
class VoiceHotkey {
  constructor({ handlers, onError, spawnImpl = spawn, platform = process.platform } = {}) {
    Object.assign(this, { handlers, onError, spawn: spawnImpl, platform });
    this.child = null;
  }

  /** Listens for `hotkey` ("Ctrl+Alt+Space"). False when it is empty, malformed or this is not Windows. */
  start(hotkey) {
    this.stop();
    const key = parse(hotkey);
    if (!key || this.platform !== 'win32') return false;
    const child = this.spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'hotkey-listener.ps1'),
      '-Key', String(key.vk), '-Modifiers', key.modVks.join(','), '-ParentPid', String(process.pid),
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    this.child = child;
    let pending = '';
    child.stdout.on('data', (chunk) => {
      const lines = (pending + chunk.toString('utf8')).split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        if (line.trim() === 'down') this.handlers.onDown();
        else if (line.trim() === 'up') void this.handlers.onUp();
      }
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk.toString('utf8')).slice(-500); });
    child.once('error', (error) => this.onError?.(error.message));
    child.once('exit', (code) => { if (this.child === child && code) this.onError?.(stderr.trim() || `the hotkey helper exited with code ${code}`); });
    return true;
  }

  stop() {
    const child = this.child;
    this.child = null;
    if (child && child.exitCode === null) child.kill();
  }
}

module.exports = { MIN_HOLD_MS, createHotkeyHandlers, VoiceHotkey };
