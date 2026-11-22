'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SUFFIX } = require('./markup.js');

const SEAL = Buffer.from(',"_clankerSeal":"');
const END = Buffer.from('"}');
const SIGNATURE_LENGTH = SEAL.length + 64 + END.length;
const CHECKPOINT_BACKUP_MS = 60000;
const footer = digest => Buffer.concat([SEAL, Buffer.from(digest.toString('hex')), END]);

const names = dir => {
  try { return fs.readdirSync(dir); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
};

const stamp = file => {
  try {
    const stat = fs.statSync(file);
    return `${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
};

function atomicWrite(file, bytes) {
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    const fd = fs.openSync(temporary, 'wx', 0o600);
    try { fs.writeFileSync(fd, bytes); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function initialiseKey(file, key) {
  if (fs.existsSync(file)) return fs.readFileSync(file);
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    atomicWrite(temporary, key);
    try { fs.linkSync(temporary, file); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    return fs.readFileSync(file);
  } finally { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
}

function recoveryDirectory(sessionDir) {
  // Windows: %LOCALAPPDATA%; Linux and macOS: the XDG data directory, not a visible folder in the home directory.
  const data = process.platform === 'win32' ? process.env.LOCALAPPDATA : process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  const base = process.env.AI_CHAT_PANEL_RECOVERY_DIR || path.join(data || os.homedir(), 'Clanker Controller', 'recovery');
  const resolved = path.resolve(sessionDir);
  const profile = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  return path.join(base, crypto.createHash('sha256').update(profile).digest('hex').slice(0, 24));
}

class ChatRecovery {
  constructor(sessionDir, dir = recoveryDirectory(sessionDir)) {
    this.sessionDir = path.resolve(sessionDir);
    this.dir = path.resolve(dir);
    const relative = path.relative(this.sessionDir, this.dir);
    if (!relative || (!relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative))) {
      throw new Error('Clanker recovery must be outside the session directory');
    }
    this.chats = path.join(this.dir, 'chats');
    this.localKey = path.join(this.sessionDir, 'snapshot.key');
    this.archiveKey = path.join(this.dir, 'snapshot.key');
    fs.mkdirSync(this.sessionDir, { recursive: true });
    fs.mkdirSync(this.chats, { recursive: true, mode: 0o700 });
    const knownKey = [this.archiveKey, this.localKey].find(file => fs.existsSync(file));
    this.key = initialiseKey(this.archiveKey, knownKey ? fs.readFileSync(knownKey) : crypto.randomBytes(32));
    if (this.key.length !== 32) throw new Error('Invalid Clanker recovery key');
    if (!initialiseKey(this.localKey, this.key).equals(this.key)) atomicWrite(this.localKey, this.key);
    this.pending = new Map();
    this.lastCheckpoint = new Map();
  }

  file(file) { return path.join(this.chats, path.basename(file).replace(/\.bak$/, '')); }
  marker(file) {
    const id = path.basename(file).replace(/^\d+_/, '').replace(/\.json(?:\.bak)?$/, '');
    return path.join(this.chats, id + '.deleted');
  }
  deleted(file) { return fs.existsSync(this.marker(file)); }
  list() { return [...new Set(names(this.chats).filter(name => /\.json(?:\.bak)?$/.test(name)).map(name => name.replace(/\.bak$/, '')))]; }

  digest(bytes) { return crypto.createHmac('sha256', this.key).update(bytes).digest(); }

  async signCheckpoint(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const body = bytes.subarray(0, -1);
    const { subtle } = crypto.webcrypto;
    this.signingKey ??= subtle.importKey('raw', this.key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const digest = Buffer.from(await subtle.sign('HMAC', await this.signingKey, body));
    return [body, footer(digest)];
  }

  signed(value) {
    const bytes = Buffer.isBuffer(value) ? value : Buffer.from(value);
    const body = bytes.subarray(0, -1);
    return Buffer.concat([body, footer(this.digest(body))]);
  }

  inspect(bytes) {
    const boundary = bytes.length - SIGNATURE_LENGTH;
    const sealed = boundary > 0 && bytes.subarray(boundary, boundary + SEAL.length).equals(SEAL);
    if (!sealed) {
      let end = bytes.length;
      while (end && [9, 10, 13, 32].includes(bytes[end - 1])) end--;
      return { bytes: bytes.subarray(0, end), sealed };
    }
    const body = bytes.subarray(0, boundary);
    const seal = Buffer.from(bytes.toString('ascii', boundary + SEAL.length, bytes.length - END.length), 'hex');
    if (seal.length !== 32 || !bytes.subarray(-END.length).equals(END) || !crypto.timingSafeEqual(seal, this.digest(body))) {
      throw new Error('Invalid Clanker snapshot seal');
    }
    return { bytes, sealed };
  }

  read(file, validate) {
    const raw = fs.readFileSync(file);
    const { bytes, sealed } = this.inspect(raw);
    if (!sealed) {
      const archive = this.file(file);
      const saved = [archive, archive + '.bak'].find(candidate => fs.existsSync(candidate));
      if (saved) {
        const previous = this.inspect(fs.readFileSync(saved));
        if (!previous.sealed || !bytes.subarray(0, -1).equals(previous.bytes.subarray(0, -SIGNATURE_LENGTH))) {
          throw new Error('Unverified change to protected Clanker snapshot');
        }
      }
      if (!saved) this.enqueue(file, validate, { seed: true });
    }
    return validate(bytes);
  }

  restore(file, validate) {
    if (this.deleted(file)) return null;
    let failure;
    for (const candidate of [this.file(file), this.file(file) + '.bak']) {
      try {
        const raw = fs.readFileSync(candidate);
        const { bytes, sealed } = this.inspect(raw);
        if (!sealed) throw new Error('Unsealed Clanker recovery copy');
        const chat = validate(bytes);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        initialiseKey(this.localKey, this.key);
        atomicWrite(file, raw);
        return chat;
      } catch (error) { if (error.code !== 'ENOENT') failure = error; }
    }
    if (failure) throw failure;
    return null;
  }

  delete(file) {
    atomicWrite(this.marker(file), '');
    this.pending.delete(this.file(file));
    this.lastCheckpoint.delete(this.file(file));
    for (const target of [this.file(file), this.file(file) + '.bak']) {
      try { fs.unlinkSync(target); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  projectBackup() { return path.join(this.dir, 'projects.json'); }

  saveProjects(items) {
    atomicWrite(this.projectBackup(), this.signed(JSON.stringify({ items })));
  }

  readProjects(file) {
    const backup = this.projectBackup();
    if (fs.existsSync(backup)) {
      try {
        const { bytes, sealed } = this.inspect(fs.readFileSync(backup));
        const { items } = JSON.parse(bytes.toString());
        if (!sealed || !Array.isArray(items)) throw new Error('Invalid Clanker project recovery copy');
        const text = JSON.stringify(items, null, 2);
        const live = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
        if (live !== text) {
          fs.mkdirSync(path.dirname(file), { recursive: true });
          atomicWrite(file, text);
        }
        return items;
      } catch (error) {
        require('./log.js').error('chat recovery', 'Could not verify or restore project registry:', error);
      }
    }
    for (const previous of [file, file + '.bak']) {
      if (!fs.existsSync(previous)) continue;
      let items;
      try { items = JSON.parse(fs.readFileSync(previous, 'utf8')); } catch { continue; }
      if (!Array.isArray(items)) continue;
      if (!fs.existsSync(backup)) this.saveProjects(items);
      return items;
    }
    if (fs.existsSync(file) || fs.existsSync(backup)) throw new Error('Clanker could not read the project registry or its recovery copy');
    return [];
  }

  assets(chat) {
    const files = new Set();
    for (const message of chat.messages) {
      for (const file of message.attachments || []) files.add(file);
      const ref = message.event?.outputBlob?.sha256;
      if (/^[0-9a-f]{64}$/.test(ref)) files.add(path.join(this.sessionDir, 'chats', 'tool-output', ref + '.gz'));
    }
    for (const file of chat.draftAttachments || []) files.add(file);
    for (const turn of chat.turnQueue?.turns || []) for (const file of turn.attachments || []) files.add(file);
    return [...files].filter(file => typeof file === 'string' && path.isAbsolute(file)).map(file => path.relative(this.sessionDir, file))
      .filter(file => /^(?:attachments|projects[\\/][a-zA-Z0-9_-]+[\\/]attachments|chats[\\/]tool-output)[\\/]/.test(file))
      .flatMap(file => /^(?:attachments|projects)[\\/]/.test(file) ? [file, file + SUFFIX] : [file]);
  }

  restoreAssets(chat) {
    for (const file of this.assets(chat)) {
      const source = path.join(this.dir, file);
      const target = path.join(this.sessionDir, file);
      if (fs.existsSync(target) || !fs.existsSync(source)) continue;
      fs.mkdirSync(path.dirname(target), { recursive: true });
      atomicWrite(target, fs.readFileSync(source));
    }
  }

  enqueue(file, validate, { seed = false, checkpoint = false } = {}) {
    const archive = this.file(file);
    if (checkpoint && Date.now() - (this.lastCheckpoint.get(archive) || 0) < CHECKPOINT_BACKUP_MS) return;
    this.lastCheckpoint.set(archive, Date.now());
    this.pending.set(archive, { file, validate, seed });
    this.start();
  }

  start() {
    if (this.running) return;
    this.running = Promise.resolve().then(() => this.drain()).finally(() => {
      this.running = null;
      if (this.pending.size) this.start();
    });
  }

  async drain() {
    while (this.pending.size) {
      const [archive, job] = this.pending.entries().next().value;
      this.pending.delete(archive);
      const { file, validate, seed } = job;
      const temporary = `${archive}.${crypto.randomUUID()}.tmp`;
      try {
        const original = stamp(file);
        if (!original || this.deleted(file) || (seed && fs.existsSync(archive))) continue;
        const raw = await fs.promises.readFile(file);
        const { bytes, sealed } = this.inspect(raw);
        if (!sealed && (!seed || fs.existsSync(archive + '.bak'))) continue;
        const chat = validate(bytes);
        for (const asset of this.assets(chat)) {
          const from = path.join(this.sessionDir, asset);
          const to = path.join(this.dir, asset);
          if (fs.existsSync(to) || !fs.existsSync(from)) continue;
          await fs.promises.mkdir(path.dirname(to), { recursive: true });
          const staged = `${to}.${crypto.randomUUID()}.tmp`;
          try {
            await fs.promises.copyFile(from, staged);
            const handle = await fs.promises.open(staged, 'r+');
            try { await handle.sync(); } finally { await handle.close(); }
            if (!fs.existsSync(to)) fs.renameSync(staged, to);
          } catch (error) { if (error.code !== 'ENOENT') throw error; }
          finally { if (fs.existsSync(staged)) fs.unlinkSync(staged); }
        }
        const handle = await fs.promises.open(temporary, 'wx');
        try { await handle.writeFile(sealed ? raw : this.signed(bytes)); await handle.sync(); }
        finally { await handle.close(); }
        if (!this.deleted(file) && stamp(file) === original && !(seed && fs.existsSync(archive))) {
          if (fs.existsSync(archive)) {
            const previous = temporary + '.previous';
            try {
              fs.linkSync(archive, previous);
              fs.renameSync(previous, archive + '.bak');
            } finally { if (fs.existsSync(previous)) fs.unlinkSync(previous); }
          }
          fs.renameSync(temporary, archive);
        }
      } catch (error) {
        require('./log.js').error('chat recovery', 'Could not back up chat:', error);
      } finally {
        try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') require('./log.js').warn('chat recovery', error); }
      }
    }
  }

  async flush() { while (this.running) await this.running; }
}

module.exports = { ChatRecovery, recoveryDirectory };
