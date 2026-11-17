'use strict';

const { EventEmitter } = require('node:events');
const { spawn, execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { locate, resolveShim, headlessEnv } = require('./binary-locator.js');
const { CodexAppServer } = require('./codex-app-server.js');
const { AVAILABLE_MODELS, defaultModel } = require('./model-catalog.js');
const { fromRateLimitEvent } = require('./claude-usage.js');
const { attachmentPrompt, codexAttachmentInput } = require('./attachments.js');
const { readQuestion } = require('./agy-question.js');
const { AgySubagents } = require('./agy-subagents.js');
const { isLimitNotice } = require('../media/limit-notice.js');
const providers = require('./providers');

// P17-D: how an older claude CLI / API rejects the Opus 5.5 model id or the
// --effort flag. Only checked before a turn has produced any output.
const MODEL_UNAVAILABLE = /unknown option '--(model|effort)'|not_found_error|invalid model|model[^"\n]{0,40}(not found|does not exist|not available)/i;
const opusFallback = () => AVAILABLE_MODELS.filter((entry) => entry.agent === 'claude' && /sonnet/i.test(entry.model))
  .sort((a, b) => b.model.localeCompare(a.model, 'en', { numeric: true }) || Number(b.effort === 'high') - Number(a.effort === 'high'))[0];
// P17-I: upstream outages (Gemini's "Eligibility check failed ... UNAVAILABLE
// (code 503)"). Before any output the turn reruns after 2s, then 4s; after
// that it ends with one upstream_error card instead of raw error text.
const TRANSIENT_UPSTREAM = /Eligibility check failed|\bUNAVAILABLE\b|code["': ]*503\b|Service Unavailable|overloaded_error/;
const BACKOFF_MS = [2000, 4000];
// agy out of quota ("RESOURCE_EXHAUSTED (code 429): Individual quota reached. ... Resets in 4h43m1s.") is not an outage. It becomes the
// reply's last line, as the other CLIs leave theirs (media/limit-notice.js), so the panel offers Continue and schedules it for the reset.
const AGY_LIMIT = /RESOURCE_EXHAUSTED[^\r\n]*|Individual quota reached[^\r\n]*/i;
const agyLimit = (text) => {
  const hit = AGY_LIMIT.exec(String(text || ''))?.[0].trim().slice(0, 300);
  return hit ? (/^RESOURCE_EXHAUSTED/i.test(hit) ? hit : `RESOURCE_EXHAUSTED: ${hit}`) : null;
};
const CODEX_TRANSIENT = /selected model is at capacity|workspace routing discovery failed/i;
const CODEX_CONTINUE = 'Continue the unfinished task in this thread after a temporary service failure. First inspect saved work and completed tool results. Preserve completed changes and continue only the remaining steps; do not repeat completed actions or restart the task.';

function transientCodexError(message, info) {
  const kind = typeof info === 'string' ? info : Object.keys(info || {})[0] || '';
  return CODEX_TRANSIENT.test(message) || /^(serveroverloaded|internalservererror)$/i.test(kind.replace(/_/g, ''));
}
// Nothing at all on stdout/stderr for this long means the CLI is stuck in
// its own upstream check; treated like a 503 rather than freezing the panel.
const FIRST_OUTPUT_TIMEOUT_MS = 30000;


/**
 * P17-R: how full the context window is after this event, or 0 when it says
 * nothing about that. Claude: each assistant message's API usage (prompt +
 * cache + output). agy: the latest step's usage (one model call: fresh input +
 * cache reads + output). Its final result usage is the sum over every call of
 * the turn, so it is not read here (see `contextGrowthOf`). Codex's turn.completed
 * usage is cumulative work across the turn and can exceed the context window many
 * times over, so ChatRun maintains an explicit context estimate instead.
 */
/** Claude's subagent-spawning tool: "Task" in older CLIs, "Agent" in newer ones. */
const SUBAGENT_TOOLS = new Set(['Agent', 'Task']);
/** Main-thread output that, after a kept-open process's turn ended, means Claude started a new one. */
const SELF_STARTED = new Set(['delta', 'tool_start', 'thought', 'approval_required', 'question_required']);
const SETTLED_TASK = new Set(['completed', 'failed', 'stopped', 'killed']);
const at = (x) => (typeof x === 'string' ? x : '');

/** What a Claude tool call acts on, for its card: the command, a search's pattern and scope, a URL, a query. */
function toolTarget(input = {}) {
  const s = (x) => (typeof x === 'string' ? x : '');
  if (s(input.command)) return s(input.command);
  if (s(input.pattern)) return [`"${s(input.pattern)}"`, s(input.path) && `in ${s(input.path)}`, s(input.glob) && `(${s(input.glob)})`].filter(Boolean).join(' ');
  return s(input.url) || s(input.query) || s(input.skill) || s(input.description) || '';
}

/** The first path-like parameter of an agy tool call, whatever this build calls it (path, file_path, DirectoryPath, paths: [...]). Content fields never match. */
function anyPathLike(params = {}) {
  for (const [key, value] of Object.entries(params || {})) {
    if (!/^(?:abs(?:olute)?_?)?(?:file_?)?(?:path|paths|name|dir|directory|uri)$|^(?:file|dir|directory|target)_?(?:path|paths|name)?s?$|path$/i.test(key)) continue;
    const text = typeof value === 'string' ? value : Array.isArray(value) && typeof value[0] === 'string' ? value.join(', ') : '';
    if (text) return text;
  }
  return '';
}

/** What a Gemini / Antigravity tool call acts on: command, file path, query, task action, etc. */
function geminiToolTarget(toolName, params = {}) {
  const at = (x) => (typeof x === 'string' ? x : '');
  const name = String(toolName || '').toLowerCase().replace(/[-_]/g, '');

  if (name === 'runcommand') return at(params.CommandLine);
  // view_file/list_dir/write_to_file (older agy) and read_file/write_file/edit_file (newer agy, other parameter names).
  if (/^(viewfile|listdir|readfile|viewcodeitem|writetofile|writefile|editfile|createfile)$/.test(name) || name.includes('replacefilecontent')) return at(params.AbsolutePath) || at(params.TargetFile) || anyPathLike(params);
  if (name === 'searchweb' || name === 'websearch') return at(params.query) || at(params.Query) || at(params.toolSummary) || at(params.toolAction);
  if (name === 'readurlcontent' || name === 'webfetch' || name === 'readbrowserpage' || name === 'browserpage') return at(params.Url) || at(params.url);
  if (name === 'managetask') {
    const parts = [at(params.Action), at(params.TaskId)].filter(Boolean);
    return parts.length ? parts.join(' ') : at(params.toolSummary) || at(params.toolAction);
  }
  if (name === 'sendmessage') {
    const parts = [at(params.Recipient), at(params.Message)].filter(Boolean);
    return parts.join(': ');
  }
  if (name === 'schedule') {
    const time = params.DurationSeconds ? `${params.DurationSeconds}s` : at(params.CronExpression);
    return [time, at(params.Prompt)].filter(Boolean).join(' ');
  }
  if (name === 'invokesubagent') {
    const subagents = Array.isArray(params.Subagents) ? params.Subagents.map((s) => at(s?.Role) || at(s?.TypeName)).filter(Boolean).join(', ') : '';
    return subagents || at(params.Role) || at(params.TypeName) || at(params.toolSummary) || at(params.toolAction); // newer agy builds take one subagent per call, flat
  }
  if (name === 'managesubagents') {
    const ids = Array.isArray(params.ConversationIds) ? params.ConversationIds.join(', ') : '';
    return [at(params.Action), ids].filter(Boolean).join(' ') || at(params.toolSummary) || at(params.toolAction);
  }
  if (name === 'definesubagent') return at(params.name) || at(params.description);
  if (name === 'generateimage') return [at(params.ImageName), at(params.Prompt)].filter(Boolean).join(': ');
  if (name === 'askquestion') {
    const qList = Array.isArray(params.questions) ? params.questions.map((q) => at(q?.question)).filter(Boolean).join('; ') : '';
    return qList || at(params.toolSummary) || at(params.toolAction);
  }
  return at(params.CommandLine) || at(params.TargetFile) || at(params.AbsolutePath) || at(params.query) || at(params.Query) || at(params.Url) || at(params.url) || anyPathLike(params) || at(params.toolSummary) || at(params.toolAction) || '';
}

function contextTokensOf(raw) {
  const n = (x) => (Number.isFinite(x) ? x : 0);
  const u = raw?.type === 'assistant' ? raw.message?.usage
    : raw?.step_update?.usage ? raw.step_update.usage
    : null;
  if (!u) return 0;
  // agy's input_tokens leaves out cache_read_tokens (its total_tokens adds them back); a resumed chat's history is nearly all cache reads.
  return n(u.total_tokens) || n(u.input_tokens) + n(u.cache_read_input_tokens) + n(u.cache_read_tokens) + n(u.cache_creation_input_tokens) + n(u.output_tokens);
}

/**
 * agy's result usage sums every model call of the turn, so only its new tokens
 * (fresh input + output, no cache reads) say how far the conversation grew.
 * Used when no step reported the context size this turn.
 */
function contextGrowthOf(raw) {
  const u = raw?.event === 'result' ? raw.result?.usage : null;
  const n = (x) => (Number.isFinite(x) ? x : 0);
  return u ? n(u.input_tokens) + n(u.output_tokens) : 0;
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
  // What each kind of token is billed as (api-cost.js): Claude reports fresh input apart from cache reads and writes;
  // Codex's input includes its cached part; Antigravity's input includes cache_read_tokens, and its thinking is billed as output.
  const detailOf = (u) => {
    if ('cache_read_input_tokens' in u || 'cache_creation_input_tokens' in u) {
      const write1h = n(u.cache_creation?.ephemeral_1h_input_tokens); // Claude Code writes its cache for an hour: twice the input rate
      return { fresh: n(u.input_tokens), cachedInput: n(u.cache_read_input_tokens), cacheWrite: n(u.cache_creation_input_tokens), ...(write1h ? { cacheWrite1h: write1h } : {}), output: outputOf(u) };
    }
    const cached = n(u.cached_input_tokens) || n(u.cache_read_tokens);
    return { fresh: Math.max(0, inputOf(u) - cached), cachedInput: cached, cacheWrite: 0, output: outputOf(u) + n(u.thinking_tokens) };
  };
  if (raw?.type === 'assistant' && raw.message?.usage) return { id: raw.message.id || null, input: inputOf(raw.message.usage), output: outputOf(raw.message.usage), detail: detailOf(raw.message.usage) };
  const final = raw?.type === 'result' || raw?.type === 'turn.completed' ? raw.usage : raw?.event === 'result' ? raw.result?.usage : null;
  return final ? { final: true, input: inputOf(final), output: outputOf(final), detail: detailOf(final) } : null;
}
const noTokens = () => ({ input: 0, output: 0, lastId: null, detail: { fresh: 0, cachedInput: 0, cacheWrite: 0, output: 0 } });
const addDetail = (a, b) => {
  const write1h = (a.cacheWrite1h || 0) + (b.cacheWrite1h || 0);
  return { fresh: a.fresh + b.fresh, cachedInput: a.cachedInput + b.cachedInput, cacheWrite: a.cacheWrite + b.cacheWrite, ...(write1h ? { cacheWrite1h: write1h } : {}), output: a.output + b.output };
};

/** agy's ask_question parameters in the shape the question card renders (Claude's AskUserQuestion): options as {label}, `multiSelect`. */
function agyQuestions(raw) {
  return (Array.isArray(raw) ? raw : []).map((q) => ({
    question: String(q?.question ?? ''),
    ...(q?.header ? { header: String(q.header) } : {}),
    multiSelect: Boolean(q?.is_multi_select ?? q?.multiSelect),
    options: (Array.isArray(q?.options) ? q.options : []).map((o) => typeof o === 'string' ? { label: o } : { label: String(o?.label ?? o?.text ?? ''), ...(o?.description ? { description: String(o.description) } : {}) }).filter((o) => o.label),
  })).filter((q) => q.question);
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
const gitRoot = (dir) => { try { return path.resolve(git(['rev-parse', '--show-toplevel'], dir).trim()); } catch { return ''; } };
const readText = (file) => { try { return fs.readFileSync(file, 'utf8'); } catch { return ''; } };
const diffBody = (text) => String(text).split('\n').filter((l) => /^[-+ ]/.test(l) && !/^(---|\+\+\+) /.test(l));
/**
 * One snapshot per repo: the workspace's own and each nested repo right below it
 * (astro-visual-editor/ has its own .git, and git run in the outer repo sees none of
 * its files). Keyed by repo root; a repo first met mid-turn diffs against its index.
 */
function repoSnapshots(cwd) {
  const bases = new Map();
  const add = (dir) => { const root = gitRoot(dir); if (root && !bases.has(root)) bases.set(root, gitSnapshot(root)); };
  add(cwd);
  try { for (const entry of fs.readdirSync(cwd, { withFileTypes: true })) if (entry.isDirectory() && fs.existsSync(path.join(cwd, entry.name, '.git'))) add(path.join(cwd, entry.name)); } catch { /* unreadable: the workspace repo alone */ }
  return bases;
}
/** `fileDiff(file)`: the engine's per-file diff against the turn's snapshot (StreamEngine#fileDiff). */
function codexDiff(changes, cwd, fileDiff) {
  const out = [];
  for (const change of changes) {
    const file = path.resolve(cwd, typeof change?.path === 'string' ? change.path : '');
    const kind = typeof change?.kind === 'string' ? change.kind : change?.kind?.type; // exec: "add"; app-server: { type: "add" }
    if (changes.length > 1) out.push(` ── ${path.basename(file)}`);
    // The app-server's own `diff` is used only when it really is a unified diff; otherwise the file tells.
    const own = typeof change?.diff === 'string' ? diffBody(change.diff) : [];
    if (own.some((l) => l[0] === '+' || l[0] === '-')) { out.push(...own); if (kind !== 'delete') fileDiff(file); } // fileDiff keeps the per-file baseline current
    else if (kind !== 'delete') out.push(...fileDiff(file).split('\n'));
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
  const custom = providers.get(agent)?.normalizeEvent?.(raw);
  if (custom !== undefined) return custom;
  const at = (x) => (typeof x === 'string' ? x : '');
  if (raw?.__appServer) {
    const params = raw.params || {};
    const method = raw.method;
    if (method === 'thread/started') return params.thread?.id ? { type: 'session', sessionId: at(params.thread.id), agent } : null;
    if (method === 'item/agentMessage/delta') return at(params.delta) ? { type: 'delta', text: at(params.delta), model: agent, agent } : null;
    if (method === 'item/reasoning/summaryTextDelta' || method === 'item/reasoning/textDelta') return at(params.delta) ? { type: 'thought', text: at(params.delta), agent } : null;
    if (method === 'turn/completed') return { type: 'turn_complete', agent, ...(params.turn?.id ? { codexTurnId: params.turn.id } : {}) };
    if (method === 'error') return { type: 'delta', text: `Codex error: ${at(params.error?.message) || at(params.message) || 'request failed'}`, block: true, model: agent, agent };
    if (method === 'item/started' || method === 'item/completed') {
      const item = params.item || {};
      if (item.type === 'agentMessage' || item.type === 'reasoning') return null; // their deltas already streamed
      if (item.type === 'exitedReviewMode' && at(item.review)) return { type: 'delta', text: at(item.review), block: true, fallback: true, model: agent, agent };
      const type = method === 'item/started' ? 'item.started' : 'item.completed';
      const normalized = {
        ...item,
        type: { commandExecution: 'command_execution', fileChange: 'file_change' }[item.type] || item.type,
        aggregated_output: item.aggregatedOutput,
        exit_code: item.exitCode,
      };
      return vendorEvent({ type, item: normalized }, agent);
    }
    if (method === 'item/tool/requestUserInput') {
      const request = raw.request || {};
      return { type: 'question_required', actionId: String(request.id), questions: params.questions || [], input: params, appServer: request, agent };
    }
    if (['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval'].includes(method)) {
      const request = raw.request || {};
      const command = at(params.command) || (Array.isArray(params.command) ? params.command.join(' ') : '');
      return {
        type: 'approval_required', actionId: String(request.id), tool: /fileChange|Patch/.test(method) ? 'edit' : method.includes('mcpServer') ? 'mcp' : 'bash',
        description: at(params.reason) || (method.includes('mcpServer') ? `${at(params.serverName) || 'An MCP server'} is requesting input` : command ? 'Codex wants to run this command' : 'Codex wants additional permissions'),
        command, file: at(params.grantRoot), preview: '', canAlwaysAllow: true, input: params, appServer: request, agent,
      };
    }
    return null;
  }
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
  // A prompt as Claude echoes it back (--replay-user-messages, live Remote Control sessions):
  // the panel's own, or one typed in the Claude app.
  if (raw?.type === 'user' && typeof raw.message?.content === 'string') return { type: 'user_message', text: raw.message.content, agent };
  if (raw?.type === 'user' && Array.isArray(raw.message?.content)) {
    const result = raw.message.content.find((b) => b?.type === 'tool_result');
    if (!result) {
      const text = raw.message.content.filter((b) => b?.type === 'text').map((b) => at(b.text)).join('');
      return text ? { type: 'user_message', text, agent } : null;
    }
    const output = Array.isArray(result.content) ? result.content.map((c) => at(c?.text)).join('') : at(result.content);
    return { type: 'tool_end', toolId: at(result.tool_use_id), output, error: result.is_error === true, diff: '', agent };
  }
  if (raw?.type === 'control_cancel_request') return { type: 'approval_cancelled', actionId: String(raw.request_id), agent };
  // total_cost_usd is Claude Code's own figure for the turn (API-equivalent: a subscription isn't billed by it).
  if (raw?.type === 'result' && 'session_id' in raw) return { type: 'turn_complete', agent, ...(raw.total_cost_usd > 0 ? { costUsd: raw.total_cost_usd } : {}) };
  // Session ids, so the agent's next turn in this chat resumes the same session.
  // Claude compacts on its own when the window runs full; say so in the transcript.
  if (raw?.type === 'system' && raw.subtype === 'compact_boundary') return { type: 'notice', text: 'Claude compacted the context automatically.', agent };
  // Remote Control bridge: ready / connected / disconnected / failed.
  if (raw?.type === 'system' && raw.subtype === 'bridge_state') return { type: 'remote_state', state: at(raw.state), agent };
  // init also names every slash command this session supports: the "/" menu's live source for Claude.
  if (raw?.type === 'system') return raw.subtype === 'init' && raw.session_id ? { type: 'session', sessionId: at(raw.session_id), agent, ...(Array.isArray(raw.slash_commands) ? { slashCommands: raw.slash_commands } : {}) } : null;
  // Claude's live plan usage, sent with every turn: the usage gauges' most exact source.
  if (raw?.type === 'rate_limit_event') { const windows = fromRateLimitEvent(raw); return windows ? { type: 'rate_limits', agent, windows } : null; }
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
        : { type: 'tool_end', toolId: at(item.id), output: at(item.aggregated_output), error: typeof item.exit_code === 'number' && item.exit_code !== 0, ...(Number.isInteger(item.exit_code) ? { exitCode: item.exit_code } : {}), diff: '', agent };
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
      // Headless agy can't wait for an answer: it resolves ask_question itself with "User Skipped" and keeps going.
      // So the questions become a card, and the engine ends the turn there (see consumeLine); the answer is the next turn.
      if (at(step.tool_name) === 'ask_question') {
        if (step.state !== 'ACTIVE') return null;
        const questions = agyQuestions(params.questions);
        if (!questions.length) return null;
        return { type: 'question_required', actionId: step.conversation_id ? `agy-${step.conversation_id}-${step.step_index}` : toolId, deferred: true, questions, agent };
      }
      const command = geminiToolTarget(step.tool_name, params);
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
    // A resumed conversation can answer only here, with no streamed text_delta steps.
    const response = at(r.response);
    const error = at(r.error);
    const limit = r.status === 'ERROR' ? agyLimit(error) : null;
    if (r.status === 'ERROR' && !response) return { type: 'delta', text: `Gemini error: ${limit || error || 'turn failed'}`, model: agent, agent };
    // Headless agy can't prompt; anything it wasn't allowed to do is reported here.
    const denied = (r.denied_actions || []).map((d) => at(d.display_name) || at(d.action)).filter(Boolean);
    return denied.length ? { type: 'notice', text: `Gemini wasn't allowed to: ${denied.join(', ')}. Headless mode can't ask, so these were skipped.`, agent, then: 'turn_complete', response } : { type: 'turn_complete', agent, response, ...(limit ? { limit, ...(r.status === 'ERROR' ? { limitError: true } : {}) } : {}) };
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

function codexResultText(label, result) {
  if (result == null || (typeof result === 'object' && !Object.keys(result).length)) return `${label} completed.`;
  if (typeof result === 'string') return result;
  const json = JSON.stringify(result, (key, value) => /^(access|refresh|id)?_?token$|secret|password|api.?key|authorization/i.test(key) ? '[redacted]' : value, 2);
  return `${label}\n\n\`\`\`json\n${json}\n\`\`\``;
}

function reviewTarget(prompt) {
  return String(prompt || '').trim()
    ? { type: 'custom', instructions: String(prompt).trim() }
    : { type: 'uncommittedChanges' };
}

class StreamEngine extends EventEmitter {
  /**
   * `interactive`: a person is watching this engine's chat window, so Claude
   * runs with --permission-prompt-tool stdio and waits for the Allow/Deny and
   * question cards to be answered. The scheduler's unattended engine keeps
   * it off (auto mode, never blocks on a click).
   */
  constructor({ cwd, chatId = null, models = {}, interactive = false, permissionMode = null, codexServerFactory = (options) => new CodexAppServer(options), agyQuestionReader = readQuestion } = {}) {
    super();
    this.agyLimit = null; // the quota failure this process reported on stderr
    this.limitShown = false; // ... and whether the reply already says so
    this.cwd = cwd || process.cwd();
    this.bridgeAgents = new (require('./bridge-agents').BridgeAgents)(chatId, event => this.emit('event', event));
    this.chatEnv = chatId ? { CLANKER_CHAT_ID: chatId } : {};
    this.bridgeTimer = setInterval(() => this.bridgeAgents.poll(this.cwd), 2000);
    this.bridgeTimer.unref();
    this.models = models;
    this.interactive = interactive;
    this.permissionMode = permissionMode; // 'ask' | 'auto' | 'fullAccess' | null
    this.child = null;
    this.live = null; // the Remote Control process, while one is on
    this.pendingControls = new Map(); // our control_request ids -> { resolve, reject }
    this.expectEcho = null; // the last panel message sent to the live process, until Claude echoes it
    this.approvals = new Map(); // actionId -> { child, input, suggestions, kind }
    this.agyEdits = new Map(); // toolId -> { event, file, before }: a Gemini edit waiting for its diff
    this.agyQuestionReader = agyQuestionReader;
    this.codexBases = new Map(); // repo root -> snapshot, for Codex's per-edit diffs
    this.turnBases = null; // repo root -> snapshot as the turn began, and when (ms): what Undo turn restores
    this.tokens = noTokens();
    this.subagentIds = new Set(); // Agent/Task tool_use ids still running (background ones outlive their call)
    this.backgroundCommands = new Map(); // tool_use id -> CLI task id (Bash/Monitor jobs also resume the conversation)
    this.agySubagentIds = new Set(); // viewer ids of the agy subagents already launched in this engine
    this.agySubagents = new AgySubagents({ emit: (event) => this.emit('event', { ...event, agent: 'gemini' }), describe: (name, params) => geminiToolTarget(name, params) });
    this.codexServerFactory = codexServerFactory;
    this.codexServer = null;
    this.codexThreadId = null;
    this.codexTurnId = null;
    this.codexActive = false;
    this.codexGeneration = 0;
    this.codexAcceptEvents = false;
    this.codexInterrupting = null;
    this.codexRetiredTurns = new Set();
  }

  effectivePermissionMode(agent, override = null) {
    const mode = override || this.permissionMode;
    if (mode) return mode;
    if (agent === 'claude') return 'auto';
    return 'fullAccess';
  }

  /** `choice` = { model, effort } from the composer picker; the configured default otherwise. */
  commandFor(agent, prompt, attachments = [], choice = {}) {
    const effort = choice.effort || null;
    const resume = choice.resume || null;
    const model = choice.model || this.models[agent] || defaultModel(agent)?.model;
    const fullPrompt = attachmentPrompt(prompt, attachments);
    const command = locate(agent).path;
    const provider = providers.get(agent);
    if (typeof provider?.commandFor === 'function') {
      const permissionMode = this.effectivePermissionMode(agent, choice.permissionMode);
      return provider.commandFor({
        command,
        prompt,
        fullPrompt,
        attachments,
        model,
        effort,
        resume,
        permissionMode,
        cwd: this.cwd,
        interactive: this.interactive,
        choice,
      });
    }
    // Flags verified against each CLI's own --help (claude 2.1, codex exec,
    // agy). The prompt always goes over stdin, which is then closed.
    if (agent === 'gemini') {
      const permMode = this.effectivePermissionMode('gemini', choice.permissionMode);
      const permArgs = permMode === 'fullAccess' ? ['--dangerously-skip-permissions'] : [];
      // agy's stream-json input is {"event":"user","message":{"content":...}}.
      // --add-dir: without it agy runs its shell and resolves relative paths in its own scratch
      // folder (~/.gemini/antigravity-cli/scratch), not the project, even though init reports the cwd.
      return { command, args: ['--input-format', 'stream-json', '--output-format', 'stream-json', ...(model ? ['--model', model] : []), ...permArgs, '--add-dir', this.cwd, ...(resume ? ['--conversation', resume] : [])], input: JSON.stringify({ event: 'user', message: { content: fullPrompt } }) + '\n' };
    }
    if (agent === 'claude') {
      // -p reads the prompt from stdin; stream-json output needs --verbose.
      // A bare "claude" model setting means "the account default".
      const permMode = this.effectivePermissionMode('claude', choice.permissionMode);
      // --name is what `claude --resume` shows for the session; without it a headless session is listed by its first prompt.
      const name = String(this.sessionName || '').replace(/[\r\n"%^&|<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);
      const modelArgs = [...(model && model !== 'claude' ? ['--model', model] : []), ...(effort ? ['--effort', effort] : []), ...(resume ? ['--resume', resume] : []), ...(name ? ['--name', name] : [])];
      if (permMode === 'fullAccess') {
        if (this.interactive) {
          return {
            command,
            args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...modelArgs],
            input: JSON.stringify({ type: 'user', message: { role: 'user', content: fullPrompt } }) + '\n',
            keepStdinOpen: false,
          };
        }
        return { command, args: ['-p', '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions', ...modelArgs], input: fullPrompt + '\n' };
      }
      const permFlag = permMode === 'ask' ? 'manual' : 'auto';
      if (this.interactive) {
        // Stdin stays open for control_responses until the result event.
        return {
          command,
          args: ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-mode', permFlag, '--permission-prompt-tool', 'stdio', ...modelArgs],
          input: JSON.stringify({ type: 'user', message: { role: 'user', content: fullPrompt } }) + '\n',
          keepStdinOpen: true,
        };
      }
      return { command, args: ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', permFlag, ...modelArgs], input: fullPrompt + '\n' };
    }
    const effortArgs = effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
    const modelArgs = model ? ['-m', model] : [];
    // Composer slash actions are discovered from this installed CLI's own
    // `codex exec --help`, then run through its native JSONL subcommand.
    if (choice.codexCommand) {
      return {
        command,
        args: ['exec', choice.codexCommand, ...(choice.codexCommandArgs || []), '--json', '--skip-git-repo-check', ...modelArgs, ...effortArgs, ...(fullPrompt ? ['-'] : [])],
        input: fullPrompt ? `${fullPrompt}\n` : '',
      };
    }
    const permMode = this.effectivePermissionMode('codex', choice.permissionMode);
    const sandboxArgs = permMode === 'fullAccess' ? ['--sandbox', 'danger-full-access'] : ['--sandbox', 'workspace-write'];
    const autoArgs = permMode === 'auto' ? ['--approve-for-me'] : [];
    const approvalArgs = ['-c', `approval_policy="${permMode === 'fullAccess' ? 'never' : 'on-request'}"`, '-c', `approvals_reviewer="${permMode === 'auto' ? 'auto_review' : 'user'}"`];
    // `exec resume` takes config overrides but has no --sandbox or --approve-for-me flags.
    if (resume) return { command, args: ['exec', 'resume', resume, '--json', '-c', `sandbox_mode="${permMode === 'fullAccess' ? 'danger-full-access' : 'workspace-write'}"`, ...approvalArgs, '--skip-git-repo-check', ...modelArgs, ...effortArgs, '-'], input: fullPrompt + '\n' };
    return { command, args: ['exec', '--json', ...sandboxArgs, ...autoArgs, ...approvalArgs, '--skip-git-repo-check', ...modelArgs, ...effortArgs, '-'], input: fullPrompt + '\n' };
  }

  getCodexServer() {
    if (this.codexServer) return this.codexServer;
    const server = this.codexServerFactory({ cwd: this.cwd, env: { ...process.env, ...this.chatEnv } });
    server.on('notification', (message) => this.handleCodexNotification(message));
    server.on('request', (message) => this.handleCodexRequest(message));
    server.on('diagnostic', (text) => this.emit('diagnostic', { agent: 'codex', text, timestamp: new Date().toISOString() }));
    server.on('close', (error) => {
      if (this.codexServer !== server) return;
      this.codexServer = null;
      this.codexThreadId = null;
      if (this.codexActive) this.finishCodexTurn(error?.message || 'Codex App Server closed unexpectedly');
    });
    this.codexServer = server;
    return server;
  }

  resetCodexTurn(turn) {
    const recovering = turn.attempt > 0 && this.turn?.agent === 'codex';
    this.turn = turn;
    if (!recovering) this.tokens = noTokens();
    this.blockCount = 0;
    if (!recovering) this.hadText = false;
    this.lastTextKey = this.hadText ? 'retry' : null;
    this.sawOutput = false;
    this.agyLimit = null;
    this.limitShown = false;
    this.codexTurnId = null;
    if (!recovering) this.codexTurnBase = null; // preserve the thread baseline across recovery attempts
    this.codexError = '';
    this.codexErrorInfo = null;
    if (!recovering) this.codexPeakPrompt = 0; // the largest prompt across all attempts decides pricing
    this.codexActive = true;
    this.codexAcceptEvents = !this.codexInterrupting;
    this.approvals.clear();
    this.codexBases = repoSnapshots(this.cwd);
  }

  async ensureCodexThread(server, { resume, model, permissionMode = null } = {}) {
    const permMode = this.effectivePermissionMode('codex', permissionMode);
    const sandbox = permMode === 'fullAccess' ? 'danger-full-access' : 'workspace-write';
    const approvalPolicy = permMode === 'fullAccess' ? 'never' : (this.interactive ? 'on-request' : 'never');
    const common = {
      cwd: this.cwd,
      model,
      sandbox,
      approvalPolicy,
      ...(permMode === 'auto' ? { approvalsReviewer: 'auto_review' } : (permMode === 'ask' ? { approvalsReviewer: 'user' } : {})),
    };
    if (resume && this.codexThreadId !== resume) {
      const result = await server.request('thread/resume', { threadId: resume, ...common });
      this.codexThreadId = result?.thread?.id || resume;
    } else if (!this.codexThreadId) {
      const result = await server.request('thread/start', common);
      this.codexThreadId = result?.thread?.id;
    }
    if (!this.codexThreadId) throw new Error('Codex App Server did not return a thread id');
    this.consumeLine(JSON.stringify({ type: 'thread.started', thread_id: this.codexThreadId }), 'codex');
    return this.codexThreadId;
  }

  startCodex({ prompt, attachments = [], model, effort, resume = null, freshPrompt = null, codexCommand = null, attempt = 0, permissionMode = null, compact = false, autoCompact = false, writerWaiting = false }) {
    this.cancel();
    const interrupting = this.codexInterrupting;
    const generation = ++this.codexGeneration;
    const turn = { agent: 'codex', prompt, attachments, model, effort, resume, freshPrompt, codexCommand, attempt, permissionMode, compact: Boolean(compact), autoCompact: Boolean(autoCompact), writerWaiting };
    this.resetCodexTurn(turn);
    const run = async () => {
      const server = this.getCodexServer();
      try {
        if (interrupting) await interrupting;
        if (generation !== this.codexGeneration || !this.codexActive) return;
        this.codexAcceptEvents = true;
        await server.connect();
        if (generation !== this.codexGeneration || !this.codexActive) return;
        try { await this.ensureCodexThread(server, { resume, model, permissionMode }); }
        catch (error) {
          if (!resume || !/missing session/i.test(error.message) && !RESUME_FAILED.test(error.message)) throw error;
          this.codexThreadId = null;
          await this.ensureCodexThread(server, { resume: null, model, permissionMode });
          if (freshPrompt) turn.prompt = freshPrompt;
        }
        if (generation !== this.codexGeneration || !this.codexActive) return;
        if (codexCommand) await this.runCodexCommand(server, codexCommand, turn.prompt, generation);
        else {
          const permMode = this.effectivePermissionMode('codex', permissionMode);
          const sandboxPolicy = permMode === 'fullAccess'
            ? { type: 'dangerFullAccess' }
            : { type: 'workspaceWrite', writableRoots: [this.cwd], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false };
          const approvalPolicy = permMode === 'fullAccess' ? 'never' : (this.interactive ? 'on-request' : 'never');
          const result = await server.request('turn/start', {
            threadId: this.codexThreadId,
            input: codexAttachmentInput(turn.prompt, attachments),
            cwd: this.cwd,
            model,
            ...(effort ? { effort } : {}),
            approvalPolicy,
            sandboxPolicy,
            ...(permMode === 'auto' ? { approvalsReviewer: 'auto_review' } : (permMode === 'ask' ? { approvalsReviewer: 'user' } : {})),
          });
          if (generation !== this.codexGeneration || !this.codexActive) {
            if (result?.turn?.id) this.codexRetiredTurns.add(result.turn.id);
            return;
          }
          this.codexTurnId = result?.turn?.id || this.codexTurnId;
          // Codex can fold new input into the interrupted native turn. An
          // accepted start makes that returned id current again.
          if (this.codexTurnId) this.codexRetiredTurns.delete(this.codexTurnId);
        }
      } catch (error) {
        if (generation !== this.codexGeneration || !this.codexActive) return;
        if (/already has an active writer/i.test(error.message) && !this.sawOutput && !this.codexTurnId) {
          // A different app can hold the writer lease even when its last answer is complete. No input was accepted here.
          this.codexActive = false;
          this.codexAcceptEvents = false;
          this.codexThreadId = null;
          if (!writerWaiting) this.emit('event', { type: 'notice', agent: 'codex', text: 'Waiting for another Codex app to release this chat. Close this conversation in ChatGPT, or quit ChatGPT if it stays locked. Your prompt is kept; Clanker retries automatically every 5 seconds. Stop cancels the waiting send.' });
          this.retryTimer = setTimeout(() => {
            this.retryTimer = null;
            if (generation === this.codexGeneration) this.startCodex({ ...turn, writerWaiting: true });
          }, 5000);
          return;
        }
        if (error?.code === 'CODEX_BINARY_MISSING') {
          const { checked } = locate('codex');
          this.emit('event', { type: 'binary_missing', agent: 'codex', checked });
          this.finishCodexTurn();
        } else this.finishCodexTurn(error.message);
      }
    };
    queueMicrotask(run);
    return null;
  }

  async runCodexCommand(server, name, prompt, generation) {
    const threadId = this.codexThreadId;
    if (name === 'review') {
      const result = await server.request('review/start', { threadId, target: reviewTarget(prompt), delivery: 'inline' });
      if (generation !== this.codexGeneration || !this.codexActive) {
        if (result?.turn?.id) this.codexRetiredTurns.add(result.turn.id);
        return;
      }
      this.codexTurnId = result?.turn?.id || this.codexTurnId;
      return;
    }
    if (name === 'compact') {
      await server.request('thread/compact/start', { threadId });
      return;
    }
    let label = `/${name}`;
    let result;
    if (name === 'goal') {
      const value = String(prompt || '').trim();
      if (/^(clear|none|off)$/i.test(value)) result = await server.request('thread/goal/clear', { threadId });
      else if (value) result = await server.request('thread/goal/set', { threadId, objective: value, status: 'active' });
      else result = await server.request('thread/goal/get', { threadId });
    } else if (name === 'status') {
      const [goal, usage, rateLimits] = await Promise.all([
        server.request('thread/goal/get', { threadId }),
        server.request('account/usage/read', null),
        server.request('account/rateLimits/read', null),
      ]);
      result = { threadId, goal: goal?.goal || null, usage, rateLimits };
    } else {
      const calls = {
        model: ['model/list', {}], skills: ['skills/list', { cwds: [this.cwd] }],
        mcp: ['mcpServerStatus/list', { threadId }], hooks: ['hooks/list', { cwds: [this.cwd] }],
        plugins: ['plugin/list', { cwds: [this.cwd] }], apps: ['app/list', { threadId }],
        permissions: ['permissionProfile/list', { cwd: this.cwd }], experimental: ['experimentalFeature/list', { threadId }],
        usage: ['account/usage/read', null],
      };
      const call = calls[name];
      if (!call) throw new Error(`Unsupported Codex command: /${name}`);
      result = await server.request(call[0], call[1]);
      if (name === 'usage') result = { usage: result, rateLimits: await server.request('account/rateLimits/read', null) };
    }
    if (generation !== this.codexGeneration || !this.codexActive) return;
    this.consumeLine(JSON.stringify({ __appServer: true, method: 'item/agentMessage/delta', params: { delta: codexResultText(label, result) } }), 'codex');
    this.finishCodexTurn();
  }

  retireCodexTurn(turnId) {
    if (!turnId) return;
    this.codexRetiredTurns.add(turnId);
    while (this.codexRetiredTurns.size > 64) this.codexRetiredTurns.delete(this.codexRetiredTurns.values().next().value);
  }

  handleCodexNotification(message) {
    const { method, params = {} } = message;
    const turnId = params.turnId || params.turn?.id || null;
    if (params.threadId && this.codexThreadId && params.threadId !== this.codexThreadId) return;
    if (turnId && (!this.codexAcceptEvents || this.codexRetiredTurns.has(turnId) || (this.codexTurnId && this.codexTurnId !== turnId))) return;
    if (method === 'thread/compacted' && this.codexActive && this.turn?.codexCommand === 'compact') {
      this.consumeLine(JSON.stringify({ __appServer: true, method: 'item/agentMessage/delta', params: { delta: 'Codex compacted this thread.' } }), 'codex');
      this.finishCodexTurn();
      return;
    }
    if (method === 'turn/started') {
      this.codexTurnId = params.turn?.id || this.codexTurnId;
      this.codexBases = repoSnapshots(this.cwd);
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage || {};
      const last = usage.last || {};
      const total = usage.total || {};
      if (usage.modelContextWindow && last.totalTokens) this.emit('event', { type: 'usage', agent: 'codex', contextTokens: last.totalTokens });
      if (total.totalTokens) {
        // `total` is the whole thread's, resumed history included. The turn began where the first update's total, less that
        // update's own request (`last`), stood; what has been drawn since is this turn's.
        const take = (u, k) => Number(u?.[k]) || 0;
        this.codexTurnBase ||= Object.fromEntries(['inputTokens', 'cachedInputTokens', 'cacheWriteInputTokens', 'outputTokens', 'totalTokens'].map((k) => [k, take(total, k) - take(last, k)]));
        const turn = Object.fromEntries(Object.keys(this.codexTurnBase).map((k) => [k, Math.max(0, take(total, k) - this.codexTurnBase[k])]));
        // OpenAI counts cached and cache-write tokens inside input; reasoning tokens are inside output.
        this.codexPeakPrompt = Math.max(this.codexPeakPrompt, take(last, 'inputTokens'));
        const detail = { fresh: Math.max(0, turn.inputTokens - turn.cachedInputTokens - turn.cacheWriteInputTokens), cachedInput: turn.cachedInputTokens, cacheWrite: turn.cacheWriteInputTokens, output: turn.outputTokens, peakPrompt: this.codexPeakPrompt };
        this.tokens = { input: turn.inputTokens, output: turn.outputTokens, lastId: null, detail };
        this.emit('event', { type: 'token_usage', agent: 'codex', inputTokens: turn.inputTokens, outputTokens: turn.outputTokens, totalTokens: turn.totalTokens });
      }
      return;
    }
    if (!this.codexActive && method !== 'thread/started') return;
    // Codex reports the failure both here and on turn/completed. Wait for
    // the terminal event; reconnect errors can also recover within the turn.
    if (method === 'error') {
      this.codexError = params.error?.message || params.message || 'request failed';
      this.codexErrorInfo = params.error?.codexErrorInfo || null;
      if (params.willRetry) this.emit('event', { type: 'notice', agent: 'codex', text: String(this.codexError) });
      return;
    }
    if (method === 'turn/completed' && params.turn?.status === 'failed') {
      const failure = params.turn?.error?.message || (typeof params.turn?.error === 'string' ? params.turn.error : '') || this.codexError || 'turn failed';
      this.finishCodexTurn(String(failure), params.turn?.error?.codexErrorInfo || this.codexErrorInfo);
      return;
    }
    if (method === 'turn/completed') {
      this.retireCodexTurn(turnId || this.codexTurnId);
      this.codexActive = false;
      this.codexAcceptEvents = false;
      this.codexTurnId = null;
    }
    this.consumeLine(JSON.stringify({ __appServer: true, method, params }), 'codex');
  }

  handleCodexRequest(request) {
    const supported = new Set(['item/commandExecution/requestApproval', 'item/fileChange/requestApproval', 'item/tool/requestUserInput', 'item/permissions/requestApproval', 'mcpServer/elicitation/request', 'execCommandApproval', 'applyPatchApproval']);
    if (!supported.has(request.method)) {
      try { this.codexServer?.reject(request.id, `The AI chat panel does not provide ${request.method}`); } catch { /* server already closed */ }
      return;
    }
    if (!this.codexActive) {
      try { this.codexServer?.reject(request.id, 'No Codex turn is active'); } catch { /* server already closed */ }
      return;
    }
    const turnId = request.params?.turnId || null;
    if ((request.params?.threadId && this.codexThreadId && request.params.threadId !== this.codexThreadId) || !this.codexAcceptEvents || (turnId && (this.codexRetiredTurns.has(turnId) || (this.codexTurnId && this.codexTurnId !== turnId)))) {
      try { this.codexServer?.reject(request.id, 'This Codex turn is no longer active'); } catch { /* server already closed */ }
      return;
    }
    this.consumeLine(JSON.stringify({ __appServer: true, method: request.method, params: request.params || {}, request: { id: request.id, method: request.method } }), 'codex');
  }

  finishCodexTurn(error = '', info = null) {
    if (!this.codexActive) return;
    if (error && !this.turn?.codexCommand && transientCodexError(error, info)) {
      this.retireCodexTurn(this.codexTurnId);
      // This attempt has ended: do not interrupt it again or accept late events.
      this.codexActive = false;
      this.codexAcceptEvents = false;
      this.codexTurnId = null;
      if (this.sawOutput && this.codexThreadId) {
        this.turn = { ...this.turn, prompt: CODEX_CONTINUE, attachments: [], resume: this.codexThreadId };
      }
      this.failUpstream('codex', error);
      return;
    }
    if (error) this.consumeLine(JSON.stringify({ __appServer: true, method: 'error', params: { message: error } }), 'codex');
    const completedTurnId = this.codexTurnId;
    this.retireCodexTurn(this.codexTurnId);
    this.codexActive = false;
    this.codexAcceptEvents = false;
    this.codexTurnId = null;
    this.consumeLine(JSON.stringify({ __appServer: true, method: 'turn/completed', params: { turn: { id: completedTurnId } } }), 'codex');
  }
  // ---------- Live mode: Claude Code Remote Control, headless ----------
  // Normally every turn is its own `claude -p` process. With Remote Control on, the chat
  // keeps ONE process (resumed from its session) that both this panel and the Claude app
  // drive: panel turns are written to its stdin, prompts from the phone come back through
  // --replay-user-messages, and approvals arrive as control_requests on either side.

  /** Starts (or reuses) the live process and asks it to open a Remote Control session. Resolves to { session_url, ... }. */
  async enableRemote({ name, model, effort, resume }) {
    if (!this.live) {
      this.cancel();
      this.start({ agent: 'claude', prompt: '', model, effort, resume, live: true });
      if (!this.live) throw new Error('the Claude Code CLI could not be started');
    }
    return this.sendControl({ subtype: 'remote_control', enabled: true, ...(name ? { name } : {}) });
  }

  /** Closes the Remote Control session and the live process; later turns spawn one process each again. */
  async disableRemote() {
    const child = this.live;
    if (!child) return;
    await this.sendControl({ subtype: 'remote_control', enabled: false }).catch(() => {});
    if (this.live !== child) return;
    this.live = null;
    if (!child.turnCompleted) return; // a turn is running: its result ends the process (turn_complete closes stdin)
    try { child.stdin.end(); } catch { /* gone */ }
    setTimeout(() => killTree(child), 3000).unref?.();
  }

  sendControl(request, child = this.live) {
    if (!child?.stdin?.writable) return Promise.reject(new Error('no live Claude process'));
    const id = `panel-${crypto.randomUUID()}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pendingControls.delete(id); reject(new Error(`${request.subtype}: no answer from Claude`)); }, 30000);
      this.pendingControls.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value); }, reject: (error) => { clearTimeout(timer); reject(error); } });
      child.stdin.write(JSON.stringify({ type: 'control_request', request_id: id, request }) + '\n');
    });
  }

  start({ agent, prompt, attachments = [], model, effort, resume = null, freshPrompt = null, codexCommand = null, codexCommandArgs = [], attempt = 0, live = false, permissionMode = null, compact = false, autoCompact = false, groqRouter = null }) {
    if (agent === 'groq') {
      this.cancel();
      const marker = {}; this.groqTurn = marker;
      this.turn = { agent, prompt, model };
      void (async () => {
        try {
          if (attachments.length || !groqRouter) throw new Error('Groq only supports text here');
          const text = await groqRouter.call('groq', { messages: [{role:'user', content:prompt}] });
          if(this.groqTurn === marker) this.emit('event',{type:'delta',text,agent});
        } catch { if(this.groqTurn === marker) this.emit('event',{type:'delta',text:'Groq and Cloudflare could not answer within the free budget or timeout. Choose an available CLI model or wait for the quota reset.',agent}); }
        finally { if(this.groqTurn === marker) { this.groqTurn=null;this.turn=null;this.emit('event',{type:'turn_complete',agent}); } }
      })();
      return;
    }
    // A live Remote Control process takes the turn as a message instead of a new process.
    if (agent === 'claude' && this.live && !live) return this.sendToLive({ agent, prompt, attachments, model, effort, permissionMode });
    // So does a process kept open for its background agents (on the model it started with):
    // a new process would kill them.
    if (agent === 'claude' && this.lingering && !live) return this.sendToLive({ agent, prompt, attachments, model, effort, permissionMode }, this.lingering);
    // Codex and agy don't send the edited text: their +/- come from each file against these snapshots.
    // The same snapshots, kept whole, are what "Undo turn" restores (lib/turn-undo.js).
    this.editCache = new Map();
    if (!attempt && !live) { this.turnStartedAt = Date.now(); this.turnBases = repoSnapshots(this.cwd); }
    if (agent !== 'claude' && !attempt) this.codexBases = new Map(this.turnBases || repoSnapshots(this.cwd));
    if (agent === 'codex') return this.startCodex({ prompt, attachments, model, effort, resume, freshPrompt, codexCommand, codexCommandArgs, attempt, permissionMode, compact, autoCompact });
    this.cancel();
    this.turn = live ? null : { agent, prompt, attachments, model, effort, resume, freshPrompt, codexCommand, codexCommandArgs, attempt, permissionMode, compact: Boolean(compact), autoCompact: Boolean(autoCompact) };
    this.tokens = noTokens(); // P17-V: this turn's token draw
    this.contextSeen = false; // set once a step reports the context size
    const spec = this.commandFor(agent, prompt, attachments, { model, effort, resume, codexCommand, codexCommandArgs, permissionMode });
    if (live && spec.command) spec.args.push('--replay-user-messages');
    // A session that no longer exists (cleared, or made on another machine)
    // reruns the turn once as a new session, with the chat's full handoff.
    this.resumeRetry = resume && !live ? { agent, prompt: freshPrompt || prompt, attachments, model, effort, permissionMode } : null;
    // P17-D: a claude CLI that predates Opus 5.5 (or --effort) fails before
    // any output; that turn reruns once on the fallback model instead.
    this.fallback = agent === 'claude' && !live && /opus/i.test(model || '') ? { agent, prompt, attachments, resume, freshPrompt, permissionMode } : null;
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
    // A shell would split the name at its spaces: only the prompt travels safely there (over stdin).
    if (useShell) { const at = spec.args.indexOf('--name'); if (at >= 0) spec.args.splice(at, 2); }
    const isCompacting = Boolean(compact || autoCompact);
    const child = spawn(shim ? shim.command : useShell ? `"${spec.command}"` : spec.command, shim ? [...shim.args, ...spec.args] : spec.args, {
      cwd: this.cwd,
      windowsHide: true,
      shell: useShell,
      env: {
        ...process.env,
        ...headlessEnv(spec.command),
        ...this.chatEnv,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        ...(isCompacting ? {
          NO_CHIME: '1',
          ANTIGRAVITY_NO_CHIME: '1',
          CLAUDE_NO_CHIME: '1',
          CODEX_NO_CHIME: '1',
          AI_CHAT_PANEL_COMPACT: '1',
        } : {}),
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.permissionMode = this.effectivePermissionMode(agent, permissionMode);
    if (live) { child.live = true; child.turnCompleted = true; this.live = child; } // idle until a message arrives
    this.blockCount = 0;
    this.lastTextKey = null;
    this.hadText = false;
    let stdoutBuffer = '';
    let stderrBuffer = '';
    let agyInput = Promise.resolve();
    let lastDiagnostic = '';
    const rememberDiagnostic = line => {
      if (line.trim() && !/^WARNING:/i.test(line.trim())) lastDiagnostic = line.trim().slice(-16384);
    };
    // A live process says nothing until it gets a message, so only per-turn processes have a first-output deadline.
    const watchdog = live ? null : setTimeout(() => { if (this.child === child) this.failUpstream(agent, `No response from ${agent} after ${FIRST_OUTPUT_TIMEOUT_MS / 1000}s.`); }, FIRST_OUTPUT_TIMEOUT_MS);
    // A live process keeps talking between our turns (phone prompts), so it's always heard.
    const current = () => this.child === child || this.live === child;
    const consumeStdout = (chunk) => {
      clearTimeout(watchdog);
      if (!current()) return;
      stdoutBuffer += chunk.toString();
      const lines = stdoutBuffer.split(/\r?\n/);
      stdoutBuffer = lines.pop();
      for (const line of lines) {
        if (!current()) return;
        if (agent === 'gemini') {
          // Await hidden question recovery before accepting any later text/result
          // from the same chunk. AGY can otherwise finish while the DB is read.
          agyInput = agyInput.then(() => current() && this.consumeAgyLine(line, child));
        } else this.consumeLine(line, agent);
      }
    };
    const consumeStderr = (chunk) => {
      clearTimeout(watchdog);
      if (!current()) return;
      stderrBuffer += chunk.toString();
      const lines = stderrBuffer.split(/\r?\n/);
      stderrBuffer = lines.pop();
      for (const line of lines) {
        if (!current()) return;
        rememberDiagnostic(line);
        this.consumeStderrLine(line, agent);
      }
    };
    child.stdout.on('data', consumeStdout);
    child.stderr.on('data', consumeStderr);
    child.on('error', (error) => { child.reportedError = true; this.emit('event', { type: 'delta', text: `Unable to start ${agent}: ${error.message}`, model: agent, agent }); });
    child.on('close', async (code) => {
      clearTimeout(watchdog);
      if (agent === 'gemini') {
        await agyInput;
        if (current() && stdoutBuffer.trim()) {
          await this.consumeAgyLine(stdoutBuffer, child);
          stdoutBuffer = '';
        }
      }
      if (this.live === child) {
        this.live = null;
        for (const pending of this.pendingControls.values()) pending.reject(new Error('Claude exited'));
        this.pendingControls.clear();
        this.emit('event', { type: 'remote_state', state: 'ended', agent });
      }
      if (this.lingering === child) this.lingering = null;
      if (this.child !== child) return;
      if (stdoutBuffer.trim()) this.consumeLine(stdoutBuffer, agent);
      if (stderrBuffer.trim()) { rememberDiagnostic(stderrBuffer); this.consumeStderrLine(stderrBuffer, agent); }
      // Subagents run inside this process: whatever it didn't report finished ended with it.
      for (const id of this.subagentIds) this.emit('event', { type: 'subagent_status', id, status: code ? 'failed' : 'ended', agent });
      this.subagentIds.clear();
      this.agySubagents.endAll(code ? 'failed' : 'ended');
      this.backgroundCommands.clear();
      if (code && !child.turnCompleted && !this.sawOutput && !child.reportedError) {
        const detail = lastDiagnostic;
        this.emit('event', { type: 'delta', text: detail || `${agent} exited with code ${code}.`, model: agent, agent });
      }
      this.child = null;
      if (!child.turnCompleted) this.emit('event', { type: 'turn_complete', agent });
    });
    // End stdin: every CLI here treats it as the whole prompt and would
    // otherwise wait for more input forever.
    child.stdin.on('error', () => {});
    if (live) return child; // the first message comes later, from either side
    if (spec.keepStdinOpen) child.stdin.write(spec.input);
    else child.stdin.end(spec.input || '');
    return child;
  }

  /** A panel turn into the live process: same message shape a fresh process would get. */
  sendToLive({ agent, prompt, attachments, model, effort, permissionMode }, child = this.live) {
    const spec = this.commandFor(agent, prompt, attachments, { model, effort, permissionMode });
    this.child = child;
    this.turn = { agent, prompt, attachments, model, effort, permissionMode, attempt: 0 };
    this.beginLiveTurn();
    try {
      // Only the Remote Control process replays user messages; its replay is ours, not the phone's.
      this.expectEcho = child === this.live ? JSON.parse(spec.input)?.message?.content ?? null : null;
    } catch {
      this.expectEcho = null;
    }
    const mode = this.effectivePermissionMode(agent, permissionMode);
    if (mode !== (child.permissionMode || this.effectivePermissionMode(agent))) {
      const turn = this.turn;
      this.sendControl({ subtype: 'set_permission_mode', mode: mode === 'fullAccess' ? 'bypassPermissions' : mode === 'auto' ? 'auto' : 'default' }, child).then(() => {
        if (this.child !== child || this.turn !== turn) return;
        child.permissionMode = mode;
        child.stdin.write(spec.input);
      }).catch((error) => {
        if (this.child !== child || this.turn !== turn) return;
        this.emit('event', { type: 'delta', text: `Unable to apply model permissions: ${error.message}`, agent });
        child.turnCompleted = true;
        this.emit('event', { type: 'turn_complete', agent });
      });
    } else child.stdin.write(spec.input);
    return child;
  }

  /** Per-turn state for a turn inside the live process (started here or from the phone). */
  beginLiveTurn() {
    this.tokens = noTokens();
    this.blockCount = 0;
    this.lastTextKey = null;
    this.hadText = false;
    this.sawOutput = false;
    this.agyLimit = null;
    this.limitShown = false;
    this.resumeRetry = null;
    this.fallback = null;
    if (this.child) this.child.turnCompleted = false; // the live or kept-open process this turn runs in
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
      if (this.fallback && MODEL_UNAVAILABLE.test(line) && opusFallback()) {
        const { model, effort, label } = opusFallback();
        this.emit('event', { type: 'notice', text: `This claude CLI can't run the selected Opus model, so this turn runs on ${label}. Update Claude Code to use Opus.`, agent });
        this.start({ ...this.fallback, model, effort });
        return;
      }
    }

    if (agent === 'gemini' && !this.agyLimit && /^(?:E\d{4}\s[^\r\n]*errorreport\.go:\d+\]|RESOURCE_EXHAUSTED\b|Individual quota reached\b)/.test(line.trim())) this.agyLimit = agyLimit(line);

    // 2. Isolate diagnostics: Stderr chatter NEVER emits a 'delta' event.
    // Route to diagnostic event for internal extension/terminal telemetry.
    this.emit('diagnostic', { agent, text: line, timestamp: new Date().toISOString() });
  }

  async consumeAgyLine(line, child) {
    let raw;
    try { raw = JSON.parse(line); } catch { /* ordinary diagnostics */ }
    if (raw?.event === 'init') child.agyConversationId = raw.conversation_id;
    const step = raw?.step_update;
    if (step?.step_type === 'unknown' && step.state === 'DONE') {
      let questions;
      let failure;
      for (let attempt = 0; attempt < 8 && this.child === child; attempt++) {
        try {
          questions = await this.agyQuestionReader(step.conversation_id || child.agyConversationId, step.step_index);
          if (questions !== undefined) { failure = null; break; }
        } catch (error) { failure = error; }
        // The trajectory write can lag behind the streamed step update.
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      if (this.child !== child) return;
      if (failure || questions === undefined) this.emit('event', { type: 'notice', agent: 'gemini', text: `Could not read AGY's hidden step: ${failure?.message || 'the local trajectory was not saved in time'}. A question may have been skipped by AGY.` });
      if (agyQuestions(questions).length) {
        this.consumeLine(JSON.stringify({ event: 'step_update', step_update: { ...step, step_type: 'tool', state: 'ACTIVE', tool_name: 'ask_question', tool_info: { parameters: { questions } } } }), 'gemini');
        return;
      }
    }
    if (this.child === child) this.consumeLine(line, 'gemini');
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
    if (this.fallback && !this.sawOutput && MODEL_UNAVAILABLE.test(line) && opusFallback()) {
      const { model, effort, label } = opusFallback();
      this.emit('event', { type: 'notice', text: `This claude CLI can't run the selected Opus model, so this turn runs on ${label}. Update Claude Code to use Opus.`, agent });
      this.start({ ...this.fallback, model, effort }); // no opus in `model`, so it never falls back twice
      return;
    }
    let event;
    // Non-JSON lines are the CLI's own stderr chatter: show them as text.
    // (No more guessing "approval" prompts from free text -- none of these
    // CLIs accept a typed y/n; real approvals arrive as control_requests.)
    let raw;
    try { raw = JSON.parse(line); } catch { raw = undefined; }
    // Answers to our own control requests (Remote Control on/off, interrupt).
    if (raw?.type === 'control_response' && this.pendingControls.has(raw.response?.request_id)) {
      const pending = this.pendingControls.get(raw.response.request_id);
      this.pendingControls.delete(raw.response.request_id);
      if (raw.response.subtype === 'success') pending.resolve(raw.response.response || {});
      else pending.reject(new Error(raw.response.error || 'Claude refused the request'));
      return;
    }
    if (agent === 'codex' && raw?.type === 'turn.started') this.codexBases = repoSnapshots(this.cwd);
    if (this.consumeSubagentLine(raw, agent)) return;
    if (raw !== undefined) {
      const contextTokens = contextTokensOf(raw);
      if (contextTokens) { this.contextSeen = true; this.emit('event', { type: 'usage', agent, contextTokens }); }
      else if (!this.contextSeen && contextGrowthOf(raw)) this.emit('event', { type: 'usage', agent, contextGrowth: contextGrowthOf(raw) });
      const counts = tokenCountsOf(raw);
      if (counts && (counts.final || counts.id === null || counts.id !== this.tokens.lastId)) {
        this.tokens = counts.final
          ? { input: counts.input, output: counts.output, lastId: null, detail: counts.detail }
          : { input: this.tokens.input + counts.input, output: this.tokens.output + counts.output, lastId: counts.id, detail: addDetail(this.tokens.detail, counts.detail) };
        const { input: inputTokens, output: outputTokens } = this.tokens;
        if (inputTokens + outputTokens) this.emit('event', { type: 'token_usage', agent, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
      }
    }
    try { event = raw === undefined ? { type: 'delta', text: line, model: agent, agent } : normalizeEvent(raw, agent); } catch { event = { type: 'delta', text: line, model: agent, agent }; }
    if (!event) return;
    if (event.fallback) {
      delete event.fallback;
      if (this.hadText) return;
    }
    if (event.type === 'user_message') {
      // Our own message echoed back, or a prompt typed in the Claude app (which starts a turn here).
      if (this.expectEcho !== null && event.text.trim() === this.expectEcho.trim()) { this.expectEcho = null; return; }
      if (!this.live) return;
      this.child = this.live;
      this.turn = { agent, prompt: event.text, attachments: [], attempt: 0 };
      this.beginLiveTurn();
      this.emit('event', { type: 'remote_prompt', text: event.text, agent });
      return;
    }
    // A kept-open process can start a turn by itself: Claude answers its background agents'
    // reports as they arrive. That output opens a turn of its own, like a prompt from the phone.
    if (agent === 'claude' && this.child?.turnCompleted && SELF_STARTED.has(event.type)) {
      this.turn = { agent, prompt: '', attachments: [], attempt: 0 };
      this.beginLiveTurn();
      // Nobody typed this: flagged so the chat shows a quiet divider, not a user bubble.
      this.emit('event', { type: 'remote_prompt', text: 'Background work continued', background: true, agent });
    }
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
    if (event.type === 'turn_complete' && agent === 'gemini' && !this.child?.turnCompleted) {
      // Shared log files can belong to another chat/model; only this process can report its quota failure.
      const limit = event.limit || this.agyLimit;
      if (limit && !this.limitShown) {
        this.emit('event', { type: 'delta', text: `${this.hadText ? '\n\n' : ''}Gemini error: ${limit}`, model: agent, agent });
        this.hadText = true;
        this.sawOutput = true;
        this.limitShown = true;
      }
    }
    delete event.limit;
    delete event.limitError;
    if (event.type === 'turn_complete' && event.error) {
      const errorText = event.error;
      delete event.error;
      // If the model produced output or an answer, an upstream error (e.g. recovered interruption in
      // a resumed session) is historical and ignored; if no text was produced at all, report the error.
      if (!this.hadText && !this.child?.turnCompleted) {
        this.hadText = true;
        this.sawOutput = true;
        this.emit('event', { type: 'delta', text: `Gemini error: ${errorText}`, model: agent, agent });
      }
    }
    if (event.type === 'turn_complete') {
      if (this.child?.turnCompleted) return; // the CLI's own result event already ended the turn
      // Claude's result can be a waiting update: background shell jobs will send their results and resume the model.
      // Keep the same reply, thinking state and stdin until that continuation actually finishes.
      if (agent === 'claude' && this.backgroundCommands.size && !raw?.is_error && !this.limitShown) return;
      if (agent === 'claude' && (raw?.is_error || this.limitShown)) this.backgroundCommands.clear();
      // Claude Code's cost figure is a running total for its process (one process lives across a chat's turns), so this
      // turn's share is the rise since the last one; a lower figure means a new process that started from zero.
      if (Number.isFinite(event.costUsd) && this.child) {
        const seen = this.child.costSeen || 0;
        this.child.costSeen = event.costUsd;
        event.costUsd = event.costUsd >= seen ? event.costUsd - seen : event.costUsd;
      }
      if (this.tokens.input + this.tokens.output) { event.totalTokens = this.tokens.input + this.tokens.output; event.usage = this.tokens.detail; } // priced by api-cost.js
      if (this.child) this.child.turnCompleted = true;
      this.approvals.clear();
      // Interactive Claude keeps stdin open for answers; the turn is over now.
      // The live Remote Control process stays open for the next message (unless it was just switched off).
      // So does one whose background agents are still working: they run inside it, and closing
      // stdin ends the process and kills them mid-task. It takes the next message instead.
      if (this.child?.stdin?.writable && this.child !== this.live) {
        if (agent === 'claude' && this.subagentIds.size) this.lingering = this.child;
        else if (this.child === this.lingering) this.releaseLingering();
        else this.child.stdin.end();
      }
    }
    // agy's edit steps carry only the target path, never the text, so the lines come from the
    // file itself: read when the edit starts, compared when it's done. The card is held until
    // then (edits take milliseconds) so it arrives with its diff and +/- counts.
    if (agent === 'gemini' && event.type === 'tool_start' && event.name === 'edit' && event.file) {
      this.agyEdits.set(event.toolId, { event, file: path.resolve(this.cwd, event.file) });
      return;
    }
    if (agent === 'gemini' && event.type === 'tool_end' && this.agyEdits.has(event.toolId)) {
      const { event: start, file } = this.agyEdits.get(event.toolId);
      this.agyEdits.delete(event.toolId);
      if (!event.error) start.diff = this.fileDiff(file);
      for (const key of ['file', 'command']) if (start[key]) start[key] = this.relative(start[key]);
      this.emit('event', start);
    }
    // Cards show workspace-relative paths, not the absolute ones the CLIs report.
    if (event.type === 'tool_start' || event.type === 'approval_required') {
      for (const key of ['file', 'command']) if (event[key]) event[key] = this.relative(event[key]);
    }
    if (event.type === 'question_required' && event.deferred) {
      if (!this.interactive) return; // Unattended AGY runs keep their native skip-and-continue behavior.
      const child = this.child;
      this.emit('event', event);
      // The reply would otherwise go on as if the user had skipped it. Closing the turn here makes the answer the next one.
      this.consumeLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } }), agent);
      if (child && this.child === child) { killTree(child); this.child = null; }
      return;
    }
    if (event.type === 'approval_required' || event.type === 'question_required') {
      this.approvals.set(event.actionId, { child: this.child, input: event.input, suggestions: event.suggestions || [], appServer: event.appServer || null, questions: event.questions || [] });
      delete event.input;
      delete event.suggestions;
      delete event.appServer;
    }
    if (event.type === 'approval_cancelled') this.approvals.delete(event.actionId);
    // Whole-message text from separate blocks gets a paragraph break between them.
    if (event.type === 'delta') {
      if (agent === 'claude' && isLimitNotice(event.text)) this.limitShown = true;
      if (agent === 'gemini' && /^Gemini error: RESOURCE_EXHAUSTED/i.test(event.text || '')) this.limitShown = true;
      if (this.hadText && /^Gemini error: The stream was interrupted/i.test(event.text || '')) return;
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
      event.diff = codexDiff(event.changes, this.cwd, (file) => this.fileDiff(file));
      delete event.changes;
    }
    this.emit('event', event);
  }

  /**
   * Claude's subagents (the Agent/Task tool) stream through the same stdout, each message tagged
   * with the parent_tool_use_id of the call that spawned it. They get their own events, so the
   * panel shows them in the agents viewer instead of mixing them into the main reply.
   * Returns true when the line belonged to a subagent and needs nothing else.
   */
  consumeSubagentLine(raw, agent) {
    if (!raw || typeof raw !== 'object') return false;
    if (agent === 'gemini' && raw.event === 'step_update' && raw.step_update?.tool_name === 'invoke_subagent') this.consumeAgySubagentStep(raw.step_update);
    const parentId = typeof raw.parent_tool_use_id === 'string' ? raw.parent_tool_use_id : null;
    if (parentId && (raw.type === 'assistant' || raw.type === 'user')) {
      let event = null;
      try { event = normalizeEvent(raw, agent); } catch { /* not a shape we render */ }
      if (event && event.type !== 'user_message') {
        if (event.type === 'tool_start') for (const key of ['file', 'command']) if (event[key]) event[key] = this.relative(event[key]);
        this.emit('event', { type: 'subagent_event', id: parentId, event, agent });
      } else if (event?.type === 'user_message') {
        // The task text the subagent was handed arrives as its first user message.
        this.emit('event', { type: 'subagent_event', id: parentId, event: { type: 'task', text: event.text }, agent });
      }
      return true;
    }
    const blocks = Array.isArray(raw.message?.content) ? raw.message.content : [];
    if (raw.type === 'assistant') {
      for (const block of blocks) {
        if (block?.type !== 'tool_use' || !SUBAGENT_TOOLS.has(block.name)) continue;
        const input = block.input || {};
        this.subagentIds.add(block.id);
        this.emit('event', {
          type: 'subagent_start', id: at(block.id), agent,
          description: at(input.description), subagentType: at(input.subagent_type) || 'general-purpose',
          prompt: at(input.prompt), background: input.run_in_background === true,
        });
      }
    }
    if (raw.type === 'user') {
      for (const block of blocks) {
        if (agent === 'claude' && block?.type === 'tool_result') {
          const output = Array.isArray(block.content) ? block.content.map((c) => at(c?.text)).join('') : at(block.content);
          const task = /Command running in background with ID:\s*([\w-]+)/i.exec(output);
          if (task) this.backgroundCommands.set(block.tool_use_id, task[1]);
        }
        if (block?.type !== 'tool_result' || !this.subagentIds.has(block.tool_use_id)) continue;
        const output = Array.isArray(block.content) ? block.content.map((c) => at(c?.text)).join('') : at(block.content);
        // A background agent's call returns at once with a launch note; it keeps working after that.
        const launched = /async agent launched|running in the background|agent is working in the background/i.test(output);
        if (!launched) this.subagentIds.delete(block.tool_use_id);
        this.emit('event', { type: 'subagent_end', id: at(block.tool_use_id), output, error: block.is_error === true, launched, agent });
      }
    }
    // Background task lifecycle (task_started / task_progress / task_notification), when the CLI reports it.
    if (raw.type === 'system' && /^task_/.test(String(raw.subtype || '')) && (raw.tool_use_id || raw.task_id)) {
      const id = at(raw.tool_use_id || raw.task_id);
      const status = at(raw.status) || (raw.subtype === 'task_started' ? 'running' : '');
      const commandId = this.backgroundCommands.has(id) ? id : [...this.backgroundCommands].find(([, taskId]) => taskId === raw.task_id)?.[0];
      if (commandId || raw.task_type === 'local_bash') {
        if (SETTLED_TASK.has(status)) this.backgroundCommands.delete(commandId || id);
        else this.backgroundCommands.set(commandId || id, at(raw.task_id));
        return true; // the model's response follows this notification, so don't close stdin here
      }
      this.emit('event', { type: 'subagent_status', id, agent, status, summary: at(raw.summary) || at(raw.description) });
      if (SETTLED_TASK.has(status)) { this.subagentIds.delete(id); this.releaseLingering(); }
      return true;
    }
    return false;
  }

  /** agy's `invoke_subagent` step: a robot-chip entry that follows the subagent's own transcript (see agy-subagents.js). The tool card stays in the reply as before. */
  consumeAgySubagentStep(step) {
    const parentId = step.conversation_id || this.child?.agyConversationId || '';
    const id = `agy-${parentId}-${step.step_index}`;
    const params = step.tool_info?.parameters || {};
    if (!this.agySubagentIds.has(id)) {
      if (!params.Prompt && !params.Role) return; // a step that names nothing to follow
      this.agySubagentIds.add(id);
      this.agySubagents.launch({ id, parentId, role: at(params.Role), typeName: at(params.TypeName), prompt: at(params.Prompt) });
    }
    if (step.state === 'ERROR') this.agySubagents.failed(id, at(step.tool_info?.error?.message));
    else if (step.state !== 'ACTIVE') this.agySubagents.launched(id, /conversationId[\\"]*\s*:\s*[\\"]*([0-9a-f-]{36})/i.exec(JSON.stringify(step))?.[1]);
  }

  /** The turn is over but Claude's background agents are still working in the kept-open process. */
  get hasBackgroundAgents() { return this.bridgeAgents.active || (Boolean(this.lingering) && this.subagentIds.size > 0); }

  /** The kept-open process closes once its turn is over and no background agent is left in it. */
  releaseLingering() {
    const child = this.lingering;
    if (!child || this.subagentIds.size || !child.turnCompleted) return;
    this.lingering = null;
    if (child !== this.live && child.stdin?.writable) child.stdin.end();
  }

  /**
   * What an edit changed in `file`: its text now against its last edit in this turn, else its
   * version in the repo snapshot taken when the turn started (the file's own repo, nested or
   * not). A file that didn't exist then counts as all added.
   */
  fileDiff(file) {
    const after = readText(file);
    let before = this.editCache?.get(file);
    if (before === undefined) {
      const root = gitRoot(path.dirname(file));
      const base = root && (this.codexBases.get(root) || 'HEAD');
      try { before = root ? git(['show', `${base}:${path.relative(root, file).split(path.sep).join('/')}`], root) : ''; } catch { before = ''; }
    }
    this.editCache?.set(file, after);
    return editDiff({ old_string: before, new_string: after });
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
    if (pending.appServer) {
      this.approvals.delete(actionId);
      try {
        const method = pending.appServer.method;
        let result;
        if (method === 'mcpServer/elicitation/request') result = { action: approved ? 'accept' : 'decline' };
        else if (method === 'item/permissions/requestApproval') result = { permissions: approved ? pending.input?.permissions || {} : {}, scope: always ? 'session' : 'turn' };
        else if (method === 'execCommandApproval' || method === 'applyPatchApproval') {
          result = { decision: approved ? (always ? 'approved_for_session' : 'approved') : { denied: { rejection: 'The user declined this action in the chat window.' } } };
        } else result = { decision: approved ? (always ? 'acceptForSession' : 'accept') : 'decline' };
        this.codexServer?.respond(pending.appServer.id, result);
        return true;
      } catch { return false; }
    }
    if (!approved) return this.control(actionId, { behavior: 'deny', message: 'The user declined this action in the chat window.' });
    return this.control(actionId, { behavior: 'allow', updatedInput: pending.input || {}, ...(always && pending.suggestions.length ? { updatedPermissions: pending.suggestions } : {}) });
  }

  /** Answers an AskUserQuestion: `answers` maps each question text to the chosen label(s). */
  respondToQuestion(actionId, answers) {
    const pending = this.approvals.get(actionId);
    if (!pending) return false;
    if (pending.appServer) {
      this.approvals.delete(actionId);
      const byId = {};
      for (const question of pending.questions) {
        const value = answers?.[question.question] ?? answers?.[question.id] ?? '';
        byId[question.id] = { answers: Array.isArray(value) ? value.map(String) : String(value).split(',').map((entry) => entry.trim()).filter(Boolean) };
      }
      try { this.codexServer?.respond(pending.appServer.id, { answers: byId }); return true; }
      catch { return false; }
    }
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
    if (agent === 'codex') this.consumeLine(JSON.stringify({ __appServer: true, method: 'turn/completed', params: {} }), agent);
    else this.emit('event', { type: 'turn_complete', agent });
  }

  cancel() {
    this.groqTurn = null;
    this.backgroundCommands.clear();
    clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.approvals.clear();
    if (this.codexActive) {
      const threadId = this.codexThreadId;
      const turnId = this.codexTurnId;
      this.retireCodexTurn(turnId);
      this.codexActive = false;
      this.codexAcceptEvents = false;
      this.codexTurnId = null;
      this.codexGeneration += 1;
      if (threadId && turnId && this.codexServer) {
        const interrupting = this.codexServer.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        const barrier = interrupting.finally(() => { if (this.codexInterrupting === barrier) this.codexInterrupting = null; });
        this.codexInterrupting = barrier;
      }
    }
    if (this.child && this.child === this.live) return; // the Remote Control process outlives turns
    if (this.child) this.agySubagents.endAll('stopped'); // agy's subagents run inside the process that is about to be killed
    killTree(this.child);
    this.child = null;
  }

  /** Extension shutdown: the live process goes too. */
  dispose() {
    clearInterval(this.bridgeTimer);
    this.cancel();
    if (this.live) killTree(this.live);
    this.live = null;
    this.codexServer?.dispose();
    this.codexServer = null;
    this.codexThreadId = null;
  }

  /** P17-F: the user's Stop / Steer Now. Ends the running turn now and says so, unlike a silent cancel(). */
  interrupt() {
    if (this.codexActive) {
      const threadId = this.codexThreadId;
      const turnId = this.codexTurnId;
      this.retireCodexTurn(turnId);
      this.codexActive = false;
      this.codexAcceptEvents = false;
      this.codexTurnId = null;
      this.codexGeneration += 1;
      this.approvals.clear();
      if (threadId && turnId && this.codexServer) {
        const interrupting = this.codexServer.request('turn/interrupt', { threadId, turnId }).catch(() => {});
        const barrier = interrupting.finally(() => { if (this.codexInterrupting === barrier) this.codexInterrupting = null; });
        this.codexInterrupting = barrier;
      }
      this.emit('event', { type: 'turn_complete', interrupted: true, agent: 'codex' });
      return true;
    }
    // Live Remote Control: ask Claude to stop the turn; the process (and the phone link) stays.
    if (this.live && this.child === this.live) {
      if (this.live.turnCompleted) return false;
      this.sendControl({ subtype: 'interrupt' }).catch(() => {});
      this.live.turnCompleted = true;
      this.approvals.clear();
      this.emit('event', { type: 'turn_complete', interrupted: true });
      return true;
    }
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

module.exports = { StreamEngine, normalizeEvent, killTree, contextTokensOf, contextGrowthOf, toolTarget, geminiToolTarget, editDiff };
