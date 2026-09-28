'use strict';

const { execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { locate, resolveShim } = require('./binary-locator.js');
const { commandsForMethods } = require('./codex-app-server.js');

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

/** Native exec commands may require a target when no prompt was supplied. */
function defaultArgsFromHelp(help) {
  return /(?:^|\s)--uncommitted\b/m.test(String(help || '')) ? ['--uncommitted'] : [];
}

function methodNamesFromSchema(schema) {
  const names = new Set();
  for (const request of Array.isArray(schema?.oneOf) ? schema.oneOf : []) {
    for (const name of request?.properties?.method?.enum || []) names.add(name);
  }
  return names;
}

/** App Server has no slash-command-list RPC; its generated request schema is its native capability list. */
async function discoverAppServerMethods(binary, runImpl = run) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-chat-panel-codex-schema-'));
  try {
    await runImpl(binary, ['app-server', 'generate-json-schema', '--out', directory]);
    return methodNamesFromSchema(JSON.parse(fs.readFileSync(path.join(directory, 'ClientRequest.json'), 'utf8')));
  } finally {
    try { fs.rmSync(directory, { recursive: true, force: true }); } catch { /* temporary capability cache */ }
  }
}

function parseInvocation(text, commands) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(String(text || '').trim());
  if (!match) return null;
  const command = commands.find((entry) => entry.name.toLowerCase() === match[1].toLowerCase());
  return command ? { ...command, prompt: (match[2] || '').trim() } : null;
}

class CodexCommandCatalog {
  constructor({ locateImpl = locate, runImpl = run, discoverMethodsImpl = discoverAppServerMethods } = {}) {
    this.locate = locateImpl;
    this.run = runImpl;
    this.discoverMethods = discoverMethodsImpl;
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
    return commandsForMethods(await this.discoverMethods(binary, this.run));
  }

  async resolve(text) {
    if (!/^\/[^\s]+(?:\s+[\s\S]*)?$/.test(String(text || '').trim())) return null;
    return parseInvocation(text, await this.list());
  }
}

module.exports = { CodexCommandCatalog, discoverAppServerMethods, methodNamesFromSchema, parseCommandTable, parseInvocation, supportsComposerCommand, defaultArgsFromHelp };
