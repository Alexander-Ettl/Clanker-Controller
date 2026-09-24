'use strict';

const { EventEmitter } = require('node:events');
const { spawn, execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { locate, resolveShim } = require('./binary-locator.js');
const { modelOption } = require('./model-catalog.js');

// P17-D: how an older claude CLI / API rejects the Opus 5.5 model id or the
// --effort flag. Only checked before a turn has produced any output.
const MODEL_UNAVAILABLE = /unknown option '--(model|effort)'|not_found_error|invalid model|model[^"\n]{0,40}(not found|does not exist|not available)/i;
const OPUS_FALLBACK_ID = 'claude-sonnet-5-high';
// P17-I: upstream outages (Gemini's "Eligibility check failed ... UNAVAILABLE
// (code 503)"). Before any output the turn reruns after 2s, then 4s; after
// that it ends with one upstream_error card instead of raw error text.
const TRANSIENT_UPSTREAM = /Eligibility check failed|\bUNAVAILABLE\b|code["': ]*503\b|Service Unavailable|overloaded_error/;
const BACKOFF_MS = [2000, 4000];
// Nothing at all on stdout/stderr for this long means the CLI is stuck in
// its own upstream check; treated like a 503 rather than freezing the panel.
const FIRST_OUTPUT_TIMEOUT_MS = 30000;


/**
 * P17-R: how full the context window is after this event, or 0 when it says
 * nothing about that. Claude: each assistant message's API usage (prompt +
 * cache + output). agy: result usage, if any. Codex's turn.completed usage is
 * cumulative work across the turn and can exceed the context window many
 * times over, so ChatRun maintains an explicit context estimate instead.
 */
/** What a Claude tool call acts on, for its card: the command, a search's pattern and scope, a URL, a query. */
function toolTarget(input = {}) {
  const s = (x) => (typeof x === 'string' ? x : '');
  if (s(input.command)) return s(input.command);
  if (s(input.pattern)) return [`"${s(input.pattern)}"`, s(input.path) && `in ${s(input.path)}`, s(input.glob) && `(${s(input.glob)})`].filter(Boolean).join(' ');
  return s(input.url) || s(input.query) || s(input.skill) || s(input.description) || '';
}

function contextTokensOf(raw) {
  const n = (x) => (Number.isFinite(x) ? x : 0);
  const u = raw?.type === 'assistant' ? raw.message?.usage
    : raw?.step_update?.usage ? raw.step_update.usage
    : raw?.event === 'result' ? raw.result?.usage
    : null;
  if (!u) return 0;
  return n(u.total_tokens) || n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens);
}

/**
 * P17-V: token draw reported by this event. Claude repeats one API message's
 * usage on each of its content blocks, so those carry the message id for
 * de-duplication; a final turn-level usage (claude result, codex
 * turn.completed, agy result) replaces the running sum.
 */
function tokenCountsOf(raw) {
  const n = (x) => (Number.isFinite(x) ? x : 0);
  const inputOf = (u) => n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_creation_input_tokens) || n(u.prompt_tokens);
  const outputOf = (u) => n(u.output_tokens) || n(u.completion_tokens);
  if (raw?.type === 'assistant' && raw.message?.usage) return { id: raw.message.id || null, input: inputOf(raw.message.usage), output: outputOf(raw.message.usage) };
  const final = raw?.type === 'result' || raw?.type === 'turn.completed' ? raw.usage : raw?.event === 'result' ? raw.result?.usage : null;
  return final ? { final: true, input: inputOf(final), output: outputOf(final) } : null;
}

function stringAt(value, keys) {
  for (const key of keys) {
    if (typeof value?.[key] === 'string') return value[key];
  }
  return '';
}

// Edit cards show what changed: "-" removed, "+" added, " " unchanged context
// shared by both ends. Capped so a whole-file write can't bloat the saved chat.
const DIFF_LINES = 300;
function editDiff(input) {
  const text = (x) => (typeof x === 'string' && x ? x.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n') : []);
  // Claude MultiEdit: edits[]; Claude Edit/Write; agy replace_file_content/write_to_file.
  const pairs = Array.isArray(input?.edits)
    ? input.edits.map((e) => [e?.old_string, e?.new_string])
    : [[input?.old_string ?? input?.TargetContent, input?.new_string ?? input?.ReplacementContent ?? input?.content ?? input?.CodeContent]];
  const out = [];
  for (const [before, after] of pairs) {
    const a = text(before);
    const b = text(after);
    let head = 0;
    while (head < a.length && head < b.length && a[head] === b[head]) head++;
    let tail = 0;
    while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
    out.push(...a.slice(0, head).map((l) => ` ${l}`), ...a.slice(head, a.length - tail).map((l) => `-${l}`), ...b.slice(head, b.length - tail).map((l) => `+${l}`), ...a.slice(a.length - tail).map((l) => ` ${l}`));
  }
  return capDiff(out);
}
function capDiff(out) {
  if (!out.some((l) => l[0] !== ' ')) return '';
  return out.length > DIFF_LINES ? [...out.slice(0, DIFF_LINES), ` … ${out.length - DIFF_LINES} more lines`].join('\n') : out.join('\n');
}

// Codex only reports which files changed, so the lines come from git (or the
// new file itself), diffed against a snapshot of the working tree taken when
// the turn started or after Codex's previous edit, so your own unstaged work
// never shows as Codex's. `git stash create` writes an object but touches no
// file, ref or stash entry; it prints nothing for a clean tree (then HEAD).
const git = (args, cwd) => execFileSync('git', args, { cwd, encoding: 'utf8', timeout: 3000, windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
function gitSnapshot(cwd) {
  try { return git(['stash', 'create'], cwd).trim() || git(['rev-parse', 'HEAD'], cwd).trim(); } catch { return ''; }
}
function codexDiff(changes, cwd, base = '') {
  const out = [];
  for (const change of changes) {
    const file = path.resolve(cwd, typeof change?.path === 'string' ? change.path : '');
    if (changes.length > 1) out.push(` ── ${path.basename(file)}`);
    try {
      if (change.kind === 'add') out.push(...editDiff({ content: fs.readFileSync(file, 'utf8') }).split('\n'));
      else if (change.kind !== 'delete') out.push(...git(['diff', '-U1', '--no-color', ...(base ? [base] : []), '--', file], cwd).split('\n').filter((l) => /^[-+ ]/.test(l) && !/^(---|\+\+\+) /.test(l)));
    } catch {
      // Not a git repo, or the file is gone: the card still names it.
    }
  }
  return capDiff(out.filter(Boolean));
}

/**
 * The three CLIs' real stream-json shapes (verified against claude 2.1,
 * codex exec --json, agy --output-format stream-json). Returns undefined
 * for a shape it doesn't know, so the generic mapping below still applies;
 * null means "known event, nothing to show".
 */
function vendorEvent(raw, agent) {
  const at = (x) => (typeof x === 'string' ? x : '');
  // Claude interactive mode (--permission-prompt-tool stdio): the CLI stops
  // and waits for a control_response. AskUserQuestion arrives the same way.
  if (raw?.type === 'control_request' && raw.request?.subtype === 'can_use_tool') {
    const r = raw.request;
    if (r.tool_name === 'AskUserQuestion') {
      return { type: 'question_required', actionId: String(raw.request_id), questions: Array.isArray(r.input?.questions) ? r.input.questions : [], input: r.input, agent };
    }
    const input = r.input || {};
    return {
      type: 'approval_required',
      actionId: String(raw.request_id),
      tool: at(r.display_name) || at(r.tool_name) || 'tool',
      description: at(r.description) || at(input.description) || `${at(r.tool_name) || 'The agent'} wants to run`,
      command: at(input.command),
      file: at(input.file_path) || at(input.notebook_path) || at(input.path),
      preview: at(input.content).slice(0, 600) || at(input.new_string).slice(0, 600),
      canAlwaysAllow: Array.isArray(r.permission_suggestions) && r.permission_suggestions.length > 0,
      input,
      suggestions: r.permission_suggestions || [],
      agent,
    };
  }
  // Claude: {type:"assistant", message:{content:[{type:"text"|"tool_use"}]}}, {type:"result"}
  if (raw?.type === 'assistant' && Array.isArray(raw.message?.content)) {
    const text = raw.message.content.filter((b) => b?.type === 'text').map((b) => at(b.text)).join('');
    const tool = raw.message.content.find((b) => b?.type === 'tool_use');
    // The question itself is rendered from its control_request, not as a tool card.
    if (tool && tool.name !== 'AskUserQuestion') return { type: 'tool_start', toolId: at(tool.id), name: at(tool.name) || 'tool', command: toolTarget(tool.input), file: at(tool.input?.file_path), diff: editDiff(tool.input), agent };
    if (text) return { type: 'delta', text, block: true, model: agent, agent };
    // P17-T: extended-thinking blocks stream as their own assistant messages.
    const thought = raw.message.content.filter((b) => b?.type === 'thinking').map((b) => at(b.thinking)).join('');
    return thought ? { type: 'thought', text: thought, agent } : null;
  }
  if (raw?.type === 'user' && Array.isArray(raw.message?.content)) {
    const result = raw.message.content.find((b) => b?.type === 'tool_result');
    if (!result) return null;
    const output = Array.isArray(result.content) ? result.content.map((c) => at(c?.text)).join('') : at(result.content);
    return { type: 'tool_end', toolId: at(result.tool_use_id), output, error: result.is_error === true, diff: '', agent };
  }
  if (raw?.type === 'control_cancel_request') return { type: 'approval_cancelled', actionId: String(raw.request_id), agent };
  if (raw?.type === 'result' && 'session_id' in raw) return { type: 'turn_complete', agent };
  // Session ids, so the agent's next turn in this chat resumes the same session.
  // Claude compacts on its own when the window runs full; say so in the transcript.
  if (raw?.type === 'system' && raw.subtype === 'compact_boundary') return { type: 'notice', text: 'Claude compacted the context automatically.', agent };
  if (raw?.type === 'system') return raw.subtype === 'init' && raw.session_id ? { type: 'session', sessionId: at(raw.session_id), agent } : null;
  if (raw?.type === 'rate_limit_event') return null;
  // Codex: thread.started / turn.started / item.started|completed / turn.completed
  if (typeof raw?.type === 'string' && /^(thread|turn|item)\./.test(raw.type)) {
    const item = raw.item || {};
    if (raw.type === 'thread.started') return raw.thread_id ? { type: 'session', sessionId: at(raw.thread_id), agent } : null;
    if (raw.type === 'turn.completed') return { type: 'turn_complete', agent };
    if (raw.type === 'turn.failed') return { type: 'delta', text: `Codex error: ${at(raw.error?.message) || 'turn failed'}`, model: agent, agent };
    if (item.type === 'reasoning' && raw.type === 'item.completed') return at(item.text) ? { type: 'thought', text: at(item.text), agent } : null; // P17-T
    if (item.type === 'agent_message' && raw.type === 'item.completed') return at(item.text) ? { type: 'delta', text: at(item.text), block: true, model: agent, agent } : null;
    if (item.type === 'command_execution') {
      // Codex wraps commands as "<powershell.exe>" -Command '<cmd>'; show the command.
      const command = at(item.command).replace(/^"[^"]*powershell\.exe"\s+-Command\s+'([\s\S]*)'$/i, '$1');
      return raw.type === 'item.started'
        ? { type: 'tool_start', toolId: at(item.id), name: 'bash', command, file: '', agent }
        : { type: 'tool_end', toolId: at(item.id), output: at(item.aggregated_output), error: typeof item.exit_code === 'number' && item.exit_code !== 0, diff: '', agent };
    }
    if (item.type === 'file_change' && raw.type === 'item.completed') {
      const files = (item.changes || []).map((c) => `${c?.kind === 'add' ? 'added' : c?.kind === 'delete' ? 'deleted' : 'edited'} ${at(c?.path).split(/[\\/]/).pop()}`).filter(Boolean).join(', ');
      return { type: 'tool_start', toolId: at(item.id), name: 'edit', command: files, file: files, done: true, changes: item.changes || [], agent };
    }
    if (item.type === 'error') return { type: 'delta', text: `Codex error: ${at(item.message)}`, model: agent, agent };
    return null;
  }
  // agy (Gemini): {event:"init"|"step_update"|"result"}
  if (raw?.event === 'init') return raw.conversation_id ? { type: 'session', sessionId: at(raw.conversation_id), agent } : null;
  if (raw?.event === 'step_update') {
    const step = raw.step_update || {};
    if (step.step_type === 'tool') {
      const params = step.tool_info?.parameters || {};
      const toolId = `step-${step.step_index}`;
      const command = at(params.CommandLine) || at(params.TargetFile) || at(params.AbsolutePath) || at(params.Query) || at(params.Url);
      // view_file/list_dir keep their own names (read cards); only writes are edits.
      const name = step.tool_name === 'run_command' ? 'bash' : /^(write_to_file|(multi_)?replace_file_content)$/.test(at(step.tool_name)) ? 'edit' : at(step.tool_name) || 'tool';
      if (step.state === 'ACTIVE') return { type: 'tool_start', toolId, name, command, file: at(params.TargetFile), diff: name === 'edit' ? editDiff(params) : '', agent };
      if (step.state === 'ERROR') return { type: 'tool_end', toolId, output: at(step.tool_info?.error?.message).split('\n')[0], error: true, diff: '', agent };
      return { type: 'tool_end', toolId, output: '', diff: '', agent };
    }
    // P17-T: thought deltas. Field names not yet seen in a captured agy stream; both spellings accepted.
    const thought = at(step.thought_delta) || at(step.thinking_delta);
    if (thought) return { type: 'thought', text: thought, agent };
    return step.text_delta ? { type: 'delta', text: at(step.text_delta), step: step.step_index, model: agent, agent } : null;
  }
  if (raw?.event === 'result') {
    const r = raw.result || {};
    if (r.status === 'ERROR') return { type: 'delta', text: `Gemini error: ${at(r.error)}`, model: agent, agent };
    // Headless agy can't prompt; anything it wasn't allowed to do is reported here.
    const denied = (r.denied_actions || []).map((d) => at(d.display_name) || at(d.action)).filter(Boolean);
    // A resumed conversation can answer only here, with no streamed text_delta steps.
    const response = at(r.response);
    return denied.length ? { type: 'notice', text: `Gemini wasn't allowed to: ${denied.join(', ')}. Headless mode can't ask, so these were skipped.`, agent, then: 'turn_complete', response } : { type: 'turn_complete', agent, response };
  }
  return undefined;
}

/** Accepts evolving CLI NDJSON without coupling the webview to vendor schemas. */
function normalizeEvent(raw, agent) {
  const vendor = vendorEvent(raw, agent);
  if (vendor !== undefined) return vendor;
  const type = String(raw?.type || raw?.event || raw?.kind || '').toLowerCase();
  const text = stringAt(raw, ['text', 'delta', 'content', 'message', 'output']);
  const tool = raw?.tool || raw?.tool_use || raw?.function || raw?.item;
  const name = stringAt(tool, ['name', 'tool_name']) || stringAt(raw, ['name', 'tool_name']);
  const command = stringAt(tool, ['command', 'input']) || stringAt(raw, ['command']);
  const file = stringAt(tool, ['file', 'path']) || stringAt(raw, ['file', 'path']);

  if (/approval|permission|confirm/.test(type) || raw?.requires_approval) {
    return { type: 'approval_required', actionId: String(raw.id || crypto.randomUUID()), description: text || command || 'Approve this agent action?', agent };
  }
  if (/tool.*(start|begin)|function.*call/.test(type) || (name && (command || file))) {
    return { type: 'tool_start', name: name || 'bash', command, file, agent };
  }
  if (/tool.*(end|result)|function.*result/.test(type)) {
    return { type: 'tool_end', output: text, diff: stringAt(raw, ['diff']), agent };
  }
  if (/complete|done|turn_end|result/.test(type) && !text) return { type: 'turn_complete', agent };
  if (text) return { type: 'delta', text, model: agent, agent };
  return null;
}

// How each CLI reports a resume id it doesn't have (all three seen on a bogus
// id): Claude and Codex fail; agy only warns and starts an empty conversation.
const RESUME_FAILED = /No conversation found with session ID|no rollout found for thread id|conversation "[^"]*" not found/i;

class StreamEngine extends EventEmitter {
  /**
   * `interactive`: a person is watching this engine's chat window, so Claude
   * runs with --permission-prompt-tool stdio and waits for the Allow/Deny and
   * question cards to be answered. The scheduler's unattended engine keeps
   * it off (auto mode, never blocks on a click).
   */
  constructor({ cwd, models = {}, interactive = false } = {}) {
    super();
    this.cwd = cwd || process.cwd();
    this.models = models;
    this.interactive = interactive;
    this.child = null;
    this.approvals = new Map(); // actionId -> { child, input, suggestions, kind }
    this.tokens = { input: 0, output: 0, lastId: null };
  }

  /** `choice` = { model, effort } from the composer picker; the configured default otherwise. */
  commandFor(agent, prompt, attachments = [], choice = {}) {
    const effort = choice.effort || null;
    const resume = choice.resume || null;
    const model = choice.model || this.models[agent] || { claude: 'claude', codex: 'gpt-5.6-terra', gemini: 'gemini-3.8-flash-high' }[agent];
    const pointers = attachments.map((file) => `Attachment available locally: ${file}`).join('\n');
    const fullPrompt = pointers ? `${prompt}\n\n${pointers}` : prompt;
    const command = locate(agent).path;
    // Flags verified against each CLI's own --help (claude 2.1, codex exec,
    // agy). The prompt always goes over stdin, which is then closed.
    if (agent === 'gemini') {
      // agy's stream-json input is {"event":"user","message":{"content":...}}.
      return { command, args: ['--input-format', 'stream-json', '--output-format', 'stream-json', '--model', model, '--dangerously-skip-permissions', ...(resume ? ['--conversation', resume] : [])], input: JSON.stringify({ event: 'user', message: { content: fullPrompt } }) + '\n' };
    }
    if (agent === 'claude') {
      // -p reads the prompt from stdin; stream-json output needs --verbose.
      // A bare "claude" model setting means "the account default".
      const modelArgs = [...(model && model !== 'claude' ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(resume ? ['--resume', resume] : [])];
      if (this.interactive) {
        // Stdin stays open for control_responses until the result event.
        return {
          command,
          // Auto mode: Claude's own classifier clears routine actions and only
          // the risky ones reach an approval card.
          args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', '--permission-prompt-tool', 'stdio', ...modelArgs],
          input: JSON.stringify({ type: 'user', message: { role: 'user', content: fullPrompt } }) + '\n',
          keepStdinOpen: true,
        };
      }
      return { command, args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'auto', ...modelArgs], input: fullPrompt + '\n' };
    }
    const effortArgs = effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
    // Composer slash actions are discovered from this installed CLI's own
    // `codex exec --help`, then run through its native JSONL subcommand.
    if (choice.codexCommand) {
      return {
        command,
        args: ['exec', choice.codexCommand, '--json', '--skip-git-repo-check', '-m', model, ...effortArgs, ...(fullPrompt ? ['-'] : [])],
        input: fullPrompt ? `${fullPrompt}\n` : '',
      };
    }
    // `exec resume` keeps the sandbox its session started with and takes no --sandbox.
    if (resume) return { command, args: ['exec', 'resume', resume, '--json', '--skip-git-repo-check', '-m', model, ...effortArgs, '-'], input: fullPrompt + '\n' };
    return { command, args: ['exec', '--json', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-m', model, ...effortArgs, '-'], input: fullPrompt + '\n' };
  }
  start({ agent, prompt, attachments = [], model, effort, resume = null, freshPrompt = null, codexCommand = null, attempt = 0 }) {
    this.cancel();
    this.turn = { agent, prompt, attachments, model, effort, resume, freshPrompt, codexCommand, attempt };
    this.tokens = { input: 0, output: 0, lastId: null }; // P17-V: this turn's token draw
    const spec = this.commandFor(agent, prompt, attachments, { model, effort, resume, codexCommand });
    // A session that no longer exists (cleared, or made on another machine)
    // reruns the turn once as a new session, with the chat's full handoff.
    this.resumeRetry = resume ? { agent, prompt: freshPrompt || prompt, attachments, model, effort } : null;
    // P17-D: a claude CLI that predates Opus 5.5 (or --effort) fails before
    // any output; that turn reruns once on the fallback model instead.
    this.fallback = agent === 'claude' && /opus/i.test(model || '') ? { agent, prompt, attachments, resume, freshPrompt } : null;
    this.sawOutput = false;
    // P16-I: a missing CLI becomes a structured event the chat view renders
    // as a setup card, instead of a raw `spawn ... ENOENT` string posing as
    // the model's reply.
    if (!spec.command) {
      const { checked } = locate(agent);
      queueMicrotask(() => {
        this.emit('event', { type: 'binary_missing', agent, checked });
        this.emit('event', { type: 'turn_complete', agent });
      });
      return null;
    }
    // .cmd shims run as `node cli.js` directly when possible (P17-O: no cmd.exe,
    // no console flash); anything else still needs a shell, path quoted for spaces.
    const isCmd = process.platform === 'win32' && /\.cmd$/i.test(spec.command);
    const shim = isCmd ? resolveShim(spec.command) : null;
    const useShell = isCmd && !shim;
    const child = spawn(shim ? shim.command : useShell ? `"${spec.command}"` : spec.command, shim ? [...shim.args, ...spec.args] : spec.args, {
      cwd: this.cwd,
      windowsHide: true,
      shell: useShell,
      env: { ...process.env, CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    this.blockCount = 0;
    this.lastTextKey = null;
    this.hadText = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    const watchdog = setTimeout(() => { if (this.child === child) this.failUpstream(agent, `No response from ${agent} after ${FIRST_OUTPUT_TIMEOUT_MS / 1000}s.`); }, FIRST_OUTPUT_TIMEOUT_MS);
    const consumeStdout = (chunk) => {
      clearTimeout(watchdog);
      if (this.child !== child) return;
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        if (this.child !== child) return;
        this.consumeLine(line, agent);
      }
    };
    const consumeStderr = (chunk) => {
      clearTimeout(watchdog);
      if (this.child !== child) return;
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop();
      for (const line of lines) {
        if (this.child !== child) return;
        this.consumeStderrLine(line, agent);
      }
    };
    child.stdout.on('data', consumeStdout);
    child.stderr.on('data', consumeStderr);
    child.on('error', (error) => this.emit('event', { type: 'delta', text: `Unable to start ${agent}: ${error.message}`, model: agent, agent }));
    child.on('close', () => {
      clearTimeout(watchdog);
      if (this.child !== child) return;
      if (stdoutBuffer.trim()) this.consumeLine(stdoutBuffer, agent);
      if (stderrBuffer.trim()) this.consumeStderrLine(stderrBuffer, agent);
      this.child = null;
      if (!child.turnCompleted) this.emit('event', { type: 'turn_complete', agent });
    });
    // End stdin: every CLI here treats it as the whole prompt and would
    // otherwise wait for more input forever.
    child.stdin.on('error', () => {});
    if (spec.keepStdinOpen) child.stdin.write(spec.input);
    else child.stdin.end(spec.input || '');
    return child;
  }

  relative(text) {
    const root = path.resolve(this.cwd) + path.sep;
    return text.split(root).join('').split(root.toLowerCase()).join('');
  }

  consumeStderrLine(line, agent) {
    if (!line.trim()) return;

    // 1. Startup recovery checks (only active before any output has streamed)
    if (!this.sawOutput) {
      if (this.resumeRetry && (RESUME_FAILED.test(line) || /"is_error":\s*true[\s\S]*"num_turns":\s*0\b/.test(line))) {
        const retry = this.resumeRetry;
        this.resumeRetry = null;
        this.start(retry);
        return;
      }
      if (TRANSIENT_UPSTREAM.test(line)) {
        this.failUpstream(agent, line);
        return;
      }
      if (this.fallback && MODEL_UNAVAILABLE.test(line)) {
        const { model, effort, label } = modelOption(OPUS_FALLBACK_ID);
        this.emit('event', { type: 'notice', text: `This claude CLI can't run Opus 5.5 yet, so this turn runs on ${label}. Update Claude Code to use Opus.`, agent });
        this.start({ ...this.fallback, model, effort });
        return;
      }
    }

    // 2. Isolate diagnostics: Stderr chatter NEVER emits a 'delta' event.
    // Route to diagnostic event for internal extension/terminal telemetry.
    this.emit('diagnostic', { agent, text: line, timestamp: new Date().toISOString() });
  }

  consumeLine(line, agent) {
    if (!line.trim()) return;
    if (this.resumeRetry && !this.sawOutput && (RESUME_FAILED.test(line) || /"is_error":\s*true[\s\S]*"num_turns":\s*0\b/.test(line))) {
      const retry = this.resumeRetry;
      this.resumeRetry = null;
      this.start(retry);
      return;
    }
    if (!this.sawOutput && TRANSIENT_UPSTREAM.test(line)) {
      this.failUpstream(agent, line);
      return;
    }
    if (this.fallback && !this.sawOutput && MODEL_UNAVAILABLE.test(line)) {
      const { model, effort, label } = modelOption(OPUS_FALLBACK_ID);
      this.emit('event', { type: 'notice', text: `This claude CLI can't run Opus 5.5 yet, so this turn runs on ${label}. Update Claude Code to use Opus.`, agent });
      this.start({ ...this.fallback, model, effort }); // no opus in `model`, so it never falls back twice
      return;
    }
    let event;
    // Non-JSON lines are the CLI's own stderr chatter: show them as text.
    // (No more guessing "approval" prompts from free text -- none of these
    // CLIs accept a typed y/n; real approvals arrive as control_requests.)
    let raw;
    try { raw = JSON.parse(line); } catch { raw = undefined; }
    if (agent === 'codex' && raw?.type === 'turn.started') this.codexBase = gitSnapshot(this.cwd);
    if (raw !== undefined) {
      const contextTokens = contextTokensOf(raw);
      if (contextTokens) this.emit('event', { type: 'usage', agent, contextTokens });
      const counts = tokenCountsOf(raw);
      if (counts && (counts.final || counts.id === null || counts.id !== this.tokens.lastId)) {
        this.tokens = counts.final
          ? { input: counts.input, output: counts.output, lastId: null }
          : { input: this.tokens.input + counts.input, output: this.tokens.output + counts.output, lastId: counts.id };
        const { input: inputTokens, output: outputTokens } = this.tokens;
        if (inputTokens + outputTokens) this.emit('event', { type: 'token_usage', agent, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
      }
    }
    try { event = raw === undefined ? { type: 'delta', text: line, model: agent, agent } : normalizeEvent(raw, agent); } catch { event = { type: 'delta', text: line, model: agent, agent }; }
    if (!event) return;
    if (event.type === 'delta' || event.type === 'tool_start' || event.type === 'thought') this.sawOutput = true;
    if (event.type === 'turn_complete' && 'response' in event) {
      // Final answer text only in the result event: show it, unless it already streamed.
      const response = String(event.response || '').trim();
      delete event.response;
      if (response && !this.hadText && !this.child?.turnCompleted) {
        this.hadText = true;
        this.sawOutput = true;
        this.emit('event', { type: 'delta', text: response, model: agent, agent });
      }
    }
    if (event.type === 'turn_complete') {
      if (this.child?.turnCompleted) return; // the CLI's own result event already ended the turn
      if (this.tokens.input + this.tokens.output) event.totalTokens = this.tokens.input + this.tokens.output;
      if (this.child) this.child.turnCompleted = true;
      this.approvals.clear();
      // Interactive Claude keeps stdin open for answers; the turn is over now.
      if (this.child?.stdin?.writable) this.child.stdin.end();
    }
    // Cards show workspace-relative paths, not the absolute ones the CLIs report.
    if (event.type === 'tool_start' || event.type === 'approval_required') {
      for (const key of ['file', 'command']) if (event[key]) event[key] = this.relative(event[key]);
    }
    if (event.type === 'approval_required' || event.type === 'question_required') {
      this.approvals.set(event.actionId, { child: this.child, input: event.input, suggestions: event.suggestions || [] });
      delete event.input;
      delete event.suggestions;
    }
    if (event.type === 'approval_cancelled') this.approvals.delete(event.actionId);
    // Whole-message text from separate blocks gets a paragraph break between them.
    if (event.type === 'delta') {
      const key = event.block ? `block-${++this.blockCount}` : event.step != null ? `step-${event.step}` : 'stream';
      if (this.lastTextKey && this.lastTextKey !== key && this.hadText) event.text = `\n\n${event.text}`;
      this.lastTextKey = key;
      this.hadText = true;
      delete event.block;
      delete event.step;
    }
    if (event.type === 'notice' && event.then === 'turn_complete') {
      delete event.then;
      this.emit('event', event);
      this.consumeLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: event.response || '' } }), agent);
      return;
    }
    if (event.changes) {
      event.diff = codexDiff(event.changes, this.cwd, this.codexBase);
      delete event.changes;
      // The next edit's card shows only what that edit changed.
      this.codexBase = gitSnapshot(this.cwd);
    }
    this.emit('event', event);
  }

  control(actionId, response) {
    const pending = this.approvals.get(actionId);
    this.approvals.delete(actionId);
    const child = pending?.child;
    if (!child || child.killed || !child.stdin.writable) return false;
    child.stdin.write(JSON.stringify({ type: 'control_response', response: { subtype: 'success', request_id: actionId, response } }) + '\n');
    return true;
  }

  /** Allow / deny a tool request. `always` also applies Claude's own suggested rule (e.g. "accept edits this session"). */
  respondToApproval(actionId, approved, { always = false } = {}) {
    const pending = this.approvals.get(actionId);
    if (!pending) return false;
    if (!approved) return this.control(actionId, { behavior: 'deny', message: 'The user declined this action in the chat window.' });
    return this.control(actionId, { behavior: 'allow', updatedInput: pending.input || {}, ...(always && pending.suggestions.length ? { updatedPermissions: pending.suggestions } : {}) });
  }

  /** Answers an AskUserQuestion: `answers` maps each question text to the chosen label(s). */
  respondToQuestion(actionId, answers) {
    const pending = this.approvals.get(actionId);
    if (!pending) return false;
    return this.control(actionId, { behavior: 'allow', updatedInput: { ...(pending.input || {}), answers: answers || {} } });
  }

  /** P17-I: kills the stuck attempt; reruns it after a backoff, or ends the turn with one clean card. */
  failUpstream(agent, detail) {
    const turn = this.turn;
    this.cancel();
    const attempt = turn?.attempt || 0;
    if (turn && attempt < BACKOFF_MS.length) {
      const wait = BACKOFF_MS[attempt];
      this.emit('event', { type: 'notice', text: `${agent} upstream is unavailable. Retrying in ${wait / 1000}s (${attempt + 1}/${BACKOFF_MS.length})…`, agent });
      this.retryTimer = setTimeout(() => { this.retryTimer = null; this.start({ ...turn, attempt: attempt + 1 }); }, wait);
      return;
    }
    this.emit('event', { type: 'upstream_error', agent, detail: String(detail).trim().slice(0, 400) });
    this.emit('event', { type: 'turn_complete', agent });
  }

  cancel() {
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.approvals.clear();
    killTree(this.child);
    this.child = null;
  }

  /** P17-F: the user's Stop / Steer Now. Ends the running turn now and says so, unlike a silent cancel(). */
  interrupt() {
    const child = this.child;
    if (!child && !this.retryTimer) return false;
    this.cancel();
    if (!child?.turnCompleted) this.emit('event', { type: 'turn_complete', interrupted: true });
    return true;
  }
}

/**
 * P17-F: child.kill() on Windows only ends the direct child. A .cmd shim runs
 * under cmd.exe (shell: true), so the real node/CLI process would live on as
 * an orphan; taskkill /T takes the whole tree. No stdin Ctrl+C first: over a
 * pipe \x03 is just a byte (Windows only raises CTRL_C_EVENT for a console),
 * and interactive Claude would read it as a malformed stream-json line.
 */
function killTree(child, execFileImpl = execFile) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32' && child.pid) {
    execFileImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => { if (error) child.kill(); });
  } else child.kill();
}

module.exports = { StreamEngine, normalizeEvent, killTree, contextTokensOf, toolTarget };
