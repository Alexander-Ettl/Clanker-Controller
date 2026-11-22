'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' };
const WINDOWS_SCRIPT = 'Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $img = [System.Drawing.Image]::FromFile($env:CLANKER_CLIP_FILE); try { [System.Windows.Forms.Clipboard]::SetImage($img) } finally { $img.Dispose() }';

/** The command that puts `file` on the clipboard as a picture, or null when this system has no way. */
function clipboardImageCommand(file, { platform = process.platform, env = process.env } = {}) {
  const mime = MIME[path.extname(file).toLowerCase()];
  if (platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', WINDOWS_SCRIPT], env: { ...env, CLANKER_CLIP_FILE: file }, windowsHide: true };
  if (!mime) return null;
  // Wayland takes the bytes on stdin (wl-clipboard); X11 reads the file itself (xclip) and keeps serving it after it forks.
  if (platform === 'linux') return env.WAYLAND_DISPLAY ? { command: 'wl-copy', args: ['--type', mime], stdinFile: file } : { command: 'xclip', args: ['-selection', 'clipboard', '-t', mime, '-i', file] };
  if (platform === 'darwin') return { command: 'osascript', args: ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(file)}) as ${mime === 'image/png' ? '«class PNGf»' : 'JPEG picture'})`] }; // not yet run on a Mac
  return null;
}

const FILE_SCRIPT = 'Set-Clipboard -LiteralPath $env:CLANKER_CLIP_FILE';

/**
 * The command that puts the file itself on the clipboard, so a file manager can paste it. Linux file managers read a URI list;
 * GNOME's (Nautilus) wants its own "copy" + URI flavour. Null when this system has no way.
 */
function clipboardFileCommand(file, { platform = process.platform, env = process.env } = {}) {
  if (platform === 'win32') return { command: 'powershell.exe', args: ['-NoProfile', '-NonInteractive', '-STA', '-Command', FILE_SCRIPT], env: { ...env, CLANKER_CLIP_FILE: file }, windowsHide: true };
  if (platform !== 'linux') return null;
  const uri = require('node:url').pathToFileURL(file, { windows: false }).href;
  const gnome = /gnome|unity|cinnamon|budgie/i.test(env.XDG_CURRENT_DESKTOP || '');
  const type = gnome ? 'x-special/gnome-copied-files' : 'text/uri-list';
  const stdinText = gnome ? `copy\n${uri}` : `${uri}\r\n`;
  return env.WAYLAND_DISPLAY ? { command: 'wl-copy', args: ['--type', type], stdinText } : { command: 'xclip', args: ['-selection', 'clipboard', '-t', type], stdinText };
}

/** Resolves when the copy succeeded; rejects with a message that says what to install when the tool is missing. */
function copyImageToClipboard(file, options = {}) { return runClipboard(clipboardImageCommand(file, options), options, 'Image'); }

/** The file itself (not its pixels or its path): what Explorer, Nautilus, Dolphin or Thunar paste. */
function copyFileToClipboard(file, options = {}) { return runClipboard(clipboardFileCommand(file, options), options, 'File'); }

function runClipboard(spec, options, noun) {
  const { spawnImpl = spawn, timeoutMs = 8000 } = options;
  if (!spec) return Promise.reject(new Error(`${noun} clipboard copy is not supported on this system.`));
  return new Promise((resolve, reject) => {
    let child;
    try { child = spawnImpl(spec.command, spec.args, { env: spec.env, windowsHide: spec.windowsHide, stdio: [spec.stdinFile || spec.stdinText ? 'pipe' : 'ignore', 'ignore', 'ignore'] }); } catch (error) { reject(error); return; }
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } reject(new Error('Copying the image timed out.')); }, timeoutMs);
    child.once('error', (error) => { clearTimeout(timer); reject(error.code === 'ENOENT' ? new Error(`Install ${spec.command === 'wl-copy' ? 'wl-clipboard' : spec.command} to copy ${noun === 'File' ? 'files' : 'images'}.`) : error); });
    child.once('exit', (code) => { clearTimeout(timer); code ? reject(new Error(`${spec.command} exited with code ${code}.`)) : resolve(); });
    if (spec.stdinText) { child.stdin.on('error', () => {}); child.stdin.end(spec.stdinText); }
    else if (spec.stdinFile) {
      child.stdin.on('error', () => {});
      fs.createReadStream(spec.stdinFile).on('error', reject).pipe(child.stdin);
    }
  });
}

module.exports = { copyImageToClipboard, clipboardImageCommand, copyFileToClipboard, clipboardFileCommand };
