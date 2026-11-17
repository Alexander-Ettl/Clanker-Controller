// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const zlib = require('node:zlib');

/** @typedef {import('../types/chat').Chat} Chat */
/** @typedef {import('../types/chat').ToolEvent} ToolEvent */
/** @typedef {import('../types/chat').ToolOutputRef} ToolOutputRef */
/** @typedef {{ ref: ToolOutputRef, text?: string, get?: () => string }} KnownOutput */

const FORMAT = 'clanker-tool-output-v1';
const THRESHOLD = 16 * 1024;
const CACHE_BYTES = 8 * 1024 * 1024;
/** @param {string} text */
const hash = text => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

// Snapshots and backups share immutable, lossless blobs. Never garbage-collect them
// without tracing backups, forks and all other conversation references first.
class ToolOutputStore {
  /** @param {string} chatDir */
  constructor(chatDir) {
    this.dir = path.join(chatDir, 'tool-output');
    /** @type {WeakMap<ToolEvent, KnownOutput>} */
    this.references = new WeakMap();
    /** @type {Map<string, string>} */
    this.cache = new Map();
    this.bytes = 0;
  }

  /** @param {ToolOutputRef | undefined} ref */
  file(ref) {
    if (!ref || !/^[a-f0-9]{64}$/.test(ref.sha256) || !Number.isSafeInteger(ref.bytes) || ref.bytes < 0) throw new Error('Invalid tool output reference');
    return path.join(this.dir, `${ref.sha256}.gz`);
  }

  /** @param {ToolOutputRef} ref @returns {string} */
  read(ref) {
    const file = this.file(ref);
    const cached = this.cache.get(ref.sha256);
    if (cached !== undefined) {
      this.cache.delete(ref.sha256); this.cache.set(ref.sha256, cached);
      return cached;
    }
    const text = zlib.gunzipSync(fs.readFileSync(file)).toString('utf8');
    if (Buffer.byteLength(text) !== ref.bytes || hash(text) !== ref.sha256) throw new Error('Damaged tool output: ' + ref.sha256);
    const bytes = text.length * 2;
    if (bytes <= CACHE_BYTES) {
      while (this.bytes + bytes > CACHE_BYTES && this.cache.size) {
        const oldest = /** @type {string} */ (this.cache.keys().next().value);
        this.bytes -= (this.cache.get(oldest) || '').length * 2; this.cache.delete(oldest);
      }
      this.cache.set(ref.sha256, text); this.bytes += bytes;
    }
    return text;
  }

  /** @param {string} text @returns {ToolOutputRef} */
  write(text) {
    const ref = { sha256: hash(text), bytes: Buffer.byteLength(text) };
    const file = this.file(ref);
    if (fs.existsSync(file)) { this.read(ref); return ref; }
    fs.mkdirSync(this.dir, { recursive: true });
    const temp = `${file}.${crypto.randomUUID()}.tmp`;
    try {
      const fd = fs.openSync(temp, 'wx');
      try { fs.writeFileSync(fd, zlib.gzipSync(text, { level: 3 })); fs.fsyncSync(fd); }
      finally { fs.closeSync(fd); }
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return ref;
  }

  /** The chat with large tool output moved to blobs; the chat itself is not changed. @param {Chat} chat @returns {Chat} */
  encode(chat) {
    return { ...chat, storageFormat: FORMAT, messages: chat.messages.map(/** @param {import('../types/chat').ChatMessage} message */ message => {
      if (message.role !== 'tool' || !message.event) return message;
      const event = message.event;
      const known = this.references.get(event);
      /** @type {ToolOutputRef} */
      let ref;
      if (known?.get && Object.getOwnPropertyDescriptor(event, 'output')?.get === known.get) ref = known.ref;
      else {
        const text = event.output;
        if (known && known.text === text && fs.existsSync(this.file(known.ref))) ref = known.ref;
        else {
          if (typeof text !== 'string' || Buffer.byteLength(text) < THRESHOLD) return message;
          // Lone UTF-16 surrogates do not round-trip through UTF-8. Keep those inline.
          if (Buffer.from(text).toString('utf8') !== text) return message;
          ref = this.write(text);
        }
        this.references.set(event, { text, ref });
      }
      if (!fs.existsSync(this.file(ref))) throw new Error('Missing tool output: ' + ref.sha256);
      const { output, ...rest } = Object.getOwnPropertyDescriptors(event);
      /** @type {ToolEvent} */
      const stored = Object.defineProperties({}, rest);
      stored.outputBlob = ref;
      return { ...message, event: stored };
    }) };
  }

  /** @param {Chat} chat @returns {Chat} */
  decode(chat) {
    if (chat.storageFormat !== FORMAT) return chat;
    delete chat.storageFormat;
    for (const message of chat.messages) {
      const event = message.role === 'tool' ? message.event : undefined;
      if (!event?.outputBlob) continue;
      const ref = event.outputBlob;
      this.file(ref); // validate before installing a lazy accessor
      delete event.outputBlob;
      this.attach(event, ref);
    }
    return chat;
  }

  /** @param {ToolEvent} event @param {ToolOutputRef} ref */
  attach(event, ref) {
    const get = () => this.read(ref);
    Object.defineProperty(event, 'output', { enumerable: true, configurable: true, get,
      set(value) { Object.defineProperty(this, 'output', { value, enumerable: true, configurable: true, writable: true }); } });
    this.references.set(event, { ref, get });
  }

  /** @param {Chat} chat */
  release(chat) {
    // Only release text after the referencing snapshot is durable. A tool may
    // have changed while an asynchronous checkpoint was writing its older value.
    for (const message of chat.messages) {
      const event = message.role === 'tool' ? message.event : undefined;
      const known = event && this.references.get(event);
      const descriptor = event ? Object.getOwnPropertyDescriptor(event, 'output') : undefined;
      if (known && !known.get && descriptor?.configurable && descriptor.value === known.text) this.attach(event, known.ref);
    }
  }
}

module.exports = { ToolOutputStore, THRESHOLD, CACHE_BYTES };
