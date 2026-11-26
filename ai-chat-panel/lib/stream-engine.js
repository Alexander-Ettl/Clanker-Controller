'use strict';

const { EventEmitter } = require('node:events');
const { spawn, execFile, execFileSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { locate, resolveShim, headlessEnv } = require('./binary-locator.js');
const { prepareCliEnv } = require('./cli-env.js');
const { cliTelemetry } = require('./cli-telemetry.js');
const { CodexAppServer } = require('./codex-app-server.js');
const { AVAILABLE_MODELS, defaultModel } = require('./model-catalog.js');
const { fromRateLimitEvent } = require('./claude-usage.js');
const { attachmentPrompt, codexAttachmentInput } = require('./attachments.js');
const { readQuestion, readThoughts, readContext } = require('./agy-question.js');
const { AgySubagents } = require('./agy-subagents.js');
const agyStepOutput = require('./agy-step-output.js');
const { isLimitNotice } = require('../media/limit-notice.js');
const providers = require('./providers');
const { silentTurnMessage } = require('./provider-health.js');

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
// Keep a warm `agy` stream-json process alive between turns to skip cold startup and keep
// subagents/background tasks intact, then release it after idle inactivity to protect RAM.
const AGY_IDLE_MS = 10 * 60 * 1000;
const AGY_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

function isInsideDir(target, root) {
  const rel = path.relative(path.resolve(root), path.resolve(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}


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
  return s(input.url) || s(input.query) || s(input.skill) || s(input.description) || s(input.task_id) || s(input.shell_id) || s(input.bash_id) || '';
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

/** agy's update_steps plan: [{ title, status: pending|in_progress|completed|... }]. */
function planSteps(steps) {
  return (Array.isArray(steps) ? steps : []).map((s) => ({ title: typeof s?.title === 'string' ? s.title.trim() : '', status: String(s?.status || 'pending').toLowerCase() })).filter((s) => s.title);
}
const stepDone = (s) => /^(complete|completed|done)$/.test(s.status);
const stepActive = (s) => /^in.?progress$/.test(s.status);
/** One line: the step being worked on and how far along the plan is ("Run the tests (2/4)"). */
function stepsLabel(steps) {
  const list = planSteps(steps);
  if (!list.length) return '';
  const current = list.find(stepActive) || list.find((s) => !stepDone(s));
  return current ? `${current.title} (${list.indexOf(current) + 1}/${list.length})` : `All ${list.length} steps done`;
}
/** The whole plan, one step per line, for the card's body. */
function stepsChecklist(steps) {
  return planSteps(steps).map((s) => `${stepDone(s) ? '✓' : stepActive(s) ? '▸' : '○'} ${s.title}`).join('\n');
}

/** agy's file-writing tools, older and newer builds: all are edits (a card that opens the file, with its diff). */
const AGY_EDIT_TOOLS = /^(write_to_file|write_file|create_file|edit_file|(multi_)?replace_file_content)$/;

/** What a Gemini / Antigravity tool call acts on: command, file path, query, task action, etc. */
function geminiToolTarget(toolName, params = {}) {
  const at = (x) => (typeof x === 'string' ? x : '');
  const name = String(toolName || '').toLowerCase().replace(/[-_]/g, '');

  if (name === 'runcommand') return at(params.CommandLine);
  // view_file/list_dir/write_to_file (older agy) and read_file/write_file/edit_file (newer agy, other parameter names).
  if (/^(viewfile|listdir|readfile|viewcodeitem|writetofile|writefile|editfile|createfile)$/.test(name) || name.includes('replacefilecontent')) return at(params.AbsolutePath) || at(params.TargetFile) || at(params.Path) || at(params.path) || at(params.file_path) || anyPathLike(params);
  if (name === 'searchweb' || name === 'websearch') return at(params.query) || at(params.Query) || at(params.toolSummary) || at(params.toolAction);
  if (name === 'readurlcontent' || name === 'webfetch' || name === 'readbrowserpage' || name === 'browserpage') return at(params.Url) || at(params.url);
  if (name === 'updatesteps') return stepsLabel(params.steps) || at(params.toolSummary) || at(params.toolAction);
  if (name === 'managetask') {
    // The id is "<conversation>/task-262". The engine adds TaskLabel (what the task runs) once it knows; without it the short id stands.
    const id = at(params.TaskId).split('/').pop();
    const parts = [at(params.Action), at(params.TaskLabel) ? `${at(params.TaskLabel)} (${id})` : id].filter(Boolean);
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

/** The window of the model that did the work, from Claude Code's result `modelUsage` ({ [model]: { contextWindow, inputTokens, ... } }). */
function contextWindowOf(raw) {
  if (raw?.type !== 'result' || !raw.modelUsage || typeof raw.modelUsage !== 'object') return 0;
  const n = (x) => (Number.isFinite(x) ? x : 0);
  const used = (m) => n(m?.inputTokens) + n(m?.outputTokens) + n(m?.cacheReadInputTokens) + n(m?.cacheCreationInputTokens);
  const main = Object.values(raw.modelUsage).filter((m) => n(m?.contextWindow) >= 32000).sort((a, b) => used(b) - used(a))[0];
  return main ? main.contextWindow : 0;
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
    : [[input?.old_string ?? input?.TargetContent ?? input?.Target, input?.new_string ?? input?.ReplacementContent ?? input?.Replacement ?? input?.content ?? input?.CodeContent ?? input?.Content]]; // agy: write_to_file CodeContent, write_file Content, edit_file Target/Replacement
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
/** `file` as the filesystem spells it (git reports real paths; 8.3 short names and junctions would break path.relative against them). Works for a file that is gone. */
const realFile = (file) => { try { return fs.realpathSync.native(file); } catch { try { return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)); } catch { return file; } } };
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
  if (raw?.type === 'system' && raw.subtype === 'compact_boundary') {
    const meta = raw.compact_metadata || raw.compactMetadata || {};
    return { type: 'context_reset', kind: 'native', agent, trigger: at(meta.trigger) || 'auto', preTokens: Number(meta.pre_tokens ?? meta.preTokens) || 0 };
  }
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
      const name = step.tool_name === 'run_command' ? 'bash' : AGY_EDIT_TOOLS.test(at(step.tool_name)) ? 'edit' : at(step.tool_name) || 'tool';
      if (step.state === 'ACTIVE') return { type: 'tool_start', toolId, name, command, file: at(params.TargetFile) || (name === 'edit' ? command : ''), diff: name === 'edit' ? editDiff(params) : '', ...(name === 'update_steps' ? { checklist: stepsChecklist(params.steps) } : {}), ...(at(params.toolSummary) && at(params.toolSummary) !== command ? { summary: at(params.toolSummary).slice(0, 200) } : {}), agent };
      if (step.state === 'ERROR') return { type: 'tool_end', toolId, output: at(step.clankerOutput) || at(step.tool_info?.error?.message).split('\n')[0], error: true, diff: '', agent };
      return { type: 'tool_end', toolId, output: at(step.clankerOutput), diff: '', agent }; // clankerOutput: the step's result, read from agy's files (agy-step-output.js)
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
  constructor({ cwd, attachmentsDir = null, chatId = null, models = {}, interactive = false, permissionMode = null, keepAgyWarm = true, agyIdleMs = AGY_IDLE_MS, spawnImpl = spawn, locateImpl = locate, codexServerFactory = (options) => new CodexAppServer(options), agyQuestionReader = readQuestion, agyThoughtReader = readThoughts, agyContextReader = readContext, agyHome = undefined } = {}) {
    super();
    this.agyLimit = null; // the quota failure this process reported on stderr
    this.limitShown = false; // ... and whether the reply already says so
    this.cwd = cwd || process.cwd();
    this.attachmentsDir = attachmentsDir || null;
    this.keepAgyWarm = keepAgyWarm !== false;
    this.agyIdleMs = Number.isFinite(agyIdleMs) ? agyIdleMs : AGY_IDLE_MS;
    this.spawn = spawnImpl;
    this.locate = locateImpl;
    this.warmAgy = null; // persistent agy stream-json process reused across turns
    this.warmAgyTimer = null; // idle TTL timer that closes warmAgy to save RAM
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
    this.agyHome = agyHome; // where ~/.gemini is (tests point it elsewhere)
    this.agyThoughtReader = agyThoughtReader;
    this.agyContextReader = agyContextReader;
    this.agyChecklists = new Map(); // toolId -> the update_steps plan, shown as the card's body once the step is done
    this.codexBases = new Map(); // repo root -> snapshot, for Codex's per-edit diffs
    this.turnBases = null; // repo root -> snapshot as the turn began, and when (ms): what Undo turn restores
    this.tokens = noTokens();
    this.subagentIds = new Set(); // Agent/Task tool_use ids still running (background ones outlive their call)
    this.copilotSubagents = new Map(); // Copilot's envelope agent id -> spawning tool call
    this.backgroundCommands = new Map(); // tool_use id -> CLI task id (Bash/Monitor jobs also resume the conversation)
    this.toolTargetsById = new Map(); // tool_use id -> command/description, so TaskStop can name the task while it runs
    this.taskLabels = new Map(); // CLI task id -> command/description of that background task
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

  /** Normalized agy --effort flag, omitted when the model id already bakes in the same level (e.g. gemini-4-neon-high). */
  agyEffortFlag(model, effort) {
    const level = String(effort || '').trim().toLowerCase();
    if (!AGY_EFFORTS.has(level)) return null;
    if (model && new RegExp(`-${level}$`, 'i').test(String(model).trim())) return null;
    return level;
  }

  /** Directories agy needs workspace access to: the project cwd plus external attachment folders. */
  agyAddDirs(attachments = []) {
    const dirs = [];
    const seen = new Set();
    const add = (dir) => {
      if (!dir) return;
      const resolved = path.resolve(dir);
      const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
      if (seen.has(key)) return;
      seen.add(key);
      dirs.push(dir);
    };
    add(this.cwd);
    if (this.attachmentsDir && !isInsideDir(this.attachmentsDir, this.cwd)) add(this.attachmentsDir);
    for (const file of attachments || []) {
      if (typeof file !== 'string' || !file.trim()) continue;
      const parent = path.dirname(path.resolve(this.cwd, file));
      if (!isInsideDir(parent, this.cwd)) add(parent);
    }
    return dirs;
  }

  /** `choice` = { model, effort } from the composer picker; the configured default otherwise. */
  commandFor(agent, prompt, attachments = [], choice = {}) {
    const effort = choice.effort || null;
    const resume = choice.resume || null;
    const model = choice.model || this.models[agent] || defaultModel(agent)?.model;
    const fullPrompt = attachmentPrompt(prompt, attachments);
    const command = this.locate(agent).path;
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
      const permArgs = permMode === 'fullAccess' ? ['--dangerously-skip-permissions']
        : permMode === 'auto' ? ['--mode', 'auto']
        : ['--mode', 'accept-edits'];
      const effortFlag = this.agyEffortFlag(model, effort);
      const effortArgs = effortFlag ? ['--effort', effortFlag] : [];
      const addDirs = this.agyAddDirs(attachments);
      const addDirArgs = addDirs.flatMap((dir) => ['--add-dir', dir]);
      const isCompacting = Boolean(choice.compact || choice.autoCompact);
      // agy's stream-json input is {"event":"user","message":{"content":...}}.
      // --add-dir: without it agy runs its shell and resolves relative paths in its own scratch
      // folder (~/.gemini/antigravity-cli/scratch), not the project, even though init reports the cwd.
      return {
        command,
        args: [...cliTelemetry('gemini').args, '--input-format', 'stream-json', '--output-format', 'stream-json', ...(model ? ['--model', model] : []), ...effortArgs, ...permArgs, ...addDirArgs, ...(resume ? ['--conversation', resume] : [])],
        input: JSON.stringify({ event: 'user', message: { content: fullPrompt } }) + '\n',
        keepStdinOpen: Boolean(this.keepAgyWarm && !isCompacting),
        addDirs,
        agyWarmConfig: {
          model: model || '',
          effort: effortFlag,
          permissionMode: permMode,
          cwd: path.resolve(this.cwd),
          addDirs: new Set(addDirs.map((dir) => (process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir)))),
        },
      };
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
    const telemetryArgs = cliTelemetry('codex').args;
    const effortArgs = effort ? ['-c', `model_reasoning_effort="${effort}"`] : [];
    const modelArgs = model ? ['-m', model] : [];
    // Composer slash actions are discovered from this installed CLI's own
    // `codex exec --help`, then run through its native JSONL subcommand.
    if (choice.codexCommand) {
      return {
        command,
        args: ['exec', choice.codexCommand, ...(choice.codexCommandArgs || []), '--json', '--skip-git-repo-check', ...telemetryArgs, ...modelArgs, ...effortArgs, ...(fullPrompt ? ['-'] : [])],
        input: fullPrompt ? `${fullPrompt}\n` : '',
      };
    }
    const permMode = this.effectivePermissionMode('codex', choice.permissionMode);
    const sandboxArgs = permMode === 'fullAccess' ? ['--sandbox', 'danger-full-access'] : ['--sandbox', 'workspace-write'];
    const autoArgs = permMode === 'auto' ? ['--approve-for-me'] : [];
    const approvalArgs = ['-c', `approval_policy="${permMode === 'fullAccess' ? 'never' : 'on-request'}"`, '-c', `approvals_reviewer="${permMode === 'auto' ? 'auto_review' : 'user'}"`];
    // `exec resume` takes config overrides but has no --sandbox or --approve-for-me flags.
    if (resume) return { command, args: ['exec', 'resume', resume, '--json', '-c', `sandbox_mode="${permMode === 'fullAccess' ? 'danger-full-access' : 'workspace-write'}"`, ...approvalArgs, '--skip-git-repo-check', ...telemetryArgs, ...modelArgs, ...effortArgs, '-'], input: fullPrompt + '\n' };
    return { command, args: ['exec', '--json', ...sandboxArgs, ...autoArgs, ...approvalArgs, '--skip-git-repo-check', ...telemetryArgs, ...modelArgs, ...effortArgs, '-'], input: fullPrompt + '\n' };
  }

  getCodexServer() {
    if (this.codexServer) return this.codexServer;
    const server = this.codexServerFactory({ cwd: this.cwd, env: prepareCliEnv({ ...process.env, ...this.chatEnv }) });
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
    this.unrecognizedLines = 0;
    this.agyLimit = null;
    this.limitShown = false;
    this.codexTurnId = null;
    if (!recovering) this.codexCompactionAnnounced = false;
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
          this.emit('event', { type: 'context_reset', kind: 'resume', agent: 'codex' });
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
    // Codex can compact a long thread mid-turn. Record the event once per turn.
    if ((method === 'thread/compacted' || (method === 'item/started' && params.item?.type === 'contextCompaction')) && this.codexActive && !this.codexCompactionAnnounced) {
      this.codexCompactionAnnounced = true;
      this.emit('event', { type: 'context_reset', kind: 'native', agent: 'codex', trigger: 'auto', preTokens: this.lastContextTokens || 0 });
    }
    if (method === 'turn/started') {
      this.codexTurnId = params.turn?.id || this.codexTurnId;
      this.codexBases = repoSnapshots(this.cwd);
    }
    if (method === 'thread/tokenUsage/updated') {
      const usage = params.tokenUsage || {};
      const last = usage.last || {};
      const total = usage.total || {};
      if (usage.modelContextWindow && last.totalTokens) this.emit('event', { type: 'usage', agent: 'codex', contextTokens: last.totalTokens, contextWindow: Number(usage.modelContextWindow) });
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
    if (agent === 'gemini' && !live && this.canReuseWarmAgy({ model, effort, resume, permissionMode, attachments, compact, autoCompact })) {
      const reused = this.sendToWarmAgy({ prompt, attachments, model, effort, resume, freshPrompt, attempt, permissionMode });
      if (reused) return reused;
    }
    this.cancel();
    this.turn = live ? null : { agent, prompt, attachments, model, effort, resume, freshPrompt, codexCommand, codexCommandArgs, attempt, permissionMode, compact: Boolean(compact), autoCompact: Boolean(autoCompact) };
    this.tokens = noTokens(); // P17-V: this turn's token draw
    this.contextSeen = false; // set once a step reports the context size
    this.lastContextTokens = 0;
    const spec = this.commandFor(agent, prompt, attachments, { model, effort, resume, codexCommand, codexCommandArgs, permissionMode, compact, autoCompact });
    if (live && spec.command) spec.args.push('--replay-user-messages');
    // A session that no longer exists (cleared, or made on another machine)
    // reruns the turn once as a new session, with the chat's full handoff.
    this.resumeRetry = resume && !live ? { agent, prompt: freshPrompt || prompt, attachments, model, effort, permissionMode } : null;
    // P17-D: a claude CLI that predates Opus 5.5 (or --effort) fails before
    // any output; that turn reruns once on the fallback model instead.
    this.fallback = agent === 'claude' && !live && /opus/i.test(model || '') ? { agent, prompt, attachments, resume, freshPrompt, permissionMode } : null;
    this.sawOutput = false;
    this.unrecognizedLines = 0;
    // P16-I: a missing CLI becomes a structured event the chat view renders
    // as a setup card, instead of a raw `spawn ... ENOENT` string posing as
    // the model's reply.
    if (!spec.command) {
      const { checked } = this.locate(agent);
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
    const child = this.spawn(shim ? shim.command : useShell ? `"${spec.command}"` : spec.command, shim ? [...shim.args, ...spec.args] : spec.args, {
      cwd: this.cwd,
      windowsHide: true,
      shell: useShell,
      env: prepareCliEnv({
        ...process.env,
        ...headlessEnv(spec.command),
        ...cliTelemetry(agent).env,
        ...this.chatEnv,
        ...spec.env,
        CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
        ...(isCompacting ? {
          NO_CHIME: '1',
          ANTIGRAVITY_NO_CHIME: '1',
          CLAUDE_NO_CHIME: '1',
          CODEX_NO_CHIME: '1',
          AI_CHAT_PANEL_COMPACT: '1',
        } : {}),
      }),
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child = child;
    child.permissionMode = this.effectivePermissionMode(agent, permissionMode);
    if (live) { child.live = true; child.turnCompleted = true; this.live = child; } // idle until a message arrives
    if (agent === 'gemini' && spec.keepStdinOpen && !live) {
      child.agyWarmConfig = spec.agyWarmConfig;
      this.warmAgy = child;
    }
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
    child.watchdog = live ? null : setTimeout(() => { if (this.child === child) this.failUpstream(agent, `No response from ${agent} after ${FIRST_OUTPUT_TIMEOUT_MS / 1000}s.`); }, FIRST_OUTPUT_TIMEOUT_MS);
    child.watchdog?.unref?.();
    // A live process keeps talking between our turns (phone prompts), so it's always heard.
    const current = () => this.child === child || this.live === child;
    const consumeStdout = (chunk) => {
      clearTimeout(child.watchdog);
      child.watchdog = null;
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
      clearTimeout(child.watchdog);
      child.watchdog = null;
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
      clearTimeout(child.watchdog);
      child.watchdog = null;
      if (agent === 'gemini') {
        await agyInput;
        if (current() && stdoutBuffer.trim()) {
          await this.consumeAgyLine(stdoutBuffer, child);
          stdoutBuffer = '';
        }
      }
      if (this.warmAgy === child) {
        clearTimeout(this.warmAgyTimer);
        this.warmAgyTimer = null;
        this.warmAgy = null;
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
      this.copilotSubagents.clear();
      this.agySubagents.endAll(code ? 'failed' : 'ended');
      this.backgroundCommands.clear();
      if (code && !child.turnCompleted && !this.sawOutput && !child.reportedError) {
        const detail = lastDiagnostic;
        this.emit('event', { type: 'delta', text: detail || silentTurnMessage({ agent, code, unrecognized: this.unrecognizedLines }) || `${agent} exited with code ${code}.`, model: agent, agent });
      } else if (!code && !child.turnCompleted && !this.sawOutput && !child.reportedError) {
        // A clean exit with no reply and no turn result: nothing it printed was something Clanker renders.
        const hint = silentTurnMessage({ agent, code, unrecognized: this.unrecognizedLines, diagnostic: lastDiagnostic });
        if (hint) this.emit('event', { type: 'delta', text: hint, model: agent, agent });
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

  /** True when the idle warm agy process matches the next turn's model, flags, workspace, and conversation. */
  canReuseWarmAgy({ model, effort, resume = null, permissionMode = null, attachments = [], compact = false, autoCompact = false } = {}) {
    if (!this.keepAgyWarm || compact || autoCompact) return false;
    const child = this.warmAgy;
    if (!child || child.killed || child.exitCode !== null || child.signalCode !== null || !child.stdin?.writable || !child.turnCompleted) return false;
    const cfg = child.agyWarmConfig;
    if (!cfg) return false;
    const effectiveModel = (model || this.models.gemini || defaultModel('gemini')?.model || '');
    const effectiveEffort = this.agyEffortFlag(effectiveModel, effort);
    const effectivePerm = this.effectivePermissionMode('gemini', permissionMode);
    if (effectiveModel !== cfg.model || effectiveEffort !== cfg.effort || effectivePerm !== cfg.permissionMode) return false;
    if (path.resolve(this.cwd) !== cfg.cwd) return false;
    if (resume && (!child.agyConversationId || resume !== child.agyConversationId)) return false;
    for (const dir of this.agyAddDirs(attachments)) {
      const key = process.platform === 'win32' ? path.resolve(dir).toLowerCase() : path.resolve(dir);
      if (!cfg.addDirs.has(key)) return false;
    }
    return true;
  }

  /** Sends a follow-up prompt over the already-warm agy stream-json stdin without cold-starting a new CLI process. */
  sendToWarmAgy({ prompt, attachments = [], model, effort, resume = null, freshPrompt = null, attempt = 0, permissionMode = null }) {
    const child = this.warmAgy;
    if (!child?.stdin?.writable) return null;
    clearTimeout(this.warmAgyTimer);
    this.warmAgyTimer = null;
    const spec = this.commandFor('gemini', prompt, attachments, { model, effort, resume, permissionMode });
    this.child = child;
    this.turn = { agent: 'gemini', prompt, attachments, model, effort, resume, freshPrompt, attempt, permissionMode, compact: false, autoCompact: false };
    this.beginLiveTurn();
    this.contextSeen = false;
    this.lastContextTokens = 0;
    this.agyEdits.clear();
    this.agyChecklists.clear();
    clearTimeout(child.watchdog);
    child.watchdog = setTimeout(() => { if (this.child === child) this.failUpstream('gemini', `No response from gemini after ${FIRST_OUTPUT_TIMEOUT_MS / 1000}s.`); }, FIRST_OUTPUT_TIMEOUT_MS);
    child.watchdog.unref?.();
    try {
      child.stdin.write(spec.input);
      return child;
    } catch {
      this.closeWarmAgy(child, { immediate: true });
      return null;
    }
  }

  /** Starts the idle TTL timer after a warm agy turn completes so inactive chats release RAM automatically. */
  armWarmAgyIdle(child) {
    if (!child || this.warmAgy !== child) return;
    clearTimeout(this.warmAgyTimer);
    this.warmAgyTimer = null;
    if (!(this.agyIdleMs > 0)) return;
    this.warmAgyTimer = setTimeout(() => {
      if (this.warmAgy === child && child.turnCompleted) this.closeWarmAgy(child);
    }, this.agyIdleMs);
    this.warmAgyTimer.unref?.();
  }

  /** Memory is short: closes a warm agy that is waiting between turns (the next turn cold-starts). True when one closed. */
  releaseIdleWarm() {
    const child = this.warmAgy;
    if (!child || !child.turnCompleted) return false;
    this.closeWarmAgy(child);
    return true;
  }

  /** Closes the warm agy process gracefully via stdin EOF (or kills immediately on cancel/dispose). */
  closeWarmAgy(child = this.warmAgy, { immediate = false } = {}) {
    if (!child) return;
    clearTimeout(child.watchdog);
    child.watchdog = null;
    if (this.warmAgy === child) {
      clearTimeout(this.warmAgyTimer);
      this.warmAgyTimer = null;
      this.warmAgy = null;
    }
    if (this.child === child && child.turnCompleted) this.child = null;
    try { child.stdin?.end(); } catch { /* already gone */ }
    if (immediate) killTree(child);
    else setTimeout(() => killTree(child), 3000).unref?.();
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
    this.unrecognizedLines = 0;
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
        this.emit('event', { type: 'context_reset', kind: 'resume', agent });
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
    if (this.child === child) {
      if (step?.step_type === 'tool') line = this.enrichAgyStep(child, raw, step) ?? line;
      // Gemini's thinking summary for the step that is about to run lives only in agy's trajectory file.
      // Read it when a tool starts or the reply begins, so it shows ahead of the step it explains.
      const begins = step && ((step.step_type === 'tool' && step.state === 'ACTIVE') || (step.text_delta && !child.agyTextSteps?.has(step.step_index)));
      if (begins && Number.isSafeInteger(step.step_index)) {
        if (step.text_delta) (child.agyTextSteps ||= new Set()).add(step.step_index);
        this.emitAgyThoughts(child, step);
      }
      // The conversation's size, from agy's own record: ahead of a result line, because the turn ends with it.
      if (begins || raw?.event === 'result') this.emitAgyContext(child, step?.conversation_id, raw?.event === 'result');
      this.consumeLine(line, 'gemini');
    }
  }

  /**
   * What the stream leaves out of a Gemini tool step, filled in from agy's own files (lib/agy-step-output.js). A finished step gets
   * its result, so the card shows what the tool printed like a Claude or Codex card does. A background task (`run_command` that
   * outlived its wait) is remembered by what it runs, so a later `manage_task` card says "kill  enroll --help (task-262)" and
   * not a bare conversation id. Returns the rewritten line, or undefined when there is nothing to add.
   */
  enrichAgyStep(child, raw, step) {
    const conversationId = step.conversation_id || child.agyConversationId;
    const tasks = (child.agyTasks ||= new Map()); // task id -> what it runs
    const summaries = (child.agySummaries ||= new Map()); // step index -> the call's own one-line summary
    const params = step.tool_info?.parameters || {};
    try {
      if (step.state === 'ACTIVE') {
        if (typeof params.toolSummary === 'string') summaries.set(step.step_index, params.toolSummary);
        if (String(step.tool_name).toLowerCase().replace(/[-_]/g, '') !== 'managetask' || typeof params.TaskId !== 'string') return undefined;
        const known = tasks.get(params.TaskId.split('/').pop());
        const label = known || agyStepOutput.taskLabel('', agyStepOutput.readTaskLog(conversationId, params.TaskId, { home: this.agyHome, lines: 1, head: true }));
        if (!label) return undefined;
        return JSON.stringify({ ...raw, step_update: { ...step, tool_info: { ...step.tool_info, parameters: { ...params, TaskLabel: label } } } });
      }
      if (step.state !== 'DONE' && step.state !== 'ERROR') return undefined;
      const result = agyStepOutput.readStepResult(conversationId, step.step_index, { home: this.agyHome });
      if (!result) return undefined;
      if (result.task) tasks.set(agyStepOutput.shortTaskId(result.task.id), agyStepOutput.taskLabel(summaries.get(step.step_index) || result.task.description, ''));
      if (!result.text) return undefined;
      return JSON.stringify({ ...raw, step_update: { ...step, clankerOutput: result.text.slice(0, 200000) } });
    } catch { return undefined; } // agy's files are an extra: a layout this does not know leaves the card as it was
  }

  /** How full Gemini's window is: its last model call's tokens (stream usage has only the fresh part) against agy's own budget. */
  emitAgyContext(child, conversationId, force) {
    if (!force && Date.now() - (child.agyContextAt || 0) < 1500) return; // a tool-heavy turn starts many steps a second
    child.agyContextAt = Date.now();
    try {
      const context = this.agyContextReader(conversationId || child.agyConversationId);
      if (!context?.tokens) return;
      // A sharp fall is believed only when a second read agrees. agy saves a model call's usage in stages (fresh input and output
      // first, the cached history after), so a read in between weighs a few thousand tokens in a window that holds 150k. A real
      // compaction stays low on the next read; a half-written row has filled in by then. (2026-11-25: a chat at 153k was told it
      // had "shrunk to 4k" = the 3,375 fresh input and 346 output tokens of a call whose cache-read count was not saved yet.)
      const last = child.agyLastContext || 0;
      if (last >= 40000 && context.tokens < last * 0.5 && !child.agyLowRead) { child.agyLowRead = context.tokens; child.agyContextAt = 0; return; }
      child.agyLowRead = 0;
      child.agyLastContext = context.tokens;
      child.agyDbContext = true;
      this.contextSeen = true;
      this.emit('event', { type: 'usage', agent: 'gemini', contextTokens: context.tokens, ...(context.limit ? { contextWindow: context.limit } : {}) });
    } catch { child.agyDbUnavailable = true; /* no trajectory file: the stream's own usage numbers stand in */ }
  }

  emitAgyThoughts(child, step) {
    const id = step.conversation_id || child.agyConversationId;
    try {
      for (const { idx, text } of this.agyThoughtReader(id, child.agyThoughtCursor ?? -1, step.step_index + (step.text_delta ? 1 : 0)) || []) {
        child.agyThoughtCursor = idx;
        this.emit('event', { type: 'thought', text, agent: 'gemini' });
      }
    } catch { /* no trajectory file (another agy build, no node:sqlite): the step just shows without its thinking */ }
  }

  consumeLine(line, agent) {
    if (!line.trim()) return;
    if (this.resumeRetry && !this.sawOutput && (RESUME_FAILED.test(line) || /"is_error":\s*true[\s\S]*"num_turns":\s*0\b/.test(line))) {
      const retry = this.resumeRetry;
      this.resumeRetry = null;
      this.emit('event', { type: 'context_reset', kind: 'resume', agent });
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
      // Gemini's stream usage is the fresh part of a call only (a few thousand tokens in a window that holds 150k), so it stands in
      // for the real figure only where agy's own record cannot be read at all.
      if (agent === 'gemini' && this.child && !this.child.agyDbContext && !this.child.agyDbUnavailable && raw?.step_update?.usage) this.emitAgyContext(this.child, raw.step_update.conversation_id, true); // is the real figure readable?
      const contextTokens = agent === 'gemini' && !this.child?.agyDbUnavailable ? 0 : contextTokensOf(raw);
      if (contextTokens) { this.contextSeen = true; this.lastContextTokens = contextTokens; this.emit('event', { type: 'usage', agent, contextTokens }); }
      else if (!this.contextSeen && contextGrowthOf(raw)) this.emit('event', { type: 'usage', agent, contextGrowth: contextGrowthOf(raw) });
      // Claude Code names each model's real window in its result; the gauge has to measure against that one.
      const windowTokens = agent === 'claude' ? contextWindowOf(raw) : 0;
      if (windowTokens && this.lastContextTokens) this.emit('event', { type: 'usage', agent, contextTokens: this.lastContextTokens, contextWindow: windowTokens });
      const counts = agent === 'copilot' ? providers.get('copilot').usage(raw) : tokenCountsOf(raw);
      if (counts && (counts.final || counts.id === null || counts.id !== this.tokens.lastId)) {
        this.tokens = counts.final
          ? { input: counts.input, output: counts.output, lastId: null, detail: counts.detail }
          : { input: this.tokens.input + counts.input, output: this.tokens.output + counts.output, lastId: counts.id, detail: addDetail(this.tokens.detail, counts.detail) };
        const { input: inputTokens, output: outputTokens } = this.tokens;
        if (inputTokens + outputTokens) this.emit('event', { type: 'token_usage', agent, inputTokens, outputTokens, totalTokens: inputTokens + outputTokens });
      }
    }
    try { event = raw === undefined ? { type: 'delta', text: line, model: agent, agent } : normalizeEvent(raw, agent); } catch { event = { type: 'delta', text: line, model: agent, agent }; }
    if (!event) { if (raw !== undefined && !this.sawOutput) this.unrecognizedLines = (this.unrecognizedLines || 0) + 1; return; } // counted for silentTurnMessage
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
    const agyTurnErrored = Boolean(event.limitError || event.error);
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
        else if (agent === 'gemini' && this.child === this.warmAgy && !agyTurnErrored) this.armWarmAgyIdle(this.child);
        else {
          if (this.child === this.warmAgy) { clearTimeout(this.warmAgyTimer); this.warmAgyTimer = null; this.warmAgy = null; }
          this.child.stdin.end();
        }
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
    if (agent === 'gemini' && event.type === 'tool_start' && 'checklist' in event) {
      if (event.checklist) this.agyChecklists.set(event.toolId, event.checklist);
      delete event.checklist;
    }
    if (agent === 'gemini' && event.type === 'tool_end' && this.agyChecklists.has(event.toolId)) {
      if (!event.error) event.output = this.agyChecklists.get(event.toolId);
      this.agyChecklists.delete(event.toolId);
    }
    // A TaskStop / KillShell card names the background task it is stopping right away when we saw it start.
    if (event.type === 'tool_start' && /^(?:task_?stop|kill_?(?:shell|bash))$/i.test(String(event.name || '')) && event.command && this.taskLabels.has(event.command)) {
      event.command = this.taskLabels.get(event.command);
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
      if (child && this.warmAgy === child) { clearTimeout(this.warmAgyTimer); this.warmAgyTimer = null; this.warmAgy = null; }
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
    if (agent === 'gemini' && raw?.event === 'result' && event.type === 'delta' && this.child && !this.child.turnCompleted) {
      this.emit('event', event);
      // Don't reuse a warm agy process after a turn-level ERROR result, and end the turn without waiting for stdin EOF.
      const errored = this.child;
      if (this.warmAgy === errored) { clearTimeout(this.warmAgyTimer); this.warmAgyTimer = null; this.warmAgy = null; }
      this.consumeLine(JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: '' } }), agent);
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
    if (agent === 'copilot') return this.consumeCopilotSubagentLine(raw);
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
        if (block?.type !== 'tool_use') continue;
        const input = block.input || {};
        const label = toolTarget(input);
        if (block.id && label) this.toolTargetsById.set(block.id, label);
        if (!SUBAGENT_TOOLS.has(block.name)) continue;
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
          if (task) {
            this.backgroundCommands.set(block.tool_use_id, task[1]);
            const label = this.toolTargetsById.get(block.tool_use_id);
            if (label) this.taskLabels.set(task[1], label);
          }
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
      const taskLabel = at(raw.command) || at(raw.description) || at(raw.summary) || this.toolTargetsById.get(at(raw.tool_use_id));
      if (raw.task_id && taskLabel && !this.taskLabels.has(at(raw.task_id))) this.taskLabels.set(at(raw.task_id), taskLabel);
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

  consumeCopilotSubagentLine(raw) {
    const data = raw.data || {};
    const id = at(data.toolCallId);
    const emit = (event) => this.emit('event', { agent: 'copilot', ...event });
    if (raw.type === 'subagent.started' && id) {
      this.subagentIds.add(id);
      if (raw.agentId) this.copilotSubagents.set(raw.agentId, id);
      emit({ type: 'subagent_start', id, model: at(data.model), description: at(data.agentDisplayName) || at(data.agentName), subagentType: at(data.agentName) || 'agent' });
      return true;
    }
    if ((raw.type === 'subagent.completed' || raw.type === 'subagent.failed') && id) {
      if (this.subagentIds.delete(id)) {
        if (data.error) emit({ type: 'subagent_event', id, event: { type: 'notice', text: at(data.error) } });
        emit({ type: 'subagent_end', id, model: at(data.model), error: raw.type === 'subagent.failed' });
      }
      return true;
    }
    const parent = at(data.parentToolCallId) || this.copilotSubagents.get(raw.agentId);
    if (!parent) return false;
    const event = raw.type === 'user.message' && at(data.content) ? { type: 'task', text: data.content }
      : providers.get('copilot').normalizeEvent(raw, { nested: true });
    if (event?.type === 'tool_start') for (const key of ['file', 'command']) if (event[key]) event[key] = this.relative(event[key]);
    if (event && ['task', 'tool_start', 'tool_progress', 'tool_end', 'delta', 'thought', 'notice'].includes(event.type)) emit({ type: 'subagent_event', id: parent, event });
    return true;
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
      try { before = root ? git(['show', `${base}:${path.relative(root, realFile(file)).split(path.sep).join('/')}`], root) : ''; } catch { before = ''; }
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
    if (this.warmAgy && this.warmAgy !== this.child) this.closeWarmAgy(this.warmAgy, { immediate: true });
    if (this.child && this.child === this.warmAgy) { clearTimeout(this.warmAgyTimer); this.warmAgyTimer = null; this.warmAgy = null; }
    clearTimeout(this.child?.watchdog);
    killTree(this.child);
    this.child = null;
  }

  /** Extension shutdown: the live process goes too. */
  dispose() {
    clearInterval(this.bridgeTimer);
    this.cancel();
    this.closeWarmAgy(this.warmAgy, { immediate: true });
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
function killTree(child, execFileImpl = execFile, { platform = process.platform, descendants = descendantPids, signal = process.kill.bind(process) } = {}) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  if (platform === 'win32' && child.pid) {
    execFileImpl('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, (error) => { if (error) child.kill(); });
    return;
  }
  // Linux and macOS: SIGTERM reaches only the CLI itself, and a tool it started (a build, a dev server) would carry on
  // with nobody listening. Collect the tree first, since children are re-parented once their parent is gone.
  const children = child.pid ? descendants(child.pid) : [];
  child.kill();
  for (const pid of children.reverse()) { try { signal(pid, 'SIGTERM'); } catch { /* already gone */ } }
}

/** Every process below `pid`, found with pgrep (which exits 1 when a process has no children). */
function descendantPids(pid) {
  const found = [];
  const walk = (parent) => {
    let out = '';
    try { out = execFileSync('pgrep', ['-P', String(parent)], { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return; }
    for (const line of out.split('\n')) {
      const child = Number(line);
      if (child > 1 && !found.includes(child)) { found.push(child); walk(child); }
    }
  };
  walk(pid);
  return found;
}

module.exports = { StreamEngine, normalizeEvent, killTree, contextTokensOf, contextWindowOf, contextGrowthOf, toolTarget, geminiToolTarget, editDiff };
