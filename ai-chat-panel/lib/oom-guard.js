'use strict';
// Keeps the editor alive through a memory shortage on Linux, so queued and running prompts survive the night.
//
// What happened on 2026-11-26 at 01:08: RAM and the 512 MB swap ran out, the kernel's OOM killer chose VS Code's Pylance
// server (3.5 GB, oom_score_adj 200), and systemd, whose default OOMPolicy is "stop", then stopped VS Code's whole app
// scope: the extension host, Clanker and every CLI with it. Three layers, none of which needs root:
//
//  1. systemd drop-ins: OOMPolicy=continue for VS Code's launcher units (app-code-*.scope, app-code@*.service) and, for an
//     editor started some other way, for its own unit for this session. A killed helper (a language server, a tool a CLI
//     started) no longer takes the editor down; VS Code restarts its language servers by itself.
//  2. oom_score_adj inside the editor's cgroup: the editor and the agent CLIs go to the lowest value an unprivileged
//     process may set (systemd leaves a floor, usually 100); restartable language servers go up so they are chosen first.
//  3. While prompts run or wait: other launched desktop apps (app.slice/app-*, e.g. ChatGPT, Bitwarden, a browser) go to
//     1000, so the kernel takes them before anything of the editor's. Their own values come back when the work is done.
//     The desktop session itself (session.slice: Plasma, KWin), user services, terminals and other editors are never touched.
//
// The kernel can still kill the editor when nothing else is left to free; only root (earlyoom, zram, more swap) closes
// that gap. Queued work also waits for memory (waitForMemory) instead of starting into a full machine.

const nodeFs = require('node:fs');
const path = require('node:path').posix;
const os = require('node:os');
const { execFile } = require('node:child_process');

const EXPENDABLE_ADJ = 1000;
const HELPER_ADJ = 500;
const FLOOR_CANDIDATES = [-1000, 0, 50, 100, 150, 200];
// Restartable helpers that run inside the editor: language servers and their bundles. VS Code starts them again.
const LANGUAGE_SERVER = /pylance|server\.bundle\.js|tsserver|typescript-language-features|rust-analyzer|gopls|jdtls|clangd|languageserver|language[-_]server|eslintServer|jsonServerMain|cssServerMain|htmlServerMain|markdown-language-features/i;
// Apps that are never made expendable: terminals (their shells may run your work) and other editors.
const KEEP_APP = /konsole|terminal|kitty|alacritty|wezterm|foot|tilix|yakuake|ghostty|xterm|code|codium|cursor|windsurf|antigravity|kate|zed/i;

const DROP_IN = `# Written by Clanker Controller (aiChatPanel.oomGuard): when the kernel OOM-kills one VS Code process (a language
# server, a tool a CLI started), keep the rest of VS Code and its running prompts instead of stopping the whole app.
# Delete this file and run \`systemctl --user daemon-reload\` to restore systemd's default (stop).
`;
const dropIns = (unitDir) => [
  { dir: path.join(unitDir, 'app-code-.scope.d'), body: `${DROP_IN}[Scope]\nOOMPolicy=continue\n` },
  { dir: path.join(unitDir, 'app-code@.service.d'), body: `${DROP_IN}[Service]\nOOMPolicy=continue\n` },
];
const FILE = '50-clanker-keep-running.conf';

/** cgroup v2 path of a process ("/user.slice/.../app-code-1.scope"), or '' when it cannot be read. */
function cgroupOf(pid, fs = nodeFs) {
  try {
    const line = String(fs.readFileSync(`/proc/${pid}/cgroup`, 'utf8')).split('\n').find((l) => l.startsWith('0::'));
    return line ? line.slice(3).trim() : '';
  } catch { return ''; }
}

/** The systemd unit a cgroup belongs to: its last path segment ending in .scope or .service. */
function unitOf(cgroup) {
  return String(cgroup).split('/').reverse().find((part) => /\.(scope|service)$/.test(part)) || '';
}

