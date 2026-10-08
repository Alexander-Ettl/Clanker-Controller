'use strict';

const { spawn } = require('node:child_process');
const path = require('node:path');

// The helper owns the exact sessions it paused. Closing stdin restores them,
// including when the extension host exits unexpectedly.
class MediaPause {
  constructor({ spawnImpl = spawn, platform = process.platform, timeoutMs = 4000 } = {}) {
    Object.assign(this, { spawn: spawnImpl, platform, timeoutMs });
    this.child = null;
  }

  pause() {
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
    const child = this.child;
    this.child = null;
    // Do not kill the helper: its finally block must restore playback.
    try { child?.stdin.end(); } catch { /* an exited helper already restored playback */ }
  }
}

module.exports = { MediaPause };
