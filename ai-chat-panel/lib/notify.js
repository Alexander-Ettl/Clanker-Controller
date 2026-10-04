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

/** Fire and forget; never throws. `toast` is { agent, text, chatTitle } or null; `chime: false` makes it a silent toast (or nothing). */
function notifyReply({ toast = null, appName = '', chime = true } = {}) {
  if (process.env.NO_CHIME === '1' || process.env.AI_CHAT_PANEL_COMPACT === '1') chime = false;
  if (process.platform !== 'win32' || (!chime && !toast)) return;
  const env = { ...process.env, CHAT_SOUND: chime ? SOUND : '', CHAT_APP_NAME: appName, CHAT_TOAST_ICON: TOAST_ICON };
  if (toast) {
    env.CHAT_TOAST_TITLE = `${NAMES[toast.agent] || 'Your AI'} replied${toast.chatTitle ? ` · ${toast.chatTitle}` : ''}`;
    env.CHAT_TOAST_BODY = firstSentence(toast.text) || 'Your response is ready.';
  }
  try {
    // P17-O: no `detached` -- on Windows that gives the child its own console window, which flashes.
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'notify.ps1')], { env, windowsHide: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch { /* a chime is never worth an error */ }
}

module.exports = { notifyReply, firstSentence };
