'use strict';

// "Your reply is ready": the completion chime every agent already plays in its
// own UI, plus a Windows toast when the IDE isn't the focused window. The toast
// text is the reply's own first sentence, so it costs no tokens.

const { spawn } = require('node:child_process');
const os = require('node:os');
const path = require('node:path');

const SOUND = path.join(process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), 'Nextcloud', 'ClaudeConfig'), 'sounds', 'universfield-new-notification-07-210334.mp3');
const NAMES = { claude: 'Claude', codex: 'Codex', gemini: 'Gemini' };
// The Clanker Controller logo (Clanker_Controller_logo.svg in the website repo's root) in its orange on a dark rounded
// tile, 256x256, which Windows shows beside "Clanker Controller". Rendered from that SVG by hand: redo it if the logo changes.
const TOAST_ICON = path.join(__dirname, '..', 'media', 'icon-toast.png');

/** Plain first sentence (or first ~140 chars) of a Markdown reply. */
function firstSentence(markdown) {
  const text = String(markdown || '')
    .replace(/```[\s\S]*?(```|$)/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^\s{0,3}(#{1,6}|>|[-*+]|\d+[.)])\s+/gm, '')
    .replace(/[*_~]{1,3}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const sentence = text.match(/^.{12,}?[.!?](?=\s|$)/)?.[0] || text;
  return sentence.length > 140 ? `${sentence.slice(0, 137).trimEnd()}...` : sentence;
}

/**
 * The part of a reply written after its last tool call: the agent's closing summary, which says what happened, rather
 * than the "I'll start by reading..." that opens the turn. Tool entries sit after the reply in `messages` and carry the
 * reply's text length at the moment they started. Falls back to the whole reply when nothing follows the last tool.
 */
function textAfterLastTool(reply, messages) {
  const text = String(reply?.text || '');
  const from = (messages || []).indexOf(reply);
  if (from < 0) return text;
  let cut = 0;
  for (const entry of messages.slice(from + 1)) {
    if (entry?.role === 'tool' && Number.isFinite(entry.offset)) cut = Math.max(cut, entry.offset);
  }
  return text.slice(cut).trim() ? text.slice(cut) : text;
}

/** Players tried in order for the chime on Linux: PulseAudio/PipeWire's own first, ffplay (ffmpeg is already required for dictation) last. */
const LINUX_PLAYERS = (file) => [['paplay', [file]], ['pw-play', [file]], ['ffplay', ['-nodisp', '-autoexit', '-loglevel', 'quiet', file]]];
const LINUX_FALLBACK_SOUND = '/usr/share/sounds/freedesktop/stereo/complete.oga';

/** Runs the first command that exists; `spawnImpl` reports a missing one as an 'error' event. */
function playFirst(candidates, spawnImpl) {
  const [next, ...rest] = candidates;
  if (!next) return;
  try {
    const child = spawnImpl(next[0], next[1], { stdio: 'ignore' });
    child.on('error', () => playFirst(rest, spawnImpl));
    child.on('exit', (code) => { if (code) playFirst(rest, spawnImpl); }); // present but could not play this file
    child.unref?.();
  } catch { playFirst(rest, spawnImpl); }
}

function notifyLinux({ toast, chime, appName, spawnImpl, existsImpl }) {
  if (toast) {
    const title = `${NAMES[toast.agent] || 'Your AI'} replied${toast.chatTitle ? ` · ${toast.chatTitle}` : ''}`;
    try {
      const child = spawnImpl('notify-send', ['--app-name', appName || 'Clanker Controller', '--icon', TOAST_ICON, '--', title, firstSentence(toast.text) || 'Your response is ready.'], { stdio: 'ignore' });
      child.on('error', () => {});
      child.unref?.();
    } catch { /* no notification daemon is fine */ }
  }
  if (chime) playFirst(LINUX_PLAYERS([SOUND, LINUX_FALLBACK_SOUND].find((file) => existsImpl(file)) || SOUND), spawnImpl);
}

/** Fire and forget; never throws. `toast` is { agent, text, chatTitle } or null; `chime: false` makes it a silent toast (or nothing). */
function notifyReply({ toast = null, appName = '', chime = true, platform = process.platform, spawnImpl = spawn, existsImpl = require('node:fs').existsSync } = {}) {
  if (process.env.NO_CHIME === '1' || process.env.AI_CHAT_PANEL_COMPACT === '1') chime = false;
  if (!chime && !toast) return;
  if (platform === 'linux') { notifyLinux({ toast, chime, appName, spawnImpl, existsImpl }); return; }
  if (platform !== 'win32') return;
  const env = { ...process.env, CHAT_SOUND: chime ? SOUND : '', CHAT_APP_NAME: appName, CHAT_TOAST_ICON: TOAST_ICON };
  if (toast) {
    env.CHAT_TOAST_TITLE = `${NAMES[toast.agent] || 'Your AI'} replied${toast.chatTitle ? ` · ${toast.chatTitle}` : ''}`;
    env.CHAT_TOAST_BODY = firstSentence(toast.text) || 'Your response is ready.';
  }
  try {
    // P17-O: no `detached` -- on Windows that gives the child its own console window, which flashes.
    const child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'notify.ps1')], { env, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* a chime is never worth an error */ }
}

module.exports = { notifyReply, firstSentence, textAfterLastTool };
