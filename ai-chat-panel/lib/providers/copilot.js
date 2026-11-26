'use strict';

// GitHub Copilot CLI provider (`@github/copilot`).
// Runs non-interactive turns (`copilot -p --output-format json`), checks sign-in,
// and discovers models. Event mapping: `normalizeEvent` below.

const { launchFailure } = require('./shared.js');

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { stripVTControlCharacters } = require('node:util');
const skillsDir = path.resolve(__dirname, '..', '..', 'skills');

const entry = (model, title, isDefault = false) => ({
  id: `copilot-${String(model).replace(/[^a-z0-9.-]+/gi, '-')}`,
  agent: 'copilot',
  model: String(model),
  effort: null,
  label: /^Copilot\b/i.test(title) ? String(title) : `Copilot · ${title}`,
  isDefault: Boolean(isDefault),
});

const text = (value) => (typeof value === 'string' ? value : '');
// Tools that only report progress to the CLI's own UI.
const HIDDEN_TOOLS = new Set(['report_intent']);

/** Copilot's edit/create/patch calls use the same file and diff cards as the other providers. */
function toolStart(data) {
  // Lazy: the stream engine loads the providers.
  const { toolTarget, editDiff } = require('../stream-engine.js');
  const input = data.arguments && typeof data.arguments === 'object' ? data.arguments : {};
  const name = text(data.toolName) || 'tool';
  const file = text(input.path) || text(input.file_path) || text(input.filePath);
  const base = { type: 'tool_start', toolId: text(data.toolCallId), agent: 'copilot' };
  const command = text(input.command) || text(input.question) || text(input.prompt) || toolTarget(input) || file || text(data.toolTitle);
  if (data.mcpServerName) return { ...base, name: `mcp__${data.mcpServerName}__${text(data.mcpToolName) || name}`, command, file: '', diff: '' };
  if (name === 'edit' || name === 'create') {
    return { ...base, name: 'edit', command: file, file, diff: editDiff({ old_string: name === 'edit' ? input.old_str : '', new_string: name === 'edit' ? input.new_str : input.file_text }) };
  }
  if (name === 'apply_patch') {
    const patch = text(input.patch) || text(input.input) || text(data.arguments);
    const files = [...patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1].trim());
    const lines = patch.replace(/\r\n/g, '\n').split('\n');
    const diff = lines.flatMap((line) => {
      if (/^[ +\-]/.test(line)) return [line];
      const header = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line);
      return header && files.length > 1 ? [` ${header[1]}`] : [];
    }).slice(0, 300).join('\n');
    return { ...base, name: 'edit', command: files.join(', ') || text(data.toolTitle), file: files.length === 1 ? files[0] : '', diff };
  }
  const summary = text(data.toolTitle) || text(input.description);
  return { ...base, name, command, file, diff: '', ...(summary && command !== summary ? { summary: summary.slice(0, 200) } : {}) };
}

function toolOutput(result) {
  const blocks = Array.isArray(result?.contents) ? result.contents : [];
  const content = blocks.map((block) => text(block?.text) || text(block?.output) || text(block?.uri)
    || (block?.type === 'image' ? '[Image output]' : block?.type === 'audio' ? '[Audio output]' : '')).filter(Boolean).join('\n');
  return text(result?.detailedContent) || content || text(result?.content);
}

function usage(raw) {
  if (raw?.type !== 'assistant.usage') return null;
  const data = raw.data || {};
  const n = (value) => Number.isFinite(value) && value >= 0 ? value : 0;
  const input = n(data.inputTokens), output = n(data.outputTokens);
  const cachedInput = Math.min(input, n(data.cacheReadTokens));
  const cacheWrite = Math.min(input - cachedInput, n(data.cacheWriteTokens));
  return { input, output, id: raw.id || null, detail: { fresh: input - cachedInput - cacheWrite, cachedInput, cacheWrite, output } };
}

