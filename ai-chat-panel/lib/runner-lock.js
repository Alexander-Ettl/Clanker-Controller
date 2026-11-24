'use strict';

// Two small files in the session folder decide who runs scheduled turns, so the editor and the headless runner
// (lib/headless-runner.js) never run the same task:
//   ide.<pid>.lock  every open editor window writes its own every few seconds; while any is fresh the runner stands down.
//   runner.lock  the runner holds it while it works; the editor leaves the queue alone until it is gone.
// A lock counts only while its process is alive and its heartbeat is recent, so a crash never blocks anyone for long.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const IDE_FRESH_MS = 45 * 1000;
const RUNNER_FRESH_MS = 90 * 1000;
const BEAT_MS = 15 * 1000;

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; }
}

function read(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/** True while the lock file names a live process that has checked in recently. */
function held(file, freshMs, now = Date.now()) {
  const lock = read(file);
  return Boolean(lock && alive(lock.pid) && now - Date.parse(lock.at) < freshMs);
}

const ideFile = (sessionDir, pid = process.pid) => path.join(sessionDir, `ide.${pid}.lock`);
const runnerFile = (sessionDir) => path.join(sessionDir, 'runner.lock');
function ideOpen(sessionDir, now) {
  let names;
  try { names = fs.readdirSync(sessionDir).filter((name) => /^ide\.\d+\.lock$/.test(name)); } catch { return false; }
  let open = false;
  for (const name of names) {
    const file = path.join(sessionDir, name);
    if (held(file, IDE_FRESH_MS, now)) open = true;
    else if (!alive(read(file)?.pid)) fs.rmSync(file, { force: true }); // a window that was killed rather than closed
  }
  return open;
}
const runnerActive = (sessionDir, now) => held(runnerFile(sessionDir), RUNNER_FRESH_MS, now);

function write(file, extra = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString(), ...extra }));
  fs.renameSync(temporary, file);
}

/** The editor's side: "someone is here". Call start() once, dispose() on shutdown. */
class IdePresence {
  constructor(sessionDir, { beatMs = BEAT_MS } = {}) { this.file = ideFile(sessionDir); this.beatMs = beatMs; this.timer = null; }
  start() {
    if (this.timer) return;
    const beat = () => { try { write(this.file); } catch { /* a read-only folder just means the runner may start; the queue lock still protects us */ } };
    beat();
    this.timer = setInterval(beat, this.beatMs);
    this.timer.unref?.();
  }
  dispose() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    fs.rmSync(this.file, { force: true });
  }
}

/**
 * The runner's side. acquire() takes the lock only when no live runner holds it and no editor is open; the exclusive
 * create is what makes two runners starting in the same second safe.
 */
class RunnerLock {
  constructor(sessionDir, { beatMs = BEAT_MS } = {}) { this.sessionDir = sessionDir; this.file = runnerFile(sessionDir); this.beatMs = beatMs; this.timer = null; this.mine = false; }
  /** @returns {{ ok: true } | { ok: false, reason: 'ide-open' | 'runner-active' }} */
  acquire() {
    if (ideOpen(this.sessionDir)) return { ok: false, reason: 'ide-open' };
    fs.mkdirSync(this.sessionDir, { recursive: true });
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        fs.writeFileSync(this.file, JSON.stringify({ pid: process.pid, host: os.hostname(), at: new Date().toISOString() }), { flag: 'wx' });
        this.mine = true;
        break;
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (runnerActive(this.sessionDir)) return { ok: false, reason: 'runner-active' };
        fs.rmSync(this.file, { force: true }); // a dead or silent runner left it behind
      }
    }
    if (!this.mine) return { ok: false, reason: 'runner-active' };
    this.timer = setInterval(() => { try { write(this.file); } catch { /* retried at the next beat */ } }, this.beatMs);
    this.timer.unref?.();
    return { ok: true };
  }
  /** The editor opened while we were running: it leaves us to finish, and we only note that it is there. */
  ideAppeared() { return ideOpen(this.sessionDir); }
  release() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.mine && read(this.file)?.pid === process.pid) fs.rmSync(this.file, { force: true });
    this.mine = false;
  }
}

module.exports = { IdePresence, RunnerLock, ideOpen, runnerActive, IDE_FRESH_MS, RUNNER_FRESH_MS };
