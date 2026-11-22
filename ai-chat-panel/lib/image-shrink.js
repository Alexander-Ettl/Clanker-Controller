'use strict';

// Linux and macOS counterpart of routing-image.ps1: a JPEG small enough to hand to another model, as base64.
// Same contract: width capped at `width` (and at 1536 tall), quality stepped down until the bytes fit `maxBytes`, then the
// picture itself is shrunk. Uses ffmpeg, which dictation already needs; null when it is missing or fails.

const { execFile } = require('node:child_process');

const QUALITIES = [4, 8, 12, 18, 24, 31]; // mjpeg -q:v: lower is better

function encode(file, width, quality, execImpl) {
  // min() takes exactly two arguments in ffmpeg, so it is nested: a small picture keeps its own size, and a tall one is
  // narrowed until its height fits 1536.
  const scale = `scale='min(${width},min(iw,iw*1536/ih))':-2`;
  return new Promise((resolve) => execImpl('ffmpeg', ['-v', 'error', '-i', file, '-vf', scale, '-frames:v', '1', '-q:v', String(quality), '-f', 'image2pipe', '-c:v', 'mjpeg', '-'],
    { encoding: 'buffer', timeout: 4000, maxBuffer: 8 * 1024 * 1024 }, (error, out) => resolve(error ? null : out)));
}

async function shrinkImage(file, { width = 1024, maxBytes = 190000, execImpl = execFile } = {}) {
  for (let w = width; w >= 64; w = Math.floor(w * 0.75)) {
    for (const quality of QUALITIES) {
      const bytes = await encode(file, w, quality, execImpl);
      if (!bytes) return null; // ffmpeg missing, or the file cannot be read: no point retrying
      if (bytes.length && bytes.length < maxBytes) return bytes.toString('base64');
    }
  }
  return null;
}

module.exports = { shrinkImage };
