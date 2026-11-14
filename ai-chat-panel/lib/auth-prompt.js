'use strict';

// The Windows popup behind a held send (lib/auth-gate.js): what is wrong, and a button that fixes it. A separate window
// (auth-prompt.ps1), not an IDE notification, because the IDE is often minimised when the queue wakes up.

const { spawn } = require('node:child_process');
const path = require('node:path');

const SCRIPT = path.join(__dirname, 'auth-prompt.ps1');
const ICON = path.join(__dirname, '..', 'media', 'icon-toast.png');

/** @returns {{ result: Promise<'act' | 'later'>, close(): void } | null} null where there is no Windows to show it on. */
function showAuthPrompt(block, { platform = process.platform, spawnImpl = spawn, extraEnv = {} } = {}) {
  if (platform !== 'win32') return null;
  const env = { ...process.env, AUTH_TITLE: block.title, AUTH_MESSAGE: block.message, AUTH_STEPS: (block.steps || []).join('\n'),
    AUTH_BUTTON: block.button || '', AUTH_ERROR: block.error || '', AUTH_ICON: ICON, ...extraEnv };
  let child;
  const result = new Promise((resolve) => {
    try {
      child = spawnImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-STA', '-WindowStyle', 'Hidden', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch { resolve('later'); return; }
    let out = '';
    child.stdout?.on('data', (chunk) => { out += chunk; });
    child.on('error', () => resolve('later'));
    child.on('close', () => resolve(/^act\s*$/m.test(out) ? 'act' : 'later'));
  });
  return { result, close() { try { child?.kill(); } catch { /* already gone */ } } };
}

module.exports = { showAuthPrompt, SCRIPT, ICON };
