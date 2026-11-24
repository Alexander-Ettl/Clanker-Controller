'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('native screenshot copy shrinks only when compression cannot fit and preserves the original', { skip: process.platform !== 'win32' && 'Windows only: the screenshot copy uses PowerShell' }, t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'clanker-routing-image-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'original image.png');
  const fixture = path.join(root, 'fixture.ps1');
  fs.writeFileSync(fixture, `param([string]$Source)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
$bitmap = New-Object System.Drawing.Bitmap(512, 384)
try {
  $rect = New-Object System.Drawing.Rectangle(0, 0, 512, 384)
  $data = $bitmap.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::WriteOnly, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  try {
    $bytes = New-Object byte[] ($data.Stride * 384)
    $random = New-Object System.Random(42)
    $random.NextBytes($bytes)
    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
  } finally { $bitmap.UnlockBits($data) }
  $bitmap.Save($Source, [System.Drawing.Imaging.ImageFormat]::Png)
} finally { $bitmap.Dispose() }
`);
  const run = (script, args) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', script, ...args], { windowsHide: true, timeout: 30000, encoding: 'utf8' }).trim(); // cold PowerShell + System.Drawing takes seconds on a CI runner
  run(fixture, ['-Source', source]);
  const original = fs.readFileSync(source);
  const converter = path.join(__dirname, '../lib/routing-image.ps1');
  const copy = (width, maxBytes) => Buffer.from(run(converter, ['-Source', source, '-Width', String(width), '-MaxBytes', String(maxBytes)]), 'base64');
  // Read the JPEG's actual dimensions rather than trusting converter variables.
  const dimensions = jpeg => {
    assert.equal(jpeg.readUInt16BE(0), 0xffd8);
    for (let offset = 2; offset < jpeg.length;) {
      const marker = jpeg.readUInt16BE(offset);
      const length = jpeg.readUInt16BE(offset + 2);
      if (marker === 0xffc0) return { width: jpeg.readUInt16BE(offset + 7), height: jpeg.readUInt16BE(offset + 5) };
      offset += 2 + length;
    }
    assert.fail('JPEG frame missing');
  };
  assert.deepEqual(dimensions(copy(1024, 190000)), { width: 512, height: 384 });
  assert.deepEqual(dimensions(copy(256, 190000)), { width: 256, height: 192 });
  const small = copy(1024, 1000);
  assert.ok(small.length > 0 && small.length < 1000);
  const size = dimensions(small);
  assert.ok(size.width < 512 && size.height < 384);
  assert.ok(Math.abs(size.height - size.width * 0.75) <= 1);
  assert.equal(copy(1024, 1).length, 0, 'impossible byte limits terminate without an oversized copy');
  assert.deepEqual(fs.readFileSync(source), original);
});
