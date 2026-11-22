'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

const MPRIS = 'org.mpris.MediaPlayer2.';
const OBJECT = '/org/mpris/MediaPlayer2';
const PLAYER = 'org.mpris.MediaPlayer2.Player';

// Windows: the helper owns the exact sessions it paused. Closing stdin restores them,
// including when the extension host exits unexpectedly.
// Linux: every MPRIS player (browsers, Spotify, VLC, mpv) that is playing gets Pause, and exactly those get Play on resume.
class MediaPause {
  constructor({ spawnImpl = spawn, platform = process.platform, timeoutMs = 4000 } = {}) {
    Object.assign(this, { spawn: spawnImpl, platform, timeoutMs });
    this.child = null;
    this.paused = []; // Linux: bus names this instance paused
    this.generation = 0; // a resume() that arrives while pause() is still asking players cancels it
  }

  pause() {
    if (this.platform === 'linux') return this.pauseMpris();
    if (this.platform !== 'win32' || this.child) return Promise.resolve();
    return new Promise(resolve => {
      let child;
      try {
        child = this.spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'media-pause.ps1')], { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
      } catch { resolve(); return; }
      this.child = child;
      child.stdin.on('error', () => {});
      const finish = () => { clearTimeout(timer); resolve(); };
      const timer = setTimeout(() => { this.resume(); finish(); }, this.timeoutMs);
      let pending = '';
      child.stdout.on('data', chunk => {
        pending += chunk.toString('utf8');
        if (pending.includes('ready\n')) finish();
      });
      child.once('error', () => { if (this.child === child) this.child = null; finish(); });
      child.once('exit', () => { if (this.child === child) this.child = null; finish(); });
    });
  }

  resume() {
    this.generation++;
    if (this.platform === 'linux') { this.resumeMpris(); return; }
    const child = this.child;
    this.child = null;
    // Do not kill the helper: its finally block must restore playback.
    try { child?.stdin.end(); } catch { /* an exited helper already restored playback */ }
  }

  /** Runs a command, resolves with its stdout ('' when it is missing, fails or takes too long). */
  run(command, args) {
    return new Promise(resolve => {
      let child;
      let out = '';
      try { child = this.spawn(command, args, { stdio: ['ignore', 'pipe', 'ignore'] }); } catch { resolve(''); return; }
      const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } resolve(out); }, this.timeoutMs);
      child.stdout?.on('data', chunk => { out += chunk.toString('utf8'); });
      child.once('error', () => { clearTimeout(timer); resolve(''); });
      child.once('close', () => { clearTimeout(timer); resolve(out); });
    });
  }

  bus(...args) { return this.run('busctl', ['--user', '--no-pager', ...args]); }

  async pauseMpris() {
    if (this.paused.length) return;
    const generation = this.generation;
    const names = (await this.bus('--no-legend', 'list')).split(/\r?\n/).map(line => line.trim().split(/\s+/)[0]).filter(name => name?.startsWith(MPRIS));
    const playing = (await Promise.all(names.map(async name => /"Playing"/.test(await this.bus('get-property', name, OBJECT, PLAYER, 'PlaybackStatus')) ? name : null))).filter(Boolean);
    this.paused = playing;
    await Promise.all(playing.map(name => this.bus('call', name, OBJECT, PLAYER, 'Pause')));
    if (generation !== this.generation) this.resumeMpris(); // the recording failed to start while we were pausing
  }

  resumeMpris() {
    const names = this.paused;
    this.paused = [];
    for (const name of names) void this.bus('call', name, OBJECT, PLAYER, 'Play');
  }
}

module.exports = { MediaPause };