/** One event of `copilot -p --output-format json`; null for a known event with nothing to show. */
function normalizeEvent(raw, { nested = false } = {}) {
  if (!raw || typeof raw !== 'object') return undefined;
  const data = raw.data && typeof raw.data === 'object' ? raw.data : {};
  if (!nested && (data.parentToolCallId || raw.agentId)) return null;
  switch (raw.type) {
    case 'session.start':
      return data.sessionId ? { type: 'session', sessionId: text(data.sessionId), agent: 'copilot' } : null;
    case 'assistant.message':
      return text(data.content).trim() ? { type: 'delta', text: data.content, block: true, model: 'copilot', agent: 'copilot' } : null;
    case 'assistant.reasoning':
      return text(data.content).trim() ? { type: 'thought', text: data.content, agent: 'copilot' } : null;
    case 'skill.invoked':
      return text(data.name) ? { type: 'tool_start', toolId: text(raw.id), name: 'skill', command: data.name, done: true, agent: 'copilot' } : null;
    case 'tool.execution_start':
      return HIDDEN_TOOLS.has(data.toolName) ? null : toolStart(data);
    case 'tool.execution_partial_result':
    case 'tool.shell_output': {
      const output = stripVTControlCharacters(text(data.partialOutput) || text(data.text)).slice(-16000);
      return output && data.toolCallId ? { type: 'tool_progress', toolId: data.toolCallId, output, sequence: data.sequence, agent: 'copilot' } : null;
    }
    case 'tool.execution_complete': {
      if (!data.toolCallId || HIDDEN_TOOLS.has(data.toolName)) return null;
      const content = toolOutput(data.result);
      const error = data.success === false ? text(data.error?.message) : '';
      const output = [error, content].filter((value, index, all) => value && all.indexOf(value) === index).join('\n\n');
      return { type: 'tool_end', toolId: text(data.toolCallId), output, error: data.success === false, diff: '', agent: 'copilot' };
    }
    case 'session.error':
      return { type: 'delta', text: `Copilot error: ${text(data.message) || 'request failed'}`, block: true, model: 'copilot', agent: 'copilot' };
    case 'session.warning':
      return text(data.message) ? { type: 'notice', text: data.message, agent: 'copilot' } : null;
    case 'session.usage_info':
      return data.currentTokens > 0 && data.tokenLimit > 0 ? { type: 'usage', contextTokens: data.currentTokens, contextWindow: data.tokenLimit, agent: 'copilot' } : null;
    case 'session.compaction_complete':
      return data.success === true ? { type: 'context_reset', kind: 'native', preTokens: data.preCompactionTokens, agent: 'copilot' }
        : text(data.error) ? { type: 'notice', text: `Copilot compaction failed: ${data.error}`, agent: 'copilot' } : null;
    case 'result':
      return { type: 'turn_complete', agent: 'copilot' };
    default:
      return null;
  }
}

// The CLI has no `models` command. Its ACP server (`copilot --acp`) answers `session/new` with the models this account may
// use, the same list as `/model` and VS Code's Copilot picker. The requests are piped in at once; the CLI exits when stdin
// closes. No prompt is sent, so nothing is billed.
const ACP_PROBE = [
  { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: 1, clientCapabilities: {} } },
  { jsonrpc: '2.0', id: 2, method: 'session/new', params: { cwd: os.tmpdir(), mcpServers: [] } },
].map((message) => JSON.stringify(message)).join('\n') + '\n';

