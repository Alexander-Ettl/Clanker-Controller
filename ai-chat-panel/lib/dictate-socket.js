'use strict';

// Linux has no app-level global hotkey (Wayland forbids it, X11 grabs are fragile). The desktop owns the shortcut instead:
// a KDE/GNOME custom shortcut runs ~/.clanker/clanker-dictate (copied from lib/clanker-dictate at every start), which writes one line to this Unix socket, and the line
// does what the Windows hotkey's key-down does (start dictation, or stop and transcribe). Every editor window listens on its
// own socket (…-<pid>.sock) and touches it when it gains focus; the script tries the most recently touched one first, so the
// shortcut reaches the window you used last without windows fighting over one path.

const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

function socketPath(env = process.env) {
  if (env.CLANKER_DICTATE_SOCKET) return env.CLANKER_DICTATE_SOCKET;
  const dir = env.XDG_RUNTIME_DIR && fs.existsSync(env.XDG_RUNTIME_DIR) ? env.XDG_RUNTIME_DIR : os.tmpdir();
  return path.join(dir, `clanker-dictate-${typeof process.getuid === 'function' ? process.getuid() : 'user'}-${process.pid}.sock`);
}

class DictateSocket {
  /** commands: { toggle() } (anything else a client sends is ignored). */
  constructor({ commands, onError = () => {}, file = socketPath(), platform = process.platform } = {}) {
    Object.assign(this, { commands, onError, file, platform });
    this.server = null;
  }

  /** Starts listening; false when this isn't Linux or the socket can't be created. */
  start() {
    this.stop();
    if (this.platform !== 'linux') return false;
    try { fs.unlinkSync(this.file); } catch { /* nothing left from an earlier window */ }
    this.sweepStale();
    const server = net.createServer((client) => {
      let pending = '';
      client.setEncoding('utf8');
      client.on('error', () => {});
      client.on('data', (chunk) => {
        pending += chunk;
        let at;
        while ((at = pending.indexOf('\n')) >= 0) {
          const line = pending.slice(0, at).trim();
          pending = pending.slice(at + 1);
          const ok = line === 'toggle' && typeof this.commands.toggle === 'function';
          if (ok) { try { Promise.resolve(this.commands.toggle()).catch((error) => this.onError(error.message)); } catch (error) { this.onError(error.message); } }
          client.end(ok ? 'ok\n' : 'unknown\n');
        }
      });
    });
    server.on('error', (error) => this.onError(error.message));
    try {
      server.listen(this.file, () => { try { fs.chmodSync(this.file, 0o600); } catch { /* the runtime dir is already private */ } });
    } catch (error) { this.onError(error.message); return false; }
    this.server = server;
    return true;
  }

  /** Removes sockets left by editor windows that no longer exist (a crash skips close()). */
  sweepStale() {
    const dir = path.dirname(this.file);
    const own = /^(clanker-dictate-[^-]+)-(\d+)\.sock$/.exec(path.basename(this.file));
    if (!own) return;
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return; }
    for (const name of names) {
      const match = /^(clanker-dictate-[^-]+)-(\d+)\.sock$/.exec(name);
      if (!match || match[1] !== own[1] || match[2] === own[2]) continue;
      try { process.kill(Number(match[2]), 0); } catch (error) { if (error.code === 'ESRCH') { try { fs.unlinkSync(path.join(dir, name)); } catch { /* already gone */ } } }
    }
  }

  /** Marks this window as the one used last (the script prefers the newest socket). */
  touch() { try { const now = new Date(); fs.utimesSync(this.file, now, now); } catch { /* not listening */ } }

  stop() {
    const server = this.server;
    this.server = null;
    if (server) server.close(); // the listening socket's file goes with it
  }
}

/** Copies the shortcut script to ~/.clanker/clanker-dictate so a Marketplace install has it at a fixed path. Returns that path (null off Linux). */
function publishScript({ home = process.env.CLANKER_HOME || path.join(os.homedir(), '.clanker'), platform = process.platform } = {}) {
  if (platform !== 'linux') return null;
  const source = fs.readFileSync(path.join(__dirname, 'clanker-dictate'));
  const target = path.join(home, 'clanker-dictate');
  fs.mkdirSync(home, { recursive: true });
  let current = null;
  try { current = fs.readFileSync(target); } catch { /* first start */ }
  if (!current || !current.equals(source)) fs.writeFileSync(target, source);
  fs.chmodSync(target, 0o755);
  return target;
}

module.exports = { publishScript, socketPath, DictateSocket };
