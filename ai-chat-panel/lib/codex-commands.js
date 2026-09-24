'use strict';

const { execFile } = require('node:child_process');
const { locate, resolveShim } = require('./binary-locator.js');

/** Commands advertised by `codex exec`; the installed CLI remains the source of truth. */
function parseCommandTable(help) {
  const commands = [];
  let inCommands = false;
  for (const line of String(help || '').split(/\r?\n/)) {
    if (/^Commands:\s*$/.test(line)) { inCommands = true; continue; }
    if (!inCommands) continue;
    if (/^\S/.test(line)) break;
    const match = /^\s{2}([a-z][\w-]*)\s{2,}(\S.*)$/i.exec(line);
    if (match) commands.push({ name: match[1], description: match[2].trim() });
  }
  return commands;
}

function run(binary, args, execFileImpl = execFile) {
  const shim = process.platform === 'win32' && /\.cmd$/i.test(binary) ? resolveShim(binary) : null;
  return new Promise((resolve, reject) => {
    execFileImpl(shim?.command || binary, [...(shim?.args || []), ...args], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, maxBuffer: 256 * 1024,
      shell: process.platform === 'win32' && /\.cmd$/i.test(binary) && !shim,
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
}

function supportsComposerCommand(help, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`Usage:\\s+codex exec ${escaped} \\[OPTIONS\\] \\[PROMPT\\]`, 'i').test(help)
    && /\s--json\b/.test(help)
    && /--skip-git-repo-check\b/.test(help)
    && /--model\b/.test(help)
    && /--config\b/.test(help)
    && /read from stdin/i.test(help);
}

function parseInvocation(text, commands) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!match) return null;
  const command = commands.find((entry) => entry.name.toLowerCase() === match[1].toLowerCase());
  return command ? { ...command, prompt: (match[2] || '').trim() } : null;
}

class CodexCommandCatalog {
  constructor({ locateImpl = locate, runImpl = run } = {}) {
    this.locate = locateImpl;
    this.run = runImpl;
    this.binary = null;
    this.promise = null;
  }

  refresh() { this.binary = null; this.promise = null; }

  async list() {
    const binary = this.locate('codex').path;
    if (!binary) return [];
    if (this.binary !== binary) { this.binary = binary; this.promise = null; }
    this.promise ||= this.discover(binary);
    try { return await this.promise; }
    catch { this.promise = null; return []; }
  }

  async discover(binary) {
    const advertised = parseCommandTable(await this.run(binary, ['exec', '--help']));
    const details = await Promise.all(advertised.map(async (command) => {
      try {
        const help = await this.run(binary, ['exec', command.name, '--help']);
        return supportsComposerCommand(help, command.name)
          ? { name: command.name, description: help.trim().split(/\r?\n/, 1)[0] || command.description }
          : null;
      } catch { return null; }
    }));
    return details.filter(Boolean);
  }

  async resolve(text) {
    if (!/^\/[^\s]+(?:\s+[\s\S]*)?$/.test(String(text || '').trim())) return null;
    return parseInvocation(text, await this.list());
  }
}

module.exports = { CodexCommandCatalog, parseCommandTable, parseInvocation, supportsComposerCommand };