/** `session/new`'s reply from the ACP output: { models: entries | null, sessionId, error }. Disabled models are left out. */
function parseAcpModels(stdout) {
  for (const line of String(stdout || '').split(/\r?\n/)) {
    let message;
    try { message = JSON.parse(line); } catch { continue; }
    if (message?.id === 2 && message.error) return { models: null, sessionId: null, error: String(message.error.message || 'session/new failed') };
    if (message?.id !== 2 || !message.result) continue;
    const { availableModels = [], currentModelId } = message.result.models || {};
    const seen = new Set();
    const models = availableModels
      .filter((item) => item?.modelId && item._meta?.copilotEnablement !== 'disabled' && !seen.has(item.modelId) && seen.add(item.modelId))
      .map((item) => entry(item.modelId, item.name || item.modelId, item.modelId === currentModelId));
    return { models: models.length ? models : null, sessionId: message.result.sessionId || null, error: models.length ? null : 'the CLI reported no enabled models for this account' };
  }
  return { models: null, sessionId: null, error: null };
}

/** The probe's session holds nothing (no events.jsonl) and is not listed, but would stay on disk: remove just that folder. */
function removeProbeSession(sessionId, env = process.env, home = os.homedir()) {
  if (!/^[0-9a-f-]{36}$/i.test(sessionId || '')) return;
  const dir = path.join(env.COPILOT_HOME || path.join(home, '.copilot'), 'session-state', sessionId);
  try {
    if (fs.existsSync(path.join(dir, 'events.jsonl'))) return;
    if (!/client_name: github\/acp/.test(fs.readFileSync(path.join(dir, 'workspace.yaml'), 'utf8'))) return;
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // Leaving an empty session behind is harmless.
  }
}