/** Every process this user can read: pid, cgroup, unit, command line, oom_score_adj and start time (guards pid reuse). */
function listProcesses(fs = nodeFs) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync('/proc'); } catch { return out; }
  for (const name of names) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const argv = String(fs.readFileSync(`/proc/${name}/cmdline`, 'utf8')).split('\0').filter(Boolean);
      if (!argv.length) continue; // kernel threads
      const cmdline = argv.join(' ');
      // What runs: the executable and its script (node server.bundle.js). Never the rest, which may be a prompt or a grep that
      // merely mentions a language server.
      const program = argv.slice(0, 2).join(' ');
      const adj = Number(String(fs.readFileSync(`/proc/${name}/oom_score_adj`, 'utf8')).trim());
      const stat = String(fs.readFileSync(`/proc/${name}/stat`, 'utf8'));
      const start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] || '';
      const cgroup = cgroupOf(name, fs);
      out.push({ pid: Number(name), cmdline, program, adj, start, cgroup, unit: unitOf(cgroup) });
    } catch { /* gone, or another user's */ }
  }
  return out;
}

/** MemAvailable from /proc/meminfo in MB (Infinity when it cannot be read, so nothing ever waits on a guess). */
function memAvailableMb(fs = nodeFs) {
  try {
    const text = String(fs.readFileSync('/proc/meminfo', 'utf8'));
    const kb = Number(/^MemAvailable:\s+(\d+)/m.exec(text)?.[1]);
    return Number.isFinite(kb) ? kb / 1024 : Infinity;
  } catch { return Infinity; }
}

class OomGuard {
  /**
   * @param {object} o
   * @param {() => boolean} o.hasWork   prompts running, queued or scheduled in any chat
   * @param {() => number} [o.releaseIdle]  closes idle warm CLI sessions; returns how many
   * @param {() => boolean} [o.enabled]
   */
  constructor({ hasWork, releaseIdle = () => 0, enabled = () => true, log = () => {}, fs = nodeFs, exec = execFile,
    platform = process.platform, selfPid = process.pid, configDir = path.join(os.homedir(), '.config', 'systemd', 'user'),
    runtimeDir = process.env.XDG_RUNTIME_DIR ? path.join(process.env.XDG_RUNTIME_DIR, 'systemd', 'user') : '',
    intervalMs = 30000, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) } = {}) {
    Object.assign(this, { hasWork, releaseIdle, enabled, log, fs, exec, platform, selfPid, configDir, runtimeDir, intervalMs, now, sleep });
    this.raised = new Map(); // pid -> { start, adj }: apps made expendable, and the value they had before
    this.floor = null;
    this.timer = null;
    this.dropInsChecked = false;
  }

  get supported() { return this.platform === 'linux'; }

  start() {
    if (!this.supported || this.timer) return;
    this.tick();
    this.timer = setInterval(() => this.tick(), this.intervalMs);
    this.timer.unref?.();
  }

  dispose() {
    clearInterval(this.timer);
    this.timer = null;
    if (this.supported) this.restore();
  }

  /** One pass: drop-ins once, the editor shield always, expendable apps only while there is work. */
  tick() {
    if (!this.supported) return;
    if (!this.enabled()) { this.restore(); return; }
    try {
      if (!this.dropInsChecked) { this.dropInsChecked = true; this.ensureDropIns(); }
      const procs = listProcesses(this.fs);
      this.shieldEditor(procs);
      if (this.hasWork()) this.markExpendable(procs); else this.restore(procs);
    } catch (error) { this.log(`oom guard: ${error.message}`); }
  }

  write(pid, value) {
    try { this.fs.writeFileSync(`/proc/${pid}/oom_score_adj`, String(value)); return true; } catch { return false; }
  }

  /** The lowest oom_score_adj this user may give its own processes: probed on the extension host, which should have it anyway. */
  lowestAllowed() {
    if (this.floor !== null) return this.floor;
    for (const value of FLOOR_CANDIDATES) if (this.write(this.selfPid, value)) return (this.floor = value);
    return (this.floor = Infinity);
  }

  shieldEditor(procs) {
    const own = cgroupOf(this.selfPid, this.fs);
    if (!own) return;
    const floor = this.lowestAllowed();
    for (const proc of procs) {
      if (proc.cgroup !== own) continue;
      if (LANGUAGE_SERVER.test(proc.program)) { if (proc.adj < HELPER_ADJ) this.write(proc.pid, HELPER_ADJ); }
      else if (Number.isFinite(floor) && proc.adj > floor) this.write(proc.pid, floor);
    }
  }

  /** Launched desktop apps other than the editor's own unit, terminals and editors. */
  isExpendable(proc, ownUnit) {
    return proc.cgroup.includes('/app.slice/') && /^app-/.test(proc.unit) && proc.unit !== ownUnit && !KEEP_APP.test(proc.unit) && proc.adj >= 0;
  }

  markExpendable(procs) {
    const ownUnit = unitOf(cgroupOf(this.selfPid, this.fs));
    for (const proc of procs) {
      if (!this.isExpendable(proc, ownUnit) || proc.adj >= EXPENDABLE_ADJ) continue;
      if (this.write(proc.pid, EXPENDABLE_ADJ) && !this.raised.has(proc.pid)) this.raised.set(proc.pid, { start: proc.start, adj: proc.adj });
    }
  }

  /** Gives raised apps their own value back (an unprivileged process may lower down to the floor systemd set). */
  restore(procs = null) {
    if (!this.raised.size) return;
    const alive = new Map((procs || listProcesses(this.fs)).map((proc) => [proc.pid, proc]));
    for (const [pid, before] of this.raised) {
      const now = alive.get(pid);
      if (now && now.start === before.start && now.adj === EXPENDABLE_ADJ) this.write(pid, before.adj);
    }
    this.raised.clear();
  }

  /** Writes the OOMPolicy=continue drop-ins; reloads the user manager only when something changed. */
  ensureDropIns() {
    const wanted = dropIns(this.configDir);
    // An editor started outside the launcher (a terminal, another desktop file) lives in another unit: cover that one too,
    // in the runtime directory, which is cleared at logout, so these one-off names never pile up.
    const ownUnit = unitOf(cgroupOf(this.selfPid, this.fs));
    if (ownUnit && !/^app-code(-|@)/.test(ownUnit) && this.runtimeDir) {
      const kind = ownUnit.endsWith('.scope') ? 'Scope' : 'Service';
      wanted.push({ dir: path.join(this.runtimeDir, `${ownUnit}.d`), body: `${DROP_IN}[${kind}]\nOOMPolicy=continue\n` });
    }
    let changed = false;
    for (const { dir, body } of wanted) {
      const file = path.join(dir, FILE);
      try {
        if (this.fs.existsSync(file) && String(this.fs.readFileSync(file, 'utf8')) === body) continue;
        this.fs.mkdirSync(dir, { recursive: true });
        this.fs.writeFileSync(file, body);
        changed = true;
      } catch (error) { this.log(`oom guard: could not write ${file}: ${error.message}`); }
    }
    if (changed) this.exec('systemctl', ['--user', 'daemon-reload'], { timeout: 10000 }, (error) => { if (error) this.log(`oom guard: systemctl --user daemon-reload failed: ${error.message}`); });
    return changed;
  }

  /** Enough memory to start another CLI: at least 700 MB or 5% of RAM, whichever is more. */
  minimumMb() {
    const totalMb = os.totalmem() / 1048576;
    return Math.max(700, totalMb * 0.05);
  }

  /**
   * Before unattended work starts (a queued or scheduled prompt): when memory is short, close idle warm sessions, then wait
   * for memory to come back, up to maxWaitMs. Returns { waitedMs, availableMb }. Never blocks off Linux or when disabled.
   */
  async waitForMemory({ maxWaitMs = 10 * 60 * 1000, pollMs = 15000, onWait = null } = {}) {
    const started = this.now();
    if (!this.supported || !this.enabled()) return { waitedMs: 0, availableMb: Infinity };
    const need = this.minimumMb();
    let available = memAvailableMb(this.fs);
    if (available >= need) return { waitedMs: 0, availableMb: available };
    const released = this.releaseIdle() || 0;
    this.log(`oom guard: ${Math.round(available)} MB available, ${Math.round(need)} MB wanted; closed ${released} idle session(s), waiting`);
    onWait?.(available, need);
    while (available < need && this.now() - started < maxWaitMs) {
      await this.sleep(pollMs);
      available = memAvailableMb(this.fs);
    }
    return { waitedMs: this.now() - started, availableMb: available };
  }
}

module.exports = { OomGuard, listProcesses, cgroupOf, unitOf, memAvailableMb, LANGUAGE_SERVER, KEEP_APP, EXPENDABLE_ADJ, HELPER_ADJ };