module.exports = {
  id: 'copilot',
  nativeAutoCompaction: true,
  name: 'GitHub Copilot',
  company: 'GitHub',
  color: '#10b981',
  cli: 'copilot',
  npmPackage: '@github/copilot',
  headlessApprovals: false,
  optional: true,
  icon: '<svg xmlns="http://www.w3.org/2000/svg" fill="currentColor" fill-rule="evenodd" class="agent-logo" aria-hidden="true" focusable="false" viewBox="0 2.5 24 19"><path d="M19.245 5.364c1.322 1.36 1.877 3.216 2.11 5.817.622 0 1.2.135 1.592.654l.73.964c.21.278.323.61.323.955v2.62c0 .339-.173.669-.453.868C20.239 19.602 16.157 21.5 12 21.5c-4.6 0-9.205-2.583-11.547-4.258-.28-.2-.452-.53-.453-.868v-2.62c0-.345.113-.679.321-.956l.73-.963c.392-.517.974-.654 1.593-.654l.029-.297c.25-2.446.81-4.213 2.082-5.52 2.461-2.54 5.71-2.851 7.146-2.864h.198c1.436.013 4.685.323 7.146 2.864zm-7.244 4.328c-.284 0-.613.016-.962.05-.123.447-.305.85-.57 1.108-1.05 1.023-2.316 1.18-2.994 1.18-.638 0-1.306-.13-1.851-.464-.516.165-1.012.403-1.044.996a65.882 65.882 0 00-.063 2.884l-.002.48c-.002.563-.005 1.126-.013 1.69.002.326.204.63.51.765 2.482 1.102 4.83 1.657 6.99 1.657 2.156 0 4.504-.555 6.985-1.657a.854.854 0 00.51-.766c.03-1.682.006-3.372-.076-5.053-.031-.596-.528-.83-1.046-.996-.546.333-1.212.464-1.85.464-.677 0-1.942-.157-2.993-1.18-.266-.258-.447-.661-.57-1.108-.32-.032-.64-.049-.96-.05zm-2.525 4.013c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zm5 0c.539 0 .976.426.976.95v1.753c0 .525-.437.95-.976.95a.964.964 0 01-.976-.95v-1.752c0-.525.437-.951.976-.951zM7.635 5.087c-1.05.102-1.935.438-2.385.906-.975 1.037-.765 3.668-.21 4.224.405.394 1.17.657 1.995.657h.09c.649-.013 1.785-.176 2.73-1.11.435-.41.705-1.433.675-2.47-.03-.834-.27-1.52-.63-1.813-.39-.336-1.275-.482-2.265-.394zm6.465.394c-.36.292-.6.98-.63 1.813-.03 1.037.24 2.06.675 2.47.968.957 2.136 1.104 2.776 1.11h.044c.825 0 1.59-.263 1.995-.657.555-.556.765-3.187-.21-4.224-.45-.468-1.335-.804-2.385-.906-.99-.088-1.875.058-2.265.394zM12 7.615c-.24 0-.525.015-.84.044.03.16.045.336.06.526l-.001.159a2.94 2.94 0 01-.014.25c.225-.022.425-.027.612-.028h.366c.187 0 .387.006.612.028-.015-.146-.015-.277-.015-.409.015-.19.03-.365.06-.526a9.29 9.29 0 00-.84-.044z"/></svg>',

  // The real CLI's own install places first: VS Code puts a `copilot` shim on PATH (/usr/bin/copilot -> code/bin/copilot-shim)
  // that only forwards to them, and answers "GitHub Copilot CLI was not found" (exit 127) until one exists.
  locate: ({ onPath, join, home, local, npmGlobal }) => [
    join(home, '.local', 'bin', 'copilot.exe'),
    join(local, 'Programs', 'copilot', 'copilot.exe'),
    join(npmGlobal, 'copilot.cmd'),
    ...onPath('copilot'),
  ],

  login: ['login'],
  // `copilot login` may show a device code or ask before it stores the token in plain text, so it runs in a terminal you can see.
  terminalLogin: true,
  authStatus: {
    args: ['--version'],
    interpret: (result) => {
      const output = `${result.stdout || ''}\n${result.stderr || ''}`;
      if (launchFailure(output)) return 'broken';
      // VS Code's shim without the real CLI behind it. Run in a terminal, the shim offers to install it.
      if (/Copilot CLI was not found|no usable GitHub Copilot CLI/i.test(output)) return 'missing';
      if (/not logged in|authentication required|run.*copilot login|please log in/i.test(output)) return 'signin';
      return result.ok ? 'ready' : 'signin';
    },
  },
  installPosix: 'npm install -g @github/copilot@latest && copilot login',
  install: 'npm.cmd install -g @github/copilot@latest; if ($LASTEXITCODE -eq 0) { & "$env:APPDATA\\npm\\copilot.cmd" login }',

  // Only the account's own list counts: no built-in or hard-coded fallback. A failure throws, and Settings shows the reason.
  discoverModels: async ({ file, runCli }) => {
    if (!file) return null;
    const result = await runCli(file, ['--acp'], 30000, undefined, ACP_PROBE);
    const { models, sessionId, error } = parseAcpModels(result?.stdout);
    removeProbeSession(sessionId);
    if (models) return models;
    const detail = error || String(result?.stderr || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1)
      || (result?.ok ? 'the CLI did not answer the model request' : `the CLI exited with code ${result?.code ?? 'unknown'}`);
    throw new Error(`Could not discover Copilot models: ${detail}`);
  },

  // JSONL session events (`--output-format json`) instead of the text log, whose tool lines and replies are one stream.
  // Streaming off: each reply arrives once, as a whole `assistant.message`.
  commandFor({ command, fullPrompt, model, resume, permissionMode, cwd }) {
    const args = ['-p', fullPrompt, '--output-format', 'json', '--stream', 'off'];
    if (model && model !== 'copilot') args.push('--model', model);
    if (resume) args.push('--resume', resume);
    if (permissionMode === 'fullAccess' || permissionMode === 'auto') args.push('--allow-all-tools');
    if (cwd) args.push('--add-dir', cwd);
    const skillDirs = [process.env.COPILOT_SKILLS_DIRS, skillsDir].filter(Boolean).join(',');
    return { command, args, input: '', env: { COPILOT_SKILLS_DIRS: skillDirs } };
  },

  normalizeEvent,
  usage,
  parseAcpModels,
  removeProbeSession,
};
